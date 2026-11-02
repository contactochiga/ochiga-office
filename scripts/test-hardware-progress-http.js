"use strict";
// Phase 5D order-progress route boundary with a fake store: flag, scope, method, input validation, no enumeration, safe errors and
// the route's own allow-list (fields a database row might carry never leave Office).
const assert = require("assert/strict"), http = require("http");
const { handleHardwareOrderProgressRequest: handler } = require("../src/lead-agents/hardware-order-progress-api");
let n = 0; const ok = (c, name) => { assert.ok(c, name); n++; console.log("PASS " + name); };
const ID = "66666666-6666-4666-8666-666666666666", G = "a".repeat(64);
(async () => {
  let reply = null, dbError = null; const calls = [];
  const store = { client: { post: async (p, b) => { calls.push([p, b]); if (dbError) { const e = new Error("db"); e.response = { data: dbError }; throw e; } return { data: reply }; } } };
  const server = http.createServer(async (req, res) => {
    const scopes = (req.headers["x-test-scopes"] || "").split(",").filter(Boolean);
    const authContext = req.headers["x-test-auth"] === "session" ? { type: "session", role: "super_admin" } : { type: "scoped_api_key", client: "getoyi", scopes };
    if (!(await handler({ req, res, pathname: new URL(req.url, "http://x").pathname, authContext, store }))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/public/orders/progress`;
  const call = async (body, { scopes = "orders.public.status", method = "POST", auth } = {}) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json", "x-test-scopes": scopes, ...(auth ? { "x-test-auth": auth } : {}) }, body: method === "POST" ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    delete process.env.OFFICE_HARDWARE_ORDER_STATUS_ENABLED; process.env.OFFICE_HARDWARE_ORDERS_ENABLED = "true";
    ok((await call({ guest_hash: G, id: ID })).body.error === "order_status_disabled", "off by default");
    process.env.OFFICE_HARDWARE_ORDER_STATUS_ENABLED = "true";
    ok((await call({ guest_hash: G, id: ID }, { scopes: "commerce.checkout.submit" })).status === 403 && (await call({ guest_hash: G, id: ID }, { scopes: "catalogue.public.read" })).status === 403, "checkout and catalogue keys refused");
    ok((await call({ guest_hash: G, id: ID }, { auth: "session" })).status === 403, "staff sessions refused (website key only)");
    ok((await call(null, { method: "GET" })).status === 405, "only POST");
    ok((await call({ guest_hash: G, id: ID, all: true })).status === 400 && (await call({ guest_hash: "x", id: ID })).status === 400 && (await call({ guest_hash: G, id: "1" })).status === 400, "unknown fields and malformed input refused before the database");
    reply = { order_id: ID, reference: "HW-66666666", kind: "paid_order", created_at: "2026-10-29T10:00:00Z", installation_requested: true, delivery_area: { state: "Lagos", city: "Ikeja", address: "SECRET street", phone: "SECRET" },
      goods_total_kobo: 100, goods_tax_kobo: 7, delivery_total_kobo: null, payable_total_kobo: null, technician: "tech@x.test", guest_hash: G,
      lines: [{ name: "Lock", variant: "Std", options: { colour: "Black" }, quantity: 1, unit_price_kobo: 100, gross_kobo: 100, sku: "SECRET-SKU", cost_kobo: 5 }],
      stages: [{ key: "received", status: "done", at: "2026-10-29T10:00:00Z", note: null, actor: "staff@x.test" }, { key: "installation", status: "pending", at: null, note: "scheduled for 10:00 by tech@x.test" }, { key: "secret_stage", status: "done", at: null }], current_stage: "installation" };
    const r = await call({ guest_hash: G, id: ID });
    const t = JSON.stringify(r.body);
    ok(r.status === 200 && calls.at(-1)[1].p_client === "getoyi" && calls.at(-1)[1].p_guest_hash === G, "ownership is checked by the database with the key's client and the guest hash");
    ok(!/SECRET|tech@x|staff@x|guest_hash|cost_kobo|"sku"|address|phone|secret_stage|10:00 by/.test(t), "route allow-list strips anything else a row might carry");
    ok(r.body.progress.stages.find((s) => s.key === "installation").note === null, "free-text notes never pass; only known note codes");
    reply={...reply,kind:'refunded',refund:{state:'processed',amount_kobo:10000,currency:'NGN',at:'2026-11-01T12:00:00Z',refund_id:'SECRET',approved_by:'SECRET',reason:'SECRET'}};
    const refunded=await call({guest_hash:G,id:ID});
    ok(refunded.body.progress.kind==='refunded'&&refunded.body.progress.refund.amount_kobo===10000&&!JSON.stringify(refunded.body).includes('SECRET'),'verified refund safe projection strips provider/staff details');
    reply.refund={state:'pending',amount_kobo:10000};const pending=await call({guest_hash:G,id:ID});
    ok(pending.body.progress.refund.amount_kobo===null,'pending refund exposes no returned amount');
    dbError = { code: "PT404", message: "order_not_found" };
    ok((await call({ guest_hash: G, id: ID })).status === 404, "unknown or not-yours order: the same 404");
    dbError = { code: "XX000", message: "internal detail" };
    const hidden = await call({ guest_hash: G, id: ID });
    ok(hidden.status === 503 && !JSON.stringify(hidden.body).includes("internal"), "unexpected errors are not leaked");
    console.log(JSON.stringify({ suite: "hardware-progress-http", passed: n }));
  } finally { server.close(); }
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
