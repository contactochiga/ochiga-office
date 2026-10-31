"use strict";

// Solutions & Packages (SP1): pure functions, no I/O. A package is a catalogue item (catalogue_products.kind = 'package') whose versioned
// content adds a `package` block; its variants are the package SIZES. Everything else -- immutable versions, second-person review,
// internal publication, approved prices, media, public release, withdrawal and refresh -- is the existing catalogue workflow.
//
// Commercial rules (owner decisions 2026-10-31):
//   * a package price covers the HARDWARE; Oyi software deployment is always consultation-led and never priced; installation is quoted
//     separately unless the package scope says 'included' (then the approved price includes it, and the reviewer approves that);
//   * predefined sizes (fixed price or consultation), per-unit configurations (component quantity per unit) and custom configurations
//     (by consultation) are all supported;
//   * Facility and Resident are experiences of one Oyi, not separate products: a package never prices software or a subscription.
//
// The blocking rules here mirror db/20261109_catalogue_packages.sql (catalogue_package_issues) so both stores refuse the same things;
// the database remains the authority in production. Warnings (optional component unavailable, no stock) never block.

const C = require("./catalogue");
const { variantAvailability } = require("./catalogue");

const KINDS = Object.freeze(["product", "package", "service"]);
const SOLUTION_TYPES = Object.freeze(["residential", "hospitality", "commercial", "mixed-use", "healthcare"]);
const ROLES = Object.freeze(["required", "optional", "recommended"]);
const BASES = Object.freeze(["fixed", "per_unit"]);
const INSTALLATION = Object.freeze(["quoted_separately", "included"]);
const PRICING = Object.freeze(["fixed", "consultation"]);
const LIMITS = Object.freeze({ components: 40, quantity: 999, scopeText: 600, note: 300, unitLabel: 40 });

const ISSUE_LABELS = Object.freeze({
  package_content_missing: "The package details are missing",
  size_pricing_invalid: "Every size must be fixed-price or by consultation",
  installation_scope_invalid: "Say whether installation is quoted separately or included",
  no_components: "Add at least one component",
  component_unknown: "A component SKU does not exist",
  component_is_package: "A package cannot contain another package",
  component_archived: "A component's product is archived",
  component_not_published: "A component's product is not published internally",
  component_not_in_published_version: "A component SKU is not in its product's published version",
  component_inactive: "A required component is inactive",
  component_discontinued: "A required component is discontinued",
  component_changed: "A component changed since this version was saved (needs re-review: save again to take the current details)",
  quantity_size_unknown: "A component quantity names a size that does not exist",
});

function str(value) { return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : ""; }

function validKind(kind) {
  const k = str(kind || "product").toLowerCase();
  if (!KINDS.includes(k)) throw C.badRequest(`kind must be one of ${KINDS.join(", ")}`);
  return k;
}

