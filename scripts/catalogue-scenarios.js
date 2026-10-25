// Product catalogue (Phase 1) acceptance scenarios, store-agnostic: run over HTTP against a real Office server, by
// scripts/test-catalogue-api.js (file store) and scripts/test-catalogue-postgres.js (Supabase Postgres + PostgREST).
// Covers 03_CATALOGUE_SPECIFICATION.md AT-04, AT-10..13, AT-20..26, AT-30..32 (+ supplier/cost boundaries and audit evidence).
"use strict";
const crypto = require("crypto");

// Users the runner must provision (email -> role + permission_scopes). Passwords are generated per run.
const CATALOGUE_TEST_USERS = Object.freeze({
  superAdmin: { role: "super_admin", scopes: [] },
  admin: { role: "ochiga_admin", scopes: [] },
  staff: { role: "ochiga_staff", scopes: [] },
  writerA: { role: "ochiga_staff", scopes: ["catalogue.write"] },
  writerB: { role: "ochiga_staff", scopes: ["catalogue.write"] },
  senior: { role: "ochiga_staff", scopes: ["catalogue.write", "catalogue.review", "catalogue.publish", "catalogue.price.approve"] },
  reviewer: { role: "ochiga_staff", scopes: ["catalogue.review"] },
  reviewer2: { role: "ochiga_staff", scopes: ["catalogue.review"] },
  publisher: { role: "ochiga_staff", scopes: ["catalogue.publish"] },
  pricerA: { role: "ochiga_staff", scopes: ["catalogue.price.approve"] },
  pricerB: { role: "ochiga_staff", scopes: ["catalogue.price.approve"] },
  finance: { role: "ochiga_staff", scopes: ["catalogue.cost.read", "catalogue.cost.manage"] },
  ops: { role: "ochiga_staff", scopes: ["inventory.manage"] },
  scopedOverride: { role: "ochiga_staff", scopes: ["catalogue.publish", "catalogue.override"] },
  releaser: { role: "ochiga_staff", scopes: ["catalogue.public.publish"] },
  outsider: { role: "estate_admin", scopes: [] },
});

function testUsers(tag = crypto.randomBytes(3).toString("hex")) {
  return Object.fromEntries(Object.entries(CATALOGUE_TEST_USERS).map(([name, u]) => [name, { ...u, email: `${name.toLowerCase()}.${tag}@fixture.test`, password: `Cat!${crypto.randomBytes(8).toString("hex")}Aa1` }]));
}

