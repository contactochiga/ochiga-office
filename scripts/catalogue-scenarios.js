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
  outsider: { role: "estate_admin", scopes: [] },
});

function testUsers(tag = crypto.randomBytes(3).toString("hex")) {
  return Object.fromEntries(Object.entries(CATALOGUE_TEST_USERS).map(([name, u]) => [name, { ...u, email: `${name.toLowerCase()}.${tag}@fixture.test`, password: `Cat!${crypto.randomBytes(8).toString("hex")}Aa1` }]));
}

async function runCatalogueScenarios({ base, users, fullKey, scopedKey, check, label = "" }) {
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

  // ------------------------------------------------------------------------------------------------ audit evidence
  {
    const events = await audit();
    const actions = new Set(events.map((e) => e.action));
    const wanted = ["catalogue_product_created", "catalogue_product_edited", "catalogue_product_submitted", "catalogue_product_approved", "catalogue_product_changes_requested", "catalogue_product_published", "catalogue_product_published_override", "catalogue_product_unpublished", "catalogue_product_archived", "catalogue_product_duplicated", "catalogue_category_created", "catalogue_category_updated", "catalogue_brand_created", "catalogue_price_change_requested", "catalogue_price_change_approved", "catalogue_price_change_published", "catalogue_inventory_changed", "catalogue_supplier_created", "catalogue_cost_recorded"];
    const missing = wanted.filter((w) => !actions.has(w));
    const costAudit = events.find((e) => e.action === "catalogue_cost_recorded");
    check(id("AUD1"), "every catalogue write is audited (19 action types present)", missing.length === 0, missing);
    check(id("AUD2"), "the cost audit record carries no amounts (audit readers may lack catalogue.cost.read)", costAudit && !/9000000|11000000/.test(JSON.stringify(costAudit)), costAudit);
  }
  return { productId: pid };
}

module.exports = { CATALOGUE_TEST_USERS, runCatalogueScenarios, testUsers };
