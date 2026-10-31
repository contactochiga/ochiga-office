"use strict";

// Public catalogue projection (Phase 2 stage 4): pure functions, no I/O.
// What leaves Office for GetOyi is built ONLY here, field by field from an allow-list: product identity is the slug (no internal ids),
// prices are the published VAT-inclusive selling prices, availability is a label (never stock counts), images are addressed by the
// rendition's content hash (never a media id, file name or storage key). Supplier links, costs, reviewers, notes, unpublished versions
// and draft-only media never appear. Previews use the same builder on the previewed version's content.

const crypto = require("crypto");
const { variantAvailability } = require("./catalogue");

const RENDITIONS = Object.freeze(["thumb", "w480", "w960", "w1600"]);
const SHA = /^[0-9a-f]{64}$/;
const PREVIEW_TTL_SECONDS = 10 * 60;

const REQUIREMENT_LABELS = Object.freeze({
  archived: "The product is archived",
  not_published_internally: "Publish the approved version internally first",
  version_not_approved: "The published version was not approved by a second person (an override publication cannot go public)",
  no_images: "Add at least one image",
  no_cover: "Choose a cover image",
  alt_text_missing: "Every image needs alt text",
  media_unavailable: "An image or its renditions are missing",
  no_active_variant: "At least one active variant is required",
  price_not_approved: "Every active variant needs an approved, published price",
  // Solutions & Packages (20261109)
  service_not_listed: "Services are package components and are never listed on their own",
  consultation_size_priced: "A by-consultation size must not carry a price",
  package_components_invalid: "The package's components need attention (see the package readiness panel)",
});

const mediaPath = (sha) => `media/${sha}.webp`;

// rows: [{ id, status, derivatives: [{ kind, sha256, width, height }] }] for the media referenced by `content`
function publicImages(content, mediaRows) {
  const byId = new Map((mediaRows || []).map((m) => [m.id, m]));
  return (content.media || []).map((item) => {
    const m = byId.get(item.media_id);
    if (!m || m.status !== "active") return null;
    const kinds = Object.fromEntries((m.derivatives || []).filter((d) => SHA.test(String(d.sha256 || ""))).map((d) => [d.kind, d]));
    if (!RENDITIONS.every((k) => kinds[k])) return null;
    return {
      src: mediaPath(kinds.w960.sha256),
      thumb: mediaPath(kinds.thumb.sha256),
      srcset: [["w480", kinds.w480], ["w960", kinds.w960], ["w1600", kinds.w1600]].map(([, d]) => ({ src: mediaPath(d.sha256), width: d.width })),
      width: kinds.w1600.width,
      height: kinds.w1600.height,
      alt: item.alt || "",
      caption: item.caption || "",
      cover: Boolean(item.cover),
      variant_skus: [...(item.variant_skus || [])],
    };
  }).filter(Boolean).sort((a, b) => Number(b.cover) - Number(a.cover));
}

function publicVariant(listed, variant) {
  const availability = variantAvailability(variant);
  const priced = Number.isSafeInteger(variant.price_ngn_kobo) && variant.vat_treatment;
  return {
    sku: variant.sku,
    name: listed.name,
    options: { ...(listed.options || {}) },
    price: priced ? { amount_kobo: variant.price_ngn_kobo, currency: "NGN", vat_inclusive: true, vat_treatment: variant.vat_treatment } : null,
    availability: priced ? availability : "unavailable",
    lead_time_days: availability === "available_to_order" && variant.lead_time_days_min != null ? { min: variant.lead_time_days_min, max: variant.lead_time_days_max ?? variant.lead_time_days_min } : null,
  };
}

