"use strict";

// Office-managed product catalogue: domain rules (pure functions, no I/O).
// Phase 1 scope (03_CATALOGUE_SPECIFICATION.md stages C1-C3, C5): taxonomy, products with immutable versions, review/publishing
// transitions, NGN prices with approval, inventory, suppliers and internal costs. Phase 2 stage 3 adds the product gallery (content.media:
// references to private, processed uploads, see catalogue-media.js and db/20261104). NOT in scope: public projection/API, storefront,
// refresh, checkout. "Publish" here only moves the internal publication state; nothing is public.

const { hasPermission } = require("./permissions");

const CATALOGUE_PERMISSIONS = Object.freeze({
  read: "catalogue.read",
  write: "catalogue.write",
  review: "catalogue.review",
  publish: "catalogue.publish",
  priceApprove: "catalogue.price.approve",
  costRead: "catalogue.cost.read",
  costManage: "catalogue.cost.manage",
  inventory: "inventory.manage",
  override: "catalogue.override",
  publicPublish: "catalogue.public.publish",
});

const LIMITS = Object.freeze({
  name: 160, model: 80, summary: 400, description: 10000, specs: 100, specKey: 80, specValue: 400, specUnit: 20,
  variants: 50, variantName: 120, options: 10, optionKey: 40, optionValue: 80, compatibilityNotes: 1000, note: 2000,
  // gallery: 5 visible positions, up to 12 images; documents are not accepted yet
  galleryVisible: 5, galleryMax: 12, mediaAlt: 250, mediaCaption: 300,
});
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKU = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VAT_TREATMENTS = Object.freeze(["standard", "exempt", "zero_rated"]);
const SOURCING = Object.freeze(["in_stock", "supplier_sourced", "made_to_order", "discontinued"]);
const STANDARD_VAT_BP = 750; // Nigeria VAT 7.5 %
const OVERRIDE_REASON_MIN = 20;

function badRequest(message, details) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "invalid_catalogue_input";
  if (details) error.details = details;
  return error;
}

