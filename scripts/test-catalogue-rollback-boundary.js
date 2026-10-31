"use strict";
// Real HTTP route handling with a read-only synthetic store. Runs on both the
// supported pre-SP rollback build and the SP candidate; never accesses a database.
const assert = require("node:assert/strict");
const http = require("node:http");
const { handlePublicCatalogueRequest } = require("../src/lead-agents/catalogue-public-api");
const { handleCatalogueRequest } = require("../src/lead-agents/catalogue-api");
const products = [{ id: "ordinary", kind: "product" }, { id: "legacy" }, { id: "bundle", kind: "package" }, { id: "service", kind: "service" }, { id: "future", kind: "unknown" }].map(p => ({ ...p, publication_status: "published" }));
const listings = products.map(p => ({ product_id: p.id, slug: p.id, status: "public", public_version: 1 }));
const content = id => ({ name: id, category_id: "cat", variants: [], media: [{ media_id: id, cover: true, alt: id }] });
const cat = {
  available: async () => true, publicAvailable: async () => true,
  listPublicListings: async () => listings,
  productsByIds: async ids => products.filter(p => ids.includes(p.id)),
  versionsFor: async ids => ids.map(([id]) => ({ product_id: id, content: content(id) })),
  variantsForProducts: async () => [], mediaWithRenditions: async () => [],
  listCategories: async () => [{ id: "cat", slug: "cat", name: "Category", status: "active" }], listBrands: async () => [],
  getPublicListingBySlug: async slug => listings.find(l => l.slug === slug),
  getPublicListing: async id => listings.find(l => l.product_id === id),
  getProduct: async id => products.find(p => p.id === id),
  getSlugRedirect: async slug => slug.startsWith("old-") ? { product_id: slug.slice(4) } : null,
  renditionBySha: async sha => [{ product_id: sha[0] === "a" ? "bundle" : "ordinary", media_id: sha[0] === "a" ? "bundle" : "ordinary", status: "active", filename: "fixture" }],
  getVersion: async id => ({ content: content(id) }),
};
let reads = 0, count = 0;
const store = { __catalogue: cat };
const authContext = { type: "scoped_api_key", scopes: ["catalogue.public.read"] };
const check = (ok, label) => { assert.ok(ok, label); count++; console.log("PASS " + label); };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/lead-agents/admin/catalogue")) return handleCatalogueRequest({ req, res, ctx: { requestId: "synthetic" }, pathname, store,
    authContext: req.headers["x-test-staff"] === "yes" ? { type: "session", role: "super_admin" } : null });
  await handlePublicCatalogueRequest({ req, res, ctx: { requestId: "synthetic" }, pathname, authContext: req.headers["x-test-auth"] === "yes" ? authContext : null, store, config: {}, storageService: { getObject: async () => { reads++; return { buffer: Buffer.from("synthetic") }; } } });
});
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public/catalogue`;
  const get = p => fetch(base + p, { headers: { "x-test-auth": "yes" } });
  try {
    check((await (await get("/products")).json()).products.map(p => p.slug).join() === "legacy,ordinary", "only ordinary and pre-kind products listed");
    check((await (await get("/categories")).json()).categories[0].product_count === 2, "category counts exclude all non-products");
    for (const id of ["bundle", "service", "future"]) {
      check((await get("/products/" + id)).status === 404, id + " cannot appear as hardware detail");
      check((await get("/products/old-" + id)).status === 404, id + " cannot appear as hardware redirect");
    }
    check((await get("/products/ordinary")).status === 200, "ordinary detail preserved");
    check((await get("/products/old-ordinary")).status === 200, "ordinary redirect preserved");
    check((await get("/media/" + "a".repeat(64) + ".webp")).status === 404 && reads === 0, "generic hardware media denies package without reading storage");
    check((await get("/media/" + "b".repeat(64) + ".webp")).status === 200 && reads === 1, "ordinary hardware media preserved");
    check((await fetch(base + "/products")).status === 403, "scoped authentication retained");
    process.env.OFFICE_CATALOGUE_ROLLBACK_READ_ONLY = "true";
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const r = await fetch(base.replace("/api/public/catalogue", "/api/lead-agents/admin/catalogue/products"), { method, headers: { "x-test-staff": "yes" } });
      check(r.status === 503 && (await r.json()).error === "catalogue_rollback_read_only", method + " frozen during rollback, including privileged staff");
    }
    console.log(`${count}/${count} passed`);
  } finally { delete process.env.OFFICE_CATALOGUE_ROLLBACK_READ_ONLY; await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
