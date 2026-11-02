"use strict";
// Phase 5B staff-only delivery records (local). Off unless OFFICE_HARDWARE_DELIVERY_ENABLED=true. No customer
// notification, public tracking, payment or inventory action exists here; every write is a SECURITY INVOKER database
// function that re-checks commerce.orders.delivery.manage. Proof photos reuse the Office storage service and office_files.
const crypto = require("crypto");
const { json, readJsonBody } = require("./http");
const { hasPermission } = require("./permissions");
const { appendAuditRecord } = require("./audit");
const { MEDIA_LIMITS, sniffImage } = require("./catalogue-media");
const PREFIX = "/api/lead-agents/admin/hardware-delivery";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE = "commerce.orders.delivery.manage";
const PROOF_MAX_UPLOAD = 8 * 1024 * 1024;
const fail = (status, code) => { const e = new Error(code); e.statusCode = status; e.code = code; throw e; };
function need(auth, permission) {
  if (!auth) fail(401, "unauthorized");
  if (auth.type !== "session") fail(403, "delivery_requires_staff_session");
  if (!hasPermission(auth, permission)) fail(403, "forbidden");
}
function only(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !keys.includes(k))) fail(400, "invalid_delivery_input");
}
const version = (v) => { if (!Number.isSafeInteger(v) || v < 0) fail(400, "invalid_delivery_input"); return v; };
const optText = (v, max) => { if (v !== undefined && v !== null && (typeof v !== "string" || v.length > max)) fail(400, "invalid_delivery_input"); return v || ""; };

