// Public catalogue projection and signing (catalogue-public.js), pure: the allow-list, availability/price rules, image handling,
// preview tokens and the GetOyi refresh signature.
"use strict";
const crypto = require("crypto");
const PUB = require("../src/lead-agents/catalogue-public");

let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 400)}`); };
const h = (n) => crypto.createHash("sha256").update(String(n)).digest("hex");
const renditions = (id) => ["thumb", "w480", "w960", "w1600"].map((kind, i) => ({ kind, sha256: h(`${id}-${kind}`), width: [320, 480, 960, 1600][i], height: [240, 360, 720, 1200][i] }));

const content = {
  name: "Hub", model: "H-1", summary: "s", description: "d", category_id: "c", brand_id: null,
  specifications: [{ key: "Power", value: "12", unit: "V", secret_note: "x" }],
  compatibility: { facility: true, experience: false, core: true, edge: false, notes: "n", internal: "x" },
  variants: [{ sku: "A", name: "White", options: { colour: "white" } }, { sku: "B", name: "Black", options: {} }, { sku: "C", name: "Old", options: {} }],
  media: [{ media_id: "m2", cover: false, alt: "Side", caption: "", variant_skus: ["B"] }, { media_id: "m1", cover: true, alt: "Front", caption: "Front panel", variant_skus: [] }, { media_id: "m3", cover: false, alt: "Broken" }],
  supplier_id: "should-never-leave", internal_notes: "never",
};
const variants = [
  { sku: "A", status: "active", price_ngn_kobo: 4500000, vat_treatment: "standard", stock_on_hand: 5, stock_reserved: 1, sourcing: "in_stock", supplier_id: "sup-1", row_version: 4 },
  { sku: "B", status: "active", price_ngn_kobo: null, vat_treatment: null, stock_on_hand: 0, stock_reserved: 0, sourcing: "supplier_sourced", lead_time_days_min: 3, lead_time_days_max: 6 },
  { sku: "C", status: "inactive", price_ngn_kobo: 100, vat_treatment: "standard", sourcing: "in_stock", stock_on_hand: 9, stock_reserved: 0 },
];
const mediaRows = [{ id: "m1", status: "active", derivatives: renditions("m1") }, { id: "m2", status: "active", derivatives: renditions("m2") }, { id: "m3", status: "active", derivatives: renditions("m3").slice(0, 3) }];
const view = PUB.publicProduct({ slug: "hub", content, variants, mediaRows, category: { id: "c", slug: "cat", name: "Cat", status: "active", row_version: 3 }, brand: null, releasedAt: "2026-10-25T00:00:00Z" });
const text = JSON.stringify(view);
check("PU1", "allow-list: unknown content keys, supplier ids, row versions, stock counts and internal ids never appear", !/should-never-leave|never|secret_note|internal|sup-1|row_version|stock_on_hand|m1|m2|"c"/.test(text), text.slice(0, 300));
check("PU2", "variants: inactive omitted; an unpriced active variant is shown as unavailable without a price; prices are VAT-inclusive kobo", view.variants.map((v) => v.sku).join() === "A,B" && view.variants[0].price.amount_kobo === 4500000 && view.variants[0].price.vat_inclusive && view.variants[1].price === null && view.variants[1].availability === "unavailable" && view.price_from_kobo === 4500000);
check("PU3", "images: cover first; an image missing a rendition is dropped; URLs are content hashes only; srcset widths 480/960/1600", view.images.length === 2 && view.images[0].alt === "Front" && view.images[0].cover && view.images.every((i) => /^media\/[0-9a-f]{64}\.webp$/.test(i.src)) && view.images[0].srcset.map((s) => s.width).join() === "480,960,1600" && view.cover.alt === "Front");
check("PU4", "card view carries only listing fields", JSON.stringify(Object.keys(PUB.publicCard(view)).sort()) === JSON.stringify(["availability", "brand", "category", "cover", "model", "name", "price_from_kobo", "price_to_kobo", "slug", "summary", "updated_at"]));
const config = { sessionSecret: crypto.randomBytes(24).toString("hex") };
const gid = crypto.randomUUID();
const token = PUB.previewToken(config, gid);
const flip = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
check("PU5", "preview token: verifies to its grant id; a changed signature, another grant id, another secret or garbage is refused", PUB.verifyPreviewToken(config, token) === gid && PUB.verifyPreviewToken(config, flip) === null && PUB.verifyPreviewToken(config, token.replace(gid, crypto.randomUUID())) === null && PUB.verifyPreviewToken({ sessionSecret: "x".repeat(32) }, token) === null && PUB.verifyPreviewToken(config, "pv1.../etc") === null);
check("PU6", "preview signing refuses to run with a missing or short secret", (() => { try { PUB.previewToken({ sessionSecret: "short" }, gid); return false; } catch (e) { return e.code === "preview_unavailable"; } })());
const sig = PUB.revalidationSignature("s3cret", "{}", 1_700_000_000_000);
check("PU7", "refresh signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>", sig === `t=1700000000,v1=${crypto.createHmac("sha256", "s3cret").update("1700000000.{}").digest("hex")}`);
check("PU8", "every requirement code has a staff-facing label", ["archived", "not_published_internally", "version_not_approved", "no_images", "no_cover", "alt_text_missing", "media_unavailable", "no_active_variant", "price_not_approved"].every((c) => PUB.REQUIREMENT_LABELS[c]));
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
