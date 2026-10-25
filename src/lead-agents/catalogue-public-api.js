"use strict";

// Public catalogue API for GetOyi (Phase 2 stage 4), mounted under /api/public/catalogue/. Read-only. Callable ONLY with a scoped key
// holding "catalogue.public.read" (a separate key from the website's intake key; never a privileged key, never a staff session).
//   GET /categories                         active categories with their number of public products
//   GET /products[?category=<slug>]         public product cards
//   GET /products/<slug>                    one public product, or { redirect_to } for an old slug of a public product
//   GET /media/<sha256>.webp                a WebP rendition referenced by a PUBLIC version (content-addressed; never an original)
//   GET /preview/<token>                    a signed, short-lived staff preview of one version (any workflow state)
//   GET /preview/<token>/media/<sha256>.webp
// A product is public only while its listing is 'public' AND it is still internally published: withdrawal, internal unpublish and
// archive all take effect on the next request. Everything returned is built by catalogue-public.js from an allow-list.
// Also exports the GetOyi refresh dispatcher used by the staff routes.

const { json } = require("./http");
const { appendAuditRecord } = require("./audit");
const { hasPermission } = require("./permissions");
const { catalogueStoreFor } = require("./catalogue-store");
const PUB = require("./catalogue-public");

const PREFIX = "/api/public/catalogue";
const PUBLIC_SCOPE = "catalogue.public.read";

// ---------------------------------------------------------------------------------------------------------------- projection
async function publicViews(cat, listings) {
  if (!listings.length) return [];
  const products = new Map((await cat.productsByIds(listings.map((l) => l.product_id))).map((p) => [p.id, p]));
  const visible = listings.filter((l) => l.status === "public" && products.get(l.product_id) && products.get(l.product_id).publication_status === "published");
  if (!visible.length) return [];
  const [versions, variants, categories, brands] = await Promise.all([
    cat.versionsFor(visible.map((l) => [l.product_id, l.public_version])),
    cat.variantsForProducts(visible.map((l) => l.product_id)),
    cat.listCategories(),
    cat.listBrands(),
  ]);
  const content = new Map(versions.map((v) => [v.product_id, v.content]));
  const mediaRows = await cat.mediaWithRenditions(versions.flatMap((v) => (v.content.media || []).map((m) => m.media_id)));
  return visible.filter((l) => content.has(l.product_id)).map((l) => {
    const c = content.get(l.product_id);
    return PUB.publicProduct({
      slug: l.slug,
      content: c,
      variants: variants.filter((v) => v.product_id === l.product_id),
      mediaRows: mediaRows.filter((m) => m.product_id === l.product_id),
      category: categories.find((x) => x.id === c.category_id && x.status === "active") || null,
      brand: brands.find((x) => x.id === c.brand_id && x.status === "active") || null,
      releasedAt: l.released_at,
    });
  });
}

// is this listing currently public (listing + internal state)?
async function currentlyPublic(cat, productId) {
  const listing = await cat.getPublicListing(productId);
  if (!listing || listing.status !== "public") return null;
  const product = await cat.getProduct(productId);
  if (!product || product.publication_status !== "published") return null;
  return { listing, product };
}

// a preview grant that may still be used -> { grant, product } (throws 404/410 otherwise)
async function usableGrant(cat, store, config, token) {
  const grantId = PUB.verifyPreviewToken(config, token);
  const fail = (status, code) => Object.assign(new Error(code), { statusCode: status, code });
  if (!grantId) throw fail(404, "preview_not_found");
  const grant = await cat.getPreviewGrant(grantId);
  if (!grant) throw fail(404, "preview_not_found");
  if (grant.revoked_at) throw fail(410, "preview_revoked");
  if (Date.parse(grant.expires_at) <= Date.now()) throw fail(410, "preview_expired");
  const product = await cat.getProduct(grant.product_id);
  if (!product || product.publication_status === "archived") throw fail(410, "preview_revoked");
  // the staff member who opened it must still be an active catalogue reader
  const staff = typeof store.getAdminUserByEmail === "function" ? await store.getAdminUserByEmail(grant.staff).catch(() => null) : null;
  if (!staff || staff.status === "inactive" || !hasPermission({ type: "session", role: staff.role, permissionScopes: staff.permission_scopes || [] }, "catalogue.read")) throw fail(410, "preview_revoked");
  return { grant, product };
}

