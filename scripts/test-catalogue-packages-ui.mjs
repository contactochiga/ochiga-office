// Solutions & Packages (SP2) screen checks (jsdom, fake API): escaping, permissions, readiness and margin display, request bodies,
// server refusals shown with their labels. The real UI-independent API <-> database path is scripts/package-scenarios.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../oyi-phase4e/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<main></main>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const m = await import("../public/office/catalogue/packages.mjs");
let n = 0; const ok = (c, name) => { assert.ok(c, name); n++; console.log("PASS " + name); };
const PID = "11111111-1111-4111-8111-111111111111", VID = "22222222-2222-4222-8222-222222222222";
const XSS = "<img src=x onerror=alert(1)>";
const card = { id: PID, slug: "oyi-smart-living", name: `Oyi Smart Living ${XSS}`, status: "draft", kind: "package", skus: ["SL-APT"] };
const options = [
  { id: "a", name: "Gateway", status: "published", kind: "product", skus: ["GW-1"] },
  { id: "b", name: "Draft lock", status: "draft", kind: "product", skus: ["LK-DRAFT"] },
  { id: "c", name: "Other package", status: "published", kind: "package", skus: ["PK-X"] },
  { id: "d", name: "Installation per door", status: "published", kind: "service", skus: ["SV-1"] },
];
const content = {
  category_id: "cat", brand_id: null, name: `Oyi Smart Living ${XSS}`, model: "", summary: "", description: "", specifications: [], compatibility: { facility: true, experience: true }, media: [], documents: [],
  variants: [{ sku: "SL-APT", name: "Apartment", options: {}, pricing: "fixed" }, { sku: "SL-CUSTOM", name: "Custom", options: {}, pricing: "consultation" }],
  package: { solution_types: ["residential"], scope: { hardware: "Gateway and locks", software_deployment: "By consultation", installation: "quoted_separately", installation_note: "" }, configuration: { custom: true, per_unit_label: "per door" },
    components: [{ sku: "GW-1", role: "required", basis: "fixed", quantity: 1, quantities: {}, note: "", snapshot: { product_version: 1, price_kobo: 9000000 } }] },
};
const readiness = (withCost) => ({
  ready: false, availability: "available_to_order",
  issues: [{ code: "component_changed", sku: "GW-1", label: "A component changed since this version was saved (needs re-review: save again to take the current details)" }],
  warnings: [{ code: "required_component_not_in_stock", sku: "GW-1" }],
  components: [{ sku: "GW-1", role: "required", kind: "product", name: "Gateway", availability: "available_to_order", changed: true, quantities: {} }],
  sizes: [
    { sku: "SL-APT", name: "Apartment", pricing: "fixed", price_kobo: 29000000, required_components_price_kobo: 9000000, ...(withCost ? { required_components_cost_kobo: 6000000, margin_kobo: 23000000 } : {}) },
    { sku: "SL-CUSTOM", name: "Custom", pricing: "consultation", price_kobo: null, required_components_price_kobo: 9000000, ...(withCost ? { required_components_cost_kobo: 6000000, margin_kobo: null } : {}) },
  ],
});
const detail = (over = {}) => ({
  product: { id: PID, slug: "oyi-smart-living", row_version: 4, current_version: 2, published_version: null, workflow_status: "draft", publication_status: "never_published" },
  status: "draft", kind: "package", content: structuredClone(content), variants: [{ id: VID, sku: "SL-APT", price_ngn_kobo: 29000000 }, { id: "v2", sku: "SL-CUSTOM", price_ngn_kobo: null }],
  media_library: { available: true, items: [] }, public: { available: true, listing: null, effective: "not_public", requirements: [] },
  permissions: { write: true, review: false, publish: false, publicPublish: false }, package_readiness: readiness(false), ...over,
});
function makeUi(perms, routes) {
  const writes = [], navigations = [], toasts = [];
  return {
    writes, navigations, toasts, state: { renderToken: 1 }, hasPermission: (p) => perms.includes(p),
    el: (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstElementChild; },
    escapeHtml: (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    emptyPanel: (t) => { const d = document.createElement("p"); d.textContent = t; return d; },
    navigate: (to) => navigations.push(to), toast: (t) => toasts.push(t), openDialog: () => {},
    api: async (p, o) => {
      if (o && o.method) { writes.push({ p, ...o }); const r = routes(p, o); if (r instanceof Error) throw r; return r || { product: { id: PID } }; }
      const r = routes(p); if (r instanceof Error) throw r; return r;
    },
  };
}
const routes = (d) => (p) => {
  if (p.includes("kind=package")) return { products: [card] };
  if (p.includes("kind=service")) return { products: [options[3]] };
  if (p.includes("kind=all")) return { products: options };
  if (p.endsWith("/categories")) return { categories: [{ id: "cat", name: "Packages", status: "active" }] };
  if (p.includes(`/products/${PID}`)) return d;
  return {};
};
const fresh = () => { const h = document.createElement("main"); document.body.appendChild(h); return h; };

// list + editor, writer
let ui = makeUi(["catalogue.read", "catalogue.write"], routes(detail())), h = fresh();
await m.renderPackages(h, 1, ui, PID);
ok(!h.querySelector("img[onerror]") && h.textContent.includes(XSS), "package names are escaped in the list and the editor (no injected element)");
ok(h.querySelector("[data-new-package]") && h.querySelector("[data-new-service]") && h.querySelector("[data-service-row]"), "writer sees New package / New service; services are listed for editing in Products");
const pickOptions = [...h.querySelectorAll("[data-pick] option")].map((o) => o.value).filter(Boolean);
ok(pickOptions.includes("GW-1") && pickOptions.includes("SV-1") && !pickOptions.includes("LK-DRAFT") && !pickOptions.includes("PK-X"), "component picker offers only internally published products and services (never drafts or other packages)");
ok(h.querySelector("[data-issues]").textContent.includes("needs re-review") && h.querySelector("[data-component-row='GW-1']").textContent.includes("needs re-review") && h.querySelector("[data-warnings]"), "readiness shows the server's issues with labels, flags changed components and lists warnings");
ok(!h.querySelector("[data-size-table]").textContent.includes("Margin") && h.querySelector("[data-size-table]").textContent.includes("By consultation") && h.querySelector("[data-size-table]").textContent.includes("₦290,000"), "without cost access: no cost or margin columns; consultation sizes say By consultation; fixed sizes show the approved price");
ok(h.querySelector("[data-action='submit']") && !h.querySelector("[data-action='approve']") && !h.querySelector("[data-action='release']"), "writer: Save and Submit, but no Approve or Release");
// edit + save: per-size quantity, role and the PATCH body
const row = h.querySelector("[data-component-row='GW-1']");
row.querySelector("[data-role]").value = "optional"; row.querySelector("[data-role]").dispatchEvent(new window.Event("change"));
const qty = row.querySelector("[data-size-quantity='SL-APT']"); qty.value = "2"; qty.dispatchEvent(new window.Event("input"));
h.querySelector("[data-action='save']").click();
await new Promise((r) => setTimeout(r, 0));
const save = ui.writes.find((w) => w.method === "PATCH");
ok(save && save.p.endsWith(`/products/${PID}`) && save.body.expected_row_version === 4 && save.body.content.package.components[0].role === "optional" && save.body.content.package.components[0].quantities["SL-APT"] === 2
  && save.body.content.variants.find((v) => v.sku === "SL-CUSTOM").pricing === "consultation", "save sends a new version (PATCH with expected_row_version) carrying roles, per-size quantities and size pricing");

// cost holder sees margin
ui = makeUi(["catalogue.read", "catalogue.cost.read"], routes(detail({ package_readiness: readiness(true), permissions: { write: false } }))); h = fresh();
await m.renderPackages(h, 1, ui, PID);
ok(h.querySelector("[data-size-table]").textContent.includes("Margin") && h.querySelector("[data-size-table]").textContent.includes("₦230,000") && !h.querySelector("[data-action='save']"), "cost holder sees component cost and margin; a read-only user gets no Save");

// reviewer on an in-review package: Approve / Request changes; a server refusal is shown with its labels
const inReview = detail({ product: { ...detail().product, workflow_status: "in_review" }, permissions: { write: false, review: true } });
ui = makeUi(["catalogue.read", "catalogue.review"], (p, o) => {
  if (o && p.endsWith("/approve")) { const e = new Error("package_components_invalid"); e.data = { current: { issues: [{ code: "component_discontinued", sku: "GW-1", label: "A required component is discontinued" }] } }; return e; }
  return routes(inReview)(p);
}); h = fresh();
await m.renderPackages(h, 1, ui, PID);
ok(h.querySelector("[data-action='approve']") && h.querySelector("[data-action='request-changes']") && !h.querySelector("[data-action='submit']"), "reviewer: Approve and Request changes on an in-review package");
h.querySelector("[data-action='approve']").click();
await new Promise((r) => setTimeout(r, 0));
ok(h.querySelector("[data-msg]").textContent.includes("A required component is discontinued (GW-1)"), "a 409 package_components_invalid refusal is shown with the server's label and SKU");

// new package: POST kind package
ui = makeUi(["catalogue.read", "catalogue.write"], routes(detail())); h = fresh();
await m.renderPackages(h, 1, ui, "new");
const slug = h.querySelector("[data-field='slug']"); slug.value = "oyi-intelligent-security"; slug.dispatchEvent(new window.Event("input"));
const name = h.querySelector("[data-field='name']"); name.value = "Oyi Intelligent Security"; name.dispatchEvent(new window.Event("input"));
h.querySelector("[data-action='save']").click();
await new Promise((r) => setTimeout(r, 0));
const create = ui.writes.find((w) => w.method === "POST");
ok(create && create.p.endsWith("/products") && create.body.kind === "package" && create.body.slug === "oyi-intelligent-security" && create.body.content.package.scope.installation === "quoted_separately", "new package: POST /products with kind package; installation defaults to quoted separately");

// read-only staff cannot open the new-package editor
ui = makeUi(["catalogue.read"], routes(detail())); h = fresh();
await m.renderPackages(h, 1, ui, "new");
ok(!h.querySelector("[data-new-package]") && !h.querySelector("[data-action='save']") && h.textContent.includes("catalogue.write"), "without catalogue.write: no New package button and no editor");

// A second catalogue page must be available in the component picker (API page size is capped at 100).
ui = makeUi(["catalogue.read","catalogue.write"], (p) => {
  if (p.includes("kind=all")) return p.includes("page=2")
    ? {products:[{...options[0],id:"late",name:"Late approved component",skus:["LATE-1"]}],pages:2}
    : {products:options,pages:2};
  return routes(detail())(p);
}); h=fresh(); await m.renderPackages(h,1,ui,PID);
ok([...h.querySelectorAll("[data-pick] option")].some(o=>o.value==="LATE-1"),"component selection follows server pagination instead of silently truncating at 100 products");

console.log(JSON.stringify({ suite: "catalogue-packages-ui", passed: n }));
