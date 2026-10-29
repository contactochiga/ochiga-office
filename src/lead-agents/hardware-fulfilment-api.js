"use strict";
// Phase 5A staff-only post-payment fulfilment lifecycle (local). No guest route, payment transition, inventory change or
// public booking exists here; every write is a SECURITY INVOKER database function that re-checks the actor's scope.
const { json, readJsonBody } = require("./http");
const { hasPermission } = require("./permissions");
const PREFIX = "/api/lead-agents/admin/hardware-fulfilment";
const ORDER_COLUMNS = "id,currency,payable_total_kobo,installation_requested,order_state,payment_state,fulfilment_state,reservation_state,created_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ["paid", "packed", "dispatched", "delivered", "installed", "closed"];
const BASE_SETTINGS = ["delivery_fees", "installation_fees", "coverage_areas"];
// Phase 5C adds two Office-managed keys, offered only when service visits are enabled (the 5C migration accepts them).
const settingKeys = () => (process.env.OFFICE_HARDWARE_SERVICE_ENABLED === "true" ? [...BASE_SETTINGS, "inspection_fees", "installation_checklist"] : BASE_SETTINGS);
const ROLES = ["fulfilment", "delivery", "technician"];
const fail = (status, code) => { const e = new Error(code); e.statusCode = status; e.code = code; throw e; };
function need(auth, permission) {
  if (!auth) fail(401, "unauthorized");
  if (auth.type !== "session") fail(403, "fulfilment_requires_staff_session");
  if (!hasPermission(auth, permission)) fail(403, "forbidden");
}
function only(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !keys.includes(k))) fail(400, "invalid_fulfilment_input");
}
// Mirrors hardware_fulfilment_next_allowed (the database is the authority; this only drives the UI).
function nextStates(state, installation) {
  return { paid: ["packed"], packed: ["dispatched"], dispatched: ["delivered"], delivered: [installation ? "installed" : "closed"], installed: ["closed"], closed: [] }[state] || [];
}
function lifecycle(order, f) {
  const installation = f ? f.installation_required : order.installation_requested;
  const state = f ? f.state : "paid";
  return { state, row_version: f ? f.row_version : 0, installation_required: installation, next: nextStates(state, installation) };
}
async function handleHardwareFulfilmentRequest({ req, res, pathname, authContext, store, config = {} }) {
  if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const send = (status, body) => { json(res, status, body); return true; };
  try {
    need(authContext, "commerce.orders.read");
    if (process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED !== "true") return send(503, { error: "fulfilment_disabled" });
    if (!["GET", "HEAD"].includes(req.method)) {
      const expectedOrigin = config.officeAppUrl || (process.env.NODE_ENV !== "production" ? `http://${req.headers.host}` : "");
      if (!expectedOrigin || req.headers.origin !== expectedOrigin) fail(403, "origin_not_allowed");
    }
    if (!store.client) return send(503, { error: "fulfilment_unavailable" });
    const actor = String(authContext.email || "").trim().toLowerCase();
    const url = new URL(req.url, "http://office.invalid");
    const parts = pathname.slice(PREFIX.length).split("/").filter(Boolean);

    if (parts[0] === "settings") {
      const SETTINGS = settingKeys();
      if (parts.length === 1 && req.method === "GET") {
        const rows = await Promise.all(SETTINGS.map((k) => store.client.get(`/hardware_fulfilment_settings?setting_key=eq.${k}&select=setting_key,version,value,actor,created_at&order=version.desc&limit=1`)));
        return send(200, { settings: Object.fromEntries(SETTINGS.map((k, i) => [k, rows[i].data[0] || { setting_key: k, version: 0, value: null }])), applied_to_pricing: false, public_booking: false });
      }
      if (parts.length === 2 && req.method === "PUT") {
        need(authContext, "commerce.orders.fulfilment.configure");
        if (!SETTINGS.includes(parts[1])) fail(404, "not_found");
        const body = await readJsonBody(req, 64 * 1024); only(body, ["expected_version", "value", "reason"]);
        if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || typeof body.reason !== "string" || !body.value || typeof body.value !== "object" || Array.isArray(body.value)) fail(400, "invalid_fulfilment_setting");
        const r = await store.client.post("/rpc/hardware_fulfilment_setting_set", { p_actor: actor, p_key: parts[1], p_expected_version: body.expected_version, p_value: body.value, p_reason: body.reason });
        return send(200, { setting: r.data });
      }
      return send(405, { error: "method_not_allowed" });
    }

    if (parts.length === 0 && req.method === "GET") {
      const raw = url.searchParams.get("offset") || "0";
      const want = url.searchParams.get("state");
      if (!/^\d{1,5}$/.test(raw) || Number(raw) > 10000) fail(400, "invalid_pagination");
      if (want !== null && !STATES.includes(want)) fail(400, "invalid_state_filter");
      const orders = await store.client.get(`/hardware_orders?payment_state=eq.paid&reservation_state=eq.allocated&select=${ORDER_COLUMNS}&order=created_at.desc,id.desc&limit=50&offset=${Number(raw)}`);
      const ids = orders.data.map((o) => o.id);
      const fs = ids.length ? await store.client.get(`/hardware_fulfilments?order_id=in.(${ids.join(",")})&select=order_id,state,installation_required,row_version,updated_at`) : { data: [] };
      const byId = new Map(fs.data.map((f) => [f.order_id, f]));
      const rows = orders.data.map((o) => ({ order: o, lifecycle: lifecycle(o, byId.get(o.id)) })).filter((r) => !want || r.lifecycle.state === want);
      return send(200, { orders: rows });
    }

    if (!UUID.test(parts[0] || "")) fail(404, "not_found");
    const id = parts[0];
    if (parts.length === 1 && req.method === "GET") {
      const o = await store.client.get(`/hardware_orders?id=eq.${id}&select=${ORDER_COLUMNS}`);
      if (!o.data[0]) fail(404, "order_not_found");
      const [f, events, assignments] = await Promise.all([
        store.client.get(`/hardware_fulfilments?order_id=eq.${id}&select=state,installation_required,row_version,created_at,updated_at`),
        store.client.get(`/hardware_fulfilment_events?order_id=eq.${id}&select=row_version,from_state,to_state,actor,authorization_scope,reason,created_at&order=row_version.asc`),
        store.client.get(`/hardware_fulfilment_assignments?order_id=eq.${id}&select=assignment_role,sequence,assignee,actor,reason,created_at&order=assignment_role.asc,sequence.asc`),
      ]);
      const current = {};
      for (const a of assignments.data) current[a.assignment_role] = a;
      const paidAndAllocated = o.data[0].payment_state === "paid" && o.data[0].reservation_state === "allocated";
      return send(200, { order: o.data[0], lifecycle: paidAndAllocated ? lifecycle(o.data[0], f.data[0]) : null, events: events.data, assignments: current, assignment_history: assignments.data });
    }
    if (parts.length === 2 && parts[1] === "transition" && req.method === "POST") {
      need(authContext, "commerce.orders.fulfilment.manage");
      const body = await readJsonBody(req, 2048); only(body, ["expected_row_version", "to", "reason"]);
      if (!Number.isSafeInteger(body.expected_row_version) || body.expected_row_version < 0 || !STATES.slice(1).includes(body.to) || (body.reason !== undefined && typeof body.reason !== "string")) fail(400, "invalid_fulfilment_input");
      const r = await store.client.post("/rpc/hardware_fulfilment_transition", { p_actor: actor, p_order: id, p_expected: body.expected_row_version, p_to: body.to, p_reason: body.reason || "" });
      return send(200, { lifecycle: r.data });
    }
    if (parts.length === 2 && parts[1] === "assign" && req.method === "POST") {
      need(authContext, "commerce.orders.fulfilment.manage");
      const body = await readJsonBody(req, 2048); only(body, ["role", "expected_sequence", "assignee", "reason"]);
      if (!ROLES.includes(body.role) || !Number.isSafeInteger(body.expected_sequence) || body.expected_sequence < 0 || (body.assignee !== null && typeof body.assignee !== "string") || (body.reason !== undefined && typeof body.reason !== "string")) fail(400, "invalid_fulfilment_input");
      const r = await store.client.post("/rpc/hardware_fulfilment_assign", { p_actor: actor, p_order: id, p_role: body.role, p_expected_sequence: body.expected_sequence, p_assignee: body.assignee, p_reason: body.reason || "" });
      return send(200, { assignment: r.data });
    }
    return send(405, { error: "method_not_allowed" });
  } catch (error) {
    if (error.statusCode && error.code) return send(error.statusCode, { error: error.code });
    if (error.statusCode === 400 || error.statusCode === 413) return send(error.statusCode, { error: "invalid_fulfilment_input" });
    const db = error.response?.data || {};
    if (/^PT(400|403|404|409)$/.test(db.code || "") && /^[a-z_]+$/.test(db.message || "")) return send(Number(db.code.slice(2)), { error: db.message });
    if (["42P01", "42883", "PGRST202", "PGRST205"].includes(db.code)) return send(503, { error: "fulfilment_unavailable" });
    return send(500, { error: "fulfilment_operation_failed" });
  }
}
module.exports = { handleHardwareFulfilmentRequest, nextStates };