// Content of one package version: the product content rules (name, category, sizes as variants, gallery...) plus `package`.
function validatePackageContent(input = {}) {
  const base = C.validateContent(input);
  const errors = [];
  const rawVariants = Array.isArray(input.variants) ? input.variants : [];
  base.variants = base.variants.map((v, index) => {
    const pricing = str(rawVariants[index] && rawVariants[index].pricing).toLowerCase();
    if (!PRICING.includes(pricing)) errors.push(`variants[${index}].pricing must be "fixed" or "consultation"`);
    return { ...v, pricing };
  });
  const sizes = new Set(base.variants.map((v) => v.sku));
  const raw = input.package && typeof input.package === "object" && !Array.isArray(input.package) ? input.package : null;
  if (!raw) throw C.badRequest("invalid package content", ["package details are required"]);

  const solutionTypes = [...new Set((Array.isArray(raw.solution_types) ? raw.solution_types : []).map((s) => str(s).toLowerCase()))];
  solutionTypes.filter((s) => !SOLUTION_TYPES.includes(s)).forEach((s) => errors.push(`unknown solution type "${s}"`));
  if (!solutionTypes.length) errors.push("choose at least one solution type");

  const scopeIn = raw.scope && typeof raw.scope === "object" ? raw.scope : {};
  const scope = {
    hardware: str(scopeIn.hardware).slice(0, LIMITS.scopeText + 1),
    software_deployment: str(scopeIn.software_deployment).slice(0, LIMITS.scopeText + 1),
    installation: str(scopeIn.installation).toLowerCase(),
    installation_note: str(scopeIn.installation_note).slice(0, LIMITS.scopeText + 1),
  };
  if (!scope.hardware) errors.push("scope.hardware: describe the hardware the package covers");
  if (!scope.software_deployment) errors.push("scope.software_deployment: describe the Oyi deployment (it is always by consultation)");
  ["hardware", "software_deployment", "installation_note"].forEach((k) => { if (scope[k].length > LIMITS.scopeText) errors.push(`scope.${k} is longer than ${LIMITS.scopeText} characters`); });
  if (!INSTALLATION.includes(scope.installation)) errors.push(`scope.installation must be ${INSTALLATION.join(" or ")}`);

  const cfgIn = raw.configuration && typeof raw.configuration === "object" ? raw.configuration : {};
  const configuration = { custom: cfgIn.custom === true, per_unit_label: str(cfgIn.per_unit_label).slice(0, LIMITS.unitLabel + 1) };
  if (configuration.per_unit_label.length > LIMITS.unitLabel) errors.push(`configuration.per_unit_label is longer than ${LIMITS.unitLabel} characters`);

  const list = Array.isArray(raw.components) ? raw.components : null;
  const components = [];
  if (!list || !list.length) errors.push("add at least one component");
  else if (list.length > LIMITS.components) errors.push(`at most ${LIMITS.components} components`);
  else {
    const seen = new Set();
    list.forEach((item, index) => {
      const sku = str(item && item.sku).toUpperCase();
      if (!sku) errors.push(`components[${index}].sku is required`);
      if (seen.has(sku)) errors.push(`component ${sku} appears twice`);
      seen.add(sku);
      if (sizes.has(sku)) errors.push(`components[${index}] is one of this package's own sizes`);
      const role = str(item && item.role).toLowerCase();
      if (!ROLES.includes(role)) errors.push(`components[${index}].role must be ${ROLES.join(", ")}`);
      const basis = str(item && item.basis || "fixed").toLowerCase();
      if (!BASES.includes(basis)) errors.push(`components[${index}].basis must be fixed or per_unit`);
      if (basis === "per_unit" && !configuration.per_unit_label) errors.push(`components[${index}] is per unit: set configuration.per_unit_label (e.g. "per door")`);
      const quantity = Number(item?.quantity == null ? 1 : item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.quantity) errors.push(`components[${index}].quantity must be 1-${LIMITS.quantity}`);
      const quantities = {};
      const rawQ = item && item.quantities && typeof item.quantities === "object" && !Array.isArray(item.quantities) ? item.quantities : {};
      Object.entries(rawQ).forEach(([size, n]) => {
        const key = str(size).toUpperCase();
        if (!sizes.has(key)) errors.push(`components[${index}].quantities names ${key || "an empty size"}, which is not a size of this package`);
        if (!Number.isInteger(Number(n)) || Number(n) < 0 || Number(n) > LIMITS.quantity) errors.push(`components[${index}].quantities.${key} must be 0-${LIMITS.quantity}`);
        quantities[key] = Number(n);
      });
      const note = str(item && item.note);
      if (note.length > LIMITS.note) errors.push(`components[${index}].note is longer than ${LIMITS.note} characters`);
      const snap = item && item.snapshot && typeof item.snapshot === "object" ? item.snapshot : null;
      components.push({ sku, role, basis, quantity, quantities, note, snapshot: snap ? { product_version: snap.product_version ?? null, price_kobo: snap.price_kobo ?? null } : null });
    });
  }
  if (errors.length) throw C.badRequest("invalid package content", errors);
  return { ...base, package: { solution_types: solutionTypes, scope, configuration, components } };
}

