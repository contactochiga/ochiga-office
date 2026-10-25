"use strict";

// Internal Office product-management API (03_CATALOGUE_SPECIFICATION.md §4, Phase 1). Mounted under /api/lead-agents/admin/catalogue/.
// Staff session only (API keys refused on every route), every permission checked per action, every write audited (appendAuditRecord)
// and every state change conditional on the caller's expected row_version (409 state_changed with the current state otherwise).
// No public route lives here: the public projection, previews and checkout are later stages.

const { json, readJsonBody, readRawBodyBuffer } = require("./http");
const { appendAuditRecord } = require("./audit");
const { canonicalRole, hasPermission } = require("./permissions");
const { notifyRecipients } = require("./office-operating-system");
const { catalogueStoreFor } = require("./catalogue-store");
const C = require("./catalogue");
const M = require("./catalogue-media");
const PUB = require("./catalogue-public");
const { refreshPublic } = require("./catalogue-public-api");

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

const MEDIA_URL = (mediaId, kind) => `${PREFIX}/media/${mediaId}/${kind}`;

// The product's image library: every upload with its renditions' URLs (authenticated Office URLs; nothing is public) and the versions
// that reference it (referenced images cannot be removed).
async function mediaLibrary(cat, productId) {
  if (!(await cat.mediaAvailable())) return { available: false, items: [] };
  const [rows, refs] = await Promise.all([cat.listMedia(productId), cat.mediaReferences(productId)]);
  return {
    available: true,
    items: rows.map((m) => ({
      id: m.id, status: m.status, format: m.format, width: m.width, height: m.height, bytes: m.bytes, original_name: m.original_name,
      uploaded_by: m.uploaded_by, created_at: m.created_at, removed_at: m.removed_at || null,
      referenced_by_versions: refs.get(m.id) || [],
      urls: m.status === "active" ? Object.fromEntries((m.derivatives || []).map((d) => [d.kind, MEDIA_URL(m.id, d.kind)])) : {},
    })),
  };
}

// GetOyi public state of one product, for the editor. effective: not_public | public | withdrawn | hidden (listed public but no longer
// internally published: the projection already hides it).
async function publicState(cat, product, config) {
  if (!(await cat.publicAvailable())) return { available: false };
  const [listing, requirements, events, redirects] = await Promise.all([
    cat.getPublicListing(product.id), cat.publicRequirements(product.id), cat.listPublicEvents(product.id), cat.listSlugRedirects(product.id),
  ]);
  const internallyPublished = product.publication_status === "published";
  const effective = !listing ? "not_public" : listing.status === "withdrawn" ? "withdrawn" : internallyPublished ? "public" : "hidden";
  const issues = Array.isArray(requirements) ? requirements : [];
  return {
    available: true,
    effective,
    listing: listing ? {
      status: listing.status, public_version: listing.public_version, slug: listing.slug, row_version: listing.row_version, released_at: listing.released_at, released_by: listing.released_by,
      withdrawn_at: listing.withdrawn_at, withdrawn_by: listing.withdrawn_by, withdrawn_reason: listing.withdrawn_reason,
      refresh_status: listing.refresh_status, refresh_attempts: listing.refresh_attempts, refresh_completed_at: listing.refresh_completed_at, refresh_error: listing.refresh_error,
    } : null,
    public_url: listing && config ? `${config.getoyiPublicBaseUrl}/hardware/${listing.slug}` : null,
    requirements: issues.map((code) => ({ code, label: PUB.REQUIREMENT_LABELS[code] || code })),
    releasable: issues.length === 0 && !(listing && listing.status === "public" && listing.public_version === product.published_version && listing.slug === product.slug),
    update_available: Boolean(listing && listing.status === "public" && product.published_version && product.published_version !== listing.public_version),
    events,
    redirects: redirects.map((r) => ({ old_slug: r.old_slug, created_at: r.created_at, created_by: r.created_by })),
  };
}