function httpError(statusCode, code, extra = {}) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function str(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function bounded(errors, field, value, max, { required = false } = {}) {
  const text = str(value);
  if (required && !text) errors.push(`${field} is required`);
  if (text.length > max) errors.push(`${field} is longer than ${max} characters`);
  return text;
}

function isUuid(value) {
  return UUID.test(String(value || ""));
}

function validSlug(value) {
  const slug = str(value).toLowerCase();
  return SLUG.test(slug) && slug.length <= 80 ? slug : "";
}

// Normalises and validates a product's versioned content. category_id / brand_id are part of the content so that changing them is
// versioned (and material) like any other field.
function validateContent(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("content must be an object");
  const errors = [];
  const content = {
    category_id: str(input.category_id),
    brand_id: str(input.brand_id) || null,
    name: bounded(errors, "name", input.name, LIMITS.name, { required: true }),
    model: bounded(errors, "model", input.model, LIMITS.model),
    summary: bounded(errors, "summary", input.summary, LIMITS.summary),
    description: bounded(errors, "description", input.description, LIMITS.description),
    specifications: [],
    compatibility: { facility: false, experience: false, core: false, edge: false, notes: "" },
    variants: [],
    media: [],
    documents: [],
  };
  if (!isUuid(content.category_id)) errors.push("category_id must be a category id");
  if (content.brand_id && !isUuid(content.brand_id)) errors.push("brand_id must be a brand id");

  const specs = Array.isArray(input.specifications) ? input.specifications : input.specifications == null ? [] : null;
  if (!specs) errors.push("specifications must be a list");
  else if (specs.length > LIMITS.specs) errors.push(`at most ${LIMITS.specs} specifications`);
  else {
    const seen = new Set();
    specs.forEach((spec, index) => {
      const key = bounded(errors, `specifications[${index}].key`, spec && spec.key, LIMITS.specKey, { required: true });
      const value = bounded(errors, `specifications[${index}].value`, spec && spec.value, LIMITS.specValue, { required: true });
      const unit = bounded(errors, `specifications[${index}].unit`, spec && spec.unit, LIMITS.specUnit);
      if (key && seen.has(key.toLowerCase())) errors.push(`specification "${key}" appears twice`);
      seen.add(key.toLowerCase());
      content.specifications.push({ key, value, unit });
    });
  }

  const compat = input.compatibility && typeof input.compatibility === "object" ? input.compatibility : {};
  ["facility", "experience", "core", "edge"].forEach((flag) => { content.compatibility[flag] = compat[flag] === true; });
  content.compatibility.notes = bounded(errors, "compatibility.notes", compat.notes, LIMITS.compatibilityNotes);

  const variants = Array.isArray(input.variants) ? input.variants : null;
  if (!variants || variants.length === 0) errors.push("at least one variant (SKU) is required");
  else if (variants.length > LIMITS.variants) errors.push(`at most ${LIMITS.variants} variants`);
  else {
    const skus = new Set();
    variants.forEach((variant, index) => {
      const sku = str(variant && variant.sku).toUpperCase();
      if (!SKU.test(sku)) errors.push(`variants[${index}].sku must be 2-64 characters: A-Z 0-9 . _ -`);
      if (skus.has(sku)) errors.push(`SKU ${sku} appears twice`);
      skus.add(sku);
      const name = bounded(errors, `variants[${index}].name`, variant && variant.name, LIMITS.variantName, { required: true });
      const options = {};
      const rawOptions = variant && variant.options && typeof variant.options === "object" && !Array.isArray(variant.options) ? variant.options : {};
      const entries = Object.entries(rawOptions);
      if (entries.length > LIMITS.options) errors.push(`variants[${index}] has more than ${LIMITS.options} options`);
      entries.slice(0, LIMITS.options).forEach(([key, value]) => {
        const k = bounded(errors, `variants[${index}].options key`, key, LIMITS.optionKey, { required: true });
        options[k] = bounded(errors, `variants[${index}].options.${k}`, value, LIMITS.optionValue, { required: true });
      });
      content.variants.push({ sku, name, options });
    });
  }

  // Gallery: ordered references to this product's uploaded images (existence, ownership and status are checked by the store / database).
  // An incomplete gallery is a valid draft; the only structural rule is exactly one cover once there is any image.
  const media = input.media == null ? [] : Array.isArray(input.media) ? input.media : null;
  if (!media) errors.push("media must be a list");
  else if (media.length > LIMITS.galleryMax) errors.push(`at most ${LIMITS.galleryMax} images`);
  else {
    const seen = new Set();
    const skus = new Set(content.variants.map((v) => v.sku));
    let covers = 0;
    media.forEach((item, index) => {
      const mediaId = str(item && item.media_id).toLowerCase();
      if (!isUuid(mediaId)) errors.push(`media[${index}].media_id must be an image id`);
      else if (seen.has(mediaId)) errors.push(`image ${mediaId} appears twice in the gallery`);
      seen.add(mediaId);
      const cover = Boolean(item && item.cover === true);
      if (cover) covers += 1;
      const alt = bounded(errors, `media[${index}].alt`, item && item.alt, LIMITS.mediaAlt);
      const caption = bounded(errors, `media[${index}].caption`, item && item.caption, LIMITS.mediaCaption);
      const rawSkus = item && item.variant_skus != null ? item.variant_skus : [];
      if (!Array.isArray(rawSkus)) errors.push(`media[${index}].variant_skus must be a list`);
      const variantSkus = [...new Set((Array.isArray(rawSkus) ? rawSkus : []).map((sku) => str(sku).toUpperCase()))];
      variantSkus.filter((sku) => !skus.has(sku)).forEach((sku) => errors.push(`media[${index}] is linked to ${sku || "an empty SKU"}, which is not a variant of this product`));
      content.media.push({ media_id: mediaId, cover, alt, caption, variant_skus: variantSkus });
    });
    if (media.length && covers !== 1) errors.push("exactly one image must be the cover");
  }
  if (Array.isArray(input.documents) && input.documents.length) errors.push("documents are not available yet");

  if (errors.length) throw badRequest("invalid product content", errors);
  return content;
}

// Bounded edit distance (stops counting above `limit`), for the "typo-class edit" rule.
// Key-order-independent equality: Postgres jsonb returns object keys in its own order, so content read back from the database must
// compare equal to the same content built in JavaScript (array order still matters: it is meaningful for specs, variants, media).
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}
const same = (a, b) => canonical(a) === canonical(b);

