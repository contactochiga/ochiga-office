"use strict";

// Internal Office product-management API (03_CATALOGUE_SPECIFICATION.md §4, Phase 1). Mounted under /api/lead-agents/admin/catalogue/.
// Staff session only (API keys refused on every route), every permission checked per action, every write audited (appendAuditRecord)
// and every state change conditional on the caller's expected row_version (409 state_changed with the current state otherwise).
// No public route lives here: the public projection, previews and checkout are later stages.

const { json, readJsonBody } = require("./http");
const { appendAuditRecord } = require("./audit");
const { canonicalRole, hasPermission } = require("./permissions");
const { notifyRecipients } = require("./office-operating-system");
const { catalogueStoreFor } = require("./catalogue-store");
const C = require("./catalogue");

const P = C.CATALOGUE_PERMISSIONS;
const PREFIX = "/api/lead-agents/admin/catalogue";

function expectedRowVersion(body) {
  const value = body && body.expected_row_version;
  if (!Number.isInteger(value) || value < 1) throw C.badRequest("expected_row_version (the row_version you last read) is required");
  return value;
}

function actorOf(authContext) {
  return String(authContext.email || authContext.userId || "").trim().toLowerCase() || "unknown";
}

async function reviewerEmails(store, excluding) {
  const users = typeof store.listAdminUsers === "function" ? await store.listAdminUsers().catch(() => []) : [];
  return users
    .filter((user) => user && user.status !== "inactive" && user.email && user.email.toLowerCase() !== excluding)
    .filter((user) => hasPermission({ type: "session", role: user.role, permissionScopes: user.permission_scopes || [] }, P.review))
    .map((user) => user.email);
}

async function productDetail(cat, product, authContext) {
  const [version, versions, reviews, events, variants] = await Promise.all([
    cat.getVersion(product.id, product.current_version),
    cat.listVersions(product.id),
    cat.listReviews(product.id),
    cat.listPublicationEvents(product.id),
    cat.listVariants(product.id),
  ]);
  return {
    product,
    content: version ? version.content : null,
    current_materiality: version ? version.materiality : null,
    versions,
    reviews,
    publication_events: events,
    variants: variants.map((v) => C.internalVariant(v, authContext)),
    permissions: Object.fromEntries(Object.entries(P).map(([name, key]) => [name, hasPermission(authContext, key)])),
  };
}

async function referencesExist(cat, content) {
  const category = await cat.getCategory(content.category_id);
  if (!category) throw C.httpError(400, "category_not_found");
  if (content.brand_id && !(await cat.getBrand(content.brand_id))) throw C.httpError(400, "brand_not_found");
}