async function productDetail(cat, product, authContext, config) {
  const [version, versions, reviews, events, variants, media, publicInfo] = await Promise.all([
    cat.getVersion(product.id, product.current_version),
    cat.listVersions(product.id),
    cat.listReviews(product.id),
    cat.listPublicationEvents(product.id),
    cat.listVariants(product.id),
    mediaLibrary(cat, product.id),
    publicState(cat, product, config),
  ]);
  return {
    product,
    status: C.displayStatus(product),
    content: version ? version.content : null,
    media_library: media,
    gallery_readiness: C.galleryReadiness(version ? version.content : {}),
    public: publicInfo,
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
// Deletes stored objects that are no longer (or never were) registered as catalogue media; best effort, never throws.
async function discardObjects(storageService, store, files) {
  for (const file of files) {
    try { await storageService.deleteObject(file.filename); } catch { /* left for manual cleanup; the audit names the media id */ }
    if (file.id && typeof store.deleteOfficeFile === "function") await Promise.resolve(store.deleteOfficeFile(file.id)).catch(() => null);
  }
}

async function storeUpload(storageService, store, input) {
  const raw = await storageService.putBuffer(input);
  return typeof store.createOfficeFile === "function" ? (await store.createOfficeFile(raw)) || raw : raw;
}

async function handleCatalogueRequest({ req, res, ctx, pathname, authContext, store, eventBus, storageService, config = {}, log = () => {} }) {
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
    let m;

    // ------------------------------------------------------------------------------------------------ gallery media
    // upload: the raw image bytes as the request body (no JSON, no data URL); everything about the file is learned from its content
    if ((m = sub.match(/^\/products\/([^/]+)\/media$/)) && method === "POST") {
      need(P.write);
      if (!storageService) throw C.httpError(503, "media_unavailable");
      if (!(await cat.mediaAvailable())) throw C.httpError(503, "media_unavailable");
      const product = C.isUuid(m[1]) ? await cat.getProduct(m[1]) : null;
      if (!product) return send(404, { error: "product_not_found" }), true;
      if (product.publication_status === "archived") throw C.httpError(409, "product_archived");
      const declared = Number(req.headers["content-length"] || 0);
      const url = new URL(req.url, "http://localhost");
      const originalName = M.safeOriginalName(url.searchParams.get("name"));
      let processed, bytes;
      try {
        if (declared > M.MEDIA_LIMITS.maxBytes) throw C.httpError(413, "image_too_large");
        bytes = await readRawBodyBuffer(req, M.MEDIA_LIMITS.maxBytes).catch((error) => { throw error && error.statusCode === 413 ? C.httpError(413, "image_too_large") : error; });
        // a retry of bytes this product already has: answer from the library without decoding or storing anything
        const digest = M.sha256(bytes);
        const known = (await cat.listMedia(product.id)).find((item) => item.status === "active" && item.sha256 === digest);
        if (known) {
          await audit("catalogue_media_uploaded", "catalogue_product", product.id, { media_id: known.id, sha256: digest, format: known.format, width: known.width, height: known.height, bytes: known.bytes, deduplicated: true });
          const library = await mediaLibrary(cat, product.id);
          return send(200, { media: library.items.find((item) => item.id === known.id), deduplicated: true }), true;
        }
        processed = await M.processProductImage(bytes);
      } catch (error) {
        const status = Number(error && error.statusCode) || 500;
        if (status < 500 || error.code === "media_busy") {
          await audit("catalogue_media_rejected", "catalogue_product", product.id, { reason: error.code || "rejected", declared_bytes: declared || null });
        }
        if (error && error.code === "media_busy") res.setHeader("retry-after", "5");
        throw error;
      }
      const stored = [];
      let media;
      try {
        const original = await storeUpload(storageService, store, { buffer: bytes, purpose: "product_image", mime_type: processed.mime_type, extension: processed.extension, resource_type: "catalogue_media", resource_id: product.id, metadata: { product_id: product.id, role: "original", sha256: processed.sha256 } });
        stored.push(original);
        const derivatives = [];
        for (const d of processed.derivatives) {
          const file = await storeUpload(storageService, store, { buffer: d.buffer, purpose: "product_image", mime_type: "image/webp", extension: ".webp", resource_type: "catalogue_media", resource_id: product.id, metadata: { product_id: product.id, role: d.kind, sha256: d.sha256 } });
          stored.push(file);
          derivatives.push({ kind: d.kind, office_file_id: file.id, width: d.width, height: d.height, bytes: d.bytes, sha256: d.sha256 });
        }
        media = await cat.registerMedia({ productId: product.id, officeFileId: original.id, sha256: processed.sha256, format: processed.format, width: processed.width, height: processed.height, bytes: processed.bytes, originalName, derivatives, actor });
      } catch (error) {
        await discardObjects(storageService, store, stored);
        throw error;
      }
      if (media.deduplicated) await discardObjects(storageService, store, stored);
      await audit("catalogue_media_uploaded", "catalogue_product", product.id, { media_id: media.id, sha256: media.sha256, format: media.format, width: media.width, height: media.height, bytes: media.bytes, deduplicated: Boolean(media.deduplicated) });
      const library = await mediaLibrary(cat, product.id);
      return send(media.deduplicated ? 200 : 201, { media: library.items.find((item) => item.id === media.id), deduplicated: Boolean(media.deduplicated) }), true;
    }

    const body = method === "POST" || method === "PATCH" || method === "PUT" ? await readJsonBody(req, 256 * 1024) : {};
    if (body && (typeof body !== "object" || Array.isArray(body))) throw C.badRequest("body must be an object");

    if ((m = sub.match(/^\/products\/([^/]+)\/media$/))) {
      if (method !== "GET") return send(405, { error: "method_not_allowed" }), true;
      const product = C.isUuid(m[1]) ? await cat.getProduct(m[1]) : null;
      if (!product) return send(404, { error: "product_not_found" }), true;
      return send(200, { media_library: await mediaLibrary(cat, product.id) }), true;
    }
    if ((m = sub.match(/^\/media\/([^/]+)\/remove$/))) {
      if (method !== "POST") return send(405, { error: "method_not_allowed" }), true;
      need(P.write);
      if (!(await cat.mediaAvailable())) throw C.httpError(503, "media_unavailable");
      const media = C.isUuid(m[1]) ? await cat.getMedia(m[1]) : null;
      if (!media) return send(404, { error: "media_not_found" }), true;
      try {
        await cat.removeMedia({ mediaId: media.id, actor });
      } catch (error) {
        if (error && error.code === "media_referenced") await audit("catalogue_media_removal_refused", "catalogue_product", media.product_id, { media_id: media.id, reason: "media_referenced" });
        throw error;
      }
      // never referenced by any version, so its bytes can go; the metadata rows stay (the database keeps them for the record)
      if (storageService) {
        const files = (typeof store.listOfficeFilesByResource === "function" ? await store.listOfficeFilesByResource("catalogue_media", media.product_id).catch(() => []) : [])
          .filter((f) => f.id === media.office_file_id || (media.derivatives || []).some((d) => d.office_file_id === f.id));
        for (const file of files) await storageService.deleteObject(file.filename).catch(() => null);
      }
      await audit("catalogue_media_removed", "catalogue_product", media.product_id, { media_id: media.id, sha256: media.sha256 });
      return send(200, { media_library: await mediaLibrary(cat, media.product_id) }), true;
    }
    // serving: processed WebP renditions only, to staff with catalogue.read; the original upload has no route at all
    if ((m = sub.match(/^\/media\/([^/]+)\/([a-z0-9]+)$/))) {
      if (method !== "GET") return send(405, { error: "method_not_allowed" }), true;
      if (!M.DERIVATIVE_KINDS.includes(m[2]) || !C.isUuid(m[1])) return send(404, { error: "not_found" }), true;
      if (!storageService || !(await cat.mediaAvailable())) return send(404, { error: "not_found" }), true;
      const file = await cat.getMediaFile(m[1], m[2]);
      if (!file || file.status !== "active") return send(404, { error: "not_found" }), true;
      const object = await storageService.getObject(file.filename);
      if (!object) return send(404, { error: "not_found" }), true;
      res.writeHead(200, {
        "content-type": "image/webp",
        "content-length": String(object.buffer.length),
        // renditions never change (a new image is a new id); private: browser only, no shared cache
        "cache-control": "private, max-age=86400, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
        "content-disposition": "inline",
        "referrer-policy": "no-referrer",
        "x-request-id": ctx.requestId,
      });
      res.end(object.buffer);
      return true;
    }

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
        // browse mode (catalogue table): statistics over the whole catalogue, then filter, sort and paginate on the server
        if (url.searchParams.get("view") === "cards") {
          const { products, contents, variants, truncated } = await cat.listProductCards();
          const cards = products.map((p) => C.productCard(p, contents.get(p.id) || {}, variants.get(p.id) || []));
          const query = Object.fromEntries(["q", "category_id", "brand_id", "status", "availability", "sort", "dir", "page", "page_size"].map((k) => [k, url.searchParams.get(k) || undefined]));
          return send(200, { ...C.browseCards(cards, query), truncated }), true;
        }
        const products = await cat.listProducts({ workflowStatus: url.searchParams.get("workflow_status") || undefined, publicationStatus: url.searchParams.get("publication_status") || undefined });
        const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
        return send(200, { products: q ? products.filter((p) => `${p.name} ${p.model} ${p.slug}`.toLowerCase().includes(q)) : products }), true;
      }
      if (method === "POST") {
        need(P.write);
        const slug = C.validSlug(body.slug);
        if (!slug) throw C.badRequest("slug must be lowercase letters, digits and single hyphens (max 80)");
        const content = C.validateContent(body.content);
        if (content.media.length) throw C.badRequest("add images after the product is created");
        await referencesExist(cat, content);
        const product = await cat.createProduct({ slug, categoryId: content.category_id, brandId: content.brand_id, content, actor });
        await audit("catalogue_product_created", "catalogue_product", product.id, { slug, version: 1 });
        return send(201, await productDetail(cat, product, authContext, config)), true;
      }
      return send(405, { error: "method_not_allowed" }), true;
    }

    if ((m = sub.match(/^\/products\/([^/]+)$/))) {
      const id = m[1];
      const product = await cat.getProduct(id);
      if (!product) return send(404, { error: "product_not_found" }), true;
      if (method === "GET") return send(200, await productDetail(cat, product, authContext, config)), true;
      if (method === "PATCH") {
        need(P.write);
        const expected = expectedRowVersion(body);
        const slug = body.slug === undefined ? product.slug : C.validSlug(body.slug);
        if (!slug) throw C.badRequest("slug must be lowercase letters, digits and single hyphens (max 80)");
        const content = C.validateContent(body.content);
        await referencesExist(cat, content);
        if (content.media.length && !(await cat.mediaAvailable())) throw C.httpError(503, "media_unavailable");
        const published = product.published_version ? await cat.getVersion(id, product.published_version) : null;
        const materiality = C.materialityOf(published ? published.content : null, content);
        const updated = await cat.saveVersion({ id, expectedRowVersion: expected, slug, categoryId: content.category_id, brandId: content.brand_id, content, materiality, actor });
        const before = await cat.getVersion(id, product.current_version);
        const galleryChanges = C.diffContent({ media: (before && before.content.media) || [] }, { media: content.media }).length;
        await audit("catalogue_product_edited", "catalogue_product", id, { version: updated.current_version, materiality, ...(galleryChanges ? { gallery_changes: galleryChanges, images: content.media.length } : {}) });
        return send(200, await productDetail(cat, updated, authContext, config)), true;
      }
      return send(405, { error: "method_not_allowed" }), true;
    }

    // ------------------------------------------------------------------------------------------------ public release to GetOyi (stage 4)
    if ((m = sub.match(/^\/products\/([^/]+)\/(public\/release|public\/withdraw|public\/refresh|slug|preview)$/))) {
      const [, id, action] = m;
      if (method !== "POST") return send(405, { error: "method_not_allowed" }), true;
      const product = C.isUuid(id) ? await cat.getProduct(id) : null;
      if (!product) return send(404, { error: "product_not_found" }), true;
      if (!(await cat.publicAvailable())) throw C.httpError(503, "public_unavailable");
      const listingVersion = () => {
        const value = body.expected_listing_row_version;
        if (!Number.isInteger(value) || value < 0) throw C.badRequest("expected_listing_row_version (0 when the product was never public) is required");
        return value;
      };
      if (action === "preview") {
        // any catalogue reader may preview; the link is bound to this version, this staff member and 10 minutes, and dies on archive
        const grant = await cat.createPreviewGrant({ productId: id, staff: actor, ttlSeconds: PUB.PREVIEW_TTL_SECONDS });
        const token = PUB.previewToken(config, grant.id);
        await audit("catalogue_preview_created", "catalogue_product", id, { grant_id: grant.id, version: grant.version, expires_at: grant.expires_at });
        return send(201, { url: `${config.getoyiPublicBaseUrl || ""}/hardware/preview/${token}`, version: grant.version, expires_at: grant.expires_at }), true;
      }
      if (action === "public/release") {
        need(P.publicPublish);
        const listing = await cat.publicRelease({ productId: id, expectedProductRowVersion: expectedRowVersion(body), expectedListingRowVersion: listingVersion(), actor });
        await audit("catalogue_public_released", "catalogue_product", id, { version: listing.public_version, slug: listing.slug, row_version: listing.row_version });
        await refreshPublic({ store, config, productId: id, event: "released", log });
      } else if (action === "public/withdraw") {
        // taking a product off GetOyi is the safe direction: a publisher may do it too
        if (!hasPermission(authContext, P.publicPublish)) need(P.publish);
        const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
        const listing = await cat.publicWithdraw({ productId: id, expectedListingRowVersion: listingVersion(), actor, reason });
        await audit("catalogue_public_withdrawn", "catalogue_product", id, { version: listing.public_version, slug: listing.slug, ...(reason ? { reason } : {}) });
        await refreshPublic({ store, config, productId: id, event: "withdrawn", log });
      } else if (action === "public/refresh") {
        if (!hasPermission(authContext, P.publicPublish)) need(P.publish);
        if (!(await cat.getPublicListing(id))) throw C.httpError(409, "not_public");
        await audit("catalogue_public_refresh_retried", "catalogue_product", id, {});
        await refreshPublic({ store, config, productId: id, event: "retry", log, newRound: true });
      } else {
        need(P.publicPublish);
        const slug = C.validSlug(body.slug);
        if (!slug) throw C.badRequest("slug must be lowercase letters, digits and single hyphens (max 80)");
        const from = product.slug;
        await cat.changeSlug({ productId: id, expectedRowVersion: expectedRowVersion(body), slug, actor });
        await audit("catalogue_slug_changed", "catalogue_product", id, { from, to: slug });
        await refreshPublic({ store, config, productId: id, event: "slug_changed", log });
      }
      return send(200, await productDetail(cat, await cat.getProduct(id), authContext, config)), true;
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
        // images belong to one product: the copy starts with an empty gallery
        const content = C.validateContent({ ...source.content, variants, media: [], name: body.name || `${source.content.name} (copy)` });
        const copy = await cat.createProduct({ slug, categoryId: content.category_id, brandId: content.brand_id, content, actor });
        await audit("catalogue_product_duplicated", "catalogue_product", copy.id, { source_product_id: id, source_version: product.current_version, slug });
        return send(201, await productDetail(cat, copy, authContext, config)), true;
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
      if ((action === "unpublish" || action === "archive") && (await cat.publicAvailable())) {
        // the public projection already hides it (internal state is part of the public check); tell GetOyi now rather than at expiry
        const listing = await cat.getPublicListing(id);
        if (listing && listing.status === "public") await refreshPublic({ store, config, productId: id, event: action === "archive" ? "archived" : "unpublished_internally", log, newRound: true });
        if (action === "archive") {
          const revoked = await cat.revokePreviewGrants({ productId: id, actor });
          if (revoked) await audit("catalogue_previews_revoked", "catalogue_product", id, { count: revoked, reason: "archived" });
        }
      }
      return send(200, await productDetail(cat, updated, authContext, config)), true;
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
        if (await cat.publicAvailable()) {
          const listing = await cat.getPublicListing(variant.product_id);
          if (listing && listing.status === "public") await refreshPublic({ store, config, productId: variant.product_id, event: "price_changed", log, newRound: true });
        }
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
