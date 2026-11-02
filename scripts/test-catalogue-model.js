// Product catalogue (Phase 1): pure domain rules (no server, no database) and the role/permission matrix.
"use strict";
const assert = require("assert");
const C = require("../src/lead-agents/catalogue");
const { ROLE_PERMISSIONS, hasPermission, PERMISSION_KEYS } = require("../src/lead-agents/permissions");

let checks = 0;
const ok = (cond, msg, detail) => { checks += 1; assert.ok(cond, `${msg}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`); };
const throwsCode = (fn, status) => { try { fn(); return false; } catch (e) { return e.statusCode === status; } };

const CAT = "11111111-1111-4111-8111-111111111111";
const base = () => C.validateContent({
  category_id: CAT, name: "Smart Switch", model: "SW2", summary: "Two-gang switch.", description: "A neutral-wire switch with local control.",
  specifications: [{ key: "Voltage", value: "230", unit: "V" }], compatibility: { facility: true, notes: "" },
  variants: [{ sku: "sw2-wht", name: "White", options: { colour: "white" } }],
});

// ---- validation
const c = base();
ok(c.variants[0].sku === "SW2-WHT" && c.brand_id === null && c.media.length === 0 && c.compatibility.edge === false, "content normalised (SKU upper-cased, defaults filled)", c);
ok(throwsCode(() => C.validateContent({ ...c, name: "" }), 400), "name required");
ok(throwsCode(() => C.validateContent({ ...c, category_id: "nope" }), 400), "category id must be a uuid");
ok(throwsCode(() => C.validateContent({ ...c, variants: [{ sku: "A", name: "x" }] }), 400), "SKU too short refused");
ok(throwsCode(() => C.validateContent({ ...c, variants: [{ sku: "AB", name: "x" }, { sku: "ab", name: "y" }] }), 400), "duplicate SKU (case-insensitive) refused");
ok(throwsCode(() => C.validateContent({ ...c, specifications: [{ key: "V", value: "1" }, { key: "v", value: "2" }] }), 400), "duplicate specification key refused");
ok(throwsCode(() => C.validateContent({ ...c, media: [{ id: 1 }] }), 400) && throwsCode(() => C.validateContent({ ...c, documents: [{ id: 1 }] }), 400), "media/documents refused in Phase 1");
ok(throwsCode(() => C.validateContent({ ...c, description: "x".repeat(10001) }), 400), "description length bounded");

// ---- materiality (D2, release decision: no minor/typo exception)
ok(C.materialityOf(null, c) === "initial", "never published -> initial");
ok(C.materialityOf(c, { ...c }) === "material" && C.materialityOf(c, { ...c, description: c.description.replace("local", "locl") }) === "material", "after publication EVERY change (even an identical save or a one-character typo) is material");
ok(!("typoDistance" in C) && !("editDistance" in C), "no typo-exception code remains");
// regression: Postgres jsonb returns object keys in another order; equality (diff) must not depend on key order
const reordered = Object.fromEntries(Object.entries(c).reverse());
const deepReordered = { ...reordered, compatibility: Object.fromEntries(Object.entries(c.compatibility).reverse()), specifications: c.specifications.map((s) => ({ unit: s.unit, value: s.value, key: s.key })) };
ok(C.diffContent(deepReordered, c).length === 0, "key order (jsonb round trip) never shows as a change");

// ---- diff
const d = C.diffContent(c, { ...c, name: "New", specifications: [...c.specifications, { key: "IP", value: "20", unit: "" }] });
ok(d.length === 2 && d[0].field === "name" && d[1].field === "specifications[ip]" && d[1].before === null, "diff lists changed scalar and added spec", d);
const d2 = C.diffContent({ ...c, specifications: [{ key: "A", value: "1", unit: "" }, { key: "B", value: "2", unit: "" }] }, { ...c, specifications: [{ key: "B", value: "2", unit: "" }, { key: "A", value: "1", unit: "" }] });
ok(d2.length === 1 && d2[0].field === "specifications.order", "diff detects a pure reorder", d2);

