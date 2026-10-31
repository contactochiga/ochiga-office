"use strict";
// Explicit synthetic catalogue-only snapshot; never opens live store configuration.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const [target, fixture] = process.argv.slice(2);
if (!target || !fixture) throw new Error("Usage: node test-catalogue-rollback-snapshot.js <build-root> <synthetic-catalogue-snapshot>");
const { handlePublicCatalogueRequest } = require(path.resolve(target, "src/lead-agents/catalogue-public-api"));
const state = JSON.parse(fs.readFileSync(fixture, "utf8"));
assert.deepEqual(Object.keys(state), ["catalogue"], "fixture must contain catalogue only");
const before = JSON.stringify(state);
const store = { state, persist() { throw new Error("unexpected mutation"); } };
const packages = state.catalogue.products.filter(p => p.kind === "package");
const listings = state.catalogue.public_listings.filter(l => l.status === "public" && packages.some(p => p.id === l.product_id));
assert.ok(listings.length > 0, "persisted public package records required");
let passed = 0, storageReads = 0;
function check(ok, label) { assert.ok(ok, label); passed++; console.log("PASS " + label); }
const server = http.createServer(async (req, res) => {
  try {
    await handlePublicCatalogueRequest({req, res, pathname: new URL(req.url, "http://localhost").pathname, ctx: {requestId: "synthetic-rollback-proof"}, store, config: {}, authContext: {type: "scoped_api_key", scopes: ["catalogue.public.read"]}, storageService: {getObject() {storageReads++; throw new Error("unexpected storage access");}}});
  } catch { res.writeHead(500); res.end(); }
});
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const get = p => fetch(`http://127.0.0.1:${server.address().port}/api/public/catalogue${p}`);
  try {
    const r = await get("/products");
    check(r.status === 200, "persisted catalogue readable by rollback build");
    const body = await r.json();
    check(!body.products.some(p => listings.some(l => l.slug === p.slug)), "persisted released packages absent from hardware list");
    for (const l of listings) check((await get(`/products/${l.slug}`)).status === 404, "persisted released package denied hardware detail");
    const packageIds = new Set(packages.map(p => p.id));
    const mediaIds = new Set(state.catalogue.media.filter(m => packageIds.has(m.product_id)).map(m => m.id));
    const derivatives = state.catalogue.media_derivatives.filter(d => mediaIds.has(d.media_id));
    check(derivatives.length > 0, "persisted package media fixture present");
    for (const d of derivatives) check((await get(`/media/${d.sha256}.webp`)).status === 404, "persisted package image denied hardware media");
    check(storageReads === 0, "no package storage read");
    check(JSON.stringify(state) === before, "records, versions and history unchanged");
    console.log(JSON.stringify({suite: "rollback-persisted-snapshot", passed, failed: 0, persistedProducts: state.catalogue.products.length, persistedPackages: packages.length, releasedPackages: listings.length}));
  } finally { await new Promise(r => server.close(r)); }
})().catch(e => {console.error(e.message); process.exitCode = 1;});
