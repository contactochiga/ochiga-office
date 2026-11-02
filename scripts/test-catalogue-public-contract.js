"use strict";
// Phase 5D public catalogue contract: the projection GetOyi receives is built only from an allow-list. Fixtures carry sentinel
// values in every private field Office holds (supplier costs and links, stock counts, reviewers, notes, internal ids, storage keys,
// draft content, inactive variants); none may appear, and the exact key sets are pinned so a new field cannot leak silently.
const assert = require("assert/strict");
const PUB = require("../src/lead-agents/catalogue-public");
let n = 0; const ok = (c, name) => { assert.ok(c, name); n++; console.log("PASS " + name); };
const SECRET = "PRIVATE-SENTINEL";
const sha = (c) => c.repeat(64);
const derivs = ["thumb", "w480", "w960", "w1600"].map((kind, i) => ({ kind, sha256: sha("abcd"[i]), width: 100 * (i + 1), height: 75 * (i + 1), storage_key: SECRET + "-key", filename: SECRET + ".webp" }));
const content = {
  name: "Lock", model: "L1", summary: "Sum", description: "Desc", category_id: SECRET + "-cat-id", brand_id: SECRET + "-brand-id",
  specifications: [{ key: "Power", value: "AA", unit: "", internal_note: SECRET }],
  compatibility: { facility: true, experience: false, core: false, edge: false, notes: "", reviewer: SECRET },
  variants: [{ sku: "L1-A", name: "Standard", options: { colour: "Black" }, supplier_sku: SECRET }, { sku: "L1-OLD", name: "Old", options: {} }],
  media: [{ media_id: SECRET + "-media-id", alt: "Lock", caption: "", cover: true, variant_skus: ["L1-A"], uploader: SECRET }],
  supplier: { name: SECRET, url: "https://" + SECRET + ".example" }, cost_kobo: 123456789, notes: SECRET, reviewer: SECRET, internal_id: SECRET,
};
const variants = [
  { sku: "L1-A", status: "active", sourcing: "in_stock", stock_on_hand: 987654, stock_reserved: 3, price_ngn_kobo: 2500000, vat_treatment: "standard", cost_ngn_kobo: 1111111, supplier_id: SECRET, lead_time_days_min: null, id: SECRET + "-variant-id", product_id: SECRET },
  { sku: "L1-OLD", status: "inactive", sourcing: "in_stock", stock_on_hand: 5, stock_reserved: 0, price_ngn_kobo: 999, vat_treatment: "standard", cost_ngn_kobo: 7 },
];
const mediaRows = [{ id: SECRET + "-media-id", status: "active", derivatives: derivs, original_key: SECRET + "-original", product_id: SECRET }];
const view = PUB.publicProduct({ slug: "lock", content, variants, mediaRows, category: { slug: "locks", name: "Locks", id: SECRET, status: "active" }, brand: { slug: "acme", name: "Acme", id: SECRET }, releasedAt: "2026-10-01T00:00:00Z" });
const text = JSON.stringify(view);
ok(!text.includes(SECRET), "no private sentinel (supplier, costs, reviewers, notes, internal ids, storage keys) in the product view");
ok(!text.includes("987654") && !text.includes("1111111") && !text.includes("123456789") && !/stock_on_hand|stock_reserved|cost|supplier|storage_key|filename|media_id/.test(text), "no stock counts or cost amounts; no private field names");
ok(JSON.stringify(Object.keys(view).sort()) === JSON.stringify(["availability", "brand", "category", "compatibility", "cover", "description", "images", "model", "name", "price_from_kobo", "price_to_kobo", "slug", "specifications", "summary", "updated_at", "variants"]), "product view key set is exactly the allow-list");
ok(view.variants.length === 1 && JSON.stringify(Object.keys(view.variants[0]).sort()) === JSON.stringify(["availability", "lead_time_days", "name", "options", "price", "sku"]), "inactive variants omitted; variant key set pinned");
ok(view.variants[0].availability === "in_stock" && view.variants[0].price.amount_kobo === 2500000, "availability is a label; price is the approved published price");
ok(JSON.stringify(Object.keys(view.images[0]).sort()) === JSON.stringify(["alt", "caption", "cover", "height", "src", "srcset", "thumb", "variant_skus", "width"]) && view.images[0].src === `media/${sha("c")}.webp`, "images addressed by rendition content hash only");
ok(JSON.stringify(Object.keys(view.specifications[0]).sort()) === JSON.stringify(["key", "unit", "value"]) && JSON.stringify(Object.keys(view.compatibility).sort()) === JSON.stringify(["core", "edge", "experience", "facility", "notes"]), "specification and compatibility key sets pinned");
const card = PUB.publicCard(view);
ok(JSON.stringify(Object.keys(card).sort()) === JSON.stringify(["availability", "brand", "category", "cover", "model", "name", "price_from_kobo", "price_to_kobo", "slug", "summary", "updated_at"]) && !JSON.stringify(card).includes(SECRET), "card key set pinned; nothing private");
const unpriced = PUB.publicProduct({ slug: "lock", content, variants: [{ ...variants[0], price_ngn_kobo: null }], mediaRows, category: null, brand: null, releasedAt: null });
ok(unpriced.variants[0].price === null && unpriced.price_from_kobo === null && unpriced.variants[0].availability === "unavailable", "no approved price: price is null (shown as Price on Request), never derived from cost");
console.log(JSON.stringify({ suite: "catalogue-public-contract", passed: n }));