// Handles a catalogue request; returns false when the path is not a catalogue path.
async function handleCatalogueRequest({ req, res, ctx, pathname, authContext, store, eventBus, log = () => {} }) {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
  const headers = { "x-request-id": ctx.requestId };
  const send = (status, payload) => json(res, status, payload, headers);
  const audit = (action, resourceType, resourceId, metadata) => appendAuditRecord({ store, authContext, action, resourceType, resourceId, metadata, req });
  const method = req.method;
  const sub = pathname.slice(PREFIX.length) || "/";
  try {
    const need = (permission) => C.requireCataloguePermission(authContext, permission);
    // the cheapest refusal first: no staff session, no catalogue
    need(P.read);
    const cat = catalogueStoreFor(store);
    if (!(await cat.available())) return send(503, { error: "catalogue_unavailable", message: "The catalogue database objects are not installed." }), true;
    const actor = actorOf(authContext);
    const body = method === "POST" || method === "PATCH" || method === "PUT" ? await readJsonBody(req, 256 * 1024) : {};
    if (body && (typeof body !== "object" || Array.isArray(body))) throw C.badRequest("body must be an object");
    let m;

    // ------------------------------------------------------------------------------------------------ taxonomy
    if ((m = sub.match(/^\/(categories|brands)$/))) {
      const kind = m[1];
      if (method === "GET") return send(200, { [kind]: kind === "categories" ? await cat.listCategories() : await cat.listBrands() }), true;
      if (method === "POST") {
        need(P.publish);
        const input = C.validateTaxonomyInput(body);
        if (kind === "brands") delete input.parent_id;
        const row = kind === "categories" ? await cat.createCategory(input, actor) : await cat.createBrand(input, actor);
        await audit(`catalogue_${kind === "categories" ? "category" : "brand"}_created`, `catalogue_${kind}`, row.id, { slug: row.slug });
        return send(201, { [kind === "categories" ? "category" : "brand"]: row }), true;
      }
      return send(405, { error: "method_not_allowed" }), true;
    }
    if ((m = sub.match(/^\/(categories|brands)\/([^/]+)$/))) {
      const [, kind, id] = m;
      if (method !== "PATCH") return send(405, { error: "method_not_allowed" }), true;
      need(P.publish);
      const patch = C.validateTaxonomyInput(body, { partial: true });
      if (kind === "brands") delete patch.parent_id;
      if (patch.parent_id && patch.parent_id === id) throw C.badRequest("a category cannot be its own parent");
      const row = kind === "categories" ? await cat.updateCategory(id, expectedRowVersion(body), patch, actor) : await cat.updateBrand(id, expectedRowVersion(body), patch, actor);
      await audit(`catalogue_${kind === "categories" ? "category" : "brand"}_updated`, `catalogue_${kind}`, id, { fields: Object.keys(patch) });
      return send(200, { [kind === "categories" ? "category" : "brand"]: row }), true;
    }

    // ------------------------------------------------------------------------------------------------ products
    if (sub === "/products") {
      if (method === "GET") {
        const url = new URL(req.url, "http://localhost");
        const products = await cat.listProducts({ workflowStatus: url.searchParams.get("workflow_status") || undefined, publicationStatus: url.searchParams.get("publication_status") || undefined });
        const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
        return send(200, { products: q ? products.filter((p) => `${p.name} ${p.model} ${p.slug}`.toLowerCase().includes(q)) : products }), true;
      }
      if (method === "POST") {
        need(P.write);
        const slug = C.validSlug(body.slug);
        if (!slug) throw C.badRequest("slug must be lowercase letters, digits and single hyphens (max 80)");
        const content = C.validateContent(body.content);
        await referencesExist(cat, content);
        const product = await cat.createProduct({ slug, categoryId: content.category_id, brandId: content.brand_id, content, actor });
        await audit("catalogue_product_created", "catalogue_product", product.id, { slug, version: 1 });
        return send(201, await productDetail(cat, product, authContext)), true;
      }
      return send(405, { error: "method_not_allowed" }), true;
    }

    if ((m = sub.match(/^\/products\/([^/]+)$/))) {
      const id = m[1];
      const product = await cat.getProduct(id);
      if (!product) return send(404, { error: "product_not_found" }), true;
      if (method === "GET") return send(200, await productDetail(cat, product, authContext)), true;
      if (method === "PATCH") {
        need(P.write);
        const expected = expectedRowVersion(body);
        const slug = body.slug === undefined ? product.slug : C.validSlug(body.slug);
        if (!slug) throw C.badRequest("slug must be lowercase letters, digits and single hyphens (max 80)");
        const content = C.validateContent(body.content);
        await referencesExist(cat, content);
        const published = product.published_version ? await cat.getVersion(id, product.published_version) : null;
        const materiality = C.materialityOf(published ? published.content : null, content);
        const updated = await cat.saveVersion({ id, expectedRowVersion: expected, slug, categoryId: content.category_id, brandId: content.brand_id, content, materiality, actor });
        await audit("catalogue_product_edited", "catalogue_product", id, { version: updated.current_version, materiality });
        return send(200, await productDetail(cat, updated, authContext)), true;
      }
      return send(405, { error: "method_not_allowed" }), true;
    }

    if ((m = sub.match(/^\/products\/([^/]+)\/(submit|approve|request-changes|publish|unpublish|archive|duplicate)$/))) {
      const [, id, action] = m;
      if (method !== "POST") return send(405, { error: "method_not_allowed" }), true;
      const product = await cat.getProduct(id);
      if (!product) return send(404, { error: "product_not_found" }), true;

      if (action === "duplicate") {
        need(P.write);
        const slug = C.validSlug(body.slug);
        if (!slug) throw C.badRequest("slug for the copy is required");
        const source = await cat.getVersion(id, product.current_version);
        const variantSuffix = String(body.sku_suffix || "").trim().toUpperCase();
        const skus = Array.isArray(body.skus) ? body.skus : null;
        // SKUs are globally unique: the copy needs its own (explicit list, or a suffix appended to every SKU)
        const variants = source.content.variants.map((v, index) => ({ ...v, sku: skus ? String(skus[index] || "") : `${v.sku}${variantSuffix}` }));
        const content = C.validateContent({ ...source.content, variants, name: body.name || `${source.content.name} (copy)` });
        const copy = await cat.createProduct({ slug, categoryId: content.category_id, brandId: content.brand_id, content, actor });
        await audit("catalogue_product_duplicated", "catalogue_product", copy.id, { source_product_id: id, source_version: product.current_version, slug });
        return send(201, await productDetail(cat, copy, authContext)), true;
      }

      const expected = expectedRowVersion(body);
      const note = typeof body.note === "string" ? body.note.trim().slice(0, C.LIMITS.note) : "";
      let overrideReason = "";
      if (action === "submit") need(P.write);
      if (action === "approve" || action === "request-changes") need(P.review);
      if (action === "publish" || action === "unpublish" || action === "archive") need(P.publish);
      if (action === "publish" && body.override_reason !== undefined && body.override_reason !== "") {
        // the administrative exception: catalogue.override AND the super_admin role (a per-user scope alone is not enough)
        need(P.override);
        if (canonicalRole(authContext.role) !== "super_admin") throw C.httpError(403, "override_requires_super_admin");
        // an approved current version is published normally; recording an "override" for it would misstate the audit trail
        if (product.workflow_status === "approved" && product.approved_version === product.current_version) throw C.httpError(400, "override_not_needed");
        overrideReason = C.validateOverrideReason(body.override_reason);
      }
      const dbAction = action === "request-changes" ? "request_changes" : action;
      const updated = await cat.transition({ id, expectedRowVersion: expected, action: dbAction, actor, note, overrideReason });
      const event = { submit: "catalogue_product_submitted", approve: "catalogue_product_approved", "request-changes": "catalogue_product_changes_requested", publish: overrideReason ? "catalogue_product_published_override" : "catalogue_product_published", unpublish: "catalogue_product_unpublished", archive: "catalogue_product_archived" }[action];
      await audit(event, "catalogue_product", id, { version: updated.current_version, published_version: updated.published_version, ...(overrideReason ? { override_reason: overrideReason } : {}), ...(note ? { note } : {}) });
      if (action === "submit") {
        await notifyRecipients(store, eventBus, { recipientEmails: await reviewerEmails(store, actor), actorEmail: actor, type: "catalogue_review_requested", summary: `Product "${updated.slug}" v${updated.current_version} is waiting for review`, relatedType: "catalogue_product", relatedId: id });
      } else if (action === "request-changes") {
        const authors = (await cat.listVersions(id)).filter((v) => v.version > (product.published_version || 0)).map((v) => v.author);
        await notifyRecipients(store, eventBus, { recipientEmails: authors, actorEmail: actor, type: "catalogue_changes_requested", summary: `Changes requested on "${updated.slug}"${note ? `: ${note}` : ""}`, relatedType: "catalogue_product", relatedId: id });
      } else if (action === "publish" && overrideReason) {
        await notifyRecipients(store, eventBus, { recipientEmails: await reviewerEmails(store, actor), actorEmail: actor, type: "catalogue_override_publish", urgency: "high", summary: `"${updated.slug}" v${updated.current_version} was published WITHOUT second review (override): ${overrideReason}`, relatedType: "catalogue_product", relatedId: id });
      }
      return send(200, await productDetail(cat, updated, authContext)), true;
    }

    if ((m = sub.match(/^\/products\/([^/]+)\/versions$/))) {
      if (method !== "GET") return send(405, { error: "method_not_allowed" }), true;
      if (!(await cat.getProduct(m[1]))) return send(404, { error: "product_not_found" }), true;
      return send(200, { versions: await cat.listVersions(m[1]) }), true;
    }
    if ((m = sub.match(/^\/products\/([^/]+)\/versions\/(\d+)$/))) {
      if (method !== "GET") return send(405, { error: "method_not_allowed" }), true;
      const version = await cat.getVersion(m[1], Number(m[2]));
      if (!version) return send(404, { error: "version_not_found" }), true;
      const url = new URL(req.url, "http://localhost");
      const against = url.searchParams.get("diff_to");
      let diff;
      if (against) {
        const other = await cat.getVersion(m[1], Number(against));
        if (!other) return send(404, { error: "version_not_found" }), true;
        diff = C.diffContent(other.content, version.content);
      }
      return send(200, { version, ...(diff ? { diff, diff_from: Number(against) } : {}) }), true;
    }

    // ------------------------------------------------------------------------------------------------ prices
    if ((m = sub.match(/^\/variants\/([^/]+)\/price-changes$/))) {
      const variant = await cat.getVariant(m[1]);
      if (!variant) return send(404, { error: "variant_not_found" }), true;
      if (method === "GET") return send(200, { price_changes: await cat.listPriceChanges({ variantId: variant.id }) }), true;
      if (method !== "POST") return send(405, { error: "method_not_allowed" }), true;
      need(P.write);
      const input = C.validatePriceRequest(body);
      const change = await cat.requestPriceChange({ variantId: variant.id, price: input.price_ngn_kobo, vatTreatment: input.vat_treatment, vatRateBp: input.vat_rate_bp, actor, note: input.note });
      await audit("catalogue_price_change_requested", "catalogue_variant", variant.id, { price_change_id: change.id, sku: variant.sku, old_price_ngn_kobo: change.old_price_ngn_kobo, new_price_ngn_kobo: change.new_price_ngn_kobo, vat_treatment: change.new_vat_treatment });
      return send(201, { price_change: await cat.getPriceChange(change.id) }), true;
    }
    if (sub === "/price-changes") {
      if (method !== "GET") return send(405, { error: "method_not_allowed" }), true;
      const url = new URL(req.url, "http://localhost");
      return send(200, { price_changes: await cat.listPriceChanges({ state: url.searchParams.get("state") || undefined }) }), true;
    }
    if ((m = sub.match(/^\/price-changes\/([^/]+)\/(approve|reject|publish)$/))) {
      const [, id, action] = m;
      if (method !== "POST") return send(405, { error: "method_not_allowed" }), true;
      const change = await cat.getPriceChange(id);
      if (!change) return send(404, { error: "price_change_not_found" }), true;
      const note = typeof body.note === "string" ? body.note.trim().slice(0, C.LIMITS.note) : "";
      if (action === "publish") {
        need(P.publish);
        const variant = await cat.publishPriceChange({ id, actor });
        await audit("catalogue_price_change_published", "catalogue_variant", variant.id, { price_change_id: id, sku: variant.sku, price_ngn_kobo: variant.price_ngn_kobo, vat_treatment: variant.vat_treatment });
      } else {
        need(P.priceApprove);
        await cat.decidePriceChange({ id, decision: action === "approve" ? "approved" : "rejected", actor, note });
        await audit(action === "approve" ? "catalogue_price_change_approved" : "catalogue_price_change_rejected", "catalogue_price_change", id, { variant_id: change.variant_id, ...(note ? { note } : {}) });
      }
      return send(200, { price_change: await cat.getPriceChange(id) }), true;
    }

    // ------------------------------------------------------------------------------------------------ inventory
    if ((m = sub.match(/^\/variants\/([^/]+)\/inventory$/))) {
      const variant = await cat.getVariant(m[1]);
      if (!variant) return send(404, { error: "variant_not_found" }), true;
      if (method === "GET") {
        need(P.inventory);
        return send(200, { variant: C.internalVariant(variant, authContext), changes: await cat.listInventoryChanges(variant.id) }), true;
      }
      if (method !== "PATCH") return send(405, { error: "method_not_allowed" }), true;
      need(P.inventory);
      const { patch, reason } = C.validateInventoryPatch(body, variant);
      if (patch.supplier_id !== undefined && !C.canSeeCosts(authContext)) throw C.httpError(403, "forbidden", { permission: P.costRead });
      if (patch.supplier_id && !(await cat.getSupplier(patch.supplier_id))) throw C.httpError(400, "supplier_not_found");
      const updated = await cat.updateInventory({ variantId: variant.id, expectedRowVersion: expectedRowVersion(body), patch, actor, reason });
      await audit("catalogue_inventory_changed", "catalogue_variant", variant.id, { sku: variant.sku, fields: Object.keys(patch), ...(reason ? { reason } : {}) });
      return send(200, { variant: C.internalVariant(updated, authContext) }), true;
    }

    // ------------------------------------------------------------------------------------------------ suppliers and internal costs
    if (sub === "/suppliers") {
      if (method === "GET") { need(P.costRead); return send(200, { suppliers: await cat.listSuppliers() }), true; }
      if (method !== "POST") return send(405, { error: "method_not_allowed" }), true;
      need(P.costManage);
      const supplier = await cat.createSupplier(C.validateSupplierInput(body), actor);
      await audit("catalogue_supplier_created", "office_supplier", supplier.id, { name: supplier.name });
      return send(201, { supplier }), true;
    }
    if ((m = sub.match(/^\/suppliers\/([^/]+)$/))) {
      if (method === "GET") {
        need(P.costRead);
        const supplier = await cat.getSupplier(m[1]);
        return supplier ? (send(200, { supplier }), true) : (send(404, { error: "supplier_not_found" }), true);
      }
      if (method !== "PATCH") return send(405, { error: "method_not_allowed" }), true;
      need(P.costManage);
      const patch = C.validateSupplierInput(body, { partial: true });
      const supplier = await cat.updateSupplier(m[1], patch);
      await audit("catalogue_supplier_updated", "office_supplier", supplier.id, { fields: Object.keys(patch) });
      return send(200, { supplier }), true;
    }
    if ((m = sub.match(/^\/variants\/([^/]+)\/costs$/))) {
      need(P.costRead);
      const variant = await cat.getVariant(m[1]);
      if (!variant) return send(404, { error: "variant_not_found" }), true;
      if (method === "GET") return send(200, { costs: (await cat.listCosts(variant.id)).map((c) => C.withMargin(c, variant)) }), true;
      if (method !== "POST") return send(405, { error: "method_not_allowed" }), true;
      need(P.costManage);
      const input = C.validateCostRecord(body);
      if (input.supplier_id && !(await cat.getSupplier(input.supplier_id))) throw C.httpError(400, "supplier_not_found");
      const cost = await cat.recordCost({ variant_id: variant.id, supplier_id: input.supplier_id, supplier_cost_kobo: input.supplier_cost_kobo, landed_cost_kobo: input.landed_cost_kobo, recorded_by: actor, note: input.note });
      // amounts deliberately not in the audit metadata (the audit log is readable by audit.read holders who may lack catalogue.cost.read)
      await audit("catalogue_cost_recorded", "catalogue_variant", variant.id, { sku: variant.sku, cost_id: cost.id });
      return send(201, { cost: C.withMargin(cost, variant) }), true;
    }

    return send(404, { error: "not_found" }), true;
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    if (status >= 500) log("error", "catalogue.request_failed", { request_id: ctx.requestId, method, path: pathname, error: String((error && error.code) || (error && error.message) || error).slice(0, 200) });
    send(status, {
      error: (error && error.code) || (status >= 500 ? "internal_server_error" : (error && error.message) || "request_failed"),
      ...(error && error.details ? { details: error.details } : {}),
      ...(error && error.current ? { current: error.current } : {}),
      ...(error && error.permission ? { permission: error.permission } : {}),
      ...(error && error.code === "override_reason_too_short" ? { message: error.message } : {}),
    });
    return true;
  }
}

module.exports = { handleCatalogueRequest, CATALOGUE_PREFIX: PREFIX };