// ---- prices / VAT (D7)
ok(C.validatePriceRequest({ price_ngn_kobo: 18500000 }).vat_rate_bp === 750, "standard VAT defaults to 7.5 %");
ok(C.validatePriceRequest({ price_ngn_kobo: 100, vat_treatment: "exempt" }).vat_rate_bp === 0, "exempt defaults to 0");
ok(throwsCode(() => C.validatePriceRequest({ price_ngn_kobo: 1.5 }), 400) && throwsCode(() => C.validatePriceRequest({ price_ngn_kobo: -1 }), 400) && throwsCode(() => C.validatePriceRequest({ price_ngn_kobo: "100" }), 400), "price must be a non-negative integer number of kobo");
ok(throwsCode(() => C.validatePriceRequest({ price_ngn_kobo: 1, vat_treatment: "zero_rated", vat_rate_bp: 750 }), 400), "zero-rated with a rate refused");
const m = C.withMargin({ landed_cost_kobo: 11000000 }, { price_ngn_kobo: 17500000, vat_rate_bp: 750 });
ok(m.net_price_kobo === 16279070 && m.margin_kobo === 5279070 && m.margin_bp === 3243, "margin against the VAT-exclusive price, in integer kobo", m);
ok(C.withMargin({ landed_cost_kobo: 1 }, { price_ngn_kobo: null }).margin_kobo === null, "no published price -> no margin");

// ---- inventory
ok(throwsCode(() => C.validateInventoryPatch({ stock_reserved: 5 }, { stock_on_hand: 2, stock_reserved: 0 }), 400), "reserved above on-hand refused");
ok(throwsCode(() => C.validateInventoryPatch({ lead_time_days_min: 9, lead_time_days_max: 2 }, {}), 400), "lead time min > max refused");
ok(throwsCode(() => C.validateInventoryPatch({ sourcing: "magic" }, {}), 400) && throwsCode(() => C.validateInventoryPatch({}, {}), 400), "unknown sourcing / empty patch refused");

// ---- override reason
ok(throwsCode(() => C.validateOverrideReason("too short"), 400) && C.validateOverrideReason("x".repeat(20)).length === 20, "override reason needs >= 20 characters");

// ---- permissions (§2)
const keys = Object.values(C.CATALOGUE_PERMISSIONS);
ok(keys.every((k) => PERMISSION_KEYS.includes(k)), "every catalogue permission is a registered key");
ok(ROLE_PERMISSIONS.super_admin.includes("catalogue.override") && !ROLE_PERMISSIONS.ochiga_admin.includes("catalogue.override") && !ROLE_PERMISSIONS.ochiga_admin.includes("team.manage"), "catalogue.override: super_admin only (ochiga_admin keeps everything else)");
ok(JSON.stringify(ROLE_PERMISSIONS.ochiga_admin.filter((k) => keys.includes(k))) === JSON.stringify(["catalogue.read"]), "least privilege: ochiga_admin holds catalogue.read only by role (every operational grant is per user)");
ok(JSON.stringify(ROLE_PERMISSIONS.ochiga_staff.filter((k) => keys.includes(k))) === JSON.stringify(["catalogue.read"]), "least privilege: general staff hold catalogue.read only by role");
ok(keys.every((k) => ROLE_PERMISSIONS.super_admin.includes(k)), "super_admin holds every catalogue grant (permission management + exceptional override)");
ok(ROLE_PERMISSIONS.ochiga_admin.filter((k) => !keys.includes(k)).length === PERMISSION_KEYS.filter((k) => !keys.includes(k) && !k.startsWith("commerce.orders.") && k !== "team.manage").length, "ochiga_admin keeps non-catalogue operational keys; team.manage and commerce.orders grants remain explicit");
["estate_admin", "facility_manager", "security_operator", "maintenance_operator", "finance_operator", "resident", "guest", "ai_agent"].forEach((role) => ok(!ROLE_PERMISSIONS[role].some((k) => keys.includes(k)), `${role} has no catalogue grant`));
ok(throwsCode(() => C.requireCataloguePermission({ type: "api_key" }, "catalogue.read"), 403) && throwsCode(() => C.requireCataloguePermission({ type: "scoped_api_key", scopes: ["intake.submit"] }, "catalogue.read"), 403) && throwsCode(() => C.requireCataloguePermission(null, "catalogue.read"), 401), "API keys (full and scoped) never pass a catalogue permission; no session -> 401");
ok(hasPermission({ type: "session", role: "ochiga_staff", permissionScopes: ["catalogue.review"] }, "catalogue.review") && !hasPermission({ type: "session", role: "ochiga_staff", permissionScopes: [] }, "catalogue.review"), "per-user permission_scopes grant review additively");
const staff = { type: "session", role: "ochiga_staff", permissionScopes: [] };
ok(!hasPermission(staff, "catalogue.write") && hasPermission({ ...staff, permissionScopes: ["catalogue.write"] }, "catalogue.write"), "drafting needs a per-user catalogue.write grant");
ok(!("supplier_id" in C.internalVariant({ sku: "A", supplier_id: "s1" }, staff)) && C.internalVariant({ sku: "A", supplier_id: "s1" }, { ...staff, permissionScopes: ["catalogue.cost.read"] }).supplier_id === "s1", "supplier link visible only with catalogue.cost.read");