function validateItemContent(kind, input) {
  return kind === "package" ? validatePackageContent(input) : C.validateContent(input);
}

// lookup: Map sku -> { variant, product, content } (content = the component product's PUBLISHED version content, or null)
// Records what each component was at save time; drift against this snapshot means "needs re-review".
function snapshotComponents(content, lookup) {
  if (!content.package) return content;
  const components = content.package.components.map((c) => {
    const hit = lookup.get(c.sku);
    return { ...c, snapshot: hit ? { product_version: hit.product.published_version ?? null, price_kobo: hit.variant.price_ngn_kobo ?? null } : null };
  });
  return { ...content, package: { ...content.package, components } };
}

const kindOf = (product) => (product && product.kind) || "product";

// Blocking issues of a package version (mirror of catalogue_package_issues): [{ code, sku? }]
function packageIssues(content, lookup) {
  const pkg = content && content.package;
  if (!pkg) return [{ code: "package_content_missing" }];
  const issues = [];
  const sizes = new Set((content.variants || []).map((v) => v.sku));
  if ((content.variants || []).some((v) => !PRICING.includes(v.pricing))) issues.push({ code: "size_pricing_invalid" });
  if (!INSTALLATION.includes(pkg.scope && pkg.scope.installation)) issues.push({ code: "installation_scope_invalid" });
  if (!Array.isArray(pkg.components) || !pkg.components.length) return [...issues, { code: "no_components" }];
  for (const comp of pkg.components) {
    const hit = lookup.get(comp.sku);
    if (!hit) { issues.push({ code: "component_unknown", sku: comp.sku }); continue; }
    const { variant, product, content: published } = hit;
    if (kindOf(product) === "package") { issues.push({ code: "component_is_package", sku: comp.sku }); continue; }
    if (product.publication_status === "archived") { issues.push({ code: "component_archived", sku: comp.sku }); continue; }
    if (product.publication_status !== "published" || product.published_version == null) { issues.push({ code: "component_not_published", sku: comp.sku }); continue; }
    if (!published || !(published.variants || []).some((v) => v.sku === comp.sku)) { issues.push({ code: "component_not_in_published_version", sku: comp.sku }); continue; }
    if (comp.role === "required" && variant.status !== "active") issues.push({ code: "component_inactive", sku: comp.sku });
    else if (comp.role === "required" && variant.sourcing === "discontinued") issues.push({ code: "component_discontinued", sku: comp.sku });
    const snap = comp.snapshot || {};
    if (String(snap.product_version ?? "") !== String(product.published_version ?? "") || String(snap.price_kobo ?? "") !== String(variant.price_ngn_kobo ?? "")) {
      issues.push({ code: "component_changed", sku: comp.sku });
    }
    Object.keys(comp.quantities || {}).filter((k) => !sizes.has(k)).forEach((size) => issues.push({ code: "quantity_size_unknown", sku: comp.sku, size }));
  }
  return issues;
}

// Non-blocking: optional/recommended components that are unavailable, required components out of stock (still orderable).
function packageWarnings(content, lookup) {
  const warnings = [];
  for (const comp of (content.package && content.package.components) || []) {
    const hit = lookup.get(comp.sku);
    if (!hit) continue;
    const availability = componentAvailability(hit);
    if (comp.role !== "required" && availability === "unavailable") warnings.push({ code: "optional_component_unavailable", sku: comp.sku });
    if (comp.role === "required" && availability === "available_to_order") warnings.push({ code: "required_component_not_in_stock", sku: comp.sku });
  }
  return warnings;
}

function componentAvailability(hit) {
  if (!hit || hit.product.publication_status !== "published" || kindOf(hit.product) === "package") return "unavailable";
  if (kindOf(hit.product) === "service") return hit.variant.status === "active" && hit.variant.sourcing !== "discontinued" ? "in_stock" : "unavailable";
  return variantAvailability(hit.variant);
}