// D2 as decided in the release review (2026-10-25): there is NO minor/typo exception. Before the first publication a version is
// "initial"; after it, EVERY change to product content is "material" and follows the review workflow (second person approves, then a
// publisher publishes). The database refuses any other classification.
function materialityOf(publishedContent) {
  return publishedContent ? "material" : "initial";
}

function diffContent(before = {}, after = {}) {
  const changes = [];
  const scalar = (field) => { if (!same(before[field], after[field])) changes.push({ field, before: before[field] ?? null, after: after[field] ?? null }); };
  ["category_id", "brand_id", "name", "model", "summary", "description"].forEach(scalar);
  const keyed = (field, keyOf) => {
    const a = new Map((before[field] || []).map((item) => [keyOf(item), item]));
    const b = new Map((after[field] || []).map((item) => [keyOf(item), item]));
    for (const [key, item] of a) if (!b.has(key)) changes.push({ field: `${field}[${key}]`, before: item, after: null });
    for (const [key, item] of b) {
      if (!a.has(key)) changes.push({ field: `${field}[${key}]`, before: null, after: item });
      else if (!same(a.get(key), item)) changes.push({ field: `${field}[${key}]`, before: a.get(key), after: item });
    }
    const order = (list) => (list || []).map(keyOf).join("\u0000");
    if (a.size === b.size && [...a.keys()].every((k) => b.has(k)) && order(before[field]) !== order(after[field])) changes.push({ field: `${field}.order`, before: (before[field] || []).map(keyOf), after: (after[field] || []).map(keyOf) });
  };
  keyed("specifications", (spec) => spec.key.toLowerCase());
  keyed("variants", (variant) => variant.sku);
  if (!same(before.compatibility, after.compatibility)) changes.push({ field: "compatibility", before: before.compatibility ?? null, after: after.compatibility ?? null });
  keyed("media", (item) => item.media_id);
  if (!same(before.documents, after.documents)) changes.push({ field: "documents", before: before.documents ?? [], after: after.documents ?? [] });
  return changes;
}

// One lifecycle label per product for lists and headers. Archived is the primary status whatever review state it was left in (the earlier
// review states stay in the history). "Published · changes pending" = a live version plus a newer, not yet published one.
function displayStatus(product) {
  if (!product) return "draft";
  if (product.publication_status === "archived") return "archived";
  const pending = product.published_version != null && product.current_version > product.published_version;
  if (product.publication_status === "published") return pending ? "published_changes_pending" : "published";
  if (product.workflow_status === "in_review") return "in_review";
  if (product.workflow_status === "changes_requested") return "changes_requested";
  if (product.workflow_status === "approved") return product.publication_status === "unpublished" ? "unpublished" : "approved";
  return product.publication_status === "unpublished" ? "unpublished" : "draft";
}

const DISPLAY_STATUSES = Object.freeze(["draft", "in_review", "changes_requested", "approved", "published", "published_changes_pending", "unpublished", "archived"]);

// Availability of one variant (staff see the numbers; a future public projection shows only this label).
function variantAvailability(variant) {
  if (!variant || variant.status === "inactive" || variant.sourcing === "discontinued") return "unavailable";
  if (variant.sourcing === "in_stock" && variant.stock_on_hand - variant.stock_reserved > 0) return "in_stock";
  return "available_to_order";
}

function coverOf(content = {}) {
  const cover = (content.media || []).find((item) => item.cover);
  return cover ? cover.media_id : null;
}

// What public publishing (stage 4) will require of a version's gallery: a cover, and alternative text on every image. Drafts may be
// incomplete; this is reported, not enforced, until the public projection exists.
function galleryReadiness(content = {}) {
  const media = content.media || [];
  const issues = [];
  if (!media.length) issues.push("no_images");
  else if (!coverOf(content)) issues.push("no_cover");
  const missingAlt = media.filter((item) => !item.alt).length;
  if (missingAlt) issues.push("alt_text_missing");
  return {
    images: media.length,
    cover_media_id: coverOf(content),
    missing_alt: missingAlt,
    below_recommended: media.length < LIMITS.galleryVisible,
    ready_for_public: issues.length === 0,
    issues,
  };
}

