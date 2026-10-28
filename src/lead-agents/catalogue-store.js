"use strict";

// Catalogue persistence, kept out of the general stores so the catalogue stays isolated until it is reviewed.
//   SupabaseCatalogueStore: PostgREST tables + the SECURITY INVOKER functions of db/20261102_catalogue_foundation.sql (every state change is one
//                           conditional statement in the database; append-only tables are protected by triggers).
//   FileCatalogueStore:     the same rules in memory for the file store (tests, local work). Each check-and-write runs synchronously (no await
//                           in between), so within this single-process store it is atomic, like the receipts implementation.
// Both expose the same methods and raise the same error codes (statusCode + code), so the API layer is store-agnostic.

const crypto = require("crypto");
const { httpError } = require("./catalogue");
// suppliers keep the CORPORATE_COLLECTIONS record shape (office_suppliers); written here so a failed write is an error, never "schema_pending"
const { normalizeCorporateRecord } = require("./office-operating-system");

const SEED_CATEGORIES = Object.freeze([
  ["smart-home-automation", "Smart Home & Automation", 10],
  ["security-access-control", "Security & Access Control", 20],
  ["networking-connectivity", "Networking & Connectivity", 30],
  ["sensors-monitoring", "Sensors & Monitoring", 40],
  ["control-panels-gateways", "Control Panels & Gateways", 50],
  ["installation-accessories", "Installation Accessories", 60],
]);

const nowIso = () => new Date().toISOString();
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function priceChangeState(decisions) {
  if (decisions.some((d) => d.decision === "published")) return "published";
  const decided = decisions.find((d) => d.decision === "approved" || d.decision === "rejected");
  return decided ? decided.decision : "requested";
}

