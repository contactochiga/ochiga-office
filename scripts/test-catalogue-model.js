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

// ---- materiality (D2), always against the PUBLISHED content
ok(C.materialityOf(null, c) === "initial", "never published -> initial");
ok(C.materialityOf(c, { ...c }) === "minor", "identical content -> minor (nothing material)");
ok(C.materialityOf(c, { ...c, description: c.description.replace("local", "locl") }) === "minor", "1-character typo in description -> minor");
ok(C.materialityOf(c, { ...c, summary: "Two-gang switc.", description: c.description.replace("local", "locl") }) === "minor", "typos in summary + description totalling 2 characters -> minor");
ok(C.materialityOf(c, { ...c, description: c.description + " New." }) === "material", "more than 3 characters -> material");
["name", "model", "category_id", "brand_id"].forEach((field) => ok(C.materialityOf(c, { ...c, [field]: field.endsWith("_id") ? "22222222-2222-4222-8222-222222222222" : "Changed" }) === "material", `${field} change -> material`));
ok(C.materialityOf(c, { ...c, specifications: [{ key: "Voltage", value: "240", unit: "V" }] }) === "material", "specification value -> material");
ok(C.materialityOf(c, { ...c, compatibility: { ...c.compatibility, edge: true } }) === "material", "compatibility -> material");
ok(C.materialityOf(c, { ...c, variants: [...c.variants, { sku: "SW2-BLK", name: "Black", options: {} }] }) === "material", "variant added -> material");
const withMedia = { ...c, media: [{ office_file_id: "a", alt: "front" }, { office_file_id: "b", alt: "side" }] };
ok(C.materialityOf(withMedia, { ...withMedia, media: [{ office_file_id: "a", alt: "Front view" }, { office_file_id: "b", alt: "side" }] }) === "minor", "(Phase 2 rule) alt-text-only media edit -> minor");
ok(C.materialityOf(withMedia, { ...withMedia, media: [withMedia.media[1], withMedia.media[0]] }) === "material", "(Phase 2 rule, 4.6a) gallery reorder -> material");
// regression: Postgres jsonb returns object keys in another order; equality must not depend on key order
const reordered = Object.fromEntries(Object.entries(c).reverse());
const deepReordered = { ...reordered, compatibility: Object.fromEntries(Object.entries(c.compatibility).reverse()), specifications: c.specifications.map((s) => ({ unit: s.unit, value: s.value, key: s.key })) };
ok(C.materialityOf(deepReordered, c) === "minor" && C.diffContent(deepReordered, c).length === 0, "key order (jsonb round trip) never makes content 'material' or 'changed'");

// ---- diff
const d = C.diffContent(c, { ...c, name: "New", specifications: [...c.specifications, { key: "IP", value: "20", unit: "" }] });
ok(d.length === 2 && d[0].field === "name" && d[1].field === "specifications[ip]" && d[1].before === null, "diff lists changed scalar and added spec", d);
const d2 = C.diffContent({ ...c, specifications: [{ key: "A", value: "1", unit: "" }, { key: "B", value: "2", unit: "" }] }, { ...c, specifications: [{ key: "B", value: "2", unit: "" }, { key: "A", value: "1", unit: "" }] });
ok(d2.length === 1 && d2[0].field === "specifications.order", "diff detects a pure reorder", d2);
ok(C.editDistance("kitten", "sitting", 10) === 3 && C.editDistance("a".repeat(50), "b".repeat(50), 3) === 4, "bounded edit distance");

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
ok(keys.filter((k) => k !== "catalogue.override").every((k) => ROLE_PERMISSIONS.ochiga_admin.includes(k)), "ochiga_admin holds every other catalogue grant");
ok(JSON.stringify(ROLE_PERMISSIONS.ochiga_staff.filter((k) => keys.includes(k))) === JSON.stringify(["catalogue.read", "catalogue.write"]), "ochiga_staff: read + write only by default");
["estate_admin", "facility_manager", "security_operator", "maintenance_operator", "finance_operator", "resident", "guest", "ai_agent"].forEach((role) => ok(!ROLE_PERMISSIONS[role].some((k) => keys.includes(k)), `${role} has no catalogue grant`));
ok(throwsCode(() => C.requireCataloguePermission({ type: "api_key" }, "catalogue.read"), 403) && throwsCode(() => C.requireCataloguePermission({ type: "scoped_api_key", scopes: ["intake.submit"] }, "catalogue.read"), 403) && throwsCode(() => C.requireCataloguePermission(null, "catalogue.read"), 401), "API keys (full and scoped) never pass a catalogue permission; no session -> 401");
ok(hasPermission({ type: "session", role: "ochiga_staff", permissionScopes: ["catalogue.review"] }, "catalogue.review") && !hasPermission({ type: "session", role: "ochiga_staff", permissionScopes: [] }, "catalogue.review"), "per-user permission_scopes grant review additively");
const staff = { type: "session", role: "ochiga_staff", permissionScopes: [] };
ok(!("supplier_id" in C.internalVariant({ sku: "A", supplier_id: "s1" }, staff)) && C.internalVariant({ sku: "A", supplier_id: "s1" }, { ...staff, permissionScopes: ["catalogue.cost.read"] }).supplier_id === "s1", "supplier link visible only with catalogue.cost.read");

console.log(JSON.stringify({ suite: "catalogue-model", checks, failed: 0 }));