// Summary row for the catalogue table: everything the list, filters, sorting and statistics need, computed from real records.
function productCard(product, content = {}, variants = []) {
  const active = variants.filter((v) => v.status === "active");
  const prices = active.map((v) => v.price_ngn_kobo).filter((p) => Number.isSafeInteger(p));
  const availabilities = new Set(active.map(variantAvailability));
  const listedSkus = (content.variants || []).map((v) => v.sku);
  return {
    id: product.id,
    slug: product.slug,
    name: content.name || product.slug,
    model: content.model || "",
    summary: content.summary || "",
    category_id: product.category_id,
    brand_id: product.brand_id || null,
    cover_media_id: coverOf(content),
    image_count: (content.media || []).length,
    sku: listedSkus[0] || (variants[0] && variants[0].sku) || "",
    sku_count: listedSkus.length,
    skus: listedSkus,
    stock_available: active.reduce((sum, v) => sum + Math.max(0, (v.stock_on_hand || 0) - (v.stock_reserved || 0)), 0),
    price_min_kobo: prices.length ? Math.min(...prices) : null,
    price_max_kobo: prices.length ? Math.max(...prices) : null,
    availability: availabilities.has("in_stock") ? "in_stock" : availabilities.has("available_to_order") ? "available_to_order" : "unavailable",
    status: displayStatus(product),
    workflow_status: product.workflow_status,
    publication_status: product.publication_status,
    row_version: product.row_version,
    current_version: product.current_version,
    published_version: product.published_version,
    updated_at: product.updated_at,
    updated_by: product.updated_by,
  };
}

const CARD_SORTS = Object.freeze({
  updated: (a, b) => String(a.updated_at).localeCompare(String(b.updated_at)),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  sku: (a, b) => a.sku.localeCompare(b.sku),
  price: (a, b) => (a.price_min_kobo ?? Number.MAX_SAFE_INTEGER) - (b.price_min_kobo ?? Number.MAX_SAFE_INTEGER),
  stock: (a, b) => a.stock_available - b.stock_available,
  status: (a, b) => DISPLAY_STATUSES.indexOf(a.status) - DISPLAY_STATUSES.indexOf(b.status),
});

// Statistics over the WHOLE catalogue (not the current page or filter), then filter -> sort -> paginate.
function browseCards(cards, query = {}) {
  const stats = {
    total: cards.filter((c) => c.status !== "archived").length,
    draft: cards.filter((c) => c.status === "draft" || c.status === "changes_requested").length,
    in_review: cards.filter((c) => c.status === "in_review").length,
    approved: cards.filter((c) => c.status === "approved").length,
    published: cards.filter((c) => c.status === "published" || c.status === "published_changes_pending").length,
    archived: cards.filter((c) => c.status === "archived").length,
  };
  const q = String(query.q || "").trim().toLowerCase();
  const statusMatch = (c) => !query.status || (query.status === "active" ? c.status !== "archived" : query.status === "published" ? c.status === "published" || c.status === "published_changes_pending" : query.status === "draft" ? c.status === "draft" || c.status === "changes_requested" : c.status === query.status);
  let rows = cards.filter((c) =>
    (!q || [c.name, c.model, c.slug, c.summary, ...c.skus].some((t) => String(t || "").toLowerCase().includes(q)))
    && (!query.category_id || c.category_id === query.category_id)
    && (!query.brand_id || c.brand_id === query.brand_id)
    && statusMatch(c)
    && (!query.availability || c.availability === query.availability));
  const sortKey = CARD_SORTS[query.sort] ? query.sort : "updated";
  const dir = query.dir === "asc" || (!query.dir && sortKey !== "updated") ? 1 : -1;
  rows = [...rows].sort((a, b) => dir * CARD_SORTS[sortKey](a, b) || a.name.localeCompare(b.name));
  const total = rows.length;
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.page_size, 10) || 12));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.page, 10) || 1));
  return { stats, total, page, pages, page_size: pageSize, sort: sortKey, dir: dir === 1 ? "asc" : "desc", products: rows.slice((page - 1) * pageSize, page * pageSize) };
}