// Derived availability of the package: any required component unavailable -> unavailable; all required in stock -> in_stock;
// otherwise available to order. Optional and recommended components never change it.
function packageAvailability(content, lookup) {
  const required = ((content.package && content.package.components) || []).filter((c) => c.role === "required");
  if (!required.length) return "unavailable";
  const states = required.map((c) => componentAvailability(lookup.get(c.sku)));
  if (states.includes("unavailable")) return "unavailable";
  return states.every((s) => s === "in_stock") ? "in_stock" : "available_to_order";
}

function quantityFor(comp, sizeSku) {
  return Object.prototype.hasOwnProperty.call(comp.quantities || {}, sizeSku) ? comp.quantities[sizeSku] : comp.quantity;
}

// Staff readiness view. costs (optional, only for catalogue.cost.read holders): Map variantId -> latest landed cost (kobo).
function packageReadiness(content, lookup, { sizeRecords = [], costs = null } = {}) {
  const issues = packageIssues(content, lookup);
  const warnings = packageWarnings(content, lookup);
  const components = ((content.package && content.package.components) || []).map((comp) => {
    const hit = lookup.get(comp.sku);
    const published = hit && hit.content;
    const listed = published && (published.variants || []).find((v) => v.sku === comp.sku);
    return {
      sku: comp.sku, role: comp.role, basis: comp.basis, quantity: comp.quantity, quantities: { ...comp.quantities }, note: comp.note,
      kind: hit ? kindOf(hit.product) : null,
      product_id: hit ? hit.product.id : null,
      name: published ? `${published.name}${listed && listed.name && listed.name !== published.name ? ` — ${listed.name}` : ""}` : null,
      availability: hit ? componentAvailability(hit) : "unavailable",
      price_kobo: hit ? hit.variant.price_ngn_kobo ?? null : null,
      changed: issues.some((i) => i.sku === comp.sku && i.code === "component_changed"),
      issues: issues.filter((i) => i.sku === comp.sku).map((i) => i.code),
    };
  });
  const records = new Map(sizeRecords.map((r) => [r.sku, r]));
  const sizes = (content.variants || []).map((size) => {
    const record = records.get(size.sku) || {};
    const lines = components.filter((c) => c.role === "required").map((c) => ({ ...c, qty: quantityFor(c, size.sku) }));
    const componentPrice = lines.every((l) => Number.isSafeInteger(l.price_kobo)) ? lines.reduce((sum, l) => sum + l.price_kobo * l.qty, 0) : null;
    const view = {
      sku: size.sku, name: size.name, pricing: size.pricing,
      price_kobo: record.price_ngn_kobo ?? null,
      required_components_price_kobo: componentPrice,
      issue: size.pricing === "consultation" && record.price_ngn_kobo != null ? "consultation_size_priced" : size.pricing === "fixed" && record.price_ngn_kobo == null ? "price_not_approved" : null,
    };
    if (costs) {
      const lineCosts = lines.map((l) => (hitVariantId(lookup, l.sku) && costs.has(hitVariantId(lookup, l.sku)) ? costs.get(hitVariantId(lookup, l.sku)) * l.qty : null));
      const cost = lineCosts.every((x) => Number.isSafeInteger(x)) ? lineCosts.reduce((a, b) => a + b, 0) : null;
      view.required_components_cost_kobo = cost;
      view.margin_kobo = cost != null && view.price_kobo != null ? C.withMargin({ landed_cost_kobo: cost }, record).margin_kobo : null;
    }
    return view;
  });
  return { issues, warnings, availability: packageAvailability(content, lookup), components, sizes, ready: issues.length === 0 };
}

function hitVariantId(lookup, sku) { const hit = lookup.get(sku); return hit ? hit.variant.id : null; }

