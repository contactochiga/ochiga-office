import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../oyi-phase4e/package.json", import.meta.url),
);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<main></main>");
globalThis.document = dom.window.document;
const { renderHardwareFinancial } =
  await import("../public/office/catalogue/hardware-financial.mjs");
let writes = [];
const order = {
  id: "synthetic-order",
  payment_state: "paid",
  payable_total_kobo: 10000,
  financial_state: "refund_pending",
  history: [
    {
      created_at: "LOCAL",
      event_type: "reconciliation_note",
      detail: { note: "<script>unsafe</script>" },
    },
  ],
};
const ui = {
  state: { renderToken: 1 },
  hasPermission: () => true,
  el: (html) => {
    const t = document.createElement("template");
    t.innerHTML = html;
    return t.content.firstElementChild;
  },
  escapeHtml: (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;"),
  api: async (_, opts) => {
    if (opts) {
      writes.push(opts.body);
      return {};
    }
    return { orders: [order] };
  },
};
await renderHardwareFinancial(document.querySelector("main"), 1, ui);
assert(!document.querySelector("script"));
assert(document.body.textContent.includes("Bank") === false);
assert(document.body.textContent.includes("does not change payment state"));
const input = document.querySelector("input");
input.value = "LOCAL refund review";
document.querySelector("button").click();
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(writes[0], {
  action: "request",
  id: "synthetic-order",
  reason: "LOCAL refund review",
});
assert(!("amount_kobo" in writes[0]));
ui.hasPermission = () => false;
await renderHardwareFinancial(document.querySelector("main"), 1, ui);
assert.equal(document.querySelectorAll("button").length, 0);
console.log(
  "6 Office financial DOM escaping/action/permission assertions PASS",
);