function validatePriceRequest(body = {}) {
  const errors = [];
  const price = body.price_ngn_kobo;
  if (!Number.isSafeInteger(price) || price < 0) errors.push("price_ngn_kobo must be a non-negative integer number of kobo");
  const vat = str(body.vat_treatment) || "standard";
  if (!VAT_TREATMENTS.includes(vat)) errors.push(`vat_treatment must be one of ${VAT_TREATMENTS.join(", ")}`);
  let rate = body.vat_rate_bp == null ? (vat === "standard" ? STANDARD_VAT_BP : 0) : body.vat_rate_bp;
  if (!Number.isInteger(rate) || rate < 0 || rate > 10000) errors.push("vat_rate_bp must be an integer between 0 and 10000");
  else if ((vat === "standard") !== (rate > 0)) errors.push("standard VAT needs a positive rate; exempt and zero_rated need 0");
  const note = bounded(errors, "note", body.note, LIMITS.note);
  if (errors.length) throw badRequest("invalid price change", errors);
  return { price_ngn_kobo: price, vat_treatment: vat, vat_rate_bp: rate, note };
}

const INVENTORY_FIELDS = Object.freeze(["stock_on_hand", "stock_reserved", "sourcing", "lead_time_days_min", "lead_time_days_max", "status", "supplier_id"]);

function validateInventoryPatch(body = {}, current = {}) {
  const errors = [];
  const patch = {};
  for (const field of INVENTORY_FIELDS) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (["stock_on_hand", "stock_reserved"].includes(field)) {
      if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) errors.push(`${field} must be a non-negative integer`);
    } else if (["lead_time_days_min", "lead_time_days_max"].includes(field)) {
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 3650)) errors.push(`${field} must be null or 0-3650 days`);
    } else if (field === "sourcing") {
      if (!SOURCING.includes(value)) errors.push(`sourcing must be one of ${SOURCING.join(", ")}`);
    } else if (field === "status") {
      if (!["active", "inactive"].includes(value)) errors.push("status must be active or inactive");
    } else if (field === "supplier_id") {
      if (value !== null && (typeof value !== "string" || !value.trim() || value.length > 120)) errors.push("supplier_id must be a supplier id or null");
    }
    patch[field] = value;
  }
  if (!Object.keys(patch).length) errors.push("nothing to change");
  const merged = { ...current, ...patch };
  if (Number.isInteger(merged.stock_reserved) && Number.isInteger(merged.stock_on_hand) && merged.stock_reserved > merged.stock_on_hand) errors.push("stock_reserved cannot exceed stock_on_hand");
  if (merged.lead_time_days_min != null && merged.lead_time_days_max != null && merged.lead_time_days_min > merged.lead_time_days_max) errors.push("lead_time_days_min cannot exceed lead_time_days_max");
  const reason = bounded(errors, "reason", body.reason, 1000);
  if (errors.length) throw badRequest("invalid inventory change", errors);
  return { patch, reason };
}

function validateCostRecord(body = {}) {
  const errors = [];
  const supplier = body.supplier_cost_kobo;
  const landed = body.landed_cost_kobo;
  if (!Number.isSafeInteger(supplier) || supplier < 0) errors.push("supplier_cost_kobo must be a non-negative integer");
  if (!Number.isSafeInteger(landed) || landed < 0) errors.push("landed_cost_kobo must be a non-negative integer");
  if (Number.isSafeInteger(supplier) && Number.isSafeInteger(landed) && landed < supplier) errors.push("landed_cost_kobo cannot be below supplier_cost_kobo");
  const supplierId = body.supplier_id == null || body.supplier_id === "" ? null : str(body.supplier_id);
  const note = bounded(errors, "note", body.note, 1000);
  if (errors.length) throw badRequest("invalid cost record", errors);
  return { supplier_cost_kobo: supplier, landed_cost_kobo: landed, supplier_id: supplierId, note };
}

