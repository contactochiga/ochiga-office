"use strict";

const crypto = require("node:crypto");
const C = require("./catalogue");
const { extract, LIMITS } = require("./product-import-extract");
const { readJsonBody } = require("./http");
const P = C.CATALOGUE_PERMISSIONS;
const SHA = (v) => crypto.createHash("sha256").update(v).digest("hex");
const actorOf = (auth) => String(auth.email || auth.userId || "").trim().toLowerCase();
const slugOf = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/g, "");
const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

async function readBytes(req) {
  let size = 0; const chunks = [];
  for await (const b of req) { size += b.length; if (size <= LIMITS.bytes) chunks.push(b); if (size > LIMITS.bytes * 2) { req.destroy(); throw C.httpError(413, "import_file_size"); } }
  if (size > LIMITS.bytes) throw C.httpError(413, "import_file_size");
  return Buffer.concat(chunks);
}
async function privateFile(storage, store, buffer, extension, id) {
  const file = await storage.putBuffer({ buffer, extension, mime_type: "application/octet-stream", purpose: "catalogue_import", resource_type: "catalogue_import", resource_id: id });
  try {
    await store.createOfficeFile({ ...file, url: "" });
    const registered = await store.listOfficeFilesByResource("catalogue_import", id);
    if (!registered.some((f) => f.id === file.id)) throw C.httpError(503, "import_storage_unavailable");
  }
  catch (error) { await storage.deleteObject(file.filename).catch(() => null); throw error; }
  return file.filename;
}
async function load(storage, id, auth) {
  if (!/^catalogue_import_[a-z0-9_]+\.json$/.test(id)) throw C.httpError(404, "import_not_found");
  const object = await storage.getObject(id);
  if (!object) throw C.httpError(404, "import_not_found");
  const envelope = JSON.parse(object.buffer.toString("utf8"));
  if (envelope.kind !== "product_import_v1" || envelope.owner !== actorOf(auth)) throw C.httpError(404, "import_not_found");
  if (envelope.extraction.contains_supplier_data) C.requireCataloguePermission(auth, P.costRead);
  return envelope;
}
async function preview(cat, extraction) {
  const [categories, brands, products] = await Promise.all([cat.listCategories(), cat.listBrands(), cat.listProducts()]);
  const allSkus = extraction.candidates.flatMap((c) => c.variants.map((v) => v.sku)).filter((s) => /^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(s));
  const existing = await cat.findImportSkus(allSkus);
  const counts = new Map(); allSkus.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
  const candidates = extraction.candidates.map((c) => {
    const category = categories.find((x) => x.status === "active" && (sameName(x.name, c.category) || sameName(x.slug, slugOf(c.category))));
    const brand = brands.find((x) => x.status === "active" && sameName(x.name, c.manufacturer));
    const warnings = [...c.warnings];
    if (!category) warnings.push("Choose an existing category; source category was not matched.");
    if (c.manufacturer && !brand) warnings.push("Manufacturer has no matching brand; retained as a source reference.");
    if (!c.image_references.length) warnings.push("Images missing. Gallery can be added after draft creation.");
    else warnings.push("Image references retained only; no remote images downloaded or validated.");
    if (!c.supplier_references.length) warnings.push("Supplier information and supplier cost missing.");
    if (!c.retail_references.length) warnings.push("Retail-price reference missing. Selling price remains unapproved.");
    else warnings.push("All spreadsheet prices are unapproved references; no selling price will be set.");
    const duplicates = c.variants.map((v) => v.sku).filter((s) => counts.get(s) > 1 || existing.some((v) => v.sku === s));
    if (duplicates.length) warnings.push(`Duplicate SKUs: ${[...new Set(duplicates)].join(", ")}. Resolve before saving.`);
    const content = { name: c.name, model: c.model, summary: c.summary, description: c.description, category_id: category?.id || "", brand_id: brand?.id || null, specifications: c.specifications, variants: c.variants, media: [] };
    return { ...c, content, slug: slugOf(c.name), warnings, duplicate_skus: duplicates, possible_matches: products.filter((p) => sameName(p.name, c.name) || (c.model && sameName(p.model, c.model))).map((p) => ({ id: p.id, name: p.name, slug: p.slug })), pricing_classification: "unapproved_source_reference" };
  });
  return { ...extraction, candidates, categories, brands, match_note: "Exact SKU checks cover the catalogue. Name/model suggestions cover the latest 500 products." };
}
async function handleImport({ sub, req, cat, authContext, storageService, store, send, audit }) {
  if (sub !== "/imports" && !sub.startsWith("/imports/")) return false;
  C.requireCataloguePermission(authContext, P.write);
  if (!storageService || typeof store.createOfficeDocument !== "function") throw C.httpError(503, "import_storage_unavailable");
  const actor = actorOf(authContext);
  if (sub === "/imports" && req.method === "POST") {
    const name = String(new URL(req.url, "http://localhost").searchParams.get("name") || "").split(/[\\/]/).pop().slice(0, 160);
    const ext = name.split(".").pop().toLowerCase();
    if (!["csv", "xlsx"].includes(ext)) throw C.httpError(415, "unsupported_import_format");
    const buffer = await readBytes(req);
    const extraction = await extract(buffer, ext);
    if (!extraction.candidates.length) throw C.httpError(422, "no_product_rows_detected");
    if (extraction.contains_supplier_data) C.requireCataloguePermission(authContext, P.costRead);
    const docId = crypto.randomUUID(), sourceHash = SHA(buffer);
    const source = await privateFile(storageService, store, buffer, `.${ext}`, docId);
    const envelope = { kind: "product_import_v1", owner: actor, document_id: docId, name, source_file: source, source_sha256: sourceHash, extraction };
    const id = await privateFile(storageService, store, Buffer.from(JSON.stringify(envelope)), ".json", docId);
    // Existing Documents registry gets a safe index only. Source/cost values never enter its broadly readable metadata or shares.
    const doc = await store.createOfficeDocument({ id: docId, title: `Product import: ${name}`, document_type: "product_import", status: "draft", owner: actor, related_type: "catalogue_import", related_id: id, metadata: { source_sha256: sourceHash, candidate_count: extraction.candidates.length, private_source: true } });
    if (doc.sync_status === "schema_pending") throw C.httpError(503, "import_documents_unavailable");
    await audit("catalogue_import_previewed", "office_document", docId, { source_sha256: sourceHash, candidate_count: extraction.candidates.length });
    send(201, { id, document_id: docId, name, ...(await preview(cat, extraction)) }); return true;
  }
  const match = /^\/imports\/([^/]+)(\/drafts)?$/.exec(sub);
  if (!match) throw C.httpError(404, "not_found");
  const id = match[1], envelope = await load(storageService, id, authContext);
  if (!match[2] && req.method === "GET") { send(200, { id, name: envelope.name, ...(await preview(cat, envelope.extraction)) }); return true; }
  if (!match[2] || req.method !== "POST") throw C.httpError(405, "method_not_allowed");
  const body = await readJsonBody(req, 1024 * 1024);
  if (!body || typeof body !== "object" || body.confirm_drafts_only !== true || !Array.isArray(body.items) || !body.items.length || body.items.length > LIMITS.candidates) throw C.httpError(400, "import_confirmation_required");
  const seenIds = new Set(), seenSkus = new Set(), seenSlugs = new Set();
  const prepared = [];
  for (const item of body.items) {
    if (!item || typeof item !== "object") throw C.httpError(400, "invalid_import_selection");
    const candidate = envelope.extraction.candidates.find((c) => c.id === item.id);
    if (!candidate || seenIds.has(item.id)) throw C.httpError(400, "invalid_import_selection");
    seenIds.add(item.id);
    const content = C.validateContent(item.content), slug = C.validSlug(item.slug);
    if (!slug || content.media.length || seenSlugs.has(slug)) throw C.httpError(400, "invalid_import_draft");
    seenSlugs.add(slug);
    const category = await cat.getCategory(content.category_id);
    if (!category || category.status !== "active") throw C.httpError(400, "category_not_found");
    if (content.brand_id && (await cat.getBrand(content.brand_id))?.status !== "active") throw C.httpError(400, "brand_not_found");
    for (const v of content.variants) { if (seenSkus.has(v.sku)) throw C.httpError(409, "duplicate_import_sku"); seenSkus.add(v.sku); }
    prepared.push({ candidate, content, slug });
  }
  const taken = await cat.findImportSkus([...seenSkus]);
  if (taken.length) throw C.httpError(409, "sku_taken", { details: taken.map((v) => v.sku) });
  // Persist exactly the reviewed payload first, through the existing private storage system.
  // Partial failures are explicit; database SKU/slug uniqueness remains the final race/retry guard.
  const review = await privateFile(storageService, store, Buffer.from(JSON.stringify({ kind: "product_import_review_v1", source: id, owner: actor, items: prepared })), ".json", envelope.document_id);
  const results = [];
  for (const { candidate, content, slug } of prepared) {
    let product;
    try {
      product = await cat.createProduct({ slug, content, categoryId: content.category_id, brandId: content.brand_id, actor });
      await audit("catalogue_product_imported", "catalogue_product", product.id, { version: 1, document_id: envelope.document_id, source_sha256: envelope.source_sha256, source_rows: candidate.source_rows, review_file: review, pricing: "unapproved_source_reference" });
      results.push({ id: candidate.id, product_id: product.id, status: "draft_created" });
    } catch (error) {
      results.push({ id: candidate.id, product_id: product?.id || null, status: product ? "draft_created_audit_failed" : "not_created", error: ["sku_taken", "slug_taken", "conflict"].includes(error.code) ? error.code : "import_save_failed" });
      // Stop on infrastructure/audit errors; never disguise partial writes as success or repeat them automatically.
      break;
    }
  }
  send(results.every((r) => r.status === "draft_created") && results.length === prepared.length ? 201 : 207, { results, requested: prepared.length }); return true;
}
module.exports = { handleImport, preview, slugOf };