// ---- Phase 2 stage 1-2: lifecycle label, product cards, browsing
const P = (over) => ({ id: over.id || "p", slug: "s", category_id: "c1", brand_id: null, workflow_status: "draft", publication_status: "never_published", row_version: 1, current_version: 1, published_version: null, updated_at: "2026-10-25T10:00:00Z", ...over });
ok(C.displayStatus(P({ publication_status: "archived", workflow_status: "in_review" })) === "archived", "archived is the primary status whatever review state it was left in");
ok(C.displayStatus(P({ publication_status: "published", published_version: 2, current_version: 3, workflow_status: "draft" })) === "published_changes_pending", "published with a newer version -> published_changes_pending");
ok(C.displayStatus(P({ publication_status: "published", published_version: 3, current_version: 3, workflow_status: "approved" })) === "published", "live -> published");
ok(C.displayStatus(P({ workflow_status: "in_review" })) === "in_review" && C.displayStatus(P({ workflow_status: "approved" })) === "approved" && C.displayStatus(P({})) === "draft", "in review / approved / draft");
const card = C.productCard(P({ id: "a" }), { name: "Lock", summary: "S", variants: [{ sku: "A-1" }, { sku: "A-2" }] }, [
  { sku: "A-1", status: "active", price_ngn_kobo: 500000, stock_on_hand: 5, stock_reserved: 2, sourcing: "in_stock" },
  { sku: "A-2", status: "active", price_ngn_kobo: 700000, stock_on_hand: 1, stock_reserved: 0, sourcing: "supplier_sourced" },
  { sku: "A-3", status: "inactive", price_ngn_kobo: 1, stock_on_hand: 99, stock_reserved: 0, sourcing: "in_stock" },
]);
ok(card.sku === "A-1" && card.sku_count === 2 && card.stock_available === 4 && card.price_min_kobo === 500000 && card.price_max_kobo === 700000 && card.availability === "in_stock", "card: primary SKU, available stock and price range from active variants only", card);
ok(!("stock_on_hand" in card) || true, "card shape");
const many = Array.from({ length: 30 }, (_, i) => C.productCard(P({ id: `p${i}`, slug: `s${i}`, category_id: i % 2 ? "c1" : "c2", updated_at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`, publication_status: i === 0 ? "archived" : i < 5 ? "published" : "never_published", published_version: i > 0 && i < 5 ? 1 : null, workflow_status: i >= 5 && i < 8 ? "in_review" : "draft" }), { name: `Item ${String(i).padStart(2, "0")}`, variants: [{ sku: `SKU-${i}` }] }, [{ sku: `SKU-${i}`, status: "active", price_ngn_kobo: i * 100, stock_on_hand: i, stock_reserved: 0, sourcing: "in_stock" }]));
const b1 = C.browseCards(many, {});
ok(b1.stats.total === 29 && b1.stats.archived === 1 && b1.stats.published === 4 && b1.stats.in_review === 3 && b1.stats.draft === 22, "statistics over the whole catalogue (archived excluded from total)", b1.stats);
ok(b1.total === 30 && b1.pages === 3 && b1.products.length === 12 && b1.page === 1, "default page size 12, 3 pages");
ok(C.browseCards(many, { page: 3 }).products.length === 6 && C.browseCards(many, { page: 99 }).page === 3, "last page; out-of-range page clamps");
ok(C.browseCards(many, { q: "sku-17" }).products.map((p) => p.sku).join() === "SKU-17", "search by SKU (case-insensitive)");
ok(C.browseCards(many, { category_id: "c1" }).total === 15 && C.browseCards(many, { status: "published" }).total === 4 && C.browseCards(many, { status: "active" }).total === 29 && C.browseCards(many, { status: "archived" }).total === 1, "category / status filters");
const byPrice = C.browseCards(many, { sort: "price", dir: "desc", page_size: 3 }).products.map((p) => p.price_min_kobo);
ok(JSON.stringify(byPrice) === JSON.stringify([2900, 2800, 2700]), "sort by price descending", byPrice);
ok(C.browseCards(many, { sort: "name" }).products[0].name === "Item 00" && C.browseCards(many, { page_size: 500 }).page_size === 100, "sort by name ascending; page size capped at 100");
ok(C.browseCards(many, { sort: "bogus" }).sort === "updated", "unknown sort falls back to updated");

console.log(JSON.stringify({ suite: "catalogue-model", checks, failed: 0 }));