// GetOyi revalidation stand-in: verifies the HMAC signature like GetOyi does, records each request, and can fail on demand.
function startRevalidator(secret) {
  const http = require("http");
  const state = { requests: [], failures: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const sig = String(req.headers["x-getoyi-signature"] || "");
      const t = (sig.match(/t=(\d+)/) || [])[1], v1 = (sig.match(/v1=([0-9a-f]{64})/) || [])[1];
      const valid = Boolean(t && v1 && crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex") === v1 && Math.abs(Date.now() / 1000 - Number(t)) < 300);
      let payload = null; try { payload = JSON.parse(body); } catch { /* invalid */ }
      state.requests.push({ valid, payload });
      if (state.failures > 0) { state.failures -= 1; res.writeHead(503); res.end("{}"); return; }
      res.writeHead(valid ? 200 : 401, { "content-type": "application/json" }); res.end(JSON.stringify({ revalidated: valid }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}/api/hardware/revalidate`,
    requests: state.requests,
    failNext: (n) => { state.failures = n; },
    close: () => new Promise((r) => server.close(r)),
  })));
}

async function runCatalogueScenarios({ base, users, fullKey, scopedKey, check, label = "", storageDir = null, catalogueKey = null, revalidator = null }) {
  const cookies = {};
  async function login(name) {
    const u = users[name];
    const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.password }) });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const cookie = (set.find((x) => /^lead_agents_admin=/.test(x)) || "").split(";")[0];
    if (!cookie) throw new Error(`login failed for ${name}: ${r.status} ${await r.text()}`);
    cookies[name] = cookie;
  }
  for (const name of Object.keys(users)) await login(name);

  const call = async (who, method, path, body, extraHeaders = {}) => {
    const headers = { "content-type": "application/json", origin: base, ...extraHeaders };
    if (who && cookies[who]) headers.cookie = cookies[who];
    const r = await fetch(`${base}/api/lead-agents/admin/catalogue${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const as = (who) => ({ get: (p) => call(who, "GET", p), post: (p, b = {}) => call(who, "POST", p, b), patch: (p, b) => call(who, "PATCH", p, b) });
  const A = Object.fromEntries(Object.keys(users).map((n) => [n, as(n)]));
  const audit = async () => {
    const r = await fetch(`${base}/api/lead-agents/admin/audit`, { headers: { "x-api-key": fullKey } });
    return ((await r.json()).audit || []);
  };
  const id = (x) => `${label}${x}`;
  const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
  const slugTag = tag.toLowerCase();

  // ------------------------------------------------------------------------------------------------ AT-13 boundary
  {
    const viaFull = await call(null, "GET", "/products", undefined, { "x-api-key": fullKey });
    const viaFullPost = await call(null, "POST", "/categories", { slug: "x", name: "x" }, { "x-api-key": fullKey });
    const viaScoped = await call(null, "GET", "/products", undefined, { "x-api-key": scopedKey });
    const anonymous = await call(null, "GET", "/products");
    const outsider = await A.outsider.get("/products");
    check(id("AT13a"), "a FULL API key (which passes every legacy permission) is refused on catalogue routes: staff session required", viaFull.status === 403 && viaFull.json.error === "catalogue_requires_staff_session" && viaFullPost.status === 403, { viaFull, viaFullPost: viaFullPost.status });
    check(id("AT13b"), "a scoped (website) key is refused; no credential is 401; a staff user without catalogue.read is 403", viaScoped.status === 403 && anonymous.status === 401 && outsider.status === 403, { viaScoped: viaScoped.status, anonymous: anonymous.status, outsider: outsider.status });
  }

  // ------------------------------------------------------------------------------------------------ least privilege (release review)
  {
    const staffRead = await A.staff.get("/products");
    const staffCreate = await A.staff.post("/products", { slug: `lp-${slugTag}`, content: {} });
    const adminRead = await A.admin.get("/products");
    const adminCreate = await A.admin.post("/products", { slug: `lp2-${slugTag}`, content: {} });
    const adminSuppliers = await A.admin.get("/suppliers");
    check(id("LP1"), "least privilege: general staff and ochiga_admin can read the catalogue but cannot create products or see suppliers without a per-user grant", staffRead.status === 200 && staffCreate.status === 403 && adminRead.status === 200 && adminCreate.status === 403 && adminSuppliers.status === 403, { staffRead: staffRead.status, staffCreate: staffCreate.status, adminRead: adminRead.status, adminCreate: adminCreate.status, adminSuppliers: adminSuppliers.status });
  }

  // ------------------------------------------------------------------------------------------------ AT-04 taxonomy
  const cats = await A.writerA.get("/categories");
  const seeded = ["smart-home-automation", "security-access-control", "networking-connectivity", "sensors-monitoring", "control-panels-gateways", "installation-accessories"];
  check(id("AT04a"), "seed: exactly the six D9 categories, in order", cats.status === 200 && JSON.stringify(cats.json.categories.slice(0, 6).map((c) => c.slug)) === JSON.stringify(seeded), cats.json && cats.json.categories.map((c) => c.slug));
  const catId = cats.json.categories.find((c) => c.slug === "smart-home-automation").id;
  const cat2Id = cats.json.categories.find((c) => c.slug === "sensors-monitoring").id;
  {
    const denied = await A.writerA.post("/categories", { slug: `kits-${slugTag}`, name: "Kits" });
    const made = await A.publisher.post("/categories", { slug: `kits-${slugTag}`, name: "Kits", sort: 70 });
    const rv = made.json && made.json.category.row_version;
    const reorder = await A.publisher.patch(`/categories/${made.json.category.id}`, { expected_row_version: rv, sort: 5, name: "Starter kits" });
    const stale = await A.publisher.patch(`/categories/${made.json.category.id}`, { expected_row_version: rv, sort: 6 });
    const writerEdit = await A.writerA.patch(`/categories/${catId}`, { expected_row_version: 1, name: "Hijack" });
    check(id("AT04b"), "categories editable and re-orderable by a permitted user (catalogue.publish), refused for a writer; stale edits 409", denied.status === 403 && made.status === 201 && reorder.status === 200 && reorder.json.category.sort === 5 && stale.status === 409 && stale.json.error === "state_changed" && writerEdit.status === 403, { denied: denied.status, made: made.status, reorder: reorder.status, stale: stale.status, writerEdit: writerEdit.status });
    const brand = await A.publisher.post("/brands", { slug: `acme-${slugTag}`, name: "Acme" });
    const brands = await A.writerA.get("/brands");
    check(id("AT04c"), "brand registry: publisher creates, staff read", brand.status === 201 && brands.json.brands.some((b) => b.slug === `acme-${slugTag}`), brand);
  }
  const brandId = (await A.writerA.get("/brands")).json.brands.find((b) => b.slug === `acme-${slugTag}`).id;

  // ------------------------------------------------------------------------------------------------ AT-10 / AT-11 / AT-12 products and versions
  const content = (over = {}) => ({
    category_id: catId, brand_id: brandId, name: "Smart Switch 2-Gang", model: `SW2-${tag}`, summary: "Two-gang smart wall switch for Oyi homes.",
    description: "A neutral-wire two-gang switch with local control and Oyi Facility integration.",
    specifications: [{ key: "Voltage", value: "220-240", unit: "V" }, { key: "Gangs", value: "2", unit: "" }],
    compatibility: { facility: true, experience: true, core: false, edge: true, notes: "Requires Oyi Edge gateway." },
    variants: [{ sku: `SW2-${tag}-WHT`, name: "White", options: { colour: "white" } }, { sku: `SW2-${tag}-BLK`, name: "Black", options: { colour: "black" } }],
    ...over,
  });
  const slug = `smart-switch-2-gang-${slugTag}`;
  const created = await A.writerA.post("/products", { slug, content: content() });
  const pid = created.json && created.json.product && created.json.product.id;
  check(id("AT10a"), "create: v1 draft, never published, two SKUs registered without price", created.status === 201 && created.json.product.current_version === 1 && created.json.product.workflow_status === "draft" && created.json.product.publication_status === "never_published" && created.json.variants.length === 2 && created.json.variants.every((v) => v.price_ngn_kobo === null), created);
  {
    const badSku = await A.writerA.post("/products", { slug: `bad-${slugTag}`, content: content({ variants: [{ sku: "lower case", name: "x" }] }) });
    const noVariant = await A.writerA.post("/products", { slug: `bad2-${slugTag}`, content: content({ variants: [] }) });
    const media = await A.writerA.post("/products", { slug: `bad3-${slugTag}`, content: content({ variants: [{ sku: `M-${tag}`, name: "m" }], media: [{ office_file_id: "x" }] }) });
    const dupSlug = await A.writerA.post("/products", { slug, content: content({ variants: [{ sku: `OTHER-${tag}`, name: "o" }] }) });
    const dupSku = await A.writerB.post("/products", { slug: `another-${slugTag}`, content: content() });
    check(id("AT10b"), "validation: bad SKU / no variant / media (Phase 2) -> 400; duplicate slug and a SKU of another product -> 409", badSku.status === 400 && noVariant.status === 400 && media.status === 400 && dupSlug.status === 409 && dupSku.status === 409 && dupSku.json.error === "sku_taken", { badSku: badSku.status, noVariant: noVariant.status, media: media.status, dupSlug: [dupSlug.status, dupSlug.json && dupSlug.json.error], dupSku: [dupSku.status, dupSku.json && dupSku.json.error] });
  }
  const edit1 = await A.writerA.patch(`/products/${pid}`, { expected_row_version: 1, content: content({ name: "Smart Switch 2-Gang Pro" }) });
  check(id("AT11a"), "every edit creates a new immutable version (v2); history lists both", edit1.status === 200 && edit1.json.product.current_version === 2 && edit1.json.versions.length === 2 && edit1.json.versions.every((v) => v.materiality === "initial"), edit1);
  {
    const v2 = await A.writerA.get(`/products/${pid}/versions/2?diff_to=1`);
    const v1 = await A.writerA.get(`/products/${pid}/versions/1`);
    check(id("AT11b"), "diff between versions is correct (only the name changed) and v1 is unchanged", v2.status === 200 && v2.json.diff.length === 1 && v2.json.diff[0].field === "name" && v2.json.diff[0].before === "Smart Switch 2-Gang" && v1.json.version.content.name === "Smart Switch 2-Gang", v2.json);
    const [x, y] = await Promise.all([
      A.writerA.patch(`/products/${pid}`, { expected_row_version: 2, content: content({ name: "Editor A" }) }),
      A.writerB.patch(`/products/${pid}`, { expected_row_version: 2, content: content({ name: "Editor B" }) }),
    ]);
    const statuses = [x.status, y.status].sort();
    const loser = x.status === 409 ? x : y;
    check(id("AT12"), "two editors with the same expected_row_version: one 200, one 409 state_changed carrying the current row_version", JSON.stringify(statuses) === "[200,409]" && loser.json.error === "state_changed" && loser.json.current && loser.json.current.row_version === 3, { statuses, loser: loser.json });
  }
  let product = (await A.writerA.get(`/products/${pid}`)).json.product;
  // writerA authored v1, v2 and possibly v3; writerB possibly v3 -> both are authors of the change set

  // ------------------------------------------------------------------------------------------------ AT-20 / AT-21 review and publishing
  {
    const pubDraft = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    const seniorDraft = await A.senior.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    const adminDraft = await A.admin.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    check(id("AT20a"), "publishing a never-reviewed draft is refused (publisher, and a senior editor holding review+publish without override); ochiga_admin has no publish grant by default", pubDraft.status === 409 && pubDraft.json.error === "review_required" && seniorDraft.status === 409 && adminDraft.status === 403, { pubDraft: pubDraft.json, seniorDraft: seniorDraft.json, adminDraft: adminDraft.status });
    const writerApprove = await A.writerA.post(`/products/${pid}/approve`, { expected_row_version: product.row_version });
    check(id("AT13c"), "catalogue.write does not grant review", writerApprove.status === 403, writerApprove.status);
    const submit = await A.writerA.post(`/products/${pid}/submit`, { expected_row_version: product.row_version });
    product = submit.json.product;
    check(id("AT21a"), "submit: in_review on the current version", submit.status === 200 && product.workflow_status === "in_review" && product.review_version === product.current_version, submit.json);
    const pubInReview = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    check(id("AT20b"), "publishing while in review (not approved) is refused", pubInReview.status === 409 && pubInReview.json.error === "review_required", pubInReview.json);
  }
  // an author who also holds catalogue.review (the admin) cannot approve their own change: create a product authored by the admin
  {
    const own = await A.senior.post("/products", { slug: `own-${slugTag}`, content: content({ variants: [{ sku: `OWN-${tag}`, name: "Own" }] }) });
    const ownSubmit = await A.senior.post(`/products/${own.json.product.id}/submit`, { expected_row_version: own.json.product.row_version });
    const ownApprove = await A.senior.post(`/products/${own.json.product.id}/approve`, { expected_row_version: ownSubmit.json.product.row_version });
    const ownChanges = await A.senior.post(`/products/${own.json.product.id}/request-changes`, { expected_row_version: ownSubmit.json.product.row_version, note: "self" });
    check(id("AT21b"), "second person enforced server-side, also for someone holding review: the author cannot approve or request changes on their own version", ownApprove.status === 403 && ownApprove.json.error === "own_change" && ownChanges.status === 403, { ownApprove: ownApprove.json, ownChanges: ownChanges.json });
  }
  {
    const changes = await A.reviewer.post(`/products/${pid}/request-changes`, { expected_row_version: product.row_version, note: "Add the IP rating" });
    check(id("AT21c"), "reviewer requests changes -> changes_requested; the authors are notified", changes.status === 200 && changes.json.product.workflow_status === "changes_requested", changes.json);
    const writerNotes = await fetch(`${base}/api/lead-agents/admin/notifications/mine`, { headers: { cookie: cookies.writerA } }).then((r) => r.json());
    check(id("AT21d"), "…the author got a changes-requested notification", (writerNotes.notifications || []).some((n) => n.type === "catalogue_changes_requested" && n.related_id === pid), (writerNotes.notifications || []).map((n) => n.type));
    product = changes.json.product;
    const edited = await A.writerA.patch(`/products/${pid}`, { expected_row_version: product.row_version, content: content({ name: "Smart Switch 2-Gang Pro", specifications: [{ key: "Voltage", value: "220-240", unit: "V" }, { key: "Gangs", value: "2", unit: "" }, { key: "IP rating", value: "IP20", unit: "" }] }) });
    const resubmit = await A.writerA.post(`/products/${pid}/submit`, { expected_row_version: edited.json.product.row_version });
    const reviewerNotes = await fetch(`${base}/api/lead-agents/admin/notifications/mine`, { headers: { cookie: cookies.reviewer } }).then((r) => r.json());
    check(id("AT21e"), "resubmitted after edit; reviewers notified of the review request", resubmit.status === 200 && (reviewerNotes.notifications || []).some((n) => n.type === "catalogue_review_requested" && n.related_id === pid), { resubmit: resubmit.status, types: (reviewerNotes.notifications || []).map((n) => n.type) });
    product = resubmit.json.product;
  }
  // ------------------------------------------------------------------------------------------------ AT-25 concurrency: approve x20, publish x20
  {
    const approvals = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? A.reviewer : A.reviewer2).post(`/products/${pid}/approve`, { expected_row_version: product.row_version })));
    const okA = approvals.filter((r) => r.status === 200);
    const conflictA = approvals.filter((r) => r.status === 409 && r.json.error === "state_changed");
    check(id("AT25a"), "20 concurrent approvals of one version: exactly one succeeds, the other 19 are 409 state_changed", okA.length === 1 && conflictA.length === 19, approvals.map((r) => r.status));
    product = okA[0].json.product;
    check(id("AT21f"), "approved by a different person holding catalogue.review", product.workflow_status === "approved" && product.approved_version === product.current_version, product);
    const writerPublish = await A.writerA.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    check(id("AT13d"), "catalogue.write/review do not grant publish", writerPublish.status === 403, writerPublish.status);
    const publishes = await Promise.all(Array.from({ length: 20 }, () => A.publisher.post(`/products/${pid}/publish`, { expected_row_version: product.row_version })));
    const okP = publishes.filter((r) => r.status === 200);
    check(id("AT25b"), "20 concurrent publishes: exactly one succeeds, the others 409", okP.length === 1 && publishes.filter((r) => r.status === 409).length === 19, publishes.map((r) => r.status));
    product = okP[0].json.product;
    const events = okP[0].json.publication_events.filter((e) => e.action.startsWith("published"));
    check(id("AT21g"), "published: publication_status published, published_version = approved version, exactly one publication event (normal path)", product.publication_status === "published" && product.published_version === product.current_version && events.length === 1 && events[0].action === "published", { product, events });
    const unpubs = await Promise.all(Array.from({ length: 10 }, () => A.publisher.post(`/products/${pid}/unpublish`, { expected_row_version: product.row_version })));
    check(id("AT25c"), "10 concurrent unpublish calls: exactly one succeeds", unpubs.filter((r) => r.status === 200).length === 1, unpubs.map((r) => r.status));
    product = unpubs.find((r) => r.status === 200).json.product;
    const republish = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    check(id("AT21h"), "an unpublished, still-approved version can be re-published without a new review", republish.status === 200 && republish.json.product.publication_status === "published", republish.json);
    product = republish.json.product;
    const evs = republish.json.publication_events.map((e) => e.action);
    check(id("AT25d"), "final state consistent with the events: published, unpublished, published", JSON.stringify(evs) === JSON.stringify(["published", "unpublished", "published"]), evs);
  }
  const publishedVersion = product.published_version;

  // ------------------------------------------------------------------------------------------------ AT-22 / AT-23 material vs minor after publication
  {
    const cur = (await A.writerA.get(`/products/${pid}`)).json;
    const material = await A.writerB.patch(`/products/${pid}`, { expected_row_version: product.row_version, content: { ...cur.content, model: `SW2-${tag}-V2` } });
    product = material.json.product;
    check(id("AT22a"), "material change after publication: new version, publication unchanged (still the earlier published version)", material.status === 200 && material.json.current_materiality === "material" && product.publication_status === "published" && product.published_version === publishedVersion && product.current_version === publishedVersion + 1, material.json);
    const tryPublish = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    const publishedNow = await A.writerA.get(`/products/${pid}/versions/${publishedVersion}`);
    check(id("AT22b"), "…cannot be published without review; the published version's content is untouched", tryPublish.status === 409 && tryPublish.json.error === "review_required" && publishedNow.json.version.content.model === `SW2-${tag}`, { tryPublish: tryPublish.json, model: publishedNow.json && publishedNow.json.version.content.model });
    // release decision: NO minor/typo exception. Revert to the published content except a one-character description typo.
    const back = await A.writerB.patch(`/products/${pid}`, { expected_row_version: product.row_version, content: { ...cur.content, description: cur.content.description.replace("local control", "local contrl") } });
    product = back.json.product;
    check(id("AT23a"), "even a one-character typo edit after publication is classified material (no minor exception)", back.status === 200 && back.json.current_materiality === "material", back.json && back.json.current_materiality);
    const typoPub = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    const superTypoPub = await A.superAdmin.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    check(id("AT23b"), "…and cannot be published without review, by a publisher or by super_admin without the audited override", typoPub.status === 409 && typoPub.json.error === "review_required" && superTypoPub.status === 409, { typoPub: typoPub.json, superTypoPub: superTypoPub.json });
    const sub = await A.writerB.post(`/products/${pid}/submit`, { expected_row_version: product.row_version });
    const appr = await A.reviewer.post(`/products/${pid}/approve`, { expected_row_version: sub.json.product.row_version });
    const pub = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: appr.json.product.row_version });
    product = pub.json.product;
    const last = pub.json.publication_events[pub.json.publication_events.length - 1];
    check(id("AT23c"), "the typo fix goes live only through the review workflow (submit -> second-person approval -> publish); no 'published_minor' event exists", pub.status === 200 && product.published_version === product.current_version && last.action === "published" && pub.json.publication_events.every((e) => e.action !== "published_minor"), { status: pub.status, last });
    const bigText = await A.writerB.patch(`/products/${pid}`, { expected_row_version: product.row_version, content: { ...cur.content, description: `${cur.content.description} Now with scene support.` } });
    check(id("AT23d"), "a further description edit is a new material version awaiting review", bigText.json && bigText.json.current_materiality === "material" && bigText.json.product.workflow_status === "draft", bigText.json && bigText.json.current_materiality);
    product = bigText.json.product;
  }

  // ------------------------------------------------------------------------------------------------ AT-24 override
  {
    const adminOverride = await A.admin.post(`/products/${pid}/publish`, { expected_row_version: product.row_version, override_reason: "Urgent correction requested by the CEO today" });
    const scopedOverride = await A.scopedOverride.post(`/products/${pid}/publish`, { expected_row_version: product.row_version, override_reason: "Urgent correction requested by the CEO today" });
    const shortReason = await A.superAdmin.post(`/products/${pid}/publish`, { expected_row_version: product.row_version, override_reason: "too short" });
    check(id("AT24a"), "override needs catalogue.override (ochiga_admin lacks it), the super_admin role (a per-user scope is not enough) and a reason >= 20 characters", adminOverride.status === 403 && scopedOverride.status === 403 && scopedOverride.json.error === "override_requires_super_admin" && shortReason.status === 400, { adminOverride: adminOverride.json, scopedOverride: scopedOverride.json, shortReason: shortReason.json });
    const reason = "Regulatory label correction needed before the trade fair";
    const override = await A.superAdmin.post(`/products/${pid}/publish`, { expected_row_version: product.row_version, override_reason: reason });
    product = override.json.product;
    const ev = override.json.publication_events[override.json.publication_events.length - 1];
    const rv = override.json.reviews[override.json.reviews.length - 1];
    check(id("AT24b"), "override publish succeeds without review; recorded on the version (review 'override' + reason) and in the publication events", override.status === 200 && ev.action === "published_override" && ev.override === true && ev.override_reason === reason && rv.decision === "override" && rv.note === reason && rv.version === product.current_version, { ev, rv });
    const notes = await fetch(`${base}/api/lead-agents/admin/notifications/mine`, { headers: { cookie: cookies.reviewer2 } }).then((r) => r.json());
    check(id("AT24c"), "…every reviewer is notified", (notes.notifications || []).some((n) => n.type === "catalogue_override_publish" && n.related_id === pid), (notes.notifications || []).map((n) => n.type));
    const cur = (await A.writerA.get(`/products/${pid}`)).json;
    const next = await A.writerA.patch(`/products/${pid}`, { expected_row_version: product.row_version, content: { ...cur.content, name: "Smart Switch 2-Gang Pro Max" } });
    const nextPub = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: next.json.product.row_version });
    check(id("AT24d"), "the next material change still requires review", next.json.current_materiality === "material" && nextPub.status === 409 && nextPub.json.error === "review_required", nextPub.json);
    product = next.json.product;
    const notNeeded = await A.writerA.post(`/products/${pid}/submit`, { expected_row_version: product.row_version });
    const appr = await A.reviewer.post(`/products/${pid}/approve`, { expected_row_version: notNeeded.json.product.row_version });
    const needless = await A.superAdmin.post(`/products/${pid}/publish`, { expected_row_version: appr.json.product.row_version, override_reason: "Not actually needed for an approved version" });
    check(id("AT24e"), "an override is refused when the version is already approved (the audit trail stays truthful)", needless.status === 400 && needless.json.error === "override_not_needed", needless.json);
    product = appr.json.product;
  }

  // ------------------------------------------------------------------------------------------------ AT-26 superseded approval
  {
    const cur = (await A.writerA.get(`/products/${pid}`)).json;
    const after = await A.writerA.patch(`/products/${pid}`, { expected_row_version: product.row_version, content: { ...cur.content, summary: "Two-gang smart switch, now in matte finishes for Oyi homes." } });
    const pub = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: after.json.product.row_version });
    const stale = await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: product.row_version });
    check(id("AT26"), "an edit after approval supersedes it (workflow back to draft); publishing the superseded approval is refused, also with its old row_version", after.json.product.workflow_status === "draft" && after.json.product.approved_version === null && pub.status === 409 && stale.status === 409 && stale.json.error === "state_changed", { after: after.json.product, pub: pub.json, stale: stale.json });
    product = after.json.product;
  }

  // ------------------------------------------------------------------------------------------------ AT-10 duplicate / archive
  {
    const dupNoSku = await A.writerA.post(`/products/${pid}/duplicate`, { slug: `copy-${slugTag}` });
    const dup = await A.writerA.post(`/products/${pid}/duplicate`, { slug: `copy-${slugTag}`, sku_suffix: "-C" });
    check(id("AT10c"), "duplicate: new slug, own SKUs, draft, never published, v1 (no publication state copied); reusing the SKUs is refused", dupNoSku.status === 409 && dup.status === 201 && dup.json.product.publication_status === "never_published" && dup.json.product.current_version === 1 && dup.json.product.published_version === null && dup.json.variants.every((v) => v.sku.endsWith("-C")), { dupNoSku: dupNoSku.json, dup: dup.json && dup.json.product });
    const dupId = dup.json.product.id;
    const arch = await A.publisher.post(`/products/${pid}/archive`, { expected_row_version: product.row_version });
    const editArchived = await A.writerA.patch(`/products/${pid}`, { expected_row_version: arch.json.product.row_version, content: content({ name: "after archive" }) });
    const versions = await A.writerA.get(`/products/${pid}/versions`);
    check(id("AT10d"), "archive: archived (no longer published), keeps every version; further edits refused", arch.status === 200 && arch.json.product.publication_status === "archived" && editArchived.status === 409 && versions.json.versions.length === product.current_version, { arch: arch.json && arch.json.product, editArchived: editArchived.status, versions: versions.json.versions.length });
    const slugLocked = await A.writerA.patch(`/products/${dupId}`, { expected_row_version: dup.json.product.row_version, slug: `copy-renamed-${slugTag}`, content: dup.json.content });
    check(id("AT10e"), "a never-published product's slug can still change", slugLocked.status === 200 && slugLocked.json.product.slug === `copy-renamed-${slugTag}`, slugLocked.json);
  }

  // ------------------------------------------------------------------------------------------------ archived products receive no review decision (20261103)
  {
    const a = await A.writerA.post("/products", { slug: `archived-review-${slugTag}`, content: content({ name: "Archived review probe", variants: [{ sku: `ARV-${tag}`, name: "x" }] }) });
    const s1 = await A.writerA.post(`/products/${a.json.product.id}/submit`, { expected_row_version: a.json.product.row_version });
    const ar = await A.publisher.post(`/products/${a.json.product.id}/archive`, { expected_row_version: s1.json.product.row_version });
    const appr = await A.reviewer.post(`/products/${a.json.product.id}/approve`, { expected_row_version: ar.json.product.row_version });
    const chg = await A.reviewer.post(`/products/${a.json.product.id}/request-changes`, { expected_row_version: ar.json.product.row_version, note: "x" });
    const pub = await A.superAdmin.post(`/products/${a.json.product.id}/publish`, { expected_row_version: ar.json.product.row_version, override_reason: "Override attempt on an archived product" });
    check(id("ARC1"), "an archived product (left in review) cannot be approved, sent back for changes, or published (also not by override)", ar.json.product.publication_status === "archived" && ar.json.product.workflow_status === "in_review" && appr.status === 409 && chg.status === 409 && pub.status === 409, { appr: [appr.status, appr.json && appr.json.error], chg: chg.status, pub: [pub.status, pub.json && pub.json.error] });
  }

  // ------------------------------------------------------------------------------------------------ AT-30 / AT-31 prices
  const p2 = await A.writerA.post("/products", { slug: `gateway-${slugTag}`, content: content({ name: "Oyi Edge Gateway", model: `EG-${tag}`, category_id: cat2Id, variants: [{ sku: `EG-${tag}`, name: "Standard", options: {} }] }) });
  const variant = p2.json.variants[0];
  {
    const badFloat = await A.writerA.post(`/variants/${variant.id}/price-changes`, { price_ngn_kobo: 1999.5 });
    const badVat = await A.writerA.post(`/variants/${variant.id}/price-changes`, { price_ngn_kobo: 100, vat_treatment: "standard", vat_rate_bp: 0 });
    const badExempt = await A.writerA.post(`/variants/${variant.id}/price-changes`, { price_ngn_kobo: 100, vat_treatment: "exempt", vat_rate_bp: 750 });
    check(id("AT31a"), "prices are integer kobo; VAT treatment must match its rate (standard > 0, exempt/zero-rated = 0)", badFloat.status === 400 && badVat.status === 400 && badExempt.status === 400, [badFloat.status, badVat.status, badExempt.status]);
    const outsiderReq = await A.outsider.post(`/variants/${variant.id}/price-changes`, { price_ngn_kobo: 18500000, vat_treatment: "standard" });
    check(id("AT13e"), "requesting a price change needs catalogue access (a staff user without catalogue grants is refused)", outsiderReq.status === 403, outsiderReq.status);
    const r1 = await A.writerA.post(`/variants/${variant.id}/price-changes`, { price_ngn_kobo: 18500000, vat_treatment: "standard", note: "Launch price" });
    const changeId = r1.json.price_change.id;
    check(id("AT31b"), "request records old -> new price, VAT treatment and the default 7.5 % standard rate", r1.status === 201 && r1.json.price_change.state === "requested" && r1.json.price_change.old_price_ngn_kobo === null && r1.json.price_change.new_vat_rate_bp === 750, r1.json);
    const publishEarly = await A.publisher.post(`/price-changes/${changeId}/publish`);
    const publisherApprove = await A.publisher.post(`/price-changes/${changeId}/approve`);
    const v0 = (await A.writerA.get(`/products/${p2.json.product.id}`)).json.variants[0];
    check(id("AT30a"), "before approval and publication the price is unchanged; publishing an unapproved change is refused; a publisher cannot approve", publishEarly.status === 409 && publishEarly.json.error === "not_approved" && publisherApprove.status === 403 && v0.price_ngn_kobo === null, { publishEarly: publishEarly.json, publisherApprove: publisherApprove.status, price: v0.price_ngn_kobo });
    const r2 = await A.pricerA.get("/price-changes?state=requested");
    const approvals = await Promise.all([A.pricerA.post(`/price-changes/${changeId}/approve`), A.pricerB.post(`/price-changes/${changeId}/approve`), A.pricerB.post(`/price-changes/${changeId}/reject`)]);
    const okCount = approvals.filter((r) => r.status === 200).length;
    check(id("AT30b"), "decisions are exactly-once (two approvers + a reject in parallel: one wins, the rest 409)", r2.json.price_changes.some((c) => c.id === changeId) && okCount === 1 && approvals.filter((r) => r.status === 409 && r.json.error === "already_decided").length === 2, approvals.map((r) => [r.status, r.json && r.json.error]));
    const decided = await A.writerA.get("/price-changes");
    const state = decided.json.price_changes.find((c) => c.id === changeId).state;
    if (state === "rejected") {
      // the reject won the race: make an approved request to continue
      const again = await A.writerA.post(`/variants/${variant.id}/price-changes`, { price_ngn_kobo: 18500000, vat_treatment: "standard" });
      await A.pricerA.post(`/price-changes/${again.json.price_change.id}/approve`);
      await A.publisher.post(`/price-changes/${again.json.price_change.id}/publish`);
    } else {
      const publishes = await Promise.all([A.publisher.post(`/price-changes/${changeId}/publish`), A.publisher.post(`/price-changes/${changeId}/publish`)]);
      check(id("AT30c"), "publication is exactly-once", publishes.filter((r) => r.status === 200).length === 1 && publishes.some((r) => r.status === 409 && r.json.error === "already_published"), publishes.map((r) => [r.status, r.json && r.json.error]));
    }
    const v1 = (await A.writerA.get(`/products/${p2.json.product.id}`)).json.variants[0];
    check(id("AT30d"), "after approval by a different holder AND publication, the variant carries the new VAT-inclusive price and treatment", v1.price_ngn_kobo === 18500000 && v1.vat_treatment === "standard" && v1.vat_rate_bp === 750, v1);
    const own = await A.writerA.post(`/variants/${variant.id}/price-changes`, { price_ngn_kobo: 17500000, vat_treatment: "standard" });
    const ownApprove = await call("senior", "POST", `/price-changes/${own.json.price_change.id}/approve`);
    const selfReq = await A.senior.post(`/variants/${variant.id}/price-changes`, { price_ngn_kobo: 17000000, vat_treatment: "standard" });
    const selfApprove = await A.senior.post(`/price-changes/${selfReq.json.price_change.id}/approve`);
    check(id("AT30e"), "the requester can never approve their own price change (also someone who holds write + price.approve)", ownApprove.status === 200 && selfApprove.status === 403 && selfApprove.json.error === "own_request", { ownApprove: ownApprove.status, selfApprove: selfApprove.json });
    // two approved changes made against the same old price: the first published makes the second stale
    const pubOwn = await A.publisher.post(`/price-changes/${own.json.price_change.id}/publish`);
    await A.pricerB.post(`/price-changes/${selfReq.json.price_change.id}/approve`);
    const stalePub = await A.publisher.post(`/price-changes/${selfReq.json.price_change.id}/publish`);
    const v2 = (await A.writerA.get(`/products/${p2.json.product.id}`)).json.variants[0];
    check(id("AT30f"), "a price change requested against a price that was replaced meanwhile cannot be published (stale)", pubOwn.status === 200 && stalePub.status === 409 && stalePub.json.error === "price_changed_since_request" && v2.price_ngn_kobo === 17500000, { pubOwn: pubOwn.status, stalePub: stalePub.json, price: v2.price_ngn_kobo });
  }

  // ------------------------------------------------------------------------------------------------ AT-32 inventory, suppliers, costs
  {
    const prodBefore = (await A.writerA.get(`/products/${p2.json.product.id}`)).json.product;
    const v = (await A.writerA.get(`/products/${p2.json.product.id}`)).json.variants[0];
    const writerInv = await A.writerA.patch(`/variants/${v.id}/inventory`, { expected_row_version: v.row_version, stock_on_hand: 12 });
    const inv = await A.ops.patch(`/variants/${v.id}/inventory`, { expected_row_version: v.row_version, stock_on_hand: 12, stock_reserved: 2, sourcing: "in_stock", lead_time_days_min: 2, lead_time_days_max: 5, reason: "Goods received" });
    const staleInv = await A.ops.patch(`/variants/${v.id}/inventory`, { expected_row_version: v.row_version, stock_on_hand: 20 });
    const overReserve = await A.ops.patch(`/variants/${v.id}/inventory`, { expected_row_version: inv.json.variant.row_version, stock_reserved: 50 });
    const history = await A.ops.get(`/variants/${v.id}/inventory`);
    const prodAfter = (await A.writerA.get(`/products/${p2.json.product.id}`)).json.product;
    check(id("AT32a"), "inventory.manage edits stock/reservation/sourcing/lead time (writer refused); stale edit 409; reserved > on hand refused", writerInv.status === 403 && inv.status === 200 && inv.json.variant.stock_on_hand === 12 && staleInv.status === 409 && overReserve.status === 400, { writerInv: writerInv.status, inv: inv.status, staleInv: staleInv.status, overReserve: overReserve.status });
    check(id("AT32b"), "every inventory change is logged per field with actor and reason; no re-publication (product row unchanged)", history.json.changes.length === 5 && history.json.changes.every((c) => c.actor === users.ops.email && c.reason === "Goods received") && prodAfter.row_version === prodBefore.row_version && prodAfter.current_version === prodBefore.current_version, { changes: history.json.changes.length, before: prodBefore.row_version, after: prodAfter.row_version });

    const writerSuppliers = await A.writerA.get("/suppliers");
    const readerCreate = await call("finance", "POST", "/suppliers", { name: "Lagos Electrical Imports", country: "NG", email: "sales@lei.example" });
    const supplierId = readerCreate.json && readerCreate.json.supplier.id;
    const writerCosts = await A.writerA.get(`/variants/${v.id}/costs`);
    const cost = await A.finance.post(`/variants/${v.id}/costs`, { supplier_id: supplierId, supplier_cost_kobo: 9000000, landed_cost_kobo: 11000000, note: "Q4 shipment" });
    const badCost = await A.finance.post(`/variants/${v.id}/costs`, { supplier_cost_kobo: 9000000, landed_cost_kobo: 100 });
    const costs = await A.finance.get(`/variants/${v.id}/costs`);
    check(id("AT32c"), "suppliers and costs need catalogue.cost.read / cost.manage (writer refused); costs are append-only records with derived margin", writerSuppliers.status === 403 && readerCreate.status === 201 && writerCosts.status === 403 && cost.status === 201 && badCost.status === 400 && costs.json.costs.length === 1 && costs.json.costs[0].margin_kobo === Math.round(17500000 * 10000 / 10750) - 11000000, { writerSuppliers: writerSuppliers.status, readerCreate: readerCreate.status, writerCosts: writerCosts.status, cost: cost.status, badCost: badCost.status, costs: costs.json });
    const linkByOps = await A.ops.patch(`/variants/${v.id}/inventory`, { expected_row_version: inv.json.variant.row_version, supplier_id: supplierId });
    const writerView = (await A.writerA.get(`/products/${p2.json.product.id}`)).json.variants[0];
    check(id("AT32d"), "linking a supplier needs cost visibility too; the supplier link is hidden from staff without catalogue.cost.read; costs never appear in product reads", linkByOps.status === 403 && !("supplier_id" in writerView) && !JSON.stringify(writerView).includes("landed") && !JSON.stringify((await A.writerA.get(`/products/${p2.json.product.id}`)).json).includes("11000000"), { linkByOps: linkByOps.status, writerView });
  }

  // ------------------------------------------------------------------------------------------------ Phase 2: browse API (cards view)
  {
    const all = await A.staff.get("/products?view=cards&page_size=100");
    const lock = all.json.products.find((c) => c.id === pid);
    const gateway = all.json.products.find((c) => c.slug === `gateway-${slugTag}`);
    check(id("BR1"), "cards view (read-only staff): statistics + rows; archived product shows 'archived'; price and stock come from real variant records", all.status === 200 && all.json.stats && typeof all.json.stats.total === "number" && lock && lock.status === "archived" && gateway && gateway.price_min_kobo === 17500000 && gateway.stock_available === 10 && gateway.availability === "in_stock", { stats: all.json.stats, lock: lock && lock.status, gateway });
    const search = await A.staff.get(`/products?view=cards&q=${encodeURIComponent(`EG-${tag}`)}`);
    const filtered = await A.staff.get("/products?view=cards&status=archived&page_size=100");
    const paged = await A.staff.get("/products?view=cards&page_size=2&page=2&sort=name&dir=asc");
    check(id("BR2"), "server-side search by SKU, status filter, sorting and pagination", search.json.total === 1 && search.json.products[0].slug === `gateway-${slugTag}` && filtered.json.products.every((c) => c.status === "archived") && paged.json.page === 2 && paged.json.products.length <= 2 && paged.json.page_size === 2, { search: search.json.total, filtered: filtered.json.total, paged: [paged.json.page, paged.json.products.length] });
    const anon = await call(null, "GET", "/products?view=cards");
    check(id("BR3"), "cards view keeps the catalogue boundary (no session -> 401) and never includes supplier links or costs", anon.status === 401 && !JSON.stringify(all.json).includes("supplier_id") && !JSON.stringify(all.json).includes("landed"), anon.status);
  }

  // ------------------------------------------------------------------------------------------------ Phase 2 stage 3: gallery media
  {
    const fs = require("fs");
    const path = require("path");
    const sharp = require("sharp");
    const img = (bg, w = 1200, h = 900) => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).withExif({ IFD0: { Copyright: "fixture-owner-exif" } }).jpeg({ quality: 85 }).toBuffer();
    const upload = async (who, productId, buf, name = "photo.jpg", type = "image/jpeg") => {
      const headers = { "content-type": type, origin: base };
      if (who && cookies[who]) headers.cookie = cookies[who];
      if (who && who.startsWith("key:")) headers["x-api-key"] = who.slice(4);
      const r = await fetch(`${base}/api/lead-agents/admin/catalogue/products/${productId}/media?name=${encodeURIComponent(name)}`, { method: "POST", headers, body: buf });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json };
    };
    const fetchImage = async (who, url) => {
      const headers = {};
      if (who && cookies[who]) headers.cookie = cookies[who];
      const r = await fetch(`${base}${url}`, { headers });
      return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
    };
    const storedFiles = () => (storageDir && fs.existsSync(storageDir) ? fs.readdirSync(storageDir).filter((f) => f.startsWith("product_image_")) : []);
    const variants = [{ sku: `GAL-${tag}-WHT`, name: "White", options: { colour: "white" } }, { sku: `GAL-${tag}-BLK`, name: "Black", options: { colour: "black" } }];
    const gal = await A.writerA.post("/products", { slug: `gallery-hub-${slugTag}`, content: content({ name: "Gallery Hub", model: `GH-${tag}`, variants }) });
    const gid = gal.json.product.id;
    const other = await A.writerA.post("/products", { slug: `gallery-other-${slugTag}`, content: content({ name: "Other", model: `GO-${tag}`, variants: [{ sku: `GO-${tag}-1`, name: "One" }] }) });
    const oid = other.json.product.id;

    // G1 permissions
    const jpg = await img("#c8102e");
    const asStaff = await upload("staff", gid, jpg);
    const asOutsider = await upload("outsider", gid, jpg);
    const asNobody = await upload(null, gid, jpg);
    const asFullKey = await upload(`key:${fullKey}`, gid, jpg);
    const asReviewer = await upload("reviewer", gid, jpg);
    const first = await upload("writerA", gid, jpg, "front.jpg");
    check(id("G1"), "upload needs a staff session with catalogue.write: read-only staff / reviewer / estate admin 403, no credential 401, FULL API key 403; writer 201",
      asStaff.status === 403 && asReviewer.status === 403 && asOutsider.status === 403 && asNobody.status === 401 && asFullKey.status === 403 && first.status === 201 && first.json.media && first.json.media.urls.thumb && first.json.media.format === "jpeg",
      { asStaff: asStaff.status, asReviewer: asReviewer.status, asOutsider: asOutsider.status, asNobody: asNobody.status, asFullKey: asFullKey.status, first });
    const m1 = first.json.media;

    // G2 content validation over HTTP (declared type ignored)
    const svg = await upload("writerA", gid, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="900" height="900"/></svg>'), "x.jpg", "image/jpeg");
    const poly = await upload("writerA", gid, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("<script>alert(1)</script>".padEnd(500, " "))]), "x.jpg");
    const empty = await upload("writerA", gid, Buffer.alloc(0));
    const big = await upload("writerA", gid, Buffer.concat([jpg, Buffer.alloc(16 * 1024 * 1024)]));
    const pngAsJpeg = await upload("writerA", gid, await sharp({ create: { width: 800, height: 800, channels: 3, background: "#123456" } }).png().toBuffer(), "really-a-png.jpg", "image/jpeg");
    check(id("G2"), "content is validated, not the declared type: SVG 415, JPEG-signature polyglot 422, empty 400, > 15 MB 413; a PNG declared as image/jpeg is stored as PNG",
      svg.status === 415 && poly.status === 422 && empty.status === 400 && big.status === 413 && pngAsJpeg.status === 201 && pngAsJpeg.json.media.format === "png",
      { svg: svg.status, poly: poly.status, empty: empty.status, big: big.status, pngAsJpeg: pngAsJpeg.status });

    // G3 retry / de-duplication
    const before = storedFiles().length;
    const again = await upload("writerA", gid, jpg, "front-retry.jpg");
    check(id("G3"), "retrying the same bytes returns the existing image (200 deduplicated, same id) and leaves no extra stored object",
      again.status === 200 && again.json.deduplicated === true && again.json.media.id === m1.id && (!storageDir || storedFiles().length === before), { again: again.status, before, after: storedFiles().length });

    // G4 concurrency
    const colours = ["#0f766e", "#7c3aed", "#ea580c", "#0369a1"];
    const parallel = await Promise.all(colours.map(async (c) => upload("writerA", gid, await img(c), `${c}.jpg`)));
    const twin = await img("#be185d");
    const twins = await Promise.all([upload("writerA", gid, twin), upload("writerB", gid, twin)]);
    check(id("G4"), "concurrent uploads: four different images all stored; the same new image uploaded twice at once yields ONE image (one 201, one 200 deduplicated)",
      parallel.every((r) => r.status === 201) && new Set(parallel.map((r) => r.json.media.id)).size === 4
        && twins.map((r) => r.status).sort().join() === "200,201" && twins[0].json.media.id === twins[1].json.media.id,
      { parallel: parallel.map((r) => r.status), twins: twins.map((r) => r.status) });
    const ids = [m1.id, pngAsJpeg.json.media.id, ...parallel.map((r) => r.json.media.id), twins[0].json.media.id];

    // G5 serving
    const thumb = await fetchImage("staff", m1.urls.thumb);
    const anonThumb = await fetchImage(null, m1.urls.thumb);
    const outsiderThumb = await fetchImage("outsider", m1.urls.thumb);
    const original = await fetchImage("writerA", m1.urls.thumb.replace(/\/thumb$/, "/original"));
    const unknown = await fetchImage("writerA", `/api/lead-agents/admin/catalogue/media/${crypto.randomUUID()}/thumb`);
    const meta = thumb.status === 200 ? await sharp(thumb.body).metadata() : {};
    check(id("G5"), "renditions are served to catalogue readers only (no credential 401, estate admin 403) as image/webp with nosniff, private cache and a sandbox CSP; there is no route to the original",
      thumb.status === 200 && thumb.headers.get("content-type") === "image/webp" && thumb.headers.get("x-content-type-options") === "nosniff" && /^private/.test(thumb.headers.get("cache-control") || "")
        && /sandbox/.test(thumb.headers.get("content-security-policy") || "") && anonThumb.status === 401 && outsiderThumb.status === 403 && original.status === 404 && unknown.status === 404,
      { thumb: thumb.status, type: thumb.headers.get("content-type"), anon: anonThumb.status, outsider: outsiderThumb.status, original: original.status, unknown: unknown.status });
    check(id("G5b"), "the served rendition is a re-encoded WebP with no EXIF (the upload's EXIF text is absent)", meta.format === "webp" && !meta.exif && !thumb.body.includes(Buffer.from("fixture-owner-exif")), { format: meta.format, exif: Boolean(meta.exif) });

    // G6 originals private: generic storage routes refuse product images even with a key that passes view/manage_storage
    const files = storedFiles();
    const generic = await Promise.all(files.slice(0, 6).map((f) => fetch(`${base}/api/lead-agents/admin/storage/${f}`, { headers: { "x-api-key": fullKey } }).then((r) => r.status)));
    const genericUpload = await fetch(`${base}/api/lead-agents/admin/storage`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": fullKey }, body: JSON.stringify({ purpose: "product_image", data_url: `data:image/jpeg;base64,${jpg.toString("base64")}` }) }).then((r) => r.status);
    check(id("G6"), "originals stay private: the generic storage route returns 404 for product image objects and refuses product_image uploads (403)",
      (!storageDir || (files.length >= 6 && generic.every((st) => st === 404))) && genericUpload === 403, { files: files.length, generic, genericUpload });

    // G7 gallery save + validation
    const detail0 = (await A.writerA.get(`/products/${gid}`)).json;
    const gallery = ids.slice(0, 5).map((mid, i) => ({ media_id: mid, cover: i === 1, alt: i === 4 ? "" : `View ${i + 1}`, caption: i === 0 ? "Front" : "", variant_skus: i === 2 ? [variants[0].sku] : [] }));
    const saved = await A.writerA.patch(`/products/${gid}`, { expected_row_version: detail0.product.row_version, content: { ...detail0.content, media: gallery } });
    const rv = saved.json && saved.json.product.row_version;
    const badVariant = await A.writerA.patch(`/products/${gid}`, { expected_row_version: rv, content: { ...detail0.content, media: [{ media_id: ids[0], cover: true, variant_skus: [`GO-${tag}-1`] }] } });
    const twoCovers = await A.writerA.patch(`/products/${gid}`, { expected_row_version: rv, content: { ...detail0.content, media: [{ media_id: ids[0], cover: true }, { media_id: ids[1], cover: true }] } });
    const foreignUp = await upload("writerA", oid, await img("#365314"));
    const foreign = await A.writerA.patch(`/products/${gid}`, { expected_row_version: rv, content: { ...detail0.content, media: [{ media_id: foreignUp.json.media.id, cover: true }] } });
    const made = await A.writerA.post("/products", { slug: `gallery-new-${slugTag}`, content: content({ name: "New", model: `GN-${tag}`, variants: [{ sku: `GN-${tag}-1`, name: "One" }], media: [{ media_id: ids[0], cover: true }] }) });
    check(id("G7"), "a 5-image gallery (cover, alt, caption, variant link) saves as a new version; unknown variant / two covers 400; another product's image 409 media_not_available; no images on create",
      saved.status === 200 && saved.json.product.current_version === 2 && saved.json.content.media.length === 5 && saved.json.content.media[1].cover === true && saved.json.gallery_readiness.missing_alt === 1 && !saved.json.gallery_readiness.ready_for_public
        && badVariant.status === 400 && twoCovers.status === 400 && foreign.status === 409 && foreign.json.error === "media_not_available" && made.status === 400,
      { saved: saved.status, badVariant: badVariant.status, twoCovers: twoCovers.status, foreign: foreign.json, made: made.status });
    const card = (await A.staff.get(`/products?view=cards&q=${encodeURIComponent(`GH-${tag}`)}`)).json.products[0];
    check(id("G7b"), "the catalogue table card shows the cover image and the image count", card && card.cover_media_id === ids[1] && card.image_count === 5, card);

    // G8 deletion protection
    const lib = (await A.writerA.get(`/products/${gid}/media`)).json.media_library;
    const refRemove = await A.writerA.post(`/media/${ids[0]}/remove`);
    const staffRemove = await A.staff.post(`/media/${ids[6]}/remove`);
    const filesBefore = storedFiles().length;
    const freeRemove = await A.writerA.post(`/media/${ids[6]}/remove`);
    const twiceRemove = await A.writerA.post(`/media/${ids[6]}/remove`);
    const goneThumb = await fetchImage("writerA", `/api/lead-agents/admin/catalogue/media/${ids[6]}/thumb`);
    check(id("G8"), "an image referenced by a version cannot be removed (409 media_referenced); an unreferenced one can (writer only), its renditions stop serving and its stored objects are deleted",
      lib.available && lib.items.find((x) => x.id === ids[0]).referenced_by_versions.includes(2) && refRemove.status === 409 && refRemove.json.error === "media_referenced"
        && staffRemove.status === 403 && freeRemove.status === 200 && twiceRemove.status === 409 && twiceRemove.json.error === "media_already_removed" && goneThumb.status === 404 && (!storageDir || storedFiles().length === filesBefore - 5),
      { refRemove: refRemove.json, staffRemove: staffRemove.status, freeRemove: freeRemove.status, twice: twiceRemove.json, goneThumb: goneThumb.status, filesBefore, after: storedFiles().length });
    const removedRef = await A.writerA.patch(`/products/${gid}`, { expected_row_version: rv, content: { ...saved.json.content, media: [...saved.json.content.media, { media_id: ids[6], cover: false }] } });
    check(id("G8b"), "a removed image cannot be put back into a gallery (409 media_not_available)", removedRef.status === 409 && removedRef.json.error === "media_not_available", removedRef.json);

    // G9 replacement keeps history
    const replacement = await upload("writerA", gid, await img("#facc15"), "front-v2.jpg");
    const replaced = saved.json.content.media.map((item, i) => (i === 0 ? { ...item, media_id: replacement.json.media.id } : item));
    const v3 = await A.writerA.patch(`/products/${gid}`, { expected_row_version: rv, content: { ...saved.json.content, media: replaced } });
    const v2 = await A.writerA.get(`/products/${gid}/versions/2`);
    const d23 = await A.writerA.get(`/products/${gid}/versions/3?diff_to=2`);
    const oldThumb = await fetchImage("staff", m1.urls.thumb);
    const oldRemove = await A.writerA.post(`/media/${ids[0]}/remove`);
    check(id("G9"), "replacing an image creates a new version; the previous version still references the old image, which keeps serving and stays undeletable",
      replacement.status === 201 && v3.status === 200 && v3.json.product.current_version === 3 && v2.json.version.content.media[0].media_id === ids[0] && oldThumb.status === 200 && oldRemove.status === 409
        && d23.json.diff.some((d) => d.field === `media[${ids[0]}]` && d.after === null) && d23.json.diff.some((d) => d.field === `media[${replacement.json.media.id}]` && d.before === null),
      { replacement: replacement.status, v3: v3.status, old: oldThumb.status, oldRemove: oldRemove.status, diff: d23.json && d23.json.diff.map((d) => d.field) });

    // G10 concurrent gallery edits: one wins, the other gets 409 state_changed
    const rv3 = v3.json.product.row_version;
    const reorder = (list) => [...list].reverse();
    const race = await Promise.all([
      A.writerA.patch(`/products/${gid}`, { expected_row_version: rv3, content: { ...v3.json.content, media: reorder(v3.json.content.media) } }),
      A.writerB.patch(`/products/${gid}`, { expected_row_version: rv3, content: { ...v3.json.content, media: v3.json.content.media.slice(0, 3).map((x, i) => ({ ...x, cover: i === 0 })) } }),
    ]);
    check(id("G10"), "two concurrent gallery saves on the same row_version: exactly one succeeds, the other is 409 state_changed", race.map((r) => r.status).sort().join() === "200,409", race.map((r) => r.status));

    // G11 workflow: after publication a gallery change is material and needs review again
    let cur = (await A.writerA.get(`/products/${gid}`)).json;
    const submit = await A.writerB.post(`/products/${gid}/submit`, { expected_row_version: cur.product.row_version });
    const approve = await A.reviewer.post(`/products/${gid}/approve`, { expected_row_version: submit.json.product.row_version });
    const publish = await A.publisher.post(`/products/${gid}/publish`, { expected_row_version: approve.json.product.row_version });
    cur = publish.json;
    const altEdit = await A.writerA.patch(`/products/${gid}`, { expected_row_version: cur.product.row_version, content: { ...cur.content, media: cur.content.media.map((x) => ({ ...x, alt: x.alt || "Rear view" })) } });
    check(id("G11"), "after publication, editing alt text is a MATERIAL version back in draft; the published version and its gallery are unchanged",
      publish.status === 200 && altEdit.status === 200 && altEdit.json.current_materiality === "material" && altEdit.json.product.workflow_status === "draft" && altEdit.json.product.published_version === publish.json.product.published_version && altEdit.json.gallery_readiness.missing_alt === 0,
      { submit: submit.status, approve: approve.status, publish: publish.status, altEdit: altEdit.status, mat: altEdit.json && altEdit.json.current_materiality });

    // G12 archived product + duplicate
    const archivedUp = await upload("writerA", pid, await img("#64748b"));
    const dup = await A.writerA.post(`/products/${gid}/duplicate`, { slug: `gallery-copy-${slugTag}`, sku_suffix: "-C" });
    check(id("G12"), "an archived product accepts no uploads (409 product_archived); a duplicated product starts with an empty gallery",
      archivedUp.status === 409 && archivedUp.json.error === "product_archived" && dup.status === 201 && dup.json.content.media.length === 0, { archivedUp: archivedUp.json, dup: dup.status });

    // G13 media library visibility for read-only staff, no cost leakage
    const staffLib = await A.staff.get(`/products/${gid}/media`);
    check(id("G13"), "read-only staff see the image library (urls only, no storage keys or file names of stored objects)",
      staffLib.status === 200 && staffLib.json.media_library.items.length >= 8 && !JSON.stringify(staffLib.json).includes("product_image_") && !JSON.stringify(staffLib.json).includes("storage_key"), { status: staffLib.status });
  }

  // ------------------------------------------------------------------------------------------------ Phase 2 stage 4: public release to GetOyi
  if (catalogueKey) {
    const sharp = require("sharp");
    const img = (bg) => sharp({ create: { width: 1000, height: 800, channels: 3, background: bg } }).jpeg({ quality: 85 }).toBuffer();
    const upload = async (productId, buf) => {
      const r = await fetch(`${base}/api/lead-agents/admin/catalogue/products/${productId}/media?name=p.jpg`, { method: "POST", headers: { "content-type": "image/jpeg", origin: base, cookie: cookies.writerA }, body: buf });
      return (await r.json()).media;
    };
    const pub = async (p, key = catalogueKey, init = {}) => {
      const headers = { ...(key ? { "x-api-key": key } : {}), ...(init.headers || {}) };
      const r = await fetch(`${base}/api/public/catalogue${p}`, { ...init, headers });
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch { /* binary */ }
      return { status: r.status, json, buf, headers: r.headers };
    };
    const detailOf = async (productId, who = "writerA") => (await A[who].get(`/products/${productId}`)).json;
    const reviewAndPublish = async (productId) => {
      let d = await detailOf(productId);
      const sub = await A.writerB.post(`/products/${productId}/submit`, { expected_row_version: d.product.row_version });
      const ap = await A.reviewer2.post(`/products/${productId}/approve`, { expected_row_version: sub.json.product.row_version });
      const pb = await A.publisher.post(`/products/${productId}/publish`, { expected_row_version: ap.json.product.row_version });
      return pb;
    };
    const lastReval = () => (revalidator ? revalidator.requests[revalidator.requests.length - 1] : null);
    const pvariants = [{ sku: `PUB-${tag}-1`, name: "White", options: { colour: "white" } }, { sku: `PUB-${tag}-2`, name: "Black", options: { colour: "black" } }];
    const made = await A.writerA.post("/products", { slug: `public-hub-${slugTag}`, content: content({ name: "Public Hub", model: `PH-${tag}`, summary: "Hub for the public catalogue", variants: pvariants }) });
    const ppid = made.json.product.id;
    const m1 = await upload(ppid, await img("#1d4ed8"));
    const m2 = await upload(ppid, await img("#15803d"));
    let d = await detailOf(ppid);
    await A.writerA.patch(`/products/${ppid}`, { expected_row_version: d.product.row_version, content: { ...d.content, media: [{ media_id: m1.id, cover: true, alt: "Public Hub, front", caption: "Front" }, { media_id: m2.id, cover: false, alt: "", caption: "" }] } });
    await reviewAndPublish(ppid);
    // a price for variant 1 only (request -> approval by a different approver -> publication)
    d = await detailOf(ppid);
    const v1 = d.variants.find((v) => v.sku === pvariants[0].sku), v2 = d.variants.find((v) => v.sku === pvariants[1].sku);
    const pr = await A.writerA.post(`/variants/${v1.id}/price-changes`, { price_ngn_kobo: 4500000, vat_treatment: "standard" });
    await A.pricerA.post(`/price-changes/${pr.json.price_change.id}/approve`);
    await A.publisher.post(`/price-changes/${pr.json.price_change.id}/publish`);
    d = await detailOf(ppid);
    const codes = (x) => x.public.requirements.map((r) => r.code).sort().join(",");
    check(id("PB1"), "public requirements are computed for the internally published version: missing alt text on an image and an unpriced active variant are reported", d.public.available && d.public.effective === "not_public" && codes(d) === "alt_text_missing,price_not_approved" && !d.public.releasable, d.public);
    const blocked = await A.releaser.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: 0 });
    check(id("PB1b"), "release is refused while requirements are unmet (409 public_requirements_not_met with the issues)", blocked.status === 409 && blocked.json.error === "public_requirements_not_met" && blocked.json.current.issues.includes("alt_text_missing"), blocked.json);
    // fix: alt text (new version, reviewed and published) and deactivate the unpriced variant
    d = await detailOf(ppid);
    await A.writerA.patch(`/products/${ppid}`, { expected_row_version: d.product.row_version, content: { ...d.content, media: d.content.media.map((x) => ({ ...x, alt: x.alt || "Public Hub, side" })) } });
    await reviewAndPublish(ppid);
    const v2now = (await detailOf(ppid)).variants.find((v) => v.sku === pvariants[1].sku);
    await A.ops.patch(`/variants/${v2.id}/inventory`, { expected_row_version: v2now.row_version, status: "inactive", reason: "Not for sale yet" });
    const v1now = (await detailOf(ppid)).variants.find((v) => v.sku === pvariants[0].sku);
    await A.ops.patch(`/variants/${v1.id}/inventory`, { expected_row_version: v1now.row_version, stock_on_hand: 7, stock_reserved: 1, sourcing: "in_stock" });
    d = await detailOf(ppid);
    check(id("PB2"), "after fixing alt text and deactivating the unpriced variant the published version is releasable", d.public.requirements.length === 0 && d.public.releasable, d.public.requirements);

    // permissions + stale protection
    const asPublisher = await A.publisher.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: 0 });
    const asStaff = await A.staff.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: 0 });
    const asAdmin = await A.admin.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: 0 });
    const stale = await A.releaser.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version - 1, expected_listing_row_version: 0 });
    const before = revalidator ? revalidator.requests.length : 0;
    const released = await A.releaser.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: 0 });
    check(id("PB3"), "public release needs catalogue.public.publish (publisher, general staff and ochiga_admin 403); a stale product row_version is 409; the releaser releases the published version",
      asPublisher.status === 403 && asStaff.status === 403 && asAdmin.status === 403 && stale.status === 409 && stale.json.error === "state_changed" && released.status === 200
        && released.json.public.effective === "public" && released.json.public.listing.public_version === released.json.product.published_version && /\/hardware\/public-hub-/.test(released.json.public.public_url || ""),
      { asPublisher: asPublisher.status, asStaff: asStaff.status, asAdmin: asAdmin.status, stale: stale.status, released: released.status, pub: released.json && released.json.public });
    if (revalidator) {
      const r = lastReval();
      check(id("PB3b"), "GetOyi is told to revalidate (signed request, event released, slug); refresh status recorded as succeeded",
        revalidator.requests.length === before + 1 && r.valid && r.payload.event === "released" && r.payload.slug === `public-hub-${slugTag}` && released.json.public.listing.refresh_status === "succeeded", { r, refresh: released.json.public.listing });
    }

    // public API boundary and exposure
    const list = await pub("/products");
    const card = list.json && list.json.products.find((c) => c.slug === `public-hub-${slugTag}`);
    const one = await pub(`/products/public-hub-${slugTag}`);
    const cats = await pub("/categories");
    const text = JSON.stringify([list.json, one.json, cats.json]);
    const forbidden = [ppid, m1.id, m2.id, "supplier", "cost", "row_version", "stock_on_hand", "product_image_", "office_file", users.writerA.email, users.reviewer2.email, "review", "draft", "internal"];
    check(id("PB4"), "public API (catalogue key): list, detail and categories show the released product with its VAT-inclusive price, availability label, cover and alt text",
      list.status === 200 && card && card.price_from_kobo === 4500000 && card.availability === "in_stock" && /^media\/[0-9a-f]{64}\.webp$/.test(card.cover.src) && one.status === 200
        && one.json.product.variants.length === 1 && one.json.product.variants[0].price.vat_inclusive === true && one.json.product.images.length === 2 && one.json.product.images[0].alt === "Public Hub, front" && one.json.product.images[0].cover
        && cats.json.categories.some((c) => c.product_count >= 1), { list: list.status, card, one: one.json });
    check(id("PB4b"), "nothing internal leaves Office: no product or media ids, costs, suppliers, stock counts, storage names, staff e-mails, review or draft data; the inactive variant is absent",
      forbidden.every((f) => !text.includes(f)) && !text.includes(pvariants[1].sku), forbidden.filter((f) => text.includes(f)));
    const noKey = await pub("/products", null);
    const intake = await pub("/products", scopedKey);
    const full = await pub("/products", fullKey);
    const staffCookie = await fetch(`${base}/api/public/catalogue/products`, { headers: { cookie: cookies.superAdmin } });
    const post = await pub("/products", catalogueKey, { method: "POST" });
    const keyOnStaff = await fetch(`${base}/api/lead-agents/admin/catalogue/products`, { headers: { "x-api-key": catalogueKey } });
    check(id("PB4c"), "public API boundary: no key 401; the website's intake key, a FULL key and a staff session 403; POST 403; the catalogue key cannot reach staff catalogue routes (403)",
      noKey.status === 401 && intake.status === 403 && full.status === 403 && staffCookie.status === 403 && post.status === 403 && keyOnStaff.status === 403,
      { noKey: noKey.status, intake: intake.status, full: full.status, staff: staffCookie.status, post: post.status, keyOnStaff: keyOnStaff.status });

    // images
    const coverSha = one.json.product.images[0].src.match(/[0-9a-f]{64}/)[0];
    const image = await pub(`/media/${coverSha}.webp`);
    const draftImage = await upload(ppid, await img("#7c2d12"));
    const draftSha = (await detailOf(ppid)).media_library.items.find((x) => x.id === draftImage.id);
    const draftThumb = await fetch(`${base}${draftSha.urls.w960}`, { headers: { cookie: cookies.writerA } });
    const draftBytes = Buffer.from(await draftThumb.arrayBuffer());
    const crypto2 = require("crypto");
    const draftHash = crypto2.createHash("sha256").update(draftBytes).digest("hex");
    const draftPublic = await pub(`/media/${draftHash}.webp`);
    const randomSha = await pub(`/media/${"a".repeat(64)}.webp`);
    const sneaky = await pub(`/media/..%2F..%2Fproducts`);
    check(id("PB5"), "published images are served by content hash as WebP with public 5-minute caching and nosniff; a draft-only image of the same product, an unknown hash and path tricks are 404",
      image.status === 200 && image.headers.get("content-type") === "image/webp" && /public, max-age=300/.test(image.headers.get("cache-control") || "") && image.headers.get("x-content-type-options") === "nosniff"
        && crypto2.createHash("sha256").update(image.buf).digest("hex") === coverSha.replace(/[^0-9a-f]/g, "") || false,
      { image: image.status, type: image.headers.get("content-type"), cache: image.headers.get("cache-control") });
    // the original upload of a PUBLISHED cover, addressed by its own sha256 (the only identifier an outsider could compute), never resolves
    // the stored original's real sha256, from Office's own upload audit record
    const uploadEvent = (await audit()).find((e) => e.action === "catalogue_media_uploaded" && e.metadata && e.metadata.media_id === m1.id);
    const originalBytesSha = uploadEvent ? uploadEvent.metadata.sha256 : "";
    const origPublic = await pub(`/media/${originalBytesSha}.webp`);
    const origNoExt = await pub(`/media/${originalBytesSha}`);
    check(id("PB5c"), "the private original of a published cover is not reachable through the public API by its content hash (with or without extension)", originalBytesSha && origPublic.status === 404 && origNoExt.status === 404, { origPublic: origPublic.status, origNoExt: origNoExt.status });
    check(id("PB5b"), "…draft-only image 404, unknown hash 404, traversal refused", draftPublic.status === 404 && randomSha.status === 404 && sneaky.status >= 400, { draftPublic: draftPublic.status, randomSha: randomSha.status, sneaky: sneaky.status });

    // pinned public version
    d = await detailOf(ppid);
    await A.writerA.patch(`/products/${ppid}`, { expected_row_version: d.product.row_version, content: { ...d.content, description: "Updated description for v-next." } });
    const whileDraft = await pub(`/products/public-hub-${slugTag}`);
    await reviewAndPublish(ppid);
    const afterInternal = await pub(`/products/public-hub-${slugTag}`);
    d = await detailOf(ppid);
    check(id("PB6"), "GetOyi shows the released version: a newer draft AND a newer internal publication do not change the public product; the editor offers an update",
      !/Updated description/.test(JSON.stringify(whileDraft.json)) && !/Updated description/.test(JSON.stringify(afterInternal.json)) && d.public.update_available && d.public.releasable, { update: d.public.update_available });
    const upd = await A.releaser.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: d.public.listing.row_version });
    const afterUpdate = await pub(`/products/public-hub-${slugTag}`);
    const again = await A.releaser.post(`/products/${ppid}/public/release`, { expected_row_version: upd.json.product.row_version, expected_listing_row_version: upd.json.public.listing.row_version });
    check(id("PB6b"), "releasing again updates GetOyi to the new version (event 'updated'); releasing an unchanged version is 409 already_public",
      upd.status === 200 && /Updated description/.test(JSON.stringify(afterUpdate.json)) && upd.json.public.events.some((e) => e.action === "updated") && again.status === 409 && again.json.error === "already_public", { upd: upd.status, again: again.json });

    // concurrent withdrawals: one wins
    const lrv = upd.json.public.listing.row_version;
    const race = await Promise.all([A.releaser.post(`/products/${ppid}/public/withdraw`, { expected_listing_row_version: lrv, reason: "race A" }), A.publisher.post(`/products/${ppid}/public/withdraw`, { expected_listing_row_version: lrv, reason: "race B" })]);
    const afterWithdraw = await pub(`/products/public-hub-${slugTag}`);
    const listAfter = await pub("/products");
    const imageAfter = await pub(`/media/${coverSha}.webp`);
    check(id("PB7"), "two concurrent withdrawals: exactly one succeeds (a publisher may withdraw), the other is 409; the product, its listing entry and its images disappear from the public API at once",
      race.map((r) => r.status).sort().join() === "200,409" && afterWithdraw.status === 404 && !listAfter.json.products.some((c) => c.slug === `public-hub-${slugTag}`) && imageAfter.status === 404,
      { race: race.map((r) => [r.status, r.json && r.json.error]), afterWithdraw: afterWithdraw.status, imageAfter: imageAfter.status });
    if (revalidator) check(id("PB7b"), "withdrawal notifies GetOyi (event withdrawn)", lastReval().payload.event === "withdrawn" && lastReval().payload.status === "withdrawn", lastReval());
    d = await detailOf(ppid);
    const rerelease = await A.releaser.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: d.public.listing.row_version });
    check(id("PB7c"), "a withdrawn product can be released again", rerelease.status === 200 && (await pub(`/products/public-hub-${slugTag}`)).status === 200, rerelease.json && rerelease.json.public);

    // internal unpublish hides it immediately; internal re-publication of the same approved version restores it
    d = await detailOf(ppid);
    const unpub = await A.publisher.post(`/products/${ppid}/unpublish`, { expected_row_version: d.product.row_version });
    const hidden = await pub(`/products/public-hub-${slugTag}`);
    check(id("PB8"), "internal unpublish removes the product from the public API immediately; the editor shows it as hidden; GetOyi is notified",
      unpub.status === 200 && hidden.status === 404 && unpub.json.public.effective === "hidden" && (!revalidator || lastReval().payload.event === "unpublished_internally"), { unpub: unpub.status, hidden: hidden.status, effective: unpub.json.public && unpub.json.public.effective });
    const repub = await A.publisher.post(`/products/${ppid}/publish`, { expected_row_version: unpub.json.product.row_version });
    check(id("PB8b"), "publishing the same approved version internally again makes the listing visible again (the public release was never withdrawn)", repub.status === 200 && (await pub(`/products/public-hub-${slugTag}`)).status === 200, repub.json && repub.json.public);

    // slug change with redirect
    d = await detailOf(ppid);
    const oldSlug = `public-hub-${slugTag}`, newSlug = `oyi-public-hub-${slugTag}`;
    const slugByPublisher = await A.publisher.post(`/products/${ppid}/slug`, { expected_row_version: d.product.row_version, slug: newSlug });
    const slugged = await A.releaser.post(`/products/${ppid}/slug`, { expected_row_version: d.product.row_version, slug: newSlug });
    const viaOld = await pub(`/products/${oldSlug}`);
    const viaNew = await pub(`/products/${newSlug}`);
    const takeOld = await A.writerA.post("/products", { slug: oldSlug, content: content({ name: "Hijack", model: `HJ-${tag}`, variants: [{ sku: `HJ-${tag}-1`, name: "x" }] }) });
    check(id("PB9"), "slug change (catalogue.public.publish only): the old slug answers redirect_to the new one, the new slug serves the product, the editor reports the public URL and the redirect; another product can never take the old slug",
      slugByPublisher.status === 403 && slugged.status === 200 && viaOld.status === 200 && viaOld.json.redirect_to === newSlug && viaNew.status === 200 && slugged.json.public.public_url.endsWith(`/hardware/${newSlug}`)
        && slugged.json.public.redirects.some((r) => r.old_slug === oldSlug) && takeOld.status === 409 && takeOld.json.error === "slug_taken",
      { slugByPublisher: slugByPublisher.status, slugged: slugged.status, viaOld: viaOld.json, viaNew: viaNew.status, takeOld: takeOld.json });
    if (revalidator) check(id("PB9b"), "slug change notifies GetOyi with the previous slugs", lastReval().payload.event === "slug_changed" && lastReval().payload.previous_slugs.includes(oldSlug) && lastReval().payload.slug === newSlug, lastReval());

    // price change on a public product -> GetOyi refresh + new public price
    d = await detailOf(ppid);
    const pv = d.variants.find((v) => v.sku === pvariants[0].sku);
    const pr2 = await A.writerA.post(`/variants/${pv.id}/price-changes`, { price_ngn_kobo: 4750000, vat_treatment: "standard" });
    await A.pricerB.post(`/price-changes/${pr2.json.price_change.id}/approve`);
    await A.publisher.post(`/price-changes/${pr2.json.price_change.id}/publish`);
    const repriced = await pub(`/products/${newSlug}`);
    check(id("PB10"), "a published price change shows on the public product at once and notifies GetOyi", repriced.json.product.price_from_kobo === 4750000 && (!revalidator || lastReval().payload.event === "price_changed"), repriced.json.product.price_from_kobo);

    // refresh failure and retry
    if (revalidator) {
      revalidator.failNext(1);
      d = await detailOf(ppid);
      const draft2 = await A.writerA.patch(`/products/${ppid}`, { expected_row_version: d.product.row_version, content: { ...d.content, summary: "Hub for the public catalogue, v-next" } });
      await reviewAndPublish(ppid);
      d = await detailOf(ppid);
      const failedRel = await A.releaser.post(`/products/${ppid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: d.public.listing.row_version });
      const retry = await A.publisher.post(`/products/${ppid}/public/refresh`, {});
      const staffRetry = await A.staff.post(`/products/${ppid}/public/refresh`, {});
      check(id("PB11"), "when GetOyi does not answer, the release still happens and the editor shows refresh 'failed'; Retry (publisher) starts a new round that succeeds; staff cannot retry",
        draft2.status === 200 && failedRel.status === 200 && failedRel.json.public.listing.refresh_status === "failed" && retry.status === 200 && retry.json.public.listing.refresh_status === "succeeded" && staffRetry.status === 403,
        { failed: failedRel.json && failedRel.json.public.listing, retry: retry.json && retry.json.public.listing, staffRetry: staffRetry.status });
    }

    // preview
    d = await detailOf(ppid);
    await A.writerA.patch(`/products/${ppid}`, { expected_row_version: d.product.row_version, content: { ...d.content, name: "Public Hub (draft name)", media: [...d.content.media, { media_id: draftImage.id, cover: false, alt: "Draft angle", caption: "" }] } });
    const pv1 = await A.staff.post(`/products/${ppid}/preview`, {});
    const token = (pv1.json.url || "").split("/hardware/preview/")[1];
    const view = await pub(`/preview/${token}`);
    const draftImg = view.json && view.json.product.images.find((x) => x.alt === "Draft angle");
    const pimg = draftImg ? await pub(`/preview/${token}/media/${draftImg.src.match(/[0-9a-f]{64}/)[0]}.webp`) : { status: 0, headers: new Map() };
    const leakPublic = draftImg ? await pub(`/media/${draftImg.src.match(/[0-9a-f]{64}/)[0]}.webp`) : { status: 0 };
    const tampered = await pub(`/preview/${token.slice(0, -2)}xx`);
    const intakePreview = await pub(`/preview/${token}`, scopedKey);
    const stillPublic = await pub(`/products/${newSlug}`);
    check(id("PB12"), "preview: any catalogue reader gets a 10-minute link to the CURRENT draft; through the catalogue key it shows the draft (name, draft image served no-store) while the public product is unchanged; tampered token 404, intake key 403",
      pv1.status === 201 && /\/hardware\/preview\/pv1\./.test(pv1.json.url) && view.status === 200 && view.json.product.name === "Public Hub (draft name)" && view.json.preview.status === "not_published"
        && pimg.status === 200 && /no-store/.test(pimg.headers.get("cache-control") || "") && leakPublic.status === 404 && tampered.status === 404 && intakePreview.status === 403 && stillPublic.json.product.name === "Public Hub",
      { pv1: pv1.status, view: view.status, name: view.json && view.json.product.name, pimg: pimg.status, leakPublic: leakPublic.status, tampered: tampered.status, intakePreview: intakePreview.status });

    // override-published versions cannot go public
    const ov = await A.writerA.post("/products", { slug: `override-hub-${slugTag}`, content: content({ name: "Override Hub", model: `OH-${tag}`, variants: [{ sku: `OH-${tag}-1`, name: "x" }] }) });
    const om = await upload(ov.json.product.id, await img("#a21caf"));
    let od = await detailOf(ov.json.product.id);
    await A.writerA.patch(`/products/${ov.json.product.id}`, { expected_row_version: od.product.row_version, content: { ...od.content, media: [{ media_id: om.id, cover: true, alt: "Override Hub", caption: "" }] } });
    od = await detailOf(ov.json.product.id);
    await A.superAdmin.post(`/products/${ov.json.product.id}/publish`, { expected_row_version: od.product.row_version, override_reason: "Emergency listing for scenario testing purposes" });
    od = await detailOf(ov.json.product.id);
    check(id("PB13"), "a version published by administrative override (no second-person approval) can never be released publicly (version_not_approved)", od.product.publication_status === "published" && od.public.requirements.some((r) => r.code === "version_not_approved"), od.public.requirements);

    // archive: hidden, previews revoked
    d = await detailOf(ppid);
    const arch = await A.publisher.post(`/products/${ppid}/archive`, { expected_row_version: d.product.row_version });
    const archivedPublic = await pub(`/products/${newSlug}`);
    const archivedPreview = await pub(`/preview/${token}`);
    const archivedImage = await pub(`/media/${coverSha}.webp`);
    check(id("PB14"), "archiving removes the product, its old-slug redirect target and its images from the public API and revokes open previews (410)",
      arch.status === 200 && archivedPublic.status === 404 && (await pub(`/products/${oldSlug}`)).status === 404 && archivedPreview.status === 410 && archivedImage.status === 404 && arch.json.public.effective === "hidden",
      { arch: arch.status, archivedPublic: archivedPublic.status, archivedPreview: archivedPreview.status, archivedImage: archivedImage.status });
  }

  // ------------------------------------------------------------------------------------------------ audit evidence
  {
    const events = await audit();
    const actions = new Set(events.map((e) => e.action));
    const wanted = ["catalogue_product_created", "catalogue_product_edited", "catalogue_product_submitted", "catalogue_product_approved", "catalogue_product_changes_requested", "catalogue_product_published", "catalogue_product_published_override", "catalogue_product_unpublished", "catalogue_product_archived", "catalogue_product_duplicated", "catalogue_category_created", "catalogue_category_updated", "catalogue_brand_created", "catalogue_price_change_requested", "catalogue_price_change_approved", "catalogue_price_change_published", "catalogue_inventory_changed", "catalogue_supplier_created", "catalogue_cost_recorded", "catalogue_media_uploaded", "catalogue_media_rejected", "catalogue_media_removed", "catalogue_media_removal_refused", ...(catalogueKey ? ["catalogue_public_released", "catalogue_public_withdrawn", "catalogue_slug_changed", "catalogue_preview_created", "catalogue_preview_viewed", "catalogue_previews_revoked", ...(revalidator ? ["catalogue_public_refresh_retried"] : [])] : [])];
    const missing = wanted.filter((w) => !actions.has(w));
    const costAudit = events.find((e) => e.action === "catalogue_cost_recorded");
    check(id("AUD1"), `every catalogue write is audited (${wanted.length} action types present, incl. media and public release)`, missing.length === 0, missing);
    check(id("AUD2"), "the cost audit record carries no amounts (audit readers may lack catalogue.cost.read)", costAudit && !/9000000|11000000/.test(JSON.stringify(costAudit)), costAudit);
  }
  return { productId: pid };
}

module.exports = { CATALOGUE_TEST_USERS, runCatalogueScenarios, startRevalidator, testUsers };