// ---- public projection (allow-list; called from catalogue-public-api.js) ---------------------------------------------------------
// sizeRecords: the package's own variant rows. lookup: component sku -> { variant, product, content (published), category, brand }.
function publicPackage({ slug, version, content, sizeRecords, lookup, images, category, releasedAt }) {
  const pkg = content.package || {};
  const records = new Map((sizeRecords || []).map((r) => [r.sku, r]));
  const availability = packageAvailability(content, lookup);
  const sizes = (content.variants || []).map((size) => {
    const record = records.get(size.sku);
    if (!record || record.status !== "active") return null;
    const priced = size.pricing === "fixed" && Number.isSafeInteger(record.price_ngn_kobo) && record.vat_treatment;
    return {
      sku: size.sku, name: size.name, options: { ...(size.options || {}) },
      pricing: priced ? "fixed" : "consultation",
      price: priced ? { amount_kobo: record.price_ngn_kobo, currency: "NGN", vat_inclusive: true, vat_treatment: record.vat_treatment } : null,
    };
  }).filter(Boolean);
  const components = (pkg.components || []).map((comp) => {
    const hit = lookup.get(comp.sku);
    const published = hit && hit.content;
    if (!published) return null;
    const listed = (published.variants || []).find((v) => v.sku === comp.sku);
    return {
      name: published.name || "",
      option: listed && listed.name !== published.name ? listed.name : "",
      model: published.model || "",
      brand: hit.brand ? hit.brand.name : "",
      kind: kindOf(hit.product) === "service" ? "service" : "hardware",
      role: comp.role,
      basis: comp.basis,
      quantity: comp.quantity,
      quantities: Object.fromEntries(Object.entries(comp.quantities || {}).filter(([k]) => sizes.some((s) => s.sku === k))),
      // a link only when that product is itself public on GetOyi
      product_slug: hit.public_slug || null,
    };
  }).filter(Boolean);
  const prices = sizes.filter((s) => s.price).map((s) => s.price.amount_kobo);
  return {
    kind: "package",
    version,
    slug,
    name: content.name || "",
    summary: content.summary || "",
    description: content.description || "",
    category: category ? { slug: category.slug, name: category.name } : null,
    solution_types: [...(pkg.solution_types || [])],
    scope: {
      hardware: (pkg.scope && pkg.scope.hardware) || "",
      software_deployment: (pkg.scope && pkg.scope.software_deployment) || "",
      software_pricing: "consultation",
      installation: (pkg.scope && pkg.scope.installation) || "quoted_separately",
      installation_note: (pkg.scope && pkg.scope.installation_note) || "",
    },
    configuration: { custom: Boolean(pkg.configuration && pkg.configuration.custom), per_unit_label: (pkg.configuration && pkg.configuration.per_unit_label) || "" },
    sizes,
    components,
    price_from_kobo: prices.length ? Math.min(...prices) : null,
    price_to_kobo: prices.length ? Math.max(...prices) : null,
    availability,
    compatibility: {
      facility: Boolean(content.compatibility && content.compatibility.facility),
      experience: Boolean(content.compatibility && content.compatibility.experience),
      notes: (content.compatibility && content.compatibility.notes) || "",
    },
    images,
    cover: images[0] || null,
    updated_at: releasedAt || null,
  };
}

function publicPackageCard(view) {
  return {
    kind: "package", slug: view.slug, name: view.name, summary: view.summary, solution_types: view.solution_types,
    price_from_kobo: view.price_from_kobo, price_to_kobo: view.price_to_kobo, availability: view.availability,
    installation: view.scope.installation, consultation_only: view.sizes.every((s) => s.pricing === "consultation"), cover: view.cover, updated_at: view.updated_at,
  };
}

module.exports = {
  BASES, INSTALLATION, ISSUE_LABELS, KINDS, LIMITS, PRICING, ROLES, SOLUTION_TYPES,
  componentAvailability, kindOf, packageAvailability, packageIssues, packageReadiness, packageWarnings, publicPackage, publicPackageCard,
  quantityFor, snapshotComponents, validKind, validateItemContent, validatePackageContent,
};