// Proof photo: content-sniffed JPEG/PNG/WebP, size and pixel limits shared with catalogue media, auto-rotated and
// re-encoded to WebP with ALL metadata (EXIF/GPS, XMP, IPTC) removed. The original upload is never stored.
async function processProof(buffer) {
  if (buffer.length > Math.min(MEDIA_LIMITS.maxBytes, PROOF_MAX_UPLOAD)) fail(413, "proof_too_large");
  const format = sniffImage(buffer);
  if (!format) fail(415, "unsupported_proof_type");
  const sharp = require("sharp");
  let out;
  try {
    const img = sharp(buffer, { failOn: "warning", limitInputPixels: MEDIA_LIMITS.maxPixels, sequentialRead: true, animated: false });
    const meta = await img.metadata();
    if (meta.format !== format) fail(422, "proof_format_mismatch");
    out = await img.rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch (e) {
    if (e.statusCode) throw e;
    fail(422, "unreadable_proof_image");
  }
  return { buffer: out, sha256: crypto.createHash("sha256").update(out).digest("hex") };
}

async function handleHardwareDeliveryRequest({ req, res, pathname, authContext, store, storageService, config = {} }) {
  if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const send = (status, body) => { json(res, status, body); return true; };
  try {
    need(authContext, "commerce.orders.read");
    if (process.env.OFFICE_HARDWARE_DELIVERY_ENABLED !== "true" || process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED !== "true") return send(503, { error: "delivery_disabled" });
    if (!["GET", "HEAD"].includes(req.method)) {
      const expectedOrigin = config.officeAppUrl || (process.env.NODE_ENV !== "production" ? `http://${req.headers.host}` : "");
      if (!expectedOrigin || req.headers.origin !== expectedOrigin) fail(403, "origin_not_allowed");
    }
    if (!store.client) return send(503, { error: "delivery_unavailable" });
    const actor = String(authContext.email || "").trim().toLowerCase();
    const parts = pathname.slice(PREFIX.length).split("/").filter(Boolean);
    if (!UUID.test(parts[0] || "")) fail(404, "not_found");
    const id = parts[0].toLowerCase();
    const rpc = (name, args) => store.client.post(`/rpc/${name}`, { p_actor: actor, p_order: id, ...args });

    if (parts.length === 1 && req.method === "GET") {
      const [d, events, proofs] = await Promise.all([
        store.client.get(`/hardware_deliveries?order_id=eq.${id}&select=*`),
        store.client.get(`/hardware_delivery_events?order_id=eq.${id}&select=row_version,event_type,from_state,to_state,actor,authorization_scope,reason,detail,created_at&order=row_version.asc`),
        store.client.get(`/hardware_delivery_proofs?order_id=eq.${id}&select=id,kind,sha256,bytes,actor,created_at&order=created_at.asc`),
      ]);
      const canSeeRecipient = hasPermission(authContext, MANAGE) || hasPermission(authContext, "commerce.orders.customer.read");
      const delivery = d.data[0] || null;
      if (delivery && !canSeeRecipient) { delivery.recipient_name = delivery.recipient_name ? "(restricted)" : null; delivery.instructions = delivery.instructions ? "(restricted)" : null; }
      return send(200, { delivery, events: events.data, proofs: proofs.data, can_view_proofs: canSeeRecipient, notifications: false, public_tracking: false });
    }
    if (parts.length === 3 && parts[1] === "proofs" && req.method === "GET") {
      if (!(hasPermission(authContext, MANAGE) || hasPermission(authContext, "commerce.orders.customer.read"))) fail(403, "forbidden");
      if (!UUID.test(parts[2])) fail(404, "not_found");
      const p = await store.client.get(`/hardware_delivery_proofs?id=eq.${parts[2]}&order_id=eq.${id}&select=id,file_id`);
      if (!p.data[0]) fail(404, "proof_not_found");
      const f = await store.client.get(`/office_files?id=eq.${encodeURIComponent(p.data[0].file_id)}&select=storage_key,purpose,resource_id`);
      const file = f.data[0];
      if (!file || file.purpose !== "delivery_proof" || file.resource_id !== id || !String(file.storage_key).startsWith("delivery_proof_")) fail(404, "proof_not_found");
      const obj = await storageService.getObject(file.storage_key);
      if (!obj) fail(404, "proof_not_found");
      await appendAuditRecord({ store, authContext, action: "hardware_delivery_proof_viewed", resourceType: "hardware_order", resourceId: id, metadata: { proof_id: parts[2] }, req });
      res.writeHead(200, { "content-type": "image/webp", "content-length": obj.buffer.length, "content-disposition": "inline", "content-security-policy": "default-src 'none'", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
      res.end(obj.buffer);
      return true;
    }
    if (parts.length !== 2 || req.method !== "POST") return send(405, { error: "method_not_allowed" });
    need(authContext, MANAGE);
    const action = parts[1];
    if (action === "proofs") {
      const body = await readJsonBody(req, Math.ceil(PROOF_MAX_UPLOAD * 1.4) + 4096);
      only(body, ["expected_row_version", "kind", "data_url"]);
      version(body.expected_row_version);
      if (!["photo", "signature"].includes(body.kind) || typeof body.data_url !== "string") fail(400, "invalid_proof");
      const m = body.data_url.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) fail(400, "invalid_proof");
      const processed = await processProof(Buffer.from(m[2], "base64"));
      const raw = await storageService.putBuffer({ buffer: processed.buffer, purpose: "delivery_proof", mime_type: "image/webp", extension: ".webp", resource_type: "hardware_order", resource_id: id, metadata: { sha256: processed.sha256, kind: body.kind } });
      let file;
      try {
        file = typeof store.createOfficeFile === "function" ? (await store.createOfficeFile(raw)) || raw : raw;
        const r = await rpc("hardware_delivery_add_proof", { p_expected: body.expected_row_version, p_file_id: file.id, p_kind: body.kind, p_sha256: processed.sha256, p_bytes: processed.buffer.length });
        return send(201, { proof: r.data });
      } catch (e) {
        // Refused or failed registration: remove the stored bytes and the file record so nothing is orphaned.
        await storageService.deleteObject(raw.filename).catch(() => {});
        if (file && typeof store.deleteOfficeFile === "function") await store.deleteOfficeFile(file.id).catch(() => {});
        throw e;
      }
    }
    const body = await readJsonBody(req, 4096);
    if (action === "schedule") {
      only(body, ["expected_row_version", "method", "courier_name", "tracking_reference", "tracking_url", "scheduled_for", "instructions"]);
      version(body.expected_row_version);
      const details = {};
      for (const k of ["method", "courier_name", "tracking_reference", "tracking_url", "scheduled_for", "instructions"]) if (body[k] !== undefined && body[k] !== null && body[k] !== "") {
        if (typeof body[k] !== "string") fail(400, "invalid_delivery_details"); details[k] = body[k].trim();
      }
      const r = await rpc("hardware_delivery_schedule", { p_expected: body.expected_row_version, p_details: details });
      return send(200, { delivery: r.data });
    }
    if (action === "dispatch") { only(body, ["expected_row_version"]); const r = await rpc("hardware_delivery_dispatch", { p_expected: version(body.expected_row_version) }); return send(200, { delivery: r.data }); }
    if (action === "fail") {
      only(body, ["expected_row_version", "reason_code", "note"]);
      const r = await rpc("hardware_delivery_fail", { p_expected: version(body.expected_row_version), p_reason_code: String(body.reason_code || ""), p_note: optText(body.note, 500) });
      return send(200, { delivery: r.data });
    }
    if (action === "reschedule") {
      only(body, ["expected_row_version", "scheduled_for", "note"]);
      if (typeof body.scheduled_for !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.scheduled_for)) fail(400, "invalid_delivery_date");
      const r = await rpc("hardware_delivery_reschedule", { p_expected: version(body.expected_row_version), p_scheduled_for: body.scheduled_for, p_note: optText(body.note, 500) });
      return send(200, { delivery: r.data });
    }
    if (action === "hold") {
      only(body, ["expected_row_version", "exception", "note"]);
      const r = await rpc("hardware_delivery_hold", { p_expected: version(body.expected_row_version), p_exception: String(body.exception || ""), p_note: optText(body.note, 500) });
      return send(200, { delivery: r.data });
    }
    if (action === "release") {
      only(body, ["expected_row_version", "note"]);
      const r = await rpc("hardware_delivery_release", { p_expected: version(body.expected_row_version), p_note: optText(body.note, 500) });
      return send(200, { delivery: r.data });
    }
    if (action === "complete") {
      only(body, ["expected_row_version", "recipient_name", "recipient_relationship", "note"]);
      const r = await rpc("hardware_delivery_complete", { p_expected: version(body.expected_row_version), p_recipient: optText(body.recipient_name, 120), p_relationship: String(body.recipient_relationship || ""), p_note: optText(body.note, 500) });
      return send(200, { delivery: r.data });
    }
    return send(404, { error: "not_found" });
  } catch (error) {
    if (error.statusCode && error.code) return send(error.statusCode, { error: error.code });
    if (error.statusCode === 400 || error.statusCode === 413) return send(error.statusCode, { error: "invalid_delivery_input" });
    const db = error.response?.data || {};
    if (/^PT(400|403|404|409)$/.test(db.code || "") && /^[a-z_]+$/.test(db.message || "")) return send(Number(db.code.slice(2)), { error: db.message });
    if (["42P01", "42883", "PGRST202", "PGRST205"].includes(db.code)) return send(503, { error: "delivery_unavailable" });
    return send(500, { error: "delivery_operation_failed" });
  }
}
module.exports = { handleHardwareDeliveryRequest, processProof };
