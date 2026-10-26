"use strict";
// Stage 4A staff-only foundation. No guest route, provider call or payment transition exists.
const { json, readJsonBody } = require("./http");
const { hasPermission } = require("./permissions");
const { appendAuditRecord } = require("./audit");
const PREFIX = "/api/lead-agents/admin/hardware-orders";
const PUBLIC_COLUMNS = "id,currency,goods_total_kobo,goods_tax_kobo,delivery_total_kobo,payable_total_kobo,delivery_state,installation_requested,order_state,payment_state,fulfilment_state,reservation_state,row_version,created_at,updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, code) => { const e = new Error(code); e.statusCode = status; e.code = code; throw e; };
function need(auth, permission) {
  if (!auth) fail(401, "unauthorized");
  if (auth.type !== "session") fail(403, "orders_require_staff_session");
  if (!hasPermission(auth, permission)) fail(403, "forbidden");
}
function only(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) fail(400, "invalid_order_input");
}
async function handleHardwareOrdersRequest({ req, res, pathname, authContext, store, config = {} }) {
  if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const send = (status, body) => { json(res, status, body); return true; };
  try {
    need(authContext, "commerce.orders.read");
    if (process.env.OFFICE_HARDWARE_ORDERS_ENABLED !== "true") return send(503, { error: "orders_disabled" });
    if (!["GET", "HEAD"].includes(req.method)) {
      const expectedOrigin = config.officeAppUrl || (process.env.NODE_ENV !== "production" ? `http://${req.headers.host}` : "");
      if (!expectedOrigin || req.headers.origin !== expectedOrigin) fail(403, "origin_not_allowed");
    }
    // Durable Postgres only: do not silently fall back to a process-local order ledger.
    if (!store.client) return send(503, { error: "orders_unavailable" });
    const actor = String(authContext.email || "").trim().toLowerCase();
    const url = new URL(req.url, "http://office.invalid");
    const sub = pathname.slice(PREFIX.length);
    if (!sub && req.method === "POST") {
      need(authContext, "commerce.orders.create"); need(authContext, "crm.read");
      const body = await readJsonBody(req, 32 * 1024);
      only(body, ["idempotency_key", "order"]);
      if (typeof body.idempotency_key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotency_key) || !body.order || typeof body.order !== "object" || Array.isArray(body.order)) fail(400, "invalid_order_input");
      const r = await store.client.post("/rpc/hardware_order_create", { p_actor: actor, p_key: body.idempotency_key, p_request: body.order });
      return send(r.data.replayed ? 200 : 201, { order: r.data });
    }
    if (!sub && req.method === "GET") {
      const raw = url.searchParams.get("offset") || "0";
      if (!/^\d{1,5}$/.test(raw) || Number(raw) > 10000) fail(400, "invalid_pagination");
      const r = await store.client.get(`/hardware_orders?select=${PUBLIC_COLUMNS}&order=created_at.desc,id.desc&limit=50&offset=${Number(raw)}`);
      return send(200, { orders: r.data });
    }
    const parts = sub.split("/").filter(Boolean);
    if (!UUID.test(parts[0] || "")) fail(404, "not_found");
    const id = parts[0];
    if (parts.length === 2 && parts[1] === "cancel" && req.method === "POST") {
      need(authContext, "commerce.orders.cancel");
      const body = await readJsonBody(req, 1024); only(body, ["expected_row_version"]);
      if (!Number.isSafeInteger(body.expected_row_version) || body.expected_row_version < 1) fail(400, "invalid_order_input");
      const r = await store.client.post("/rpc/hardware_order_cancel", { p_actor: actor, p_id: id, p_expected: body.expected_row_version });
      return send(200, { order: r.data });
    }
    if (parts.length === 1 && req.method === "GET") {
      const sensitive = url.searchParams.get("customer") === "true";
      if (sensitive) { need(authContext, "commerce.orders.customer.read"); need(authContext, "crm.read"); }
      const r = await store.client.get(`/hardware_orders?id=eq.${id}&select=${PUBLIC_COLUMNS}${sensitive ? ",contact_id,organization_id,opportunity_id" : ""}`);
      if (!r.data[0]) fail(404, "order_not_found");
      const [lines, events] = await Promise.all([
        store.client.get(`/hardware_order_lines?order_id=eq.${id}&order=position.asc`),
        store.client.get(`/hardware_order_events?order_id=eq.${id}&select=id,event_type,row_version,metadata,created_at&order=row_version.asc`),
      ]);
      let customer;
      if (sensitive) {
        const p = await store.client.get(`/hardware_order_private?order_id=eq.${id}&select=customer,delivery`);
        await appendAuditRecord({ store, authContext, action: "hardware_order_customer_viewed", resourceType: "hardware_order", resourceId: id, metadata: {}, req });
        customer = p.data[0];
      }
      return send(200, { order: r.data[0], lines: lines.data, events: events.data, ...(customer ? { private: customer } : {}), payment_eligible: false });
    }
    return send(405, { error: "method_not_allowed" });
  } catch (error) {
    if (error.statusCode && error.code) return send(error.statusCode, { error: error.code });
    if (error.statusCode === 400 || error.statusCode === 413) return send(error.statusCode, { error: "invalid_order_input" });
    const db = error.response?.data || {};
    if (/^PT(400|403|404|409)$/.test(db.code || "") && /^[a-z_]+$/.test(db.message || "")) return send(Number(db.code.slice(2)), { error: db.message });
    if (["42P01", "42883", "PGRST202", "PGRST205"].includes(db.code)) return send(503, { error: "orders_unavailable" });
    // Never expose SQL messages, customer data or request bodies in responses or logs.
    return send(500, { error: "order_operation_failed" });
  }
}
module.exports = { handleHardwareOrdersRequest };