// The public view of one product version. `variants` are the product's variant records (only active ones listed in the version appear).
function publicProduct({ slug, content, variants, mediaRows, category, brand, releasedAt }) {
  const records = new Map((variants || []).map((v) => [v.sku, v]));
  const publicVariants = (content.variants || []).map((listed) => {
    const record = records.get(listed.sku);
    return record && record.status === "active" ? publicVariant(listed, record) : null;
  }).filter(Boolean);
  const prices = publicVariants.filter((v) => v.price).map((v) => v.price.amount_kobo);
  const avail = new Set(publicVariants.map((v) => v.availability));
  const images = publicImages(content, mediaRows);
  return {
    slug,
    name: content.name || "",
    model: content.model || "",
    summary: content.summary || "",
    description: content.description || "",
    category: category ? { slug: category.slug, name: category.name } : null,
    brand: brand ? { slug: brand.slug, name: brand.name } : null,
    specifications: (content.specifications || []).map((s) => ({ key: s.key, value: s.value, unit: s.unit || "" })),
    compatibility: {
      facility: Boolean(content.compatibility && content.compatibility.facility),
      experience: Boolean(content.compatibility && content.compatibility.experience),
      core: Boolean(content.compatibility && content.compatibility.core),
      edge: Boolean(content.compatibility && content.compatibility.edge),
      notes: (content.compatibility && content.compatibility.notes) || "",
    },
    variants: publicVariants,
    price_from_kobo: prices.length ? Math.min(...prices) : null,
    price_to_kobo: prices.length ? Math.max(...prices) : null,
    availability: avail.has("in_stock") ? "in_stock" : avail.has("available_to_order") ? "available_to_order" : "unavailable",
    images,
    cover: images[0] || null,
    updated_at: releasedAt || null,
  };
}

function publicCard(view) {
  return {
    slug: view.slug, name: view.name, model: view.model, summary: view.summary, category: view.category, brand: view.brand,
    price_from_kobo: view.price_from_kobo, price_to_kobo: view.price_to_kobo, availability: view.availability, cover: view.cover, updated_at: view.updated_at,
  };
}

// Media ids an image request may resolve to: only those referenced by the given version content
function referencedMediaIds(content) {
  return new Set((content && content.media || []).map((m) => m.media_id));
}

// ---- preview tokens: "pv1.<grant id>.<HMAC>" keyed by a domain-separated derivative of the signing secret; the grant row holds
// product, version, staff, expiry and revocation, so the token itself carries nothing readable.
function signingKey(config, purpose) {
  const root = String(config.catalogueSigningSecret || config.sessionSecret || "");
  if (root.length < 16) return null;
  return crypto.createHmac("sha256", root).update(`ochiga-catalogue:${purpose}:v1`).digest();
}

function previewToken(config, grantId) {
  const key = signingKey(config, "preview");
  if (!key) throw Object.assign(new Error("preview_signing_unavailable"), { statusCode: 503, code: "preview_unavailable" });
  return `pv1.${grantId}.${crypto.createHmac("sha256", key).update(`pv1.${grantId}`).digest("base64url")}`;
}

// -> grant id, or null when the token is malformed or its signature does not match
function verifyPreviewToken(config, token) {
  const match = /^pv1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ""));
  const key = signingKey(config, "preview");
  if (!match || !key) return null;
  // compare the canonical encoded string: base64url's last character carries 2 unused bits, so comparing decoded bytes would accept
  // several spellings of one signature (harmless, but tokens must not be malleable)
  const expected = Buffer.from(crypto.createHmac("sha256", key).update(`pv1.${match[1]}`).digest("base64url"));
  const given = Buffer.from(match[2]);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? match[1] : null;
}

// ---- GetOyi revalidation request signature: "t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + '.' + body)>"
function revalidationSignature(secret, body, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", String(secret)).update(`${t}.${body}`).digest("hex")}`;
}

module.exports = {
  PREVIEW_TTL_SECONDS,
  RENDITIONS,
  REQUIREMENT_LABELS,
  SHA,
  previewToken,
  publicCard,
  publicImages,
  publicProduct,
  referencedMediaIds,
  revalidationSignature,
  verifyPreviewToken,
};
