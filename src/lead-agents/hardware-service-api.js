"use strict";
// Phase 5C staff-only site inspections and installations (local). Off unless OFFICE_HARDWARE_SERVICE_ENABLED=true (and the
// 5A fulfilment flag). No public booking, customer notification, payment, refund or inventory action exists here; every write
// is a SECURITY INVOKER database function that re-checks its commerce.orders.service.* scope. Appointments are mirrored into
// the existing Office calendar (office_meetings) by the database. Photographs reuse the 5B processing (re-encoded WebP, all
// metadata removed), the Office storage service and office_files.
const { json, readJsonBody } = require("./http");
const { hasPermission } = require("./permissions");
const { appendAuditRecord } = require("./audit");
const { processProof } = require("./hardware-delivery-api");
const PREFIX = "/api/lead-agents/admin/hardware-service";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const SCHEDULE = "commerce.orders.service.schedule", PERFORM = "commerce.orders.service.perform", CONFIGURE = "commerce.orders.service.configure";
const PHOTO_MAX_UPLOAD = 8 * 1024 * 1024;
const PHOTO_ERRORS = { proof_too_large: "photo_too_large", unsupported_proof_type: "unsupported_photo_type", proof_format_mismatch: "photo_format_mismatch", unreadable_proof_image: "unreadable_photo" };
const fail = (status, code) => { const e = new Error(code); e.statusCode = status; e.code = code; throw e; };
function need(auth, ...permissions) {
  if (!auth) fail(401, "unauthorized");
  if (auth.type !== "session") fail(403, "service_requires_staff_session");
  if (!permissions.some((p) => hasPermission(auth, p))) fail(403, "forbidden");
}
function only(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !keys.includes(k))) fail(400, "invalid_service_input");
}
const version = (v) => { if (!Number.isSafeInteger(v) || v < 1) fail(400, "invalid_service_input"); return v; };
const text = (v, max) => { if (v !== undefined && v !== null && (typeof v !== "string" || v.length > max)) fail(400, "invalid_service_input"); return (v || "").trim(); };
const instant = (v) => { if (typeof v !== "string" || !ISO.test(v) || Number.isNaN(Date.parse(v))) fail(400, "invalid_slot"); return v; };
const email = (v) => { const e = String(v || "").trim().toLowerCase(); if (!EMAIL.test(e)) fail(400, "invalid_service_input"); return e; };
// Customer contact data (service address, acceptance name) is shown to service staff and customer readers only.
const canSeeCustomer = (auth) => [SCHEDULE, PERFORM, "commerce.orders.customer.read"].some((p) => hasPermission(auth, p));
function redact(v, auth) {
  if (!v || canSeeCustomer(auth)) return v;
  return { ...v, service_address: { state: v.service_address?.state, city: v.service_address?.city, address: "(restricted)" }, acceptance_name: v.acceptance_name ? "(restricted)" : null };
}
// Postgres range bounds look like "2026-11-01 09:00:00+00".
const pgTime = (t) => new Date(String(t).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toISOString();
const VISIT_FIELDS = "id,kind,order_id,contact_id,service_address,state,technician,starts_at,ends_at,reschedule_count,report,checklist_version,checklist,acceptance_name,acceptance_relationship,completed_at,row_version,created_by,created_at,updated_at";

async function handleHardwareServiceRequest({ req, res, pathname, authContext, store, storageService, config = {} }) {
  if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const send = (status, body) => { json(res, status, body); return true; };
  try {
    need(authContext, "commerce.orders.read");
    if (process.env.OFFICE_HARDWARE_SERVICE_ENABLED !== "true" || process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED !== "true") return send(503, { error: "service_disabled" });
    if (!["GET", "HEAD"].includes(req.method)) {
      const expectedOrigin = config.officeAppUrl || (process.env.NODE_ENV !== "production" ? `http://${req.headers.host}` : "");
      if (!expectedOrigin || req.headers.origin !== expectedOrigin) fail(403, "origin_not_allowed");
    }
    if (!store.client) return send(503, { error: "service_unavailable" });
    const actor = String(authContext.email || "").trim().toLowerCase();
    const url = new URL(req.url, "http://local");
    const parts = pathname.slice(PREFIX.length).split("/").filter(Boolean);
    const rpc = (name, args) => store.client.post(`/rpc/${name}`, { p_actor: actor, ...args });
    const get = async (p) => (await store.client.get(p)).data;

    // ---- Technicians, working hours, unavailability and the verified busy times of one day ----
    if (parts[0] === "technicians") {
      if (parts.length === 1 && req.method === "GET") {
        const caps = await get("/office_staff_capabilities?capability=eq.hardware.field_technician&select=staff_email,specialty");
        const emails = caps.map((c) => String(c.staff_email).toLowerCase());
        if (!emails.length) return send(200, { technicians: [] });
        const inList = `(${emails.map((e) => `"${e.replace(/"/g, "")}"`).join(",")})`;
        const [users, hours] = await Promise.all([
          get(`/admin_users?email=in.${encodeURIComponent(inList)}&select=email,display_name,status,removed_at`),
          get(`/hardware_technician_schedules?technician=in.${encodeURIComponent(inList)}&select=technician,version,windows,created_at&order=version.desc`),
        ]);
        const technicians = users.filter((u) => u.status === "active" && !u.removed_at).map((u) => {
          const e = u.email.toLowerCase(); const h = hours.find((x) => x.technician === e);
          return { email: e, display_name: u.display_name || null, specialty: caps.find((c) => c.staff_email.toLowerCase() === e)?.specialty || null, hours_version: h?.version || 0, windows: h?.windows || [] };
        });
        return send(200, { technicians, timezone: "Africa/Lagos" });
      }
      const tech = parts[1] ? email(decodeURIComponent(parts[1])) : null;
      if (parts.length === 3 && parts[2] === "busy" && req.method === "GET") {
        const day = url.searchParams.get("date") || "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, "invalid_service_input");
        // Africa/Lagos is UTC+1 with no daylight saving: the local day is [day 00:00+01:00, next day 00:00+01:00).
        const from = new Date(`${day}T00:00:00+01:00`); if (Number.isNaN(from.getTime())) fail(400, "invalid_service_input");
        const to = new Date(from.getTime() + 86400000);
        const range = `and=(starts_at.lt.${encodeURIComponent(to.toISOString())},ends_at.gt.${encodeURIComponent(from.toISOString())})`;
        const [visits, away, meetings] = await Promise.all([
          get(`/hardware_service_visits?technician=eq.${encodeURIComponent(tech)}&state=in.(scheduled,in_progress)&${range}&select=id,kind,starts_at,ends_at`),
          get(`/hardware_technician_unavailability?technician=eq.${encodeURIComponent(tech)}&period=ov.${encodeURIComponent(`[${from.toISOString()},${to.toISOString()})`)}&select=period`),
          get(`/office_meetings?owner=eq.${encodeURIComponent(tech)}&status=eq.active&trashed_at=is.null&scheduled_at=gte.${encodeURIComponent(new Date(from.getTime() - 3600000).toISOString())}&scheduled_at=lt.${encodeURIComponent(to.toISOString())}&select=scheduled_at,related_type`),
        ]);
        const busy = [
          ...visits.map((v) => ({ type: v.kind, starts_at: v.starts_at, ends_at: v.ends_at })),
          ...away.map((u) => { const m = String(u.period).match(/^[[(]"?([^",]+)"?,"?([^",)\]]+)"?[)\]]$/); return m ? { type: "unavailable", starts_at: pgTime(m[1]), ends_at: pgTime(m[2]) } : null; }).filter(Boolean),
          ...meetings.filter((m) => m.related_type !== "hardware_service_visit").map((m) => ({ type: "meeting", starts_at: m.scheduled_at, ends_at: new Date(Date.parse(m.scheduled_at) + 3600000).toISOString() })),
        ].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
        // Busy times only: the database re-verifies every booking. No open slots are computed or published.
        return send(200, { technician: tech, date: day, timezone: "Africa/Lagos", busy });
      }
      if (parts.length === 3 && req.method === "POST") {
        need(authContext, CONFIGURE);
        const body = await readJsonBody(req, 8192);
        if (parts[2] === "hours") {
          only(body, ["expected_version", "windows", "reason"]);
          if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || !Array.isArray(body.windows)) fail(400, "invalid_schedule");
          const r = await rpc("hardware_service_set_schedule", { p_technician: tech, p_expected: body.expected_version, p_windows: body.windows, p_reason: text(body.reason, 500) });
          return send(200, { schedule: r.data });
        }
        if (parts[2] === "unavailability") {
          only(body, ["starts_at", "ends_at", "reason"]);
          const r = await rpc("hardware_service_add_unavailability", { p_technician: tech, p_start: instant(body.starts_at), p_end: instant(body.ends_at), p_reason: text(body.reason, 200) });
          return send(201, { unavailability: { id: r.data.id } });
        }
      }
      return send(404, { error: "not_found" });
    }

    if (parts[0] !== "visits") return send(404, { error: "not_found" });
    if (parts.length === 1 && req.method === "GET") {
      const filters = [];
      const s = url.searchParams.get("state"), k = url.searchParams.get("kind"), o = url.searchParams.get("order_id");
      if (s) { if (!["requested", "scheduled", "in_progress", "on_hold", "completed", "cancelled"].includes(s)) fail(400, "invalid_service_input"); filters.push(`state=eq.${s}`); }
      if (k) { if (!["inspection", "installation"].includes(k)) fail(400, "invalid_service_input"); filters.push(`kind=eq.${k}`); }
      if (o) { if (!UUID.test(o)) fail(400, "invalid_service_input"); filters.push(`order_id=eq.${o.toLowerCase()}`); }
      const visits = await get(`/hardware_service_visits?${filters.join("&")}${filters.length ? "&" : ""}select=${VISIT_FIELDS}&order=updated_at.desc&limit=200`);
      return send(200, { visits: visits.map((v) => redact(v, authContext)), notifications: false, public_booking: false });
    }
    if (parts.length === 1 && req.method === "POST") {
      need(authContext, SCHEDULE);
      const body = await readJsonBody(req, 8192);
      only(body, ["kind", "order_id", "contact_id", "service_address", "note"]);
      if (body.order_id != null && !UUID.test(String(body.order_id))) fail(400, "invalid_service_input");
      if (body.contact_id != null && !UUID.test(String(body.contact_id))) fail(400, "invalid_service_input");
      if (!body.service_address || typeof body.service_address !== "object" || Array.isArray(body.service_address)) fail(400, "invalid_service_input");
      const address = {};
      for (const [k, v] of Object.entries(body.service_address)) { if (typeof v !== "string") fail(400, "invalid_service_input"); if (v.trim()) address[k] = v.trim(); }
      const r = await rpc("hardware_service_request", { p_kind: String(body.kind || ""), p_order: body.order_id || null, p_contact: body.contact_id || null, p_address: address, p_note: text(body.note, 1000) });
      return send(201, { visit: redact(r.data, authContext) });
    }
    if (!UUID.test(parts[1] || "")) fail(404, "not_found");
    const id = parts[1].toLowerCase();
    if (parts.length === 2 && req.method === "GET") {
      const [v, events, appointments, evidence] = await Promise.all([
        get(`/hardware_service_visits?id=eq.${id}&select=${VISIT_FIELDS}`),
        get(`/hardware_service_visit_events?visit_id=eq.${id}&select=row_version,event_type,from_state,to_state,actor,authorization_scope,reason,detail,created_at&order=row_version.asc`),
        get(`/hardware_service_appointments?visit_id=eq.${id}&select=sequence,technician,slot,state,meeting_id,actor,created_at&order=sequence.asc`),
        get(`/hardware_service_visit_evidence?visit_id=eq.${id}&select=id,kind,sha256,bytes,actor,created_at&order=created_at.asc`),
      ]);
      if (!v[0]) fail(404, "visit_not_found");
      let checklist = null;
      if (v[0].kind === "installation") {
        const cl = v[0].checklist_version
          ? await get(`/hardware_fulfilment_settings?setting_key=eq.installation_checklist&version=eq.${Number(v[0].checklist_version)}&select=version,value`)
          : await get("/hardware_fulfilment_settings?setting_key=eq.installation_checklist&select=version,value&order=version.desc&limit=1");
        checklist = cl[0] ? { version: cl[0].version, items: cl[0].value.items } : null;
      }
      const canSee = canSeeCustomer(authContext);
      if (!canSee) for (const e of events) if (e.reason) e.reason = "(restricted)";
      return send(200, { visit: redact(v[0], authContext), events, appointments, evidence, checklist, can_view_evidence: canSee, notifications: false, public_booking: false });
    }
    if (parts.length === 4 && parts[2] === "evidence" && req.method === "GET") {
      need(authContext, SCHEDULE, PERFORM, "commerce.orders.customer.read");
      if (!UUID.test(parts[3])) fail(404, "not_found");
      const e = await get(`/hardware_service_visit_evidence?id=eq.${parts[3]}&visit_id=eq.${id}&select=id,file_id`);
      if (!e[0]) fail(404, "evidence_not_found");
      const f = await get(`/office_files?id=eq.${encodeURIComponent(e[0].file_id)}&select=storage_key,purpose,resource_id`);
      const file = f[0];
      if (!file || file.purpose !== "service_visit_photo" || file.resource_id !== id || !String(file.storage_key).startsWith("service_visit_photo_")) fail(404, "evidence_not_found");
      const obj = await storageService.getObject(file.storage_key);
      if (!obj) fail(404, "evidence_not_found");
      await appendAuditRecord({ store, authContext, action: "hardware_service_evidence_viewed", resourceType: "hardware_service_visit", resourceId: id, metadata: { evidence_id: parts[3] }, req });
      res.writeHead(200, { "content-type": "image/webp", "content-length": obj.buffer.length, "content-disposition": "inline", "content-security-policy": "default-src 'none'", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
      res.end(obj.buffer);
      return true;
    }
    if (parts.length !== 3 || req.method !== "POST") return send(405, { error: "method_not_allowed" });
    const action = parts[2];
    const visitRpc = async (name, args) => send(200, { visit: redact((await rpc(name, { p_visit: id, ...args })).data, authContext) });
    if (action === "evidence") {
      need(authContext, PERFORM);
      const body = await readJsonBody(req, Math.ceil(PHOTO_MAX_UPLOAD * 1.4) + 4096);
      only(body, ["expected_row_version", "kind", "data_url"]);
      version(body.expected_row_version);
      if (!["inspection_photo", "installation_photo", "acceptance_signature"].includes(body.kind) || typeof body.data_url !== "string") fail(400, "invalid_evidence");
      const m = body.data_url.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) fail(400, "invalid_evidence");
      let processed;
      try { processed = await processProof(Buffer.from(m[2], "base64")); } catch (e) { if (PHOTO_ERRORS[e.code]) fail(e.statusCode, PHOTO_ERRORS[e.code]); throw e; }
      const raw = await storageService.putBuffer({ buffer: processed.buffer, purpose: "service_visit_photo", mime_type: "image/webp", extension: ".webp", resource_type: "hardware_service_visit", resource_id: id, metadata: { sha256: processed.sha256, kind: body.kind } });
      let file;
      try {
        file = typeof store.createOfficeFile === "function" ? (await store.createOfficeFile(raw)) || raw : raw;
        const r = await rpc("hardware_service_add_evidence", { p_visit: id, p_expected: body.expected_row_version, p_file_id: file.id, p_kind: body.kind, p_sha256: processed.sha256, p_bytes: processed.buffer.length });
        return send(201, { evidence: r.data });
      } catch (e) {
        // Refused or failed registration: remove the stored bytes and the file record so nothing is orphaned.
        await storageService.deleteObject(raw.filename).catch(() => {});
        if (file && typeof store.deleteOfficeFile === "function") await store.deleteOfficeFile(file.id).catch(() => {});
        throw e;
      }
    }
    const body = await readJsonBody(req, 16384);
    if (action === "schedule") {
      need(authContext, SCHEDULE);
      only(body, ["expected_row_version", "technician", "starts_at", "ends_at", "note"]);
      return await visitRpc("hardware_service_schedule", { p_expected: version(body.expected_row_version), p_technician: email(body.technician), p_start: instant(body.starts_at), p_end: instant(body.ends_at), p_note: text(body.note, 1000) });
    }
    if (action === "hold" || action === "release" || action === "cancel") {
      need(authContext, SCHEDULE);
      if (action === "hold") { only(body, ["expected_row_version", "exception", "note"]); return await visitRpc("hardware_service_hold", { p_expected: version(body.expected_row_version), p_exception: String(body.exception || ""), p_note: text(body.note, 1000) }); }
      if (action === "release") { only(body, ["expected_row_version", "note"]); return await visitRpc("hardware_service_release", { p_expected: version(body.expected_row_version), p_note: text(body.note, 1000) }); }
      only(body, ["expected_row_version", "reason", "note"]);
      return await visitRpc("hardware_service_cancel", { p_expected: version(body.expected_row_version), p_reason: String(body.reason || ""), p_note: text(body.note, 1000) });
    }
    need(authContext, PERFORM);
    if (action === "start") { only(body, ["expected_row_version"]); return await visitRpc("hardware_service_start", { p_expected: version(body.expected_row_version) }); }
    if (action === "report") {
      only(body, ["expected_row_version", "findings", "recommendation", "notes"]);
      const report = { findings: text(body.findings, 4000), recommendation: String(body.recommendation || "") };
      if (body.notes) report.notes = text(body.notes, 2000);
      return await visitRpc("hardware_service_record_report", { p_expected: version(body.expected_row_version), p_report: report });
    }
    if (action === "checklist") {
      only(body, ["expected_row_version", "checklist"]);
      if (!body.checklist || typeof body.checklist !== "object" || Array.isArray(body.checklist)) fail(400, "invalid_checklist");
      return await visitRpc("hardware_service_update_checklist", { p_expected: version(body.expected_row_version), p_checklist: body.checklist });
    }
    if (action === "complete") {
      only(body, ["expected_row_version", "acceptance_name", "acceptance_relationship", "note"]);
      return await visitRpc("hardware_service_complete", { p_expected: version(body.expected_row_version), p_acceptance_name: text(body.acceptance_name, 120) || null, p_relationship: body.acceptance_relationship ? String(body.acceptance_relationship) : null, p_note: text(body.note, 1000) });
    }
    return send(404, { error: "not_found" });
  } catch (error) {
    if (error.statusCode && error.code) return send(error.statusCode, { error: error.code });
    if (error.statusCode === 400 || error.statusCode === 413) return send(error.statusCode, { error: "invalid_service_input" });
    const db = error.response?.data || {};
    if (/^PT(400|403|404|409)$/.test(db.code || "") && /^[a-z_]+$/.test(db.message || "")) return send(Number(db.code.slice(2)), { error: db.message });
    if (["42P01", "42883", "PGRST202", "PGRST205"].includes(db.code)) return send(503, { error: "service_unavailable" });
    return send(500, { error: "service_operation_failed" });
  }
}
module.exports = { handleHardwareServiceRequest };
