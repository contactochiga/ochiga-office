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
// key-order-independent serialisation (the in-memory equivalent of jsonb equality)
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}
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
    if (data.code === "PGRST202" || data.code === "42883" || data.code === "42P01" || data.code === "PGRST205") {
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
  async listProducts({ workflowStatus, publicationStatus } = {}) {
    return clone(this.s.products
      .filter((p) => (!workflowStatus || p.workflow_status === workflowStatus) && (!publicationStatus || p.publication_status === publicationStatus))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((p) => { const v = this.s.versions.find((x) => x.product_id === p.id && x.version === p.current_version) || { content: {} }; return { ...p, name: v.content.name || "", model: v.content.model || "" }; }));
  }
  async getProduct(id) { return clone(this.s.products.find((p) => p.id === id) || null); }
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
    if (this.s.products.some((p) => p.slug === slug)) throw httpError(409, "slug_taken");
    for (const v of content.variants || []) { const owner = this.s.variants.find((x) => x.sku === v.sku); if (owner) throw httpError(409, "sku_taken", { current: { sku: v.sku } }); }
    const at = nowIso();
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
    // same guard as catalogue_save_version: "minor" differs from the published version in summary/description only
    if (materiality === "minor") {
      const published = this.s.versions.find((v) => v.product_id === id && v.version === p.published_version);
      const rest = (c) => { const { summary, description, ...others } = c || {}; return canonicalJson(others); };
      if (!published || rest(published.content) !== rest(content)) throw httpError(409, "minor_not_allowed");
    }
    if (materiality === "initial" && p.published_version != null) throw httpError(409, "initial_not_allowed");
    if (p.slug !== slug && p.first_published_at) throw httpError(409, "slug_locked");
    if (p.slug !== slug && this.s.products.some((x) => x.slug === slug && x.id !== id)) throw httpError(409, "slug_taken");
    for (const v of content.variants || []) { const owner = this.s.variants.find((x) => x.sku === v.sku); if (owner && owner.product_id !== id) throw httpError(409, "sku_taken", { current: { sku: v.sku } }); }
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
      if (!matches || p.workflow_status !== "in_review" || p.review_version !== p.current_version) this.stateChanged(p);
      const approve = action === "approve";
      bump({ workflow_status: approve ? "approved" : "changes_requested", approved_version: approve ? p.review_version : null });
      review(p.review_version, approve ? "approved" : "changes_requested", note);
    } else if (action === "publish") {
      if (reason && reason.length < 20) throw httpError(400, "override_reason_too_short");
      if (!matches || p.publication_status === "archived") this.stateChanged(p);
      const current = this.s.versions.find((v) => v.product_id === id && v.version === p.current_version);
      const notLive = p.published_version !== p.current_version || p.publication_status !== "published";
      const normal = p.workflow_status === "approved" && p.approved_version === p.current_version && notLive;
      const minor = p.publication_status === "published" && p.published_version != null && p.current_version > p.published_version && current.materiality === "minor";
      const override = reason.length >= 20 && notLive;
      if (!normal && !minor && !override) throw httpError(409, "review_required");
      const approvedReview = this.s.reviews.some((r) => r.product_id === id && r.version === p.current_version && r.decision === "approved");
      const path = approvedReview ? "published" : current.materiality === "minor" && !reason ? "published_minor" : "published_override";
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