function validateTaxonomyInput(body = {}, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || body.slug !== undefined) {
    out.slug = validSlug(body.slug);
    if (!out.slug) errors.push("slug must be lowercase letters, digits and single hyphens (max 80)");
  }
  if (!partial || body.name !== undefined) out.name = bounded(errors, "name", body.name, 120, { required: true });
  if (body.sort !== undefined) { if (!Number.isInteger(body.sort) || Math.abs(body.sort) > 100000) errors.push("sort must be an integer"); else out.sort = body.sort; }
  if (body.status !== undefined) { if (!["active", "hidden"].includes(body.status)) errors.push("status must be active or hidden"); else out.status = body.status; }
  if (body.parent_id !== undefined) { if (body.parent_id !== null && !isUuid(body.parent_id)) errors.push("parent_id must be a category id or null"); else out.parent_id = body.parent_id; }
  if (partial && !Object.keys(out).length) errors.push("nothing to change");
  if (errors.length) throw badRequest("invalid taxonomy input", errors);
  return out;
}

function validateSupplierInput(body = {}, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const fields = { name: 200, contact_name: 200, email: 320, phone: 60, country: 80, payment_terms: 200, notes: 4000 };
  for (const [field, max] of Object.entries(fields)) {
    if (partial && body[field] === undefined) continue;
    out[field] = bounded(errors, field, body[field], max, { required: field === "name" });
  }
  if (body.status !== undefined) { if (!["active", "inactive"].includes(body.status)) errors.push("status must be active or inactive"); else out.status = body.status; }
  if (partial && !Object.keys(out).length) errors.push("nothing to change");
  if (errors.length) throw badRequest("invalid supplier", errors);
  return out;
}

function validateOverrideReason(reason) {
  const text = str(reason);
  if (text.length < OVERRIDE_REASON_MIN) throw httpError(400, "override_reason_too_short", { message: `override needs a reason of at least ${OVERRIDE_REASON_MIN} characters` });
  return text.slice(0, LIMITS.note);
}

// Catalogue routes are staff-session only: an API key (full keys pass every hasPermission check, scoped keys pass none) never reaches
// any catalogue action, and every permission is checked against the signed-in user's role + permission_scopes.
function requireCataloguePermission(authContext, permission) {
  if (!authContext) throw httpError(401, "unauthorized");
  if (authContext.type !== "session") throw httpError(403, "catalogue_requires_staff_session");
  if (!hasPermission(authContext, permission)) throw httpError(403, "forbidden", { permission });
  return authContext;
}

function canSeeCosts(authContext) {
  return Boolean(authContext && authContext.type === "session" && hasPermission(authContext, CATALOGUE_PERMISSIONS.costRead));
}

// Internal (staff) view of a variant: supplier link only for catalogue.cost.read holders; costs are never part of it.
function internalVariant(variant, authContext) {
  if (!variant) return variant;
  const { supplier_id: supplierId, ...rest } = variant;
  return canSeeCosts(authContext) ? { ...rest, supplier_id: supplierId ?? null } : rest;
}

function withMargin(cost, variant) {
  if (!cost) return cost;
  const price = variant && Number.isSafeInteger(variant.price_ngn_kobo) ? variant.price_ngn_kobo : null;
  // margin against the VAT-exclusive selling price; null while the variant has no published price
  if (price == null) return { ...cost, margin_kobo: null, margin_bp: null };
  const net = variant.vat_rate_bp > 0 ? Math.round((price * 10000) / (10000 + variant.vat_rate_bp)) : price;
  const margin = net - cost.landed_cost_kobo;
  return { ...cost, net_price_kobo: net, margin_kobo: margin, margin_bp: net > 0 ? Math.round((margin * 10000) / net) : null };
}

module.exports = {
  CATALOGUE_PERMISSIONS,
  INVENTORY_FIELDS,
  LIMITS,
  OVERRIDE_REASON_MIN,
  SOURCING,
  STANDARD_VAT_BP,
  VAT_TREATMENTS,
  badRequest,
  canSeeCosts,
  browseCards,
  diffContent,
  displayStatus,
  galleryReadiness,
  coverOf,
  productCard,
  variantAvailability,
  DISPLAY_STATUSES,
  httpError,
  internalVariant,
  isUuid,
  materialityOf,
  requireCataloguePermission,
  validSlug,
  validateContent,
  validateCostRecord,
  validateInventoryPatch,
  validateOverrideReason,
  validatePriceRequest,
  validateSupplierInput,
  validateTaxonomyInput,
  withMargin,
};
