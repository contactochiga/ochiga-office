"use strict";
// Phase 5A fulfilment API boundary: flag, staff session, scopes, origin, input validation, error mapping and
// lifecycle projection. The store is a fake; the database functions are exercised by test-hardware-fulfilment-cases.js.
const assert = require("assert/strict"), http = require("http");
const { handleHardwareFulfilmentRequest: handler, nextStates } = require("../src/lead-agents/hardware-fulfilment-api");
const ORDER = "11111111-1111-4111-8111-111111111111", ORDER2 = "22222222-2222-4222-8222-222222222222";
let results = 0, calls = [];
const ok = (cond, name) => { assert.ok(cond, name); results++; console.log("PASS " + name); };
(async () => {
  let dbError = null;
  const store = { client: {
    get: async (p) => {
      calls.push(["GET", p]);
      if (p.startsWith("/hardware_orders?payment_state=eq.paid")) return { data: [{ id: ORDER, installation_requested: false, payment_state: "paid", reservation_state: "allocated" }, { id: ORDER2, installation_requested: true, payment_state: "paid", reservation_state: "allocated" }] };
      if (p.startsWith("/hardware_fulfilments?order_id=in.")) return { data: [{ order_id: ORDER2, state: "delivered", installation_required: true, row_version: 3 }] };
      if (p.startsWith(`/hardware_orders?id=eq.${ORDER}`)) return { data: [{ id: ORDER, installation_requested: false, payment_state: "paid", reservation_state: "allocated" }] };
      if (p.startsWith("/hardware_orders?id=eq.")) return { data: [] };
      if (p.startsWith("/hardware_fulfilment_settings")) return { data: [] };
      return { data: [] };
    },
    post: async (p, body) => {
      calls.push(["POST", p, body]);
      if (dbError) { const e = new Error("db"); e.response = { data: dbError }; throw e; }
      return { data: { ok: true } };
    },
  } };
  const server = http.createServer(async (req, res) => {
    const scopes = (req.headers["x-test-scopes"] || "").split(",").filter(Boolean);
    const authContext = req.headers["x-test-auth"] === "key" ? { type: "scoped_api_key", scopes: ["commerce.orders.read"] }
      : req.headers["x-test-auth"] === "none" ? null
      : { type: "session", role: "ochiga_staff", email: "Staff@Fixture.test", permissionScopes: scopes, permission_scopes: scopes };
    const handled = await handler({ req, res, pathname: new URL(req.url, "http://x").pathname, authContext, store, config: { officeAppUrl: "https://office.example.invalid" } });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/lead-agents/admin/hardware-fulfilment`;
  const call = async (method, p, { scopes = "commerce.orders.read", body, origin = "https://office.example.invalid", auth } = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-scopes": scopes, ...(origin ? { origin } : {}), ...(auth ? { "x-test-auth": auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const MANAGE = "commerce.orders.read,commerce.orders.fulfilment.manage", CONFIGURE = "commerce.orders.read,commerce.orders.fulfilment.configure";
  try {
    delete process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED;
    ok((await call("GET", "")).status === 503, "flag off: fulfilment disabled (503)");
    process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED = "true";
    ok((await call("GET", "", { auth: "none" })).status === 401, "no session: 401");
    ok((await call("GET", "", { auth: "key" })).body.error === "fulfilment_requires_staff_session", "API key cannot use fulfilment");
    ok((await call("GET", "", { scopes: "" })).status === 403, "without commerce.orders.read: 403");
    const list = await call("GET", "");
    ok(list.status === 200 && list.body.orders.length === 2, "list returns paid, allocated orders");
    ok(list.body.orders[0].lifecycle.state === "paid" && list.body.orders[0].lifecycle.next.join() === "packed", "order without lifecycle row is 'paid' and can be packed");
    ok(list.body.orders[1].lifecycle.state === "delivered" && list.body.orders[1].lifecycle.next.join() === "installed", "installation order at delivered can only be installed");
    ok((await call("GET", "?state=delivered")).body.orders.length === 1, "state filter");
    ok((await call("GET", "?state=shipped")).status === 400, "unknown state filter refused");
    ok((await call("GET", "?offset=99999")).status === 400, "pagination bound");
    const detail = await call("GET", "/" + ORDER);
    ok(detail.status === 200 && detail.body.lifecycle.state === "paid", "detail shows lifecycle");
    ok((await call("GET", "/" + ORDER2.replace("2222-4", "3333-4"))).status === 404, "unknown order 404");
    ok((await call("GET", "/not-a-uuid")).status === 404, "malformed id 404");
    const t = { expected_row_version: 0, to: "packed", reason: "" };
    ok((await call("POST", `/${ORDER}/transition`, { body: t })).status === 403, "transition needs fulfilment.manage");
    ok((await call("POST", `/${ORDER}/transition`, { body: t, scopes: MANAGE, origin: "https://evil.example" })).body.error === "origin_not_allowed", "cross-origin write refused");
    ok((await call("POST", `/${ORDER}/transition`, { body: t, scopes: MANAGE, origin: null })).body.error === "origin_not_allowed", "write without origin refused");
    ok((await call("POST", `/${ORDER}/transition`, { body: { ...t, to: "paid" }, scopes: MANAGE })).status === 400, "cannot transition to paid");
    ok((await call("POST", `/${ORDER}/transition`, { body: { ...t, payment_state: "paid" }, scopes: MANAGE })).status === 400, "unknown fields refused (no payment_state)");
    ok((await call("POST", `/${ORDER}/transition`, { body: { ...t, expected_row_version: -1 }, scopes: MANAGE })).status === 400, "negative version refused");
    calls = [];
    const done = await call("POST", `/${ORDER}/transition`, { body: t, scopes: MANAGE });
    const rpc = calls.find((c) => c[0] === "POST");
    ok(done.status === 200 && rpc[1] === "/rpc/hardware_fulfilment_transition" && rpc[2].p_actor === "staff@fixture.test" && rpc[2].p_expected === 0 && rpc[2].p_to === "packed", "transition calls the database function with the normalized actor");
    dbError = { code: "PT409", message: "invalid_fulfilment_transition" };
    ok((await call("POST", `/${ORDER}/transition`, { body: t, scopes: MANAGE })).body.error === "invalid_fulfilment_transition", "database refusal mapped to a safe code (409)");
    dbError = { code: "XX000", message: "secret detail" };
    const leak = await call("POST", `/${ORDER}/transition`, { body: t, scopes: MANAGE });
    ok(leak.status === 500 && leak.body.error === "fulfilment_operation_failed" && !JSON.stringify(leak.body).includes("secret"), "unexpected errors never leak detail");
    dbError = null;
    ok((await call("POST", `/${ORDER}/assign`, { body: { role: "technician", expected_sequence: 0, assignee: "t@fixture.test" } })).status === 403, "assign needs fulfilment.manage");
    ok((await call("POST", `/${ORDER}/assign`, { body: { role: "owner", expected_sequence: 0, assignee: "t@fixture.test" }, scopes: MANAGE })).status === 400, "unknown assignment role refused");
    ok((await call("POST", `/${ORDER}/assign`, { body: { role: "delivery", expected_sequence: 0, assignee: null }, scopes: MANAGE })).status === 200, "unassign allowed");
    const settings = await call("GET", "/settings");
    ok(settings.status === 200 && settings.body.applied_to_pricing === false && settings.body.public_booking === false && settings.body.settings.delivery_fees.version === 0, "settings readable; not applied to pricing; no public booking");
    const s = { expected_version: 0, value: { currency: "NGN", zones: [] }, reason: "Local configuration test" };
    ok((await call("PUT", "/settings/delivery_fees", { body: s, scopes: MANAGE })).status === 403, "settings need fulfilment.configure");
    ok((await call("PUT", "/settings/prices", { body: s, scopes: CONFIGURE })).status === 404, "unknown setting 404");
    ok((await call("PUT", "/settings/delivery_fees", { body: { ...s, value: [] }, scopes: CONFIGURE })).status === 400, "array value refused");
    ok((await call("PUT", "/settings/delivery_fees", { body: s, scopes: CONFIGURE })).status === 200, "configure allowed with fulfilment.configure");
    ok((await call("DELETE", "/" + ORDER, { scopes: MANAGE })).status === 405, "unsupported method 405");
    ok(nextStates("delivered", false).join() === "closed" && nextStates("delivered", true).join() === "installed" && nextStates("closed", true).length === 0, "UI transition map mirrors the database rule");
    console.log(JSON.stringify({ suite: "hardware-fulfilment-http", passed: results, failed: 0 }));
  } catch (e) {
    console.error("FAIL", e.message); process.exitCode = 1;
  } finally { server.close(); }
})();
