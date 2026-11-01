"use strict";
// Phase 5D customer order progress for GetOyi (local). POST /api/public/orders/progress with a scoped key holding ONLY
// "orders.public.status" (separate from the checkout, payment and catalogue keys). Off unless OFFICE_HARDWARE_ORDER_STATUS_ENABLED.
// Read-only: the database function proves ownership through the existing checkout receipt (client + guest hash + order) and
// builds a customer-safe view; this module re-applies the same allow-list so nothing else can ever leave Office.
const { json, readJsonBody } = require("./http");
const PATH = "/api/public/orders/progress";
const SCOPE = "orders.public.status";
const KINDS = new Set(["order_request", "paid_order", "under_review", "cancelled", "refunded"]);
const STAGE_KEYS = new Set(["received", "payment", "packed", "dispatched", "delivered", "installation", "completed"]);
const STATUSES = new Set(["done", "pending", "not_paid", "cancelled"]);
const NOTES = new Set(["being_arranged", "on_its_way", "being_rearranged", "requested", "in_progress"]);
const fail = (status, code) => { const e = new Error(code); e.statusCode = status; e.code = code; throw e; };
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

// The only shape that may leave Office (defence in depth over the database function).
function customerView(p) {
  if (!p || typeof p !== "object") fail(404, "order_not_found");
  return {
    order_id: str(p.order_id, 36),
    reference: str(p.reference, 16),
    kind: KINDS.has(p.kind) ? p.kind : "order_request",
    ...(p.refund && ['processed','pending','under_review'].includes(p.refund.state) ? {refund: {
      state: p.refund.state, currency: 'NGN',
      amount_kobo: p.refund.state==='processed' && int(p.refund.amount_kobo)>0 ? int(p.refund.amount_kobo) : null,
      at: iso(p.refund.at),
    }} : {}),
    created_at: iso(p.created_at),
    installation_requested: p.installation_requested === true,
    delivery_area: { state: str(p.delivery_area?.state, 60), city: str(p.delivery_area?.city, 60) },
    currency: "NGN",
    goods_total_kobo: int(p.goods_total_kobo),
    goods_tax_kobo: int(p.goods_tax_kobo),
    delivery_total_kobo: int(p.delivery_total_kobo),
    payable_total_kobo: int(p.payable_total_kobo),
    lines: (Array.isArray(p.lines) ? p.lines : []).slice(0, 50).map((l) => ({
      name: str(l.name, 200), variant: str(l.variant, 200),
      options: Object.fromEntries(Object.entries(l.options && typeof l.options === "object" ? l.options : {}).slice(0, 10).map(([k, v]) => [str(k, 40), str(String(v), 80)])),
      quantity: int(l.quantity), unit_price_kobo: int(l.unit_price_kobo), gross_kobo: int(l.gross_kobo),
    })),
    stages: (Array.isArray(p.stages) ? p.stages : []).filter((s) => STAGE_KEYS.has(s.key)).map((s) => ({
      key: s.key, status: STATUSES.has(s.status) ? s.status : "pending", at: iso(s.at), note: NOTES.has(s.note) ? s.note : null,
    })),
    current_stage: STAGE_KEYS.has(p.current_stage) ? p.current_stage : "received",
  };
}

async function handleHardwareOrderProgressRequest({ req, res, pathname, authContext, store }) {
  if (pathname !== PATH) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const send = (status, value) => { json(res, status, value); return true; };
  try {
    if (authContext?.type !== "scoped_api_key" || !(authContext.scopes || []).includes(SCOPE)) fail(403, "forbidden");
    if (process.env.OFFICE_HARDWARE_ORDER_STATUS_ENABLED !== "true" || process.env.OFFICE_HARDWARE_ORDERS_ENABLED !== "true" || !store.client) fail(503, "order_status_disabled");
    if (req.method !== "POST") fail(405, "method_not_allowed");
    const b = await readJsonBody(req, 2048);
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => !["guest_hash", "id"].includes(k))) fail(400, "invalid_progress_request");
    if (!/^[0-9a-f]{64}$/.test(b.guest_hash || "") || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.id || "")) fail(400, "invalid_progress_request");
    const r = await store.client.post("/rpc/hardware_order_public_progress", { p_client: authContext.client, p_guest_hash: b.guest_hash, p_order: b.id });
    return send(200, { progress: customerView(r.data) });
  } catch (e) {
    if (e.statusCode && e.code) return send(e.statusCode, { error: e.code });
    if ([400, 413].includes(e.statusCode)) return send(e.statusCode, { error: "invalid_progress_request" });
    const d = e.response?.data || {};
    if (d.code === "PT404") return send(404, { error: "order_not_found" });
    if (d.code === "PT400") return send(400, { error: "invalid_progress_request" });
    if (["42883", "PGRST202"].includes(d.code)) return send(503, { error: "order_status_unavailable" });
    return send(503, { error: "order_status_unavailable" });
  }
}
module.exports = { handleHardwareOrderProgressRequest, customerView, ORDER_PROGRESS_PATH: PATH, ORDER_PROGRESS_SCOPE: SCOPE };
