// Phase 5A.2 fulfilment screen unit checks (jsdom, fake API): escaping, permissions, conditional installation,
// request bodies and amount conversion. The real UI <-> API <-> database path is in test-hardware-fulfilment-cases.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../oyi-phase4e/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
globalThis.document = new JSDOM("<main></main>").window.document;
const m = await import("../public/office/catalogue/fulfilment.mjs");
let n = 0; const ok = (c, name) => { assert.ok(c, name); n++; console.log("PASS " + name); };
const ID = "33333333-3333-4333-8333-333333333333";
const detail = (over = {}) => ({
  order: { id: ID, payable_total_kobo: 10000, payment_state: "paid", reservation_state: "allocated" },
  lifecycle: { state: "delivered", row_version: 3, installation_required: false, next: ["closed"] },
  events: [{ row_version: 1, from_state: "paid", to_state: "packed", actor: "a@fixture.test", authorization_scope: "commerce.orders.fulfilment.manage", reason: "<img src=x onerror=alert(1)>", created_at: "2026-10-29T10:00:00Z" }],
  assignments: {}, assignment_history: [], ...over,
});
function makeUi(perms, routes) {
  const writes = [], dialogs = [];
  return { writes, dialogs, state: { renderToken: 1 }, hasPermission: (p) => perms.includes(p),
    el: (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstElementChild; },
    escapeHtml: (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    openDialog: (title, fields, onSubmit) => dialogs.push({ title, fields, onSubmit }),
    api: async (p, o) => { if (o) { writes.push({ p, ...o }); return {}; } const r = routes(p); if (r instanceof Error) throw r; return r; } };
}
const MANAGE = ["commerce.orders.read", "commerce.orders.fulfilment.manage"];
const fresh = () => { const h = document.createElement("main"); document.body.appendChild(h); return h; };

let ui = makeUi(MANAGE, () => detail()), h = fresh();
await m.renderDetail(h, 1, ui, ID);
ok(!h.querySelector("img") && h.textContent.includes("<img src=x onerror=alert(1)>"), "history text is escaped (no injected element)");
ok([...h.querySelectorAll("[data-transition]")].map((b) => b.dataset.transition).join() === "closed", "delivery-only order at delivered offers Close only");
ok(!h.querySelector('[data-assignment="technician"]'), "no technician row without installation");
h.querySelector('[data-transition="closed"]').click();
await assert.rejects(ui.dialogs[0].onSubmit({ reason: "" }), /closing reason/i); ok(ui.writes.length === 0, "close without reason sends nothing");
await ui.dialogs[0].onSubmit({ reason: "Accepted by customer" });
ok(JSON.stringify(Object.keys(ui.writes[0].body).sort()) === JSON.stringify(["expected_row_version", "reason", "to"]) && ui.writes[0].body.expected_row_version === 3 && ui.writes[0].method === "POST", "transition body carries only version, target and reason");

ui = makeUi(MANAGE, () => detail({ lifecycle: { state: "delivered", row_version: 3, installation_required: true, next: ["installed"] } })); h = fresh();
await m.renderDetail(h, 1, ui, ID);
ok([...h.querySelectorAll("[data-transition]")].map((b) => b.dataset.transition).join() === "installed" && !!h.querySelector('[data-assignment="technician"]'), "installation order offers Installed and a technician assignment");

ui = makeUi(["commerce.orders.read"], () => detail()); h = fresh();
await m.renderDetail(h, 1, ui, ID);
ok(h.querySelectorAll("button").length === 0 && !!h.querySelector("[data-readonly]"), "no controls without the fulfilment permission");

ui = makeUi(MANAGE, () => detail({ lifecycle: null, order: { id: ID, payable_total_kobo: 10000, payment_state: "not_started" } })); h = fresh();
await m.renderDetail(h, 1, ui, ID);
ok(h.querySelectorAll("[data-transition],[data-assign]").length === 0 && h.textContent.includes("Not eligible"), "unpaid order shows no fulfilment controls");

const disabled = Object.assign(new Error("fulfilment_disabled"), { data: { error: "fulfilment_disabled" } });
ui = makeUi(MANAGE, () => disabled); h = fresh();
await m.renderFulfilment(h, 1, ui);
ok(h.textContent.includes("not enabled in this environment") && h.querySelectorAll("[data-transition],[data-save]").length === 0, "disabled feature shows a notice only");

ok(m.toKobo("12.5") === 1250 && m.toKobo("0") === 0 && m.toKobo("1.234") === null && m.toKobo("-1") === null && m.toKobo("1e3") === null && m.toKobo("") === null, "naira to kobo conversion is exact and strict");
ok(m.toBasisPoints("7.5") === 750 && m.toBasisPoints("100") === 10000 && m.toBasisPoints("100.01") === null && m.toBasisPoints("abc") === null, "VAT percent to basis points is strict");
ok(Object.values(m.ERRORS).every((s) => !/PT\\d|sql|select/i.test(s)), "user messages never expose database detail");
console.log(JSON.stringify({ suite: "hardware-fulfilment-ui", passed: n, failed: 0 }));