async function serveRendition({ res, storageService, filename, publicCache, requestId }) {
  const object = storageService ? await storageService.getObject(filename) : null;
  if (!object) return false;
  res.writeHead(200, {
    "content-type": "image/webp",
    "content-length": String(object.buffer.length),
    // public: URL = content hash, so the bytes never change; a withdrawn product's images stop resolving at Office immediately and in
    // shared caches within max-age (documented withdrawal delay). Previews are never cached.
    "cache-control": publicCache ? "public, max-age=300, s-maxage=300" : "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-request-id": requestId,
  });
  res.end(object.buffer);
  return true;
}

async function handlePublicCatalogueRequest({ req, res, ctx, pathname, authContext, store, storageService, config, log = () => {} }) {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
  const headers = { "x-request-id": ctx.requestId, "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const send = (status, payload) => json(res, status, payload, headers);
  try {
    if (!authContext || authContext.type !== "scoped_api_key" || !(authContext.scopes || []).includes(PUBLIC_SCOPE)) return send(403, { error: "forbidden" }), true;
    if (req.method !== "GET") return send(405, { error: "method_not_allowed" }), true;
    const cat = catalogueStoreFor(store);
    if (!(await cat.available()) || !(await cat.publicAvailable())) return send(503, { error: "catalogue_unavailable" }), true;
    const sub = pathname.slice(PREFIX.length) || "/";
    const url = new URL(req.url, "http://localhost");
    let m;

    if (sub === "/categories") {
      const views = await publicViews(cat, await cat.listPublicListings());
      const counts = new Map();
      views.forEach((v) => { if (v.category) counts.set(v.category.slug, (counts.get(v.category.slug) || 0) + 1); });
      const categories = (await cat.listCategories()).filter((c) => c.status === "active").map((c) => ({ slug: c.slug, name: c.name, product_count: counts.get(c.slug) || 0 }));
      return send(200, { categories }), true;
    }
    if (sub === "/products") {
      let views = await publicViews(cat, await cat.listPublicListings());
      const category = String(url.searchParams.get("category") || "");
      if (category) views = views.filter((v) => v.category && v.category.slug === category);
      views.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      return send(200, { products: views.map(PUB.publicCard), total: views.length }), true;
    }
    if ((m = sub.match(/^\/products\/([a-z0-9-]{1,80})$/))) {
      const slug = m[1];
      const listing = await cat.getPublicListingBySlug(slug);
      if (listing) {
        const [view] = await publicViews(cat, [listing]);
        if (view) return send(200, { product: view }), true;
        return send(404, { error: "not_found" }), true;
      }
      const redirect = await cat.getSlugRedirect(slug);
      if (redirect) {
        const live = await currentlyPublic(cat, redirect.product_id);
        if (live && live.listing.slug !== slug) return send(200, { redirect_to: live.listing.slug }), true;
      }
      return send(404, { error: "not_found" }), true;
    }
    if ((m = sub.match(/^\/media\/([0-9a-f]{64})\.webp$/))) {
      for (const r of await cat.renditionBySha(m[1])) {
        if (r.status !== "active") continue;
        const live = await currentlyPublic(cat, r.product_id);
        if (!live) continue;
        const version = await cat.getVersion(r.product_id, live.listing.public_version);
        if (!version || !PUB.referencedMediaIds(version.content).has(r.media_id)) continue;
        if (await serveRendition({ res, storageService, filename: r.filename, publicCache: true, requestId: ctx.requestId })) return true;
      }
      return send(404, { error: "not_found" }), true;
    }
    if ((m = sub.match(/^\/preview\/([A-Za-z0-9._-]{1,200})$/))) {
      const { grant, product } = await usableGrant(cat, store, config, m[1]);
      const version = await cat.getVersion(product.id, grant.version);
      if (!version) return send(404, { error: "preview_not_found" }), true;
      const [variants, mediaRows, categories, brands] = await Promise.all([
        cat.listVariants(product.id), cat.mediaWithRenditions((version.content.media || []).map((x) => x.media_id)), cat.listCategories(), cat.listBrands(),
      ]);
      const view = PUB.publicProduct({
        slug: product.slug, content: version.content, variants, mediaRows,
        category: categories.find((x) => x.id === version.content.category_id) || null, brand: brands.find((x) => x.id === version.content.brand_id) || null, releasedAt: null,
      });
      await appendAuditRecord({ store, authContext, action: "catalogue_preview_viewed", resourceType: "catalogue_product", resourceId: product.id, metadata: { grant_id: grant.id, version: grant.version, staff: grant.staff }, req });
      return send(200, { preview: { version: grant.version, expires_at: grant.expires_at, status: product.publication_status === "published" && product.published_version === grant.version ? "published_internally" : "not_published" }, product: view }), true;
    }
    if ((m = sub.match(/^\/preview\/([A-Za-z0-9._-]{1,200})\/media\/([0-9a-f]{64})\.webp$/))) {
      const { grant, product } = await usableGrant(cat, store, config, m[1]);
      const version = await cat.getVersion(product.id, grant.version);
      const allowed = PUB.referencedMediaIds(version && version.content);
      for (const r of await cat.renditionBySha(m[2])) {
        if (r.status !== "active" || r.product_id !== product.id || !allowed.has(r.media_id)) continue;
        if (await serveRendition({ res, storageService, filename: r.filename, publicCache: false, requestId: ctx.requestId })) return true;
      }
      return send(404, { error: "not_found" }), true;
    }
    return send(404, { error: "not_found" }), true;
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    if (status >= 500) log("error", "public_catalogue.request_failed", { request_id: ctx.requestId, path: pathname.replace(/\/preview\/[^/]+/, "/preview/<token>"), error: String((error && error.code) || (error && error.message) || error).slice(0, 200) });
    send(status, { error: status >= 500 ? "internal_server_error" : (error && error.code) || "request_failed" });
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------- refresh dispatcher
// Tells GetOyi to revalidate its Hardware pages, records the outcome against the listing's refresh round, and retries a failed round
// twice in the background. A newer round (another public change, or a manual Retry) supersedes an older one: its late answers are ignored.
async function notifyGetOyi(config, payload) {
  if (!config.getoyiRevalidateUrl || !config.getoyiRevalidateSecret) return { outcome: "not_configured", error: "" };
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.getoyiRevalidateTimeoutMs) || 5000);
  try {
    const response = await fetch(config.getoyiRevalidateUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-getoyi-signature": PUB.revalidationSignature(config.getoyiRevalidateSecret, body) },
      body,
      signal: controller.signal,
    });
    return response.ok ? { outcome: "succeeded", error: "" } : { outcome: "failed", error: `http_${response.status}` };
  } catch (error) {
    return { outcome: "failed", error: error && error.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

const RETRY_DELAYS_MS = [2000, 8000];

async function refreshPublic({ store, config, productId, event, log = () => {}, newRound = false, retryDelays = RETRY_DELAYS_MS }) {
  const cat = catalogueStoreFor(store);
  if (!(await cat.publicAvailable())) return null;
  let listing = await cat.getPublicListing(productId);
  if (!listing) return null;
  if (newRound) { await cat.requestPublicRefresh(productId); listing = await cat.getPublicListing(productId); }
  const seq = listing.refresh_seq;
  const redirects = await cat.listSlugRedirects(productId);
  const payload = { event, slug: listing.slug, previous_slugs: redirects.map((r) => r.old_slug), status: listing.status, at: new Date().toISOString() };
  const attempt = async () => {
    const result = await notifyGetOyi(config, payload);
    const current = await cat.recordPublicRefresh({ productId, seq, outcome: result.outcome, error: result.error });
    if (result.outcome === "failed") log("warn", "public_catalogue.refresh_failed", { event, error: result.error, superseded: !current });
    return { ...result, current };
  };
  const first = await attempt();
  if (first.outcome === "failed" && first.current && retryDelays.length) {
    let i = 0;
    const next = () => setTimeout(async () => {
      try {
        const r = await attempt();
        i += 1;
        if (r.outcome === "failed" && r.current && i < retryDelays.length) next();
      } catch (error) { log("warn", "public_catalogue.refresh_retry_error", { error: String(error && error.message || error).slice(0, 120) }); }
    }, retryDelays[i]).unref();
    next();
  }
  return cat.getPublicListing(productId);
}

module.exports = { PUBLIC_CATALOGUE_PREFIX: PREFIX, PUBLIC_SCOPE, handlePublicCatalogueRequest, publicViews, refreshPublic };