function withPriceState(change, decisions) {
  const own = decisions.filter((d) => d.price_change_id === change.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const decided = own.find((d) => d.decision === "approved" || d.decision === "rejected");
  const published = own.find((d) => d.decision === "published");
  return {
    ...change,
    state: priceChangeState(own),
    decided_by: decided ? decided.actor : null,
    decided_at: decided ? decided.created_at : null,
    decision_note: decided ? decided.note : "",
    published_by: published ? published.actor : null,
    published_at: published ? published.created_at : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------- PostgREST implementation
class SupabaseCatalogueStore {
  constructor(store) {
    this.client = store.client;
    this.capability = null;
    this.capabilityCheckedAt = 0;
  }

  // PostgREST error -> HTTP error with the function's code; PT409 details carry the current state
  fail(error) {
    const response = error && error.response;
    if (!response) throw error;
    const data = response.data || {};
    if (data.code === "PGRST202" || data.code === "42883" || data.code === "42P01" || data.code === "PGRST205" || data.code === "PGRST200") {
      // a missing media object (20261104 not installed or rolled back) disables media only, never the rest of the catalogue
      if (/catalogue_(public|slug_redirect|preview|change_slug|create_preview|revoke_preview)/.test(JSON.stringify(data))) {
        this.publicCapability = false;
        this.publicCheckedAt = Date.now();
        throw httpError(503, "public_unavailable");
      }
      if (/catalogue_(media|register_media|remove_media)/.test(JSON.stringify(data))) {
        this.mediaCapability = false;
        this.mediaCheckedAt = Date.now();
        throw httpError(503, "media_unavailable");
      }
      this.capability = false;
      throw httpError(503, "catalogue_unavailable");
    }
    const code = typeof data.message === "string" && /^[a-z_]+$/.test(data.message.split(":")[0]) ? data.message.split(":")[0] : `db_${data.code || response.status}`;
    let current;
    try { current = data.details ? JSON.parse(data.details) : undefined; } catch { current = undefined; }
    const status = data.code === "23505" ? 409 : data.code === "42501" ? 403 : response.status >= 400 && response.status < 600 ? response.status : 500;
    throw httpError(status, data.code === "23505" ? "conflict" : code, current ? { current } : {});
  }

  async rpc(name, args) {
    try {
      const response = await this.client.post(`/rpc/${name}`, args);
      return response.data;
    } catch (error) {
      return this.fail(error);
    }
  }

  async get(path) {
    try {
      const response = await this.client.get(path);
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      return this.fail(error);
    }
  }

  async insert(table, row) {
    try {
      const response = await this.client.post(`/${table}`, row, { headers: { Prefer: "return=representation" } });
      return Array.isArray(response.data) ? response.data[0] : response.data;
    } catch (error) {
      return this.fail(error);
    }
  }

  // single conditional statement: PATCH ... ?id=eq.X&row_version=eq.N (0 rows -> state_changed)
  async conditionalPatch(table, id, expectedRowVersion, patch) {
    let rows;
    try {
      const response = await this.client.patch(`/${table}?id=eq.${encodeURIComponent(id)}&row_version=eq.${Number(expectedRowVersion)}`, { ...patch, row_version: Number(expectedRowVersion) + 1, updated_at: nowIso() }, { headers: { Prefer: "return=representation" } });
      rows = Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      return this.fail(error);
    }
    if (rows.length) return rows[0];
    const current = (await this.get(`/${table}?id=eq.${encodeURIComponent(id)}&select=id,row_version`))[0];
    if (!current) throw httpError(404, "not_found");
    throw httpError(409, "state_changed", { current });
  }

  async available() {
    if (this.capability === true) return true;
    if (this.capability === false && Date.now() - this.capabilityCheckedAt < 60_000) return false;
    this.capabilityCheckedAt = Date.now();
    try {
      const response = await this.client.post("/rpc/catalogue_schema_version", {});
      this.capability = Number(response.data) >= 1;
    } catch {
      this.capability = false;
    }
    return this.capability;
  }

  listCategories() { return this.get("/catalogue_categories?order=sort.asc,name.asc"); }
  createCategory(row, actor) { return this.insert("catalogue_categories", { ...row, created_by: actor, updated_by: actor }); }
  updateCategory(id, expectedRowVersion, patch, actor) { return this.conditionalPatch("catalogue_categories", id, expectedRowVersion, { ...patch, updated_by: actor }); }
  async getCategory(id) { return (await this.get(`/catalogue_categories?id=eq.${encodeURIComponent(id)}`))[0] || null; }
  listBrands() { return this.get("/catalogue_brands?order=sort.asc,name.asc"); }
  createBrand(row, actor) { return this.insert("catalogue_brands", { ...row, created_by: actor, updated_by: actor }); }
  updateBrand(id, expectedRowVersion, patch, actor) { return this.conditionalPatch("catalogue_brands", id, expectedRowVersion, { ...patch, updated_by: actor }); }
  async getBrand(id) { return (await this.get(`/catalogue_brands?id=eq.${encodeURIComponent(id)}`))[0] || null; }

  async findImportSkus(skus) {
    const result = [];
    for (let i = 0; i < skus.length; i += 100) {
      const valid = skus.slice(i, i + 100).filter((s) => /^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(s));
      if (valid.length) result.push(...await this.get(`/catalogue_variants?sku=in.(${valid.join(",")})&select=sku,product_id`));
    }
    return result;
  }
  async listProducts({ workflowStatus, publicationStatus } = {}) {
    const filters = [];
    if (workflowStatus) filters.push(`workflow_status=eq.${encodeURIComponent(workflowStatus)}`);
    if (publicationStatus) filters.push(`publication_status=eq.${encodeURIComponent(publicationStatus)}`);
    const products = await this.get(`/catalogue_products?${filters.concat("order=updated_at.desc", "limit=500").join("&")}`);
    if (!products.length) return [];
    const ids = products.map((p) => p.id).join(",");
    const versions = await this.get(`/catalogue_product_versions?product_id=in.(${ids})&select=product_id,version,content->>name,content->>model`);
    const byKey = new Map(versions.map((v) => [`${v.product_id}:${v.version}`, v]));
    return products.map((p) => { const v = byKey.get(`${p.id}:${p.current_version}`) || {}; return { ...p, name: v.name || "", model: v.model || "" }; });
  }
  async getProduct(id) { return (await this.get(`/catalogue_products?id=eq.${encodeURIComponent(id)}`))[0] || null; }
  // Every product with its current content and variants, for the catalogue table (chunked id lists keep URLs short).
  async listProductCards() {
    const products = await this.get("/catalogue_products?order=updated_at.desc&limit=5000");
    const contents = new Map(), variants = new Map();
    for (let i = 0; i < products.length; i += 100) {
      const ids = products.slice(i, i + 100).map((p) => p.id).join(",");
      const versions = await this.get(`/catalogue_product_versions?product_id=in.(${ids})&select=product_id,version,content`);
      const wanted = new Map(products.slice(i, i + 100).map((p) => [p.id, p.current_version]));
      versions.filter((v) => wanted.get(v.product_id) === v.version).forEach((v) => contents.set(v.product_id, v.content));
      (await this.get(`/catalogue_variants?product_id=in.(${ids})&order=sku.asc`)).forEach((v) => { if (!variants.has(v.product_id)) variants.set(v.product_id, []); variants.get(v.product_id).push(v); });
    }
    return { products, contents, variants, truncated: products.length >= 5000 };
  }
  async getVersion(id, version) { return (await this.get(`/catalogue_product_versions?product_id=eq.${encodeURIComponent(id)}&version=eq.${Number(version)}`))[0] || null; }
  listVersions(id) { return this.get(`/catalogue_product_versions?product_id=eq.${encodeURIComponent(id)}&select=version,materiality,author,created_at&order=version.asc`); }
  listReviews(id) { return this.get(`/catalogue_reviews?product_id=eq.${encodeURIComponent(id)}&order=created_at.asc`); }
  listPublicationEvents(id) { return this.get(`/catalogue_publication_events?product_id=eq.${encodeURIComponent(id)}&order=created_at.asc`); }
  listVariants(productId) { return this.get(`/catalogue_variants?product_id=eq.${encodeURIComponent(productId)}&order=sku.asc`); }
  async getVariant(id) { return (await this.get(`/catalogue_variants?id=eq.${encodeURIComponent(id)}`))[0] || null; }

  createProduct({ slug, categoryId, brandId, content, actor }) {
    return this.rpc("catalogue_create_product", { p_slug: slug, p_category_id: categoryId, p_brand_id: brandId, p_content: content, p_actor: actor });
  }
  saveVersion({ id, expectedRowVersion, slug, categoryId, brandId, content, materiality, actor }) {
    return this.rpc("catalogue_save_version", { p_product_id: id, p_expected_row_version: expectedRowVersion, p_slug: slug, p_category_id: categoryId, p_brand_id: brandId, p_content: content, p_materiality: materiality, p_actor: actor });
  }
  transition({ id, expectedRowVersion, action, actor, note, overrideReason }) {
    return this.rpc("catalogue_transition", { p_product_id: id, p_expected_row_version: expectedRowVersion, p_action: action, p_actor: actor, p_note: note || "", p_override_reason: overrideReason || "" });
  }

  async listPriceChanges({ variantId, state } = {}) {
    const changes = await this.get(`/catalogue_price_changes?${variantId ? `variant_id=eq.${encodeURIComponent(variantId)}&` : ""}order=requested_at.desc&limit=500`);
    if (!changes.length) return [];
    const decisions = await this.get(`/catalogue_price_decisions?price_change_id=in.(${changes.map((c) => c.id).join(",")})`);
    const rows = changes.map((c) => withPriceState(c, decisions));
    return state ? rows.filter((row) => row.state === state) : rows;
  }
  async getPriceChange(id) {
    const change = (await this.get(`/catalogue_price_changes?id=eq.${encodeURIComponent(id)}`))[0];
    if (!change) return null;
    return withPriceState(change, await this.get(`/catalogue_price_decisions?price_change_id=eq.${encodeURIComponent(id)}`));
  }
  requestPriceChange({ variantId, price, vatTreatment, vatRateBp, actor, note }) {
    return this.rpc("catalogue_request_price_change", { p_variant_id: variantId, p_new_price: price, p_vat_treatment: vatTreatment, p_vat_rate_bp: vatRateBp, p_actor: actor, p_note: note || "" });
  }
  decidePriceChange({ id, decision, actor, note }) { return this.rpc("catalogue_decide_price_change", { p_change_id: id, p_decision: decision, p_actor: actor, p_note: note || "" }); }
  publishPriceChange({ id, actor }) { return this.rpc("catalogue_publish_price_change", { p_change_id: id, p_actor: actor }); }

  updateInventory({ variantId, expectedRowVersion, patch, actor, reason }) {
    return this.rpc("catalogue_update_inventory", { p_variant_id: variantId, p_expected_row_version: expectedRowVersion, p_patch: patch, p_actor: actor, p_reason: reason || "" });
  }
  listInventoryChanges(variantId) { return this.get(`/catalogue_inventory_changes?variant_id=eq.${encodeURIComponent(variantId)}&order=created_at.desc&limit=200`); }

  listCosts(variantId) { return this.get(`/catalogue_variant_costs?variant_id=eq.${encodeURIComponent(variantId)}&order=valid_from.desc,created_at.desc`); }
  recordCost(row) { return this.insert("catalogue_variant_costs", row); }

  // ---- gallery media (20261104; reported unavailable until that migration is installed)
  // re-probed at most once a minute either way, so installing or rolling back 20261104 takes effect without a restart
  async mediaAvailable() {
    if (this.mediaCapability !== undefined && Date.now() - (this.mediaCheckedAt || 0) < 60_000) return this.mediaCapability;
    this.mediaCheckedAt = Date.now();
    try {
      const response = await this.client.post("/rpc/catalogue_media_schema_version", {});
      this.mediaCapability = Number(response.data) >= 1;
    } catch {
      this.mediaCapability = false;
    }
    return this.mediaCapability;
  }
  listMedia(productId) {
    return this.get(`/catalogue_media?product_id=eq.${encodeURIComponent(productId)}&order=created_at.asc&select=*,derivatives:catalogue_media_derivatives(kind,office_file_id,width,height,bytes)`);
  }
  async getMedia(id) {
    return (await this.get(`/catalogue_media?id=eq.${encodeURIComponent(id)}&select=*,derivatives:catalogue_media_derivatives(kind,office_file_id,width,height,bytes)`))[0] || null;
  }
  async getMediaFile(mediaId, kind) {
    const row = (await this.get(`/catalogue_media_derivatives?media_id=eq.${encodeURIComponent(mediaId)}&kind=eq.${encodeURIComponent(kind)}&select=kind,width,height,bytes,file:office_files(filename),media:catalogue_media(status,product_id)`))[0];
    return row && row.file && row.media ? { kind: row.kind, filename: row.file.filename, status: row.media.status, product_id: row.media.product_id } : null;
  }
  // media ids referenced by ANY version of the product (history included)
  async mediaReferences(productId) {
    const rows = await this.get(`/catalogue_product_versions?product_id=eq.${encodeURIComponent(productId)}&select=version,media:content->media`);
    const refs = new Map();
    rows.forEach((row) => (Array.isArray(row.media) ? row.media : []).forEach((item) => { if (!refs.has(item.media_id)) refs.set(item.media_id, []); refs.get(item.media_id).push(row.version); }));
    return refs;
  }
  registerMedia({ productId, officeFileId, sha256, format, width, height, bytes, originalName, derivatives, actor }) {
    return this.rpc("catalogue_register_media", { p_product_id: productId, p_office_file_id: officeFileId, p_sha256: sha256, p_format: format, p_width: width, p_height: height, p_bytes: bytes, p_original_name: originalName, p_derivatives: derivatives, p_actor: actor });
  }
  removeMedia({ mediaId, actor }) { return this.rpc("catalogue_remove_media", { p_media_id: mediaId, p_actor: actor }); }

  // ---- public release, slugs, previews (20261105; reported unavailable until that migration is installed)
  async publicAvailable() {
    if (this.publicCapability !== undefined && Date.now() - (this.publicCheckedAt || 0) < 60_000) return this.publicCapability;
    this.publicCheckedAt = Date.now();
    try {
      const response = await this.client.post("/rpc/catalogue_public_schema_version", {});
      this.publicCapability = Number(response.data) >= 1;
    } catch {
      this.publicCapability = false;
    }
    return this.publicCapability;
  }
  async getPublicListing(productId) { return (await this.get(`/catalogue_public_listings?product_id=eq.${encodeURIComponent(productId)}`))[0] || null; }
  listPublicListings() { return this.get("/catalogue_public_listings?status=eq.public&order=released_at.desc&limit=5000"); }
  async getPublicListingBySlug(slug) { return (await this.get(`/catalogue_public_listings?slug=eq.${encodeURIComponent(slug)}&status=eq.public`))[0] || null; }
  async getSlugRedirect(slug) { return (await this.get(`/catalogue_slug_redirects?old_slug=eq.${encodeURIComponent(slug)}`))[0] || null; }
  listSlugRedirects(productId) { return this.get(`/catalogue_slug_redirects?product_id=eq.${encodeURIComponent(productId)}&order=created_at.asc`); }
  listPublicEvents(productId) { return this.get(`/catalogue_public_events?product_id=eq.${encodeURIComponent(productId)}&order=created_at.asc`); }
  publicRequirements(productId) { return this.rpc("catalogue_public_requirements", { p_product_id: productId }); }
  publicRelease({ productId, expectedProductRowVersion, expectedListingRowVersion, actor }) {
    return this.rpc("catalogue_public_release", { p_product_id: productId, p_expected_product_row_version: expectedProductRowVersion, p_expected_listing_row_version: expectedListingRowVersion, p_actor: actor });
  }
  publicWithdraw({ productId, expectedListingRowVersion, actor, reason }) {
    return this.rpc("catalogue_public_withdraw", { p_product_id: productId, p_expected_listing_row_version: expectedListingRowVersion, p_actor: actor, p_reason: reason || "" });
  }
  changeSlug({ productId, expectedRowVersion, slug, actor }) { return this.rpc("catalogue_change_slug", { p_product_id: productId, p_expected_row_version: expectedRowVersion, p_new_slug: slug, p_actor: actor }); }
  requestPublicRefresh(productId) { return this.rpc("catalogue_public_request_refresh", { p_product_id: productId }); }
  recordPublicRefresh({ productId, seq, outcome, error }) { return this.rpc("catalogue_public_record_refresh", { p_product_id: productId, p_seq: seq, p_outcome: outcome, p_error: error || "" }); }
  createPreviewGrant({ productId, staff, ttlSeconds }) { return this.rpc("catalogue_create_preview_grant", { p_product_id: productId, p_staff: staff, p_ttl_seconds: ttlSeconds }); }
  async getPreviewGrant(id) { return (await this.get(`/catalogue_preview_grants?id=eq.${encodeURIComponent(id)}`))[0] || null; }
  revokePreviewGrants({ productId, actor }) { return this.rpc("catalogue_revoke_preview_grants", { p_product_id: productId, p_actor: actor }); }
  // media rows with their renditions' public facts, for the given ids
  async mediaWithRenditions(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    const out = [];
    for (let i = 0; i < list.length; i += 50) {
      out.push(...await this.get(`/catalogue_media?id=in.(${list.slice(i, i + 50).join(",")})&select=id,status,product_id,derivatives:catalogue_media_derivatives(kind,sha256,width,height)`));
    }
    return out;
  }
  // a rendition by content hash -> { media_id, kind, filename, status, product_id }
  async renditionBySha(sha) {
    const rows = await this.get(`/catalogue_media_derivatives?sha256=eq.${encodeURIComponent(sha)}&select=kind,media_id,file:office_files(filename),media:catalogue_media(status,product_id)`);
    return rows.filter((r) => r.file && r.media).map((r) => ({ media_id: r.media_id, kind: r.kind, filename: r.file.filename, status: r.media.status, product_id: r.media.product_id }));
  }
  // exact versions for several products: [{ product_id, version, content }]
  async versionsFor(pairs) {
    const out = [];
    for (let i = 0; i < pairs.length; i += 40) {
      const filter = pairs.slice(i, i + 40).map(([pid, v]) => `and(product_id.eq.${pid},version.eq.${Number(v)})`).join(",");
      out.push(...await this.get(`/catalogue_product_versions?or=(${filter})&select=product_id,version,content`));
    }
    return out;
  }
  async productsByIds(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    const out = [];
    for (let i = 0; i < list.length; i += 100) out.push(...await this.get(`/catalogue_products?id=in.(${list.slice(i, i + 100).join(",")})`));
    return out;
  }
  async variantsForProducts(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    const out = [];
    for (let i = 0; i < list.length; i += 100) out.push(...await this.get(`/catalogue_variants?product_id=in.(${list.slice(i, i + 100).join(",")})&order=sku.asc`));
    return out;
  }

  listSuppliers() { return this.get("/office_suppliers?order=name.asc"); }
  async getSupplier(id) { return (await this.get(`/office_suppliers?id=eq.${encodeURIComponent(id)}`))[0] || null; }
  createSupplier(input, actor) { return this.insert("office_suppliers", normalizeCorporateRecord("suppliers", input, { actorEmail: actor })); }
  async updateSupplier(id, patch) {
    let rows;
    try {
      const response = await this.client.patch(`/office_suppliers?id=eq.${encodeURIComponent(id)}`, { ...patch, updated_at: nowIso() }, { headers: { Prefer: "return=representation" } });
      rows = Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      return this.fail(error);
    }
    if (!rows.length) throw httpError(404, "supplier_not_found");
    return rows[0];
  }
}

// ---------------------------------------------------------------------------------------------------------------- in-memory implementation
class FileCatalogueStore {
  constructor(store) {
    this.store = store;
  }

  get s() {
    const state = this.store.state;
    if (!state.catalogue) {
      const at = nowIso();
      state.catalogue = {
        categories: SEED_CATEGORIES.map(([slug, name, sort]) => ({ id: crypto.randomUUID(), slug, name, parent_id: null, sort, status: "active", row_version: 1, created_by: "migration", updated_by: "migration", created_at: at, updated_at: at })),
        brands: [], products: [], versions: [], reviews: [], events: [], variants: [], price_changes: [], price_decisions: [], inventory_changes: [], costs: [],
      };
    }
    return state.catalogue;
  }

  persist() { return this.store.persist(); }
  async available() { return true; }
  async mediaAvailable() { return true; }
  get media() { if (!this.s.media) { this.s.media = []; this.s.media_derivatives = []; } return this.s.media; }
  get derivatives() { this.media; return this.s.media_derivatives; }

  // mirror of catalogue_version_media_check (20261104): runs synchronously right before a version is appended
  checkGallery(productId, content) {
    const media = (content && content.media) || [];
    if (!media.length) return;
    if (media.length > 12) throw httpError(400, "gallery_too_large");
    if (new Set(media.map((m) => m.media_id)).size !== media.length) throw httpError(400, "gallery_duplicate_image");
    if (media.filter((m) => m.cover === true).length !== 1) throw httpError(400, "gallery_cover_required");
    const skus = new Set((content.variants || []).map((v) => v.sku));
    if (media.some((m) => (m.variant_skus || []).some((sku) => !skus.has(sku)))) throw httpError(400, "gallery_unknown_variant");
    if (!media.every((m) => this.media.some((x) => x.id === m.media_id && x.product_id === productId && x.status === "active"))) throw httpError(409, "media_not_available");
  }
  referencedMedia(productId, mediaId) {
    return this.s.versions.some((v) => v.product_id === productId && (v.content.media || []).some((m) => m.media_id === mediaId));
  }

  stateChanged(product) {
    if (!product) throw httpError(404, "product_not_found");
    throw httpError(409, "state_changed", { current: { id: product.id, row_version: product.row_version, workflow_status: product.workflow_status, publication_status: product.publication_status, current_version: product.current_version, published_version: product.published_version } });
  }

  // ---- taxonomy
  async listCategories() { return clone([...this.s.categories].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))); }
  async getCategory(id) { return clone(this.s.categories.find((c) => c.id === id) || null); }
  async listBrands() { return clone([...this.s.brands].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))); }
  async getBrand(id) { return clone(this.s.brands.find((c) => c.id === id) || null); }
  taxonomyCreate(list, row, actor) {
    if (list.some((item) => item.slug === row.slug)) throw httpError(409, "conflict");
    if (row.parent_id && !this.s.categories.some((c) => c.id === row.parent_id)) throw httpError(400, "parent_not_found");
    const at = nowIso();
    const item = { id: crypto.randomUUID(), parent_id: null, sort: 0, status: "active", ...row, row_version: 1, created_by: actor, updated_by: actor, created_at: at, updated_at: at };
    list.push(item);
    return item;
  }
  taxonomyUpdate(list, id, expectedRowVersion, patch, actor) {
    const item = list.find((x) => x.id === id);
    if (!item) throw httpError(404, "not_found");
    if (item.row_version !== Number(expectedRowVersion)) throw httpError(409, "state_changed", { current: { id, row_version: item.row_version } });
    if (patch.slug && list.some((x) => x.slug === patch.slug && x.id !== id)) throw httpError(409, "conflict");
    Object.assign(item, patch, { row_version: item.row_version + 1, updated_by: actor, updated_at: nowIso() });
    return item;
  }
  async createCategory(row, actor) { const item = this.taxonomyCreate(this.s.categories, row, actor); await this.persist(); return clone(item); }
  async updateCategory(id, v, patch, actor) { const item = this.taxonomyUpdate(this.s.categories, id, v, patch, actor); await this.persist(); return clone(item); }
  async createBrand(row, actor) { const item = this.taxonomyCreate(this.s.brands, row, actor); await this.persist(); return clone(item); }
  async updateBrand(id, v, patch, actor) { const item = this.taxonomyUpdate(this.s.brands, id, v, patch, actor); await this.persist(); return clone(item); }

  // ---- products
  async findImportSkus(skus) { const wanted = new Set(skus); return clone(this.s.variants.filter((v) => wanted.has(v.sku)).map(({ sku, product_id }) => ({ sku, product_id }))); }
  async listProducts({ workflowStatus, publicationStatus } = {}) {
    return clone(this.s.products
      .filter((p) => (!workflowStatus || p.workflow_status === workflowStatus) && (!publicationStatus || p.publication_status === publicationStatus))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((p) => { const v = this.s.versions.find((x) => x.product_id === p.id && x.version === p.current_version) || { content: {} }; return { ...p, name: v.content.name || "", model: v.content.model || "" }; }));
  }
  async getProduct(id) { return clone(this.s.products.find((p) => p.id === id) || null); }
  async listProductCards() {
    const products = clone([...this.s.products].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))));
    const contents = new Map(products.map((p) => [p.id, clone((this.s.versions.find((v) => v.product_id === p.id && v.version === p.current_version) || {}).content || {})]));
    const variants = new Map(products.map((p) => [p.id, clone(this.s.variants.filter((v) => v.product_id === p.id).sort((a, b) => a.sku.localeCompare(b.sku)))]));
    return { products, contents, variants, truncated: false };
  }
  async getVersion(id, version) { return clone(this.s.versions.find((v) => v.product_id === id && v.version === Number(version)) || null); }
  async listVersions(id) { return clone(this.s.versions.filter((v) => v.product_id === id).sort((a, b) => a.version - b.version).map(({ version, materiality, author, created_at }) => ({ version, materiality, author, created_at }))); }
  async listReviews(id) { return clone(this.s.reviews.filter((r) => r.product_id === id)); }
  async listPublicationEvents(id) { return clone(this.s.events.filter((e) => e.product_id === id)); }
  async listVariants(productId) { return clone(this.s.variants.filter((v) => v.product_id === productId).sort((a, b) => a.sku.localeCompare(b.sku))); }
  async getVariant(id) { return clone(this.s.variants.find((v) => v.id === id) || null); }

  registerVariants(productId, variants) {
    for (const v of variants || []) {
      const owner = this.s.variants.find((x) => x.sku === v.sku);
      if (owner && owner.product_id !== productId) throw httpError(409, "sku_taken", { current: { sku: v.sku } });
    }
    const at = nowIso();
    for (const v of variants || []) {
      if (!this.s.variants.some((x) => x.sku === v.sku)) {
        this.s.variants.push({ id: crypto.randomUUID(), product_id: productId, sku: v.sku, status: "active", price_ngn_kobo: null, vat_treatment: null, vat_rate_bp: null, stock_on_hand: 0, stock_reserved: 0, sourcing: "supplier_sourced", lead_time_days_min: null, lead_time_days_max: null, supplier_id: null, row_version: 1, created_at: at, updated_at: at });
      }
    }
  }

  async createProduct({ slug, categoryId, brandId, content, actor }) {
    if (this.s.products.some((p) => p.slug === slug) || (this.s.slug_redirects || []).some((r) => r.old_slug === slug)) throw httpError(409, "slug_taken");
    for (const v of content.variants || []) { const owner = this.s.variants.find((x) => x.sku === v.sku); if (owner) throw httpError(409, "sku_taken", { current: { sku: v.sku } }); }
    const at = nowIso();
    if ((content.media || []).length) throw httpError(409, "media_not_available");
    const product = { id: crypto.randomUUID(), slug, category_id: categoryId, brand_id: brandId || null, workflow_status: "draft", publication_status: "never_published", row_version: 1, current_version: 1, review_version: null, approved_version: null, published_version: null, published_at: null, first_published_at: null, archived_at: null, last_publish_error: null, created_by: actor, updated_by: actor, created_at: at, updated_at: at };
    this.s.products.push(product);
    this.s.versions.push({ product_id: product.id, version: 1, content: clone(content), materiality: "initial", author: actor, created_at: at });
    this.registerVariants(product.id, content.variants);
    await this.persist();
    return clone(product);
  }

  async saveVersion({ id, expectedRowVersion, slug, categoryId, brandId, content, materiality, actor }) {
    const p = this.s.products.find((x) => x.id === id);
    if (!p || p.row_version !== Number(expectedRowVersion) || p.publication_status === "archived") this.stateChanged(p);
    // same rules as catalogue_save_version: no minor/typo exception; "initial" before the first publication, "material" after it
    if (!["initial", "material"].includes(materiality)) throw httpError(400, "invalid_materiality");
    if (materiality === "initial" && p.published_version != null) throw httpError(409, "initial_not_allowed");
    if (materiality === "material" && p.published_version == null) throw httpError(409, "material_not_allowed");
    if (p.slug !== slug && p.first_published_at) throw httpError(409, "slug_locked");
    if (p.slug !== slug && (this.s.products.some((x) => x.slug === slug && x.id !== id) || (this.s.slug_redirects || []).some((r) => r.old_slug === slug && r.product_id !== id))) throw httpError(409, "slug_taken");
    for (const v of content.variants || []) { const owner = this.s.variants.find((x) => x.sku === v.sku); if (owner && owner.product_id !== id) throw httpError(409, "sku_taken", { current: { sku: v.sku } }); }
    this.checkGallery(id, content);
    const at = nowIso();
    Object.assign(p, { row_version: p.row_version + 1, current_version: p.current_version + 1, workflow_status: "draft", review_version: null, approved_version: null, slug, category_id: categoryId, brand_id: brandId || null, updated_by: actor, updated_at: at });
    this.s.versions.push({ product_id: id, version: p.current_version, content: clone(content), materiality, author: actor, created_at: at });
    this.registerVariants(id, content.variants);
    await this.persist();
    return clone(p);
  }

  async transition({ id, expectedRowVersion, action, actor, note, overrideReason }) {
    const p = this.s.products.find((x) => x.id === id);
    const expected = Number(expectedRowVersion);
    const at = nowIso();
    const reason = overrideReason || "";
    const matches = p && p.row_version === expected;
    const review = (version, decision, text) => this.s.reviews.push({ id: crypto.randomUUID(), product_id: id, version, decision, actor, note: text || "", created_at: at });
    const event = (version, kind, extra = {}) => this.s.events.push({ id: crypto.randomUUID(), product_id: id, version, action: kind, actor, override: false, override_reason: "", refresh_outcome: "not_applicable", error: "", created_at: at, ...extra });
    const bump = (patch) => Object.assign(p, patch, { row_version: p.row_version + 1, updated_by: actor, updated_at: at });

    if (action === "submit") {
      if (!matches || !["draft", "changes_requested"].includes(p.workflow_status) || p.publication_status === "archived") this.stateChanged(p);
      bump({ workflow_status: "in_review", review_version: p.current_version });
      review(p.review_version, "submitted", note);
    } else if (action === "approve" || action === "request_changes") {
      const ownChange = matches && p.workflow_status === "in_review" && this.s.versions.some((v) => v.product_id === id && v.version > (p.published_version || 0) && v.version <= p.review_version && v.author === actor);
      if (ownChange) throw httpError(403, "own_change");
      // 20261103: an archived product receives no review decision
      if (!matches || p.workflow_status !== "in_review" || p.review_version !== p.current_version || p.publication_status === "archived") this.stateChanged(p);
      const approve = action === "approve";
      bump({ workflow_status: approve ? "approved" : "changes_requested", approved_version: approve ? p.review_version : null });
      review(p.review_version, approve ? "approved" : "changes_requested", note);
    } else if (action === "publish") {
      if (reason && reason.length < 20) throw httpError(400, "override_reason_too_short");
      if (!matches || p.publication_status === "archived") this.stateChanged(p);
      const notLive = p.published_version !== p.current_version || p.publication_status !== "published";
      const normal = p.workflow_status === "approved" && p.approved_version === p.current_version && notLive;
      const override = reason.length >= 20 && notLive;
      if (!normal && !override) throw httpError(409, "review_required");
      const approvedReview = this.s.reviews.some((r) => r.product_id === id && r.version === p.current_version && r.decision === "approved");
      const path = approvedReview ? "published" : "published_override";
      bump({ publication_status: "published", published_version: p.current_version, published_at: at, first_published_at: p.first_published_at || at, workflow_status: "approved", approved_version: p.current_version, review_version: null, last_publish_error: null });
      if (path === "published_override") review(p.current_version, "override", reason);
      event(p.current_version, path, path === "published_override" ? { override: true, override_reason: reason } : {});
    } else if (action === "unpublish") {
      if (!matches || p.publication_status !== "published") this.stateChanged(p);
      bump({ publication_status: "unpublished" });
      event(p.published_version, "unpublished");
    } else if (action === "archive") {
      if (!matches || p.publication_status === "archived") this.stateChanged(p);
      bump({ publication_status: "archived", archived_at: at });
      event(p.published_version, "archived");
    } else {
      throw httpError(400, "invalid_action");
    }
    await this.persist();
    return clone(p);
  }

  // ---- prices
  async listPriceChanges({ variantId, state } = {}) {
    const rows = this.s.price_changes.filter((c) => !variantId || c.variant_id === variantId).map((c) => withPriceState(c, this.s.price_decisions)).sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)));
    return clone(state ? rows.filter((r) => r.state === state) : rows);
  }
  async getPriceChange(id) { const c = this.s.price_changes.find((x) => x.id === id); return c ? clone(withPriceState(c, this.s.price_decisions)) : null; }
  async requestPriceChange({ variantId, price, vatTreatment, vatRateBp, actor, note }) {
    const v = this.s.variants.find((x) => x.id === variantId);
    if (!v) throw httpError(404, "variant_not_found");
    const change = { id: crypto.randomUUID(), variant_id: v.id, old_price_ngn_kobo: v.price_ngn_kobo, old_vat_treatment: v.vat_treatment, old_vat_rate_bp: v.vat_rate_bp, new_price_ngn_kobo: price, new_vat_treatment: vatTreatment, new_vat_rate_bp: vatRateBp, requested_by: actor, note: note || "", requested_at: nowIso() };
    this.s.price_changes.push(change);
    await this.persist();
    return clone(change);
  }
  async decidePriceChange({ id, decision, actor, note }) {
    if (!["approved", "rejected"].includes(decision)) throw httpError(400, "invalid_decision");
    const c = this.s.price_changes.find((x) => x.id === id);
    if (!c) throw httpError(404, "price_change_not_found");
    if (c.requested_by === actor) throw httpError(403, "own_request");
    if (this.s.price_decisions.some((d) => d.price_change_id === id && (d.decision === "approved" || d.decision === "rejected"))) throw httpError(409, "already_decided");
    const d = { id: crypto.randomUUID(), price_change_id: id, decision, actor, note: note || "", created_at: nowIso() };
    this.s.price_decisions.push(d);
    await this.persist();
    return clone(d);
  }
  async publishPriceChange({ id, actor }) {
    const c = this.s.price_changes.find((x) => x.id === id);
    if (!c) throw httpError(404, "price_change_not_found");
    if (!this.s.price_decisions.some((d) => d.price_change_id === id && d.decision === "approved")) throw httpError(409, "not_approved");
    if (this.s.price_decisions.some((d) => d.price_change_id === id && d.decision === "published")) throw httpError(409, "already_published");
    const v = this.s.variants.find((x) => x.id === c.variant_id);
    if (v.price_ngn_kobo !== c.old_price_ngn_kobo || v.vat_treatment !== c.old_vat_treatment || v.vat_rate_bp !== c.old_vat_rate_bp) throw httpError(409, "price_changed_since_request");
    const at = nowIso();
    this.s.price_decisions.push({ id: crypto.randomUUID(), price_change_id: id, decision: "published", actor, note: "", created_at: at });
    Object.assign(v, { price_ngn_kobo: c.new_price_ngn_kobo, vat_treatment: c.new_vat_treatment, vat_rate_bp: c.new_vat_rate_bp, row_version: v.row_version + 1, updated_at: at });
    await this.persist();
    return clone(v);
  }

  // ---- inventory
  async updateInventory({ variantId, expectedRowVersion, patch, actor, reason }) {
    const v = this.s.variants.find((x) => x.id === variantId);
    if (!v) throw httpError(404, "variant_not_found");
    if (v.row_version !== Number(expectedRowVersion)) throw httpError(409, "state_changed", { current: { id: v.id, row_version: v.row_version } });
    const next = { ...v, ...patch };
    if (next.stock_reserved > next.stock_on_hand) throw httpError(400, "db_23514");
    if (next.supplier_id && !(this.store.state.office_suppliers || []).some((s) => s.id === next.supplier_id)) throw httpError(409, "conflict");
    const at = nowIso();
    for (const field of Object.keys(patch)) {
      if (String(v[field] ?? "") !== String(next[field] ?? "") || (v[field] == null) !== (next[field] == null)) {
        this.s.inventory_changes.push({ id: crypto.randomUUID(), variant_id: v.id, field, old_value: v[field] == null ? null : String(v[field]), new_value: next[field] == null ? null : String(next[field]), actor, reason: reason || "", created_at: at });
      }
    }
    Object.assign(v, patch, { row_version: v.row_version + 1, updated_at: at });
    await this.persist();
    return clone(v);
  }
  async listInventoryChanges(variantId) { return clone(this.s.inventory_changes.filter((c) => c.variant_id === variantId).reverse()); }

  // ---- internal costs
  async listCosts(variantId) { return clone(this.s.costs.filter((c) => c.variant_id === variantId).sort((a, b) => String(b.valid_from).localeCompare(String(a.valid_from)))); }
  async recordCost(row) {
    if (row.supplier_id && !(this.store.state.office_suppliers || []).some((s) => s.id === row.supplier_id)) throw httpError(409, "conflict");
    const at = nowIso();
    const cost = { id: crypto.randomUUID(), currency: "NGN", valid_from: at, created_at: at, note: "", ...row };
    this.s.costs.push(cost);
    await this.persist();
    return clone(cost);
  }

  // ---- gallery media (same rules as 20261104)
  withDerivatives(m) { return m ? { ...m, derivatives: this.derivatives.filter((d) => d.media_id === m.id).map(({ kind, office_file_id, width, height, bytes }) => ({ kind, office_file_id, width, height, bytes })) } : null; }
  async listMedia(productId) { return clone(this.media.filter((m) => m.product_id === productId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((m) => this.withDerivatives(m))); }
  async getMedia(id) { return clone(this.withDerivatives(this.media.find((m) => m.id === id))); }
  async getMediaFile(mediaId, kind) {
    const d = this.derivatives.find((x) => x.media_id === mediaId && x.kind === kind);
    const m = d && this.media.find((x) => x.id === mediaId);
    const file = d && (this.store.state.office_files || []).find((f) => f.id === d.office_file_id);
    return d && m && file ? { kind, filename: file.filename, status: m.status, product_id: m.product_id } : null;
  }
  async mediaReferences(productId) {
    const refs = new Map();
    this.s.versions.filter((v) => v.product_id === productId).forEach((v) => (v.content.media || []).forEach((item) => { if (!refs.has(item.media_id)) refs.set(item.media_id, []); refs.get(item.media_id).push(v.version); }));
    return refs;
  }
  async registerMedia({ productId, officeFileId, sha256, format, width, height, bytes, originalName, derivatives, actor }) {
    const p = this.s.products.find((x) => x.id === productId);
    if (!p) throw httpError(404, "product_not_found");
    if (p.publication_status === "archived") throw httpError(409, "product_archived");
    const existing = this.media.find((m) => m.product_id === productId && m.sha256 === sha256 && m.status === "active");
    if (existing) return { ...clone(existing), deduplicated: true };
    if (this.media.filter((m) => m.product_id === productId && m.status === "active").length >= 60) throw httpError(409, "media_limit");
    if (!Array.isArray(derivatives) || derivatives.length !== 4) throw httpError(400, "invalid_derivatives");
    const files = this.store.state.office_files || [];
    if (![officeFileId, ...derivatives.map((d) => d.office_file_id)].every((fid) => files.some((f) => f.id === fid))) throw httpError(409, "conflict");
    const at = nowIso();
    const m = { id: crypto.randomUUID(), product_id: productId, office_file_id: officeFileId, sha256, format, width, height, bytes, original_name: String(originalName || "").slice(0, 200), status: "active", uploaded_by: actor, created_at: at, removed_by: null, removed_at: null };
    this.media.push(m);
    derivatives.forEach((d) => this.derivatives.push({ media_id: m.id, kind: d.kind, office_file_id: d.office_file_id, format: "webp", width: d.width, height: d.height, bytes: d.bytes, sha256: d.sha256, created_at: at }));
    await this.persist();
    return { ...clone(m), deduplicated: false };
  }
  async removeMedia({ mediaId, actor }) {
    const m = this.media.find((x) => x.id === mediaId);
    if (!m) throw httpError(404, "media_not_found");
    if (m.status !== "active") throw httpError(409, "media_already_removed");
    if (this.referencedMedia(m.product_id, m.id)) throw httpError(409, "media_referenced");
    Object.assign(m, { status: "removed", removed_by: actor, removed_at: nowIso() });
    await this.persist();
    return clone(m);
  }
  // mirror of office_files ... ON DELETE RESTRICT from the media tables
  officeFileInUse(fileId) { return this.media.some((m) => m.office_file_id === fileId) || this.derivatives.some((d) => d.office_file_id === fileId); }

  // ---- public release, slugs, previews (same rules as 20261105)
  get pub() {
    if (!this.s.public_listings) Object.assign(this.s, { public_listings: [], public_events: [], slug_redirects: [], preview_grants: [] });
    return this.s;
  }
  async publicAvailable() { return true; }
  async getPublicListing(productId) { return clone(this.pub.public_listings.find((l) => l.product_id === productId) || null); }
  async listPublicListings() { return clone(this.pub.public_listings.filter((l) => l.status === "public")); }
  async getPublicListingBySlug(slug) { return clone(this.pub.public_listings.find((l) => l.slug === slug && l.status === "public") || null); }
  async getSlugRedirect(slug) { return clone(this.pub.slug_redirects.find((r) => r.old_slug === slug) || null); }
  async listSlugRedirects(productId) { return clone(this.pub.slug_redirects.filter((r) => r.product_id === productId)); }
  async listPublicEvents(productId) { return clone(this.pub.public_events.filter((e) => e.product_id === productId)); }
  requirementsOf(p) {
    if (!p) throw httpError(404, "product_not_found");
    if (p.publication_status === "archived") return ["archived"];
    if (p.publication_status !== "published" || p.published_version == null) return ["not_published_internally"];
    const v = this.s.versions.find((x) => x.product_id === p.id && x.version === p.published_version);
    const issues = [];
    if (!this.s.reviews.some((r) => r.product_id === p.id && r.version === p.published_version && r.decision === "approved")) issues.push("version_not_approved");
    const media = (v.content.media || []);
    if (!media.length) issues.push("no_images");
    else {
      if (media.filter((m) => m.cover === true).length !== 1) issues.push("no_cover");
      if (media.some((m) => !String(m.alt || "").trim())) issues.push("alt_text_missing");
      if (media.some((m) => !this.media.some((x) => x.id === m.media_id && x.product_id === p.id && x.status === "active") || this.derivatives.filter((d) => d.media_id === m.media_id).length !== 4)) issues.push("media_unavailable");
    }
    const listed = new Set((v.content.variants || []).map((x) => x.sku));
    const active = this.s.variants.filter((x) => x.product_id === p.id && x.status === "active" && listed.has(x.sku));
    if (!active.length) issues.push("no_active_variant");
    else if (active.some((x) => x.price_ngn_kobo == null || x.vat_treatment == null)) issues.push("price_not_approved");
    return issues;
  }
  async publicRequirements(productId) { return this.requirementsOf(this.s.products.find((p) => p.id === productId)); }
  publicEvent(productId, action, version, slug, actor, note = "") { this.pub.public_events.push({ id: crypto.randomUUID(), product_id: productId, action, version, slug, actor, note: String(note || "").slice(0, 500), created_at: nowIso() }); }
  listingConflict(l) { throw httpError(409, "public_state_changed", { current: l ? { row_version: l.row_version, status: l.status, public_version: l.public_version } : { row_version: 0 } }); }
  async publicRelease({ productId, expectedProductRowVersion, expectedListingRowVersion, actor }) {
    const p = this.s.products.find((x) => x.id === productId);
    if (!p) throw httpError(404, "product_not_found");
    if (p.row_version !== Number(expectedProductRowVersion)) this.stateChanged(p);
    const issues = this.requirementsOf(p);
    if (issues.length) throw httpError(409, "public_requirements_not_met", { current: { issues } });
    const at = nowIso();
    let l = this.pub.public_listings.find((x) => x.product_id === productId);
    let action;
    if (!l) {
      if (Number(expectedListingRowVersion || 0) !== 0) this.listingConflict(null);
      l = { product_id: p.id, status: "public", public_version: p.published_version, slug: p.slug, row_version: 1, released_at: at, released_by: actor, withdrawn_at: null, withdrawn_by: null, withdrawn_reason: "", refresh_seq: 1, refresh_status: "pending", refresh_attempts: 0, refresh_requested_at: at, refresh_completed_at: null, refresh_error: "", created_at: at, updated_at: at };
      this.pub.public_listings.push(l);
      action = "released";
    } else {
      if (l.row_version !== Number(expectedListingRowVersion)) this.listingConflict(l);
      if (l.status === "public" && l.public_version === p.published_version && l.slug === p.slug) throw httpError(409, "already_public");
      action = l.status === "public" ? "updated" : "released";
      Object.assign(l, { status: "public", public_version: p.published_version, slug: p.slug, row_version: l.row_version + 1, released_at: at, released_by: actor, withdrawn_at: null, withdrawn_by: null, withdrawn_reason: "", refresh_seq: l.refresh_seq + 1, refresh_status: "pending", refresh_attempts: 0, refresh_requested_at: at, refresh_completed_at: null, refresh_error: "", updated_at: at });
    }
    this.publicEvent(p.id, action, p.published_version, p.slug, actor);
    await this.persist();
    return clone(l);
  }
  async publicWithdraw({ productId, expectedListingRowVersion, actor, reason }) {
    const l = this.pub.public_listings.find((x) => x.product_id === productId);
    if (!l) throw httpError(409, "not_public");
    if (l.row_version !== Number(expectedListingRowVersion) || l.status !== "public") this.listingConflict(l);
    const at = nowIso();
    Object.assign(l, { status: "withdrawn", withdrawn_at: at, withdrawn_by: actor, withdrawn_reason: String(reason || "").slice(0, 500), row_version: l.row_version + 1, refresh_seq: l.refresh_seq + 1, refresh_status: "pending", refresh_attempts: 0, refresh_requested_at: at, refresh_completed_at: null, refresh_error: "", updated_at: at });
    this.publicEvent(productId, "withdrawn", l.public_version, l.slug, actor, reason);
    await this.persist();
    return clone(l);
  }
  async changeSlug({ productId, expectedRowVersion, slug, actor }) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(slug || "")) || slug.length > 80) throw httpError(400, "invalid_slug");
    const p = this.s.products.find((x) => x.id === productId);
    if (!p) throw httpError(404, "product_not_found");
    if (!p.first_published_at) throw httpError(400, "slug_change_not_needed");
    if (p.publication_status === "archived") throw httpError(409, "product_archived");
    if (p.slug === slug) throw httpError(400, "slug_unchanged");
    if (this.s.products.some((x) => x.slug === slug && x.id !== productId) || this.pub.slug_redirects.some((r) => r.old_slug === slug && r.product_id !== productId)) throw httpError(409, "slug_taken");
    if (p.row_version !== Number(expectedRowVersion)) this.stateChanged(p);
    const old = p.slug;
    const at = nowIso();
    Object.assign(p, { slug, row_version: p.row_version + 1, updated_by: actor, updated_at: at });
    if (!this.pub.slug_redirects.some((r) => r.old_slug === old)) this.pub.slug_redirects.push({ old_slug: old, product_id: productId, created_by: actor, created_at: at });
    const l = this.pub.public_listings.find((x) => x.product_id === productId);
    if (l) Object.assign(l, { slug, refresh_seq: l.refresh_seq + 1, refresh_status: "pending", refresh_attempts: 0, refresh_requested_at: at, refresh_completed_at: null, refresh_error: "", updated_at: at });
    this.publicEvent(productId, "slug_changed", p.published_version, slug, actor, `from ${old}`);
    await this.persist();
    return clone(p);
  }
  async requestPublicRefresh(productId) {
    const l = this.pub.public_listings.find((x) => x.product_id === productId);
    if (!l) throw httpError(409, "not_public");
    Object.assign(l, { refresh_seq: l.refresh_seq + 1, refresh_status: "pending", refresh_requested_at: nowIso(), refresh_completed_at: null, refresh_error: "" });
    await this.persist();
    return l.refresh_seq;
  }
  async recordPublicRefresh({ productId, seq, outcome, error }) {
    if (!["succeeded", "failed", "not_configured"].includes(outcome)) throw httpError(400, "invalid_outcome");
    const l = this.pub.public_listings.find((x) => x.product_id === productId);
    if (!l || l.refresh_seq !== Number(seq)) return false;
    Object.assign(l, { refresh_status: outcome, refresh_attempts: l.refresh_attempts + 1, refresh_completed_at: nowIso(), refresh_error: String(error || "").slice(0, 500) });
    await this.persist();
    return true;
  }
  async createPreviewGrant({ productId, staff, ttlSeconds }) {
    if (!(ttlSeconds >= 60 && ttlSeconds <= 1800)) throw httpError(400, "invalid_ttl");
    const p = this.s.products.find((x) => x.id === productId);
    if (!p) throw httpError(404, "product_not_found");
    if (p.publication_status === "archived") throw httpError(409, "product_archived");
    const now = Date.now();
    const g = { id: crypto.randomUUID(), product_id: p.id, version: p.current_version, staff, created_at: new Date(now).toISOString(), expires_at: new Date(now + ttlSeconds * 1000).toISOString(), revoked_at: null, revoked_by: null };
    this.pub.preview_grants.push(g);
    await this.persist();
    return clone(g);
  }
  async getPreviewGrant(id) { return clone(this.pub.preview_grants.find((g) => g.id === id) || null); }
  async revokePreviewGrants({ productId, actor }) {
    const now = nowIso();
    const live = this.pub.preview_grants.filter((g) => g.product_id === productId && !g.revoked_at && g.expires_at > now);
    live.forEach((g) => Object.assign(g, { revoked_at: now, revoked_by: actor }));
    await this.persist();
    return live.length;
  }
  async mediaWithRenditions(ids) {
    const set = new Set(ids);
    return clone(this.media.filter((m) => set.has(m.id)).map((m) => ({ id: m.id, status: m.status, product_id: m.product_id, derivatives: this.derivatives.filter((d) => d.media_id === m.id).map(({ kind, sha256, width, height }) => ({ kind, sha256, width, height })) })));
  }
  async renditionBySha(sha) {
    const files = this.store.state.office_files || [];
    return this.derivatives.filter((d) => d.sha256 === sha).map((d) => {
      const m = this.media.find((x) => x.id === d.media_id);
      const f = files.find((x) => x.id === d.office_file_id);
      return m && f ? { media_id: m.id, kind: d.kind, filename: f.filename, status: m.status, product_id: m.product_id } : null;
    }).filter(Boolean);
  }
  async versionsFor(pairs) {
    return clone(pairs.map(([pid, v]) => this.s.versions.find((x) => x.product_id === pid && x.version === Number(v))).filter(Boolean).map(({ product_id, version, content }) => ({ product_id, version, content })));
  }
  async productsByIds(ids) { const set = new Set(ids); return clone(this.s.products.filter((p) => set.has(p.id))); }
  async variantsForProducts(ids) { const set = new Set(ids); return clone(this.s.variants.filter((v) => set.has(v.product_id))); }

  // ---- suppliers (CORPORATE_COLLECTIONS.suppliers -> state.office_suppliers)
  get suppliers() {
    if (!Array.isArray(this.store.state.office_suppliers)) this.store.state.office_suppliers = [];
    return this.store.state.office_suppliers;
  }
  async listSuppliers() { return clone([...this.suppliers].sort((a, b) => a.name.localeCompare(b.name))); }
  async getSupplier(id) { return clone(this.suppliers.find((s) => s.id === id) || null); }
  async createSupplier(input, actor) {
    const record = normalizeCorporateRecord("suppliers", input, { actorEmail: actor });
    this.suppliers.push(record);
    await this.persist();
    return clone(record);
  }
  async updateSupplier(id, patch) {
    const record = this.suppliers.find((s) => s.id === id);
    if (!record) throw httpError(404, "supplier_not_found");
    Object.assign(record, patch, { updated_at: nowIso() });
    await this.persist();
    return clone(record);
  }
}

function catalogueStoreFor(store) {
  if (!store) throw new Error("store required");
  if (!store.__catalogue) {
    Object.defineProperty(store, "__catalogue", { value: store.client ? new SupabaseCatalogueStore(store) : new FileCatalogueStore(store), enumerable: false });
  }
  return store.__catalogue;
}

module.exports = { FileCatalogueStore, SEED_CATEGORIES, SupabaseCatalogueStore, catalogueStoreFor, priceChangeState };
