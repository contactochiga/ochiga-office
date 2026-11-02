// Solutions & Packages (SP1/SP3) acceptance scenarios, store-agnostic: run over HTTP against a real Office server by
// scripts/test-catalogue-packages.js (file store) and scripts/test-catalogue-postgres.js (Supabase Postgres + PostgREST).
// Synthetic components and prices only. Three synthetic packages: Oyi Smart Living, Oyi Intelligent Security, Oyi Building Intelligence.
// Covers: kinds, package content rules, component validation (unknown / unpublished / nested / archived), readiness and margin (cost
// holders only), independent review, consultation sizes, price approval of fixed sizes, public release / projection / withdrawal,
// component changes (needs re-review), missing inventory, unavailable devices, services never listed, previews and public data isolation.
"use strict";
const crypto = require("crypto");

async function runPackageScenarios({ base, users, fullKey, check, catalogueKey, revalidator = null, label = "" }) {
  const cookies = {};
  for (const name of Object.keys(users)) {
    const u = users[name];
    const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.password }) });
    cookies[name] = ((r.headers.getSetCookie ? r.headers.getSetCookie() : []).find((x) => /^lead_agents_admin=/.test(x)) || "").split(";")[0];
  }
  const call = async (who, method, path, body) => {
    const headers = { "content-type": "application/json", origin: base };
    if (who && cookies[who]) headers.cookie = cookies[who];
    const r = await fetch(`${base}/api/lead-agents/admin/catalogue${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const A = Object.fromEntries(Object.keys(users).map((n) => [n, { get: (p) => call(n, "GET", p), post: (p, b = {}) => call(n, "POST", p, b), patch: (p, b) => call(n, "PATCH", p, b) }]));
  const pub = async (path) => {
    const r = await fetch(`${base}/api/public/catalogue${path}`, { headers: { "x-api-key": catalogueKey } });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const auditRows = async () => ((await (await fetch(`${base}/api/lead-agents/admin/audit`, { headers: { "x-api-key": fullKey } })).json()).audit || []);
  const id = (x) => `${label}${x}`;
  const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
  const slugTag = tag.toLowerCase();
  const sharp = require("sharp");
  const upload = async (productId, bg) => {
    const buf = await sharp({ create: { width: 1200, height: 900, channels: 3, background: bg } }).jpeg({ quality: 85 }).toBuffer();
    const r = await fetch(`${base}/api/lead-agents/admin/catalogue/products/${productId}/media?name=pkg.jpg`, { method: "POST", headers: { "content-type": "image/jpeg", origin: base, cookie: cookies.writerA }, body: buf });
    return (await r.json()).media;
  };
  const detail = async (pid, who = "writerA") => (await A[who].get(`/products/${pid}`)).json;

  // ------------------------------------------------------------------------------------------------ fixtures (synthetic only)
  const cat = await A.publisher.post("/categories", { slug: `packages-${slugTag}`, name: "Packages", sort: 90 });
  const catId = cat.json.category.id;
  const hwCat = (await A.writerA.get("/categories")).json.categories.find((c) => c.slug === "security-access-control").id;
  const brand = await A.publisher.post("/brands", { slug: `synthetic-${slugTag}`, name: "Synthetic Devices" });
  const brandId = brand.json.brand.id;
  const productContent = (name, sku, extra = {}) => ({ category_id: hwCat, brand_id: brandId, name, model: `${sku}-M`, summary: `Synthetic ${name} for package tests.`, description: "Synthetic test component. Not for sale.", specifications: [{ key: "Power", value: "3", unit: "W" }], compatibility: { facility: true, experience: true }, variants: [{ sku, name }], ...extra });

  // publish a component internally: writerA creates, reviewer approves, publisher publishes; price writerA -> pricerA -> publisher
  async function component(name, sku, { kind = "product", priceKobo = null, costKobo = null, stock = null } = {}) {
    const made = await A.writerA.post("/products", { kind, slug: `${sku.toLowerCase()}-${slugTag}`, content: productContent(name, sku) });
    let p = made.json.product;
    p = (await A.writerA.post(`/products/${p.id}/submit`, { expected_row_version: p.row_version })).json.product;
    p = (await A.reviewer.post(`/products/${p.id}/approve`, { expected_row_version: p.row_version })).json.product;
    p = (await A.publisher.post(`/products/${p.id}/publish`, { expected_row_version: p.row_version })).json.product;
    const variant = (await detail(p.id)).variants[0];
    if (priceKobo != null) await setPrice(variant.id, priceKobo);
    if (costKobo != null) await A.finance.post(`/variants/${variant.id}/costs`, { supplier_cost_kobo: Math.round(costKobo * 0.8), landed_cost_kobo: costKobo, note: "synthetic" });
    if (stock != null) {
      const v = (await detail(p.id)).variants[0];
      await A.ops.patch(`/variants/${v.id}/inventory`, { expected_row_version: v.row_version, stock_on_hand: stock, stock_reserved: 0, sourcing: "in_stock", lead_time_days_min: 3, lead_time_days_max: 7, reason: "synthetic stock" });
    }
    return { product: (await detail(p.id)).product, variantId: variant.id, sku };
  }
  async function setPrice(variantId, kobo) {
    const req = await A.writerA.post(`/variants/${variantId}/price-changes`, { price_ngn_kobo: kobo, vat_treatment: "standard", note: "synthetic" });
    if (req.status !== 201) return req;
    await A.pricerA.post(`/price-changes/${req.json.price_change.id}/approve`);
    return A.publisher.post(`/price-changes/${req.json.price_change.id}/publish`);
  }

  const GW = await component("Synthetic Gateway", `GW-${tag}`, { priceKobo: 9000000, costKobo: 6000000, stock: 5 });
  const LOCK = await component("Synthetic Smart Lock", `LK-${tag}`, { priceKobo: 12000000, costKobo: 8000000, stock: 20 });
  const CAM = await component("Synthetic Camera", `CM-${tag}`, { priceKobo: 15000000, costKobo: 10000000, stock: 0 });
  const SENSOR = await component("Synthetic Motion Sensor", `MS-${tag}`, { priceKobo: 2500000, costKobo: 1500000, stock: 10 });
  const INSTALL = await component("Installation per door", `SV-INST-${tag}`, { kind: "service", priceKobo: 2000000 });
  const DRAFT = (await A.writerA.post("/products", { slug: `draft-${slugTag}`, content: productContent("Unpublished Device", `DR-${tag}`) })).json.product;

  const packageContent = (name, sizes, components, scopeOver = {}, extra = {}) => ({
    category_id: catId, brand_id: null, name, model: "", summary: `${name}: synthetic package for staging.`,
    description: "Synthetic package. Hardware price only; Oyi deployment by consultation.", specifications: [],
    compatibility: { facility: true, experience: true, notes: "" },
    variants: sizes,
    package: {
      solution_types: ["residential"],
      scope: { hardware: "Gateway, smart locks and sensors as listed.", software_deployment: "Oyi deployment planned with your team in a consultation.", installation: "quoted_separately", installation_note: "Installation is quoted after a site survey.", ...scopeOver },
      configuration: { custom: true, per_unit_label: "per door" },
      components,
    },
    ...extra,
  });
  const comp = (sku, role, over = {}) => ({ sku, role, basis: "fixed", quantity: 1, ...over });

  // ------------------------------------------------------------------------------------------------ K: kinds and validation
  {
    const badKind = await A.writerA.post("/products", { kind: "bundle", slug: `k1-${slugTag}`, content: {} });
    const noPkg = await A.writerA.post("/products", { kind: "package", slug: `k2-${slugTag}`, content: productContent("x", `K2-${tag}`) });
    const badPricing = await A.writerA.post("/products", { kind: "package", slug: `k3-${slugTag}`, content: packageContent("x", [{ sku: `K3-${tag}`, name: "Size", pricing: "monthly" }], [comp(GW.sku, "required")]) });
    const noComponents = await A.writerA.post("/products", { kind: "package", slug: `k4-${slugTag}`, content: packageContent("x", [{ sku: `K4-${tag}`, name: "Size", pricing: "fixed" }], []) });
    const badScope = await A.writerA.post("/products", { kind: "package", slug: `k5-${slugTag}`, content: packageContent("x", [{ sku: `K5-${tag}`, name: "Size", pricing: "fixed" }], [comp(GW.sku, "required")], { installation: "free", software_deployment: "" }) });
    check(id("PK01"), "package content is validated: unknown kind, missing package block, size pricing other than fixed/consultation (e.g. monthly), no components, invalid installation scope or missing deployment scope are refused",
      badKind.status === 400 && noPkg.status === 400 && badPricing.status === 400 && noComponents.status === 400 && badScope.status === 400 && /monthly|pricing/.test(JSON.stringify(badPricing.json.details)),
      [badKind.status, noPkg.status, badPricing.status, noComponents.status, badScope.status]);
  }

  // ------------------------------------------------------------------------------------------------ Smart Living (fixed sizes + custom)
  const SL = { APT: `SL-APT-${tag}`, VILLA: `SL-VILLA-${tag}`, CUSTOM: `SL-CUSTOM-${tag}` };
  const slContent = () => packageContent(`Oyi Smart Living ${tag}`, [
    { sku: SL.APT, name: "Apartment (up to 2 doors)", pricing: "fixed" },
    { sku: SL.VILLA, name: "Villa (up to 4 doors)", pricing: "fixed" },
    { sku: SL.CUSTOM, name: "Custom configuration", pricing: "consultation" },
  ], [
    comp(GW.sku, "required"),
    comp(LOCK.sku, "required", { basis: "per_unit", quantity: 1, quantities: { [SL.APT]: 2, [SL.VILLA]: 4 } }),
    comp(SENSOR.sku, "optional", { quantity: 2 }),
    comp(INSTALL.sku, "recommended", { basis: "per_unit", quantities: { [SL.APT]: 2, [SL.VILLA]: 4 }, note: "Quoted separately" }),
  ]);
  const created = await A.writerA.post("/products", { kind: "package", slug: `oyi-smart-living-${slugTag}`, content: slContent() });
  let sl = created.json && created.json.product;
  {
    const list = await A.writerA.get("/products?view=cards");
    const pkgs = await A.writerA.get("/products?view=cards&kind=package");
    const snap = created.json && created.json.content.package.components.find((c) => c.sku === LOCK.sku).snapshot;
    check(id("PK02"), "a package is created as a catalogue item of kind package; its component snapshot records the component's published version and price; the product table lists products only, ?kind=package lists packages",
      created.status === 201 && created.json.kind === "package" && snap && snap.product_version === LOCK.product.published_version && snap.price_kobo === 12000000
        && !list.json.products.some((c) => c.id === sl.id) && pkgs.json.products.some((c) => c.id === sl.id && c.kind === "package"),
      { status: created.status, kind: created.json && created.json.kind, snap });
  }

  // readiness: resolved components, availability, margin for cost holders only
  {
    const writerView = await detail(sl.id, "writerA");
    const financeView = await detail(sl.id, "finance");
    const r = writerView.package_readiness;
    const fr = financeView.package_readiness;
    const villa = fr && fr.sizes.find((s) => s.sku === SL.VILLA);
    check(id("PK03"), "readiness resolves every component (name, kind, availability, price), sizes compute required-component totals (Villa = 1 gateway + 4 locks), and cost/margin appear ONLY for catalogue.cost.read holders",
      r && r.ready === true && r.components.length === 4 && r.components.find((c) => c.sku === INSTALL.sku).kind === "service" && r.components.find((c) => c.sku === LOCK.sku).name === "Synthetic Smart Lock"
        && r.sizes.find((s) => s.sku === SL.VILLA).required_components_price_kobo === 9000000 + 4 * 12000000 && !("margin_kobo" in r.sizes[0]) && !("required_components_cost_kobo" in r.sizes[0])
        && villa && villa.required_components_cost_kobo === 6000000 + 4 * 8000000,
      { r: r && r.sizes, villa });
  }

  // component validation at submit
  {
    const bad = await A.writerA.post("/products", { kind: "package", slug: `bad-components-${slugTag}`, content: packageContent(`Bad ${tag}`, [{ sku: `BAD-${tag}`, name: "Size", pricing: "fixed" }], [comp(`NOPE-${tag}`, "required"), comp(`DR-${tag}`, "required"), comp(SL.APT, "required")]) });
    const b = bad.json.product;
    const submit = await A.writerA.post(`/products/${b.id}/submit`, { expected_row_version: b.row_version });
    const codes = (submit.json && submit.json.current && submit.json.current.issues || []).map((i) => `${i.code}:${i.sku}`);
    check(id("PK04"), "a package cannot enter review while a component is unknown, unpublished or another package (409 package_components_invalid, each problem named with a label)",
      submit.status === 409 && submit.json.error === "package_components_invalid" && codes.includes(`component_unknown:NOPE-${tag}`) && codes.includes(`component_not_published:DR-${tag}`) && codes.includes(`component_is_package:${SL.APT}`)
        && submit.json.current.issues.every((i) => i.label),
      submit.json);
  }

  // independent review and internal publication
  {
    const submit = await A.writerA.post(`/products/${sl.id}/submit`, { expected_row_version: sl.row_version });
    sl = submit.json.product;
    const writerApprove = await A.writerA.post(`/products/${sl.id}/approve`, { expected_row_version: sl.row_version });
    const approve = await A.reviewer.post(`/products/${sl.id}/approve`, { expected_row_version: sl.row_version });
    sl = approve.json.product;
    const publish = await A.publisher.post(`/products/${sl.id}/publish`, { expected_row_version: sl.row_version });
    sl = publish.json.product;
    const own = await A.senior.post("/products", { kind: "package", slug: `own-${slugTag}`, content: packageContent(`Own ${tag}`, [{ sku: `OWN-${tag}`, name: "Size", pricing: "consultation" }], [comp(GW.sku, "required")]) });
    const ownSubmit = await A.senior.post(`/products/${own.json.product.id}/submit`, { expected_row_version: own.json.product.row_version });
    const ownApprove = await A.senior.post(`/products/${own.json.product.id}/approve`, { expected_row_version: ownSubmit.json.product.row_version });
    check(id("PK05"), "independent review: the author cannot approve (no review grant; a senior author is refused own_change), a second person approves, a publisher publishes internally",
      submit.status === 200 && writerApprove.status === 403 && approve.status === 200 && publish.status === 200 && sl.publication_status === "published" && ownApprove.status === 403 && ownApprove.json.error === "own_change",
      [submit.status, writerApprove.status, approve.status, publish.status, ownApprove.status]);
  }

  // sizes: fixed prices through the existing approval; consultation sizes never priced
  const slSizes = async () => (await detail(sl.id)).variants;
  {
    const sizes = await slSizes();
    const apt = sizes.find((v) => v.sku === SL.APT), villa = sizes.find((v) => v.sku === SL.VILLA), custom = sizes.find((v) => v.sku === SL.CUSTOM);
    const consult = await A.writerA.post(`/variants/${custom.id}/price-changes`, { price_ngn_kobo: 100, vat_treatment: "standard" });
    const selfApprove = await A.writerA.post(`/variants/${apt.id}/price-changes`, { price_ngn_kobo: 29000000, vat_treatment: "standard", note: "Apartment hardware price" });
    const writerDecides = await A.writerA.post(`/price-changes/${selfApprove.json.price_change.id}/approve`);
    await A.pricerA.post(`/price-changes/${selfApprove.json.price_change.id}/approve`);
    const pubApt = await A.publisher.post(`/price-changes/${selfApprove.json.price_change.id}/publish`);
    const pubVilla = await setPrice(villa.id, 52000000);
    const priced = await slSizes();
    check(id("PK06"), "fixed sizes are priced through the existing price approval (requester cannot approve; a price approver approves; a publisher publishes); a consultation size cannot be priced (409 consultation_size_not_priced)",
      consult.status === 409 && consult.json.error === "consultation_size_not_priced" && writerDecides.status === 403 && pubApt.status === 200 && pubVilla.status === 200
        && priced.find((v) => v.sku === SL.APT).price_ngn_kobo === 29000000 && priced.find((v) => v.sku === SL.CUSTOM).price_ngn_kobo == null,
      [consult.status, writerDecides.status, pubApt.status, pubVilla.status]);
  }

  // public release: same requirements as products (images, approval) plus package rules
  {
    let d = await detail(sl.id);
    const noImages = await A.releaser.post(`/products/${sl.id}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: 0 });
    const m = await upload(sl.id, "#1d4ed8");
    const content = { ...d.content, media: [{ media_id: m.id, cover: true, alt: "Oyi Smart Living package", caption: "", variant_skus: [] }] };
    let p = (await A.writerA.patch(`/products/${sl.id}`, { expected_row_version: d.product.row_version, content })).json.product;
    p = (await A.writerA.post(`/products/${sl.id}/submit`, { expected_row_version: p.row_version })).json.product;
    p = (await A.reviewer.post(`/products/${sl.id}/approve`, { expected_row_version: p.row_version })).json.product;
    p = (await A.publisher.post(`/products/${sl.id}/publish`, { expected_row_version: p.row_version })).json.product;
    const before = revalidator ? revalidator.requests.length : 0;
    const release = await A.releaser.post(`/products/${sl.id}/public/release`, { expected_row_version: p.row_version, expected_listing_row_version: 0 });
    sl = p;
    check(id("PK07"), "public release: refused without images (no_images), released once the approved version has a cover with alt text and every fixed size has an approved price; GetOyi is asked to refresh",
      noImages.status === 409 && /no_images/.test(noImages.text) && release.status === 200 && (!revalidator || revalidator.requests.length > before),
      [noImages.status, release.status, release.text.slice(0, 200)]);
  }

  // projection and isolation
  {
    const list = await pub("/packages");
    const one = await pub(`/packages/oyi-smart-living-${slugTag}`);
    const asProduct = await pub(`/products/oyi-smart-living-${slugTag}`);
    const products = await pub("/products");
    const solution = await pub("/packages?solution=healthcare");
    const v = one.json && one.json.package;
    const text = one.text;
    const ids = [sl.id, GW.product.id, LOCK.product.id, LOCK.variantId, GW.variantId, catId, brandId];
    const leaks = ["landed", "supplier", "cost", "stock_on_hand", "stock_reserved", "reviewer", "author", "monthly", "subscription", "price_kobo\":", ...ids].filter((s) => text.includes(s));
    const villa = v && v.sizes.find((s) => s.sku === SL.VILLA);
    const lockLine = v && v.components.find((c) => c.name === "Synthetic Smart Lock");
    check(id("PK08"), "projection: /packages lists it (filterable by solution type), /packages/<slug> gives sizes (fixed price or consultation), scope (software by consultation, installation quoted separately), components by public name with per-size quantities; /products never shows packages",
      list.status === 200 && list.json.packages.some((p) => p.slug === `oyi-smart-living-${slugTag}`) && solution.json.packages.length === 0 && one.status === 200
        && villa && villa.price.amount_kobo === 52000000 && v.sizes.find((s) => s.sku === SL.CUSTOM).pricing === "consultation" && v.sizes.find((s) => s.sku === SL.CUSTOM).price === null
        && v.scope.software_pricing === "consultation" && v.scope.installation === "quoted_separately" && lockLine && lockLine.quantities[SL.VILLA] === 4 && lockLine.basis === "per_unit"
        && v.components.find((c) => c.name === "Installation per door").kind === "service" && asProduct.status === 404 && !products.json.products.some((p) => p.slug === `oyi-smart-living-${slugTag}`),
      { list: list.status, one: one.status, asProduct: asProduct.status });
    check(id("PK09"), "public data isolation: no internal id, cost, supplier, stock count, reviewer/author or any subscription/monthly field in the public package", leaks.length === 0, leaks);
    check(id("PK10"), "derived availability: every required component in stock -> in_stock; the optional camera-free package is unaffected by optional components", v && v.availability === "in_stock", v && v.availability);
  }

  // missing inventory and unavailable devices
  {
    const lock = (await detail(LOCK.product.id)).variants[0];
    await A.ops.patch(`/variants/${lock.id}/inventory`, { expected_row_version: lock.row_version, stock_on_hand: 0, stock_reserved: 0, sourcing: "in_stock", lead_time_days_min: 5, lead_time_days_max: 10, reason: "sold out (synthetic)" });
    const noStock = (await pub(`/packages/oyi-smart-living-${slugTag}`)).json.package.availability;
    const warn = (await detail(sl.id)).package_readiness.warnings.map((w) => `${w.code}:${w.sku}`);
    const sensor = (await detail(SENSOR.product.id)).variants[0];
    await A.ops.patch(`/variants/${sensor.id}/inventory`, { expected_row_version: sensor.row_version, sourcing: "discontinued", reason: "optional device discontinued (synthetic)" });
    const optionalGone = (await pub(`/packages/oyi-smart-living-${slugTag}`)).json.package.availability;
    const lock2 = (await detail(LOCK.product.id)).variants[0];
    await A.ops.patch(`/variants/${lock2.id}/inventory`, { expected_row_version: lock2.row_version, sourcing: "discontinued", reason: "required device discontinued (synthetic)" });
    const requiredGone = (await pub(`/packages/oyi-smart-living-${slugTag}`)).json.package.availability;
    const d = await detail(sl.id);
    const resubmitted = await A.writerA.patch(`/products/${sl.id}`, { expected_row_version: d.product.row_version, content: d.content });
    const blocked = await A.writerA.post(`/products/${sl.id}/submit`, { expected_row_version: resubmitted.json.product.row_version });
    check(id("PK11"), "missing inventory: a required component out of stock makes the package 'available to order' (warning in Office, not a blocker)", noStock === "available_to_order" && warn.includes(`required_component_not_in_stock:${LOCK.sku}`), { noStock, warn });
    check(id("PK12"), "unavailable devices: a discontinued OPTIONAL component never changes availability; a discontinued REQUIRED component makes the public package 'unavailable' at once and blocks a new version from review (component_discontinued)",
      optionalGone === "available_to_order" && requiredGone === "unavailable" && blocked.status === 409 && JSON.stringify(blocked.json.current.issues).includes("component_discontinued"),
      { optionalGone, requiredGone, blocked: blocked.status });
    // restore the lock for the following scenarios
    const lock3 = (await detail(LOCK.product.id)).variants[0];
    await A.ops.patch(`/variants/${lock3.id}/inventory`, { expected_row_version: lock3.row_version, stock_on_hand: 20, sourcing: "in_stock", reason: "restocked (synthetic)" });
    sl = (await detail(sl.id)).product;
  }

  // component change -> needs re-review; the public version stays pinned until re-released
  {
    await setPrice(GW.variantId, 9500000);
    const d = await detail(sl.id);
    const changed = d.package_readiness.components.find((c) => c.sku === GW.sku).changed;
    const listing = d.public.listing;
    const update = await A.releaser.post(`/products/${sl.id}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: listing ? listing.row_version : 0 });
    const stillPublic = await pub(`/packages/oyi-smart-living-${slugTag}`);
    // accept the change: save again (fresh snapshot), second-person review, publish, release
    let p = (await A.writerA.patch(`/products/${sl.id}`, { expected_row_version: d.product.row_version, content: d.content })).json.product;
    p = (await A.writerA.post(`/products/${sl.id}/submit`, { expected_row_version: p.row_version })).json.product;
    p = (await A.reviewer.post(`/products/${sl.id}/approve`, { expected_row_version: p.row_version })).json.product;
    p = (await A.publisher.post(`/products/${sl.id}/publish`, { expected_row_version: p.row_version })).json.product;
    const d2 = await detail(sl.id);
    const rerelease = await A.releaser.post(`/products/${sl.id}/public/release`, { expected_row_version: p.row_version, expected_listing_row_version: d2.public.listing.row_version });
    check(id("PK13"), "component change (gateway price): Office flags the component as changed, 'Update GetOyi' is refused (package_components_invalid) while the released version stays public; re-saving, second-person review and publication re-release it",
      changed === true && update.status === 409 && /package_components_invalid/.test(update.text) && stillPublic.status === 200 && rerelease.status === 200,
      { changed, update: update.status, stillPublic: stillPublic.status, rerelease: rerelease.status });
    sl = p;
  }

  // services are never listed on their own; unpublished component -> package unavailable
  {
    const sd = await detail(INSTALL.product.id);
    const svc = await A.releaser.post(`/products/${INSTALL.product.id}/public/release`, { expected_row_version: sd.product.row_version, expected_listing_row_version: 0 });
    check(id("PK14"), "a service cannot be released publicly on its own (service_not_listed)", svc.status === 409 && /service_not_listed/.test(svc.text), svc.text.slice(0, 200));
  }

  // Intelligent Security: installation INCLUDED in the approved price; Building Intelligence: consultation only
  let lateCreatedId = null;
  {
    const isec = await A.writerA.post("/products", { kind: "package", slug: `oyi-intelligent-security-${slugTag}`, content: packageContent(`Oyi Intelligent Security ${tag}`, [{ sku: `IS-STD-${tag}`, name: "Standard (4 cameras)", pricing: "fixed" }],
      [comp(GW.sku, "required"), comp(CAM.sku, "required", { quantity: 4 }), comp(INSTALL.sku, "required", { quantity: 4, note: "Included in the price" })],
      { installation: "included", installation_note: "Installation of the listed devices is included." }) });
    const isc = isec.json ? isec.json.product : null;
    const bi = await A.writerA.post("/products", { kind: "package", slug: `oyi-building-intelligence-${slugTag}`, content: { ...packageContent(`Oyi Building Intelligence ${tag}`, [{ sku: `BI-SITE-${tag}`, name: "Per building", pricing: "consultation" }], [comp(GW.sku, "required", { quantity: 3 }), comp(SENSOR.sku, "recommended", { quantity: 20 })], { installation: "quoted_separately" }) } });
    const bic = bi.json ? bi.json.product : null;
    lateCreatedId = bic && bic.id;
    const releaseAll = async (pid, colour, price) => {
      let d = await detail(pid);
      const m = await upload(pid, colour);
      let p = (await A.writerA.patch(`/products/${pid}`, { expected_row_version: d.product.row_version, content: { ...d.content, media: [{ media_id: m.id, cover: true, alt: d.content.name, caption: "", variant_skus: [] }] } })).json.product;
      p = (await A.writerA.post(`/products/${pid}/submit`, { expected_row_version: p.row_version })).json.product;
      p = (await A.reviewer.post(`/products/${pid}/approve`, { expected_row_version: p.row_version })).json.product;
      p = (await A.publisher.post(`/products/${pid}/publish`, { expected_row_version: p.row_version })).json.product;
      if (price) for (const v of (await detail(pid)).variants) await setPrice(v.id, price);
      d = await detail(pid);
      return A.releaser.post(`/products/${pid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: 0 });
    };
    const r1 = isc ? await releaseAll(isc.id, "#065f46", 98000000) : { status: 0 };
    const r2 = bic ? await releaseAll(bic.id, "#7c2d12", null) : { status: 0 };
    const v1 = (await pub(`/packages/oyi-intelligent-security-${slugTag}`)).json;
    const cards = (await pub("/packages")).json.packages;
    const biCard = cards.find((c) => c.slug === `oyi-building-intelligence-${slugTag}`);
    check(id("PK15"), "Oyi Intelligent Security: installation INCLUDED is part of the reviewed scope and shown as such; camera out of stock -> available to order",
      isec.status === 201 && r1.status === 200 && v1 && v1.package.scope.installation === "included" && v1.package.availability === "available_to_order", { create: isec.status, release: r1.status, scope: v1 && v1.package && v1.package.scope });
    check(id("PK16"), "Oyi Building Intelligence: consultation-only sizes release WITHOUT any price; the card says consultation_only and carries no price",
      bi.status === 201 && r2.status === 200 && biCard && biCard.consultation_only === true && biCard.price_from_kobo === null, { create: bi.status, release: r2.status, biCard });
  }

  // preview and withdrawal
  {
    const prev = await A.writerA.post(`/products/${sl.id}/preview`);
    const token = prev.json && prev.json.url && prev.json.url.split("/").pop();
    const seen = token ? await pub(`/preview/${token}`) : { status: 0 };
    const d = await detail(sl.id);
    const withdraw = await A.releaser.post(`/products/${sl.id}/public/withdraw`, { expected_listing_row_version: d.public.listing.row_version, reason: "synthetic withdrawal" });
    const gone = await pub(`/packages/oyi-smart-living-${slugTag}`);
    const listAfter = (await pub("/packages")).json.packages;
    check(id("PK17"), "staff preview of a package returns the package view (not a product); withdrawal removes it from /packages and /packages/<slug> at once",
      prev.status === 201 && seen.status === 200 && seen.json.package && seen.json.package.kind === "package" && withdraw.status === 200 && gone.status === 404 && !listAfter.some((p) => p.slug === `oyi-smart-living-${slugTag}`),
      { prev: prev.status, seen: seen.status, withdraw: withdraw.status, gone: gone.status });
  }

  // audit evidence
  {
    const rows = await auditRows();
    // (the audit endpoint returns the latest 200 events: checked on the package created last and the withdrawal just made)
    check(id("PK18"), "audit: package creation is recorded with its kind; releases and withdrawals use the existing catalogue audit events",
      rows.some((r) => r.action === "catalogue_product_created" && (r.resource_id || r.target_id || r.metadata?.resource_id) === lateCreatedId && (r.metadata || {}).kind === "package") && rows.some((r) => r.action === "catalogue_public_withdrawn" && (r.resource_id || r.target_id || r.metadata?.resource_id) === sl.id),
      rows.filter((r) => (r.resource_id || r.target_id || r.metadata?.resource_id) === sl.id || (r.resource_id || r.target_id || r.metadata?.resource_id) === lateCreatedId).map((r) => r.action));
  }
  return { packageId: sl.id, tag };
}

module.exports = { runPackageScenarios };
