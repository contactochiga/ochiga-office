// Featured images reach Sanity only from Office storage -- the server never fetches a cover URL. Proves, against the real HTTP routes:
// an uploaded cover (content and development project) is validated from its bytes, read from Office storage and attached to the Sanity draft and the published
// article; Replace and Remove still work; invalid files (wrong type, disguised, unreadable, too large) are refused at upload; external, internal and
// metadata-service URLs and other private Office files are refused on save and never requested; a legacy link already on an article is never fetched and
// never removes the cover Sanity already has, and the editor is told; a Sanity CDN image of this project is referenced without downloading it; and the
// private storage route still requires a session.
// Temporary file store, temporary storage directory and an in-memory Sanity fake only: no network, no database, no real Sanity project.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { setSanityClientFactoryForTests } = require("../src/lead-agents/sanity-adapter");
const images = require("../src/lead-agents/content-images");

let checks = 0;
const ok = (cond, name) => { assert.ok(cond, name); checks += 1; console.log("PASS " + name); };

// Every outbound fetch the server makes is recorded; only calls to this test's own server are allowed through.
const realFetch = globalThis.fetch;
const outbound = [];
let ownOrigin = "";
// Node's http/https clients too (axios and most libraries use them): anything not addressed to this test's own server is recorded and refused.
const http = require("node:http");
const https = require("node:https");
for (const mod of [http, https]) {
  for (const name of ["request", "get"]) {
    const original = mod[name];
    mod[name] = function guarded(...args) {
      const first = args[0];
      const target = typeof first === "string" || first instanceof URL ? String(first) : `${first && (first.protocol || "")}//${first && (first.hostname || first.host || "")}:${first && first.port || ""}${first && first.path || ""}`;
      if (ownOrigin && target.startsWith(ownOrigin)) return original.apply(this, args);
      outbound.push(target);
      throw new Error(`test: outbound request blocked (${target})`);
    };
  }
}
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (ownOrigin && url.startsWith(ownOrigin)) return realFetch(input, init);
  outbound.push(url);
  throw new Error(`test: outbound request blocked (${url})`);
};

function createFakeSanity() {
  const docs = new Map();
  const published = [];
  const uploads = [];
  const hooks = { failGetDocument: false };
  let rev = 0;
  const client = {
    fetch: async () => null,
    assets: {
      upload: async (type, buffer, options) => {
        const id = `image-${crypto.createHash("sha1").update(buffer).digest("hex")}-10x10-png`;
        uploads.push({ type, id, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), options });
        return { _id: id };
      },
    },
    async createOrReplace(doc) {
      const stored = { ...doc, _rev: `rev-${++rev}` };
      docs.set(doc._id, stored);
      if (!String(doc._id).startsWith("drafts.")) published.push(stored);
      return stored;
    },
    async getDocument(id) {
      if (hooks.failGetDocument) throw new Error("sanity read failed");
      return docs.has(id) ? { ...docs.get(id) } : undefined;
    },
    async delete(id) { docs.delete(id); },
    async createIfNotExists(doc) {
      if (!docs.has(doc._id)) docs.set(doc._id, { ...doc, _rev: `rev-${++rev}` });
      return docs.get(doc._id);
    },
  };
  return { client, docs, published, uploads, hooks };
}

const png = (w = 40, h = 20, color = { r: 200, g: 40, b: 30 }) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const dataUrl = (buffer, mime) => `data:${mime};base64,${buffer.toString("base64")}`;
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const coverRef = (doc) => doc && doc.coverImage && doc.coverImage.asset && doc.coverImage.asset._ref;

async function unitChecks() {
  const c = (url, kind = "content") => images.classifyCoverImageUrl(url, kind, { sanityProjectId: "test-project", sanityDataset: "test" });
  ok(c("").kind === "none" && c(null).kind === "none", "classify: no image");
  ok(c("/api/lead-agents/admin/storage/content_featured_image_mh2k3_0a1b2c3d4e5f.png").kind === "office", "classify: an Office content cover upload");
  ok(c("/api/lead-agents/admin/storage/development_cover_image_mh2k3_0a1b2c3d4e5f.webp", "development").kind === "office", "classify: an Office development cover upload");
  ok(c("/api/lead-agents/admin/storage/development_cover_image_mh2k3_0a1b2c3d4e5f.webp").kind === "unsupported", "classify: another purpose's file is not a content cover");
  for (const [url, label] of [
    ["/api/lead-agents/admin/storage/staff_photo_mh2k3_0a1b2c3d4e5f.png", "a staff photo"],
    ["/api/lead-agents/admin/storage/document_mh2k3_0a1b2c3d4e5f.pdf", "a private document"],
    ["/api/lead-agents/admin/storage/message_attachment_mh2k3_0a1b2c3d4e5f.png", "a message attachment"],
    ["/api/lead-agents/admin/storage/content_featured_image_mh2k3_0a1b2c3d4e5f.svg", "an SVG"],
    ["/api/lead-agents/admin/storage/..%2F..%2Fstore.json", "a path traversal"],
    ["/api/lead-agents/admin/storage/content_featured_image_mh2k3_0a1b2c3d4e5f.png%2F..%2Fx", "an encoded path suffix"],
    ["/api/lead-agents/admin/storage/%E0%A4%A", "a malformed escape"],
  ]) ok(c(url).kind === "unsupported", `classify: refused Office path (${label})`);
  for (const [url, label] of [
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "the cloud metadata service"],
    ["http://localhost:4000/api/lead-agents/admin/storage/content_featured_image_mh2k3_0a1b2c3d4e5f.png", "localhost"],
    ["http://127.0.0.1/", "loopback"],
    ["http://10.0.0.5/cover.png", "a private address"],
    ["http://[::1]/cover.png", "IPv6 loopback"],
    ["https://images.example.com/cover.jpg", "an external site"],
    ["file:///etc/passwd", "a file URL"],
    ["data:image/png;base64,AAAA", "a data URL"],
    ["//evil.example/cover.png", "a protocol-relative URL"],
    ["https://cdn.sanity.io/images/other-project/test/0123456789abcdef0123456789abcdef01234567-10x10.png", "another Sanity project"],
    ["https://cdn.sanity.io.evil.example/images/test-project/test/0123456789abcdef0123456789abcdef01234567-10x10.png", "a look-alike Sanity host"],
  ]) ok(c(url).kind === "unsupported", `classify: refused URL (${label})`);
  const sanityCdn = c("https://cdn.sanity.io/images/test-project/test/0123456789abcdef0123456789abcdef01234567-1200x630.jpg?w=800");
  ok(sanityCdn.kind === "sanity_asset" && sanityCdn.assetId === "image-0123456789abcdef0123456789abcdef01234567-1200x630-jpg", "classify: this project's Sanity image maps to its asset id");
  ok(c("https://cdn.sanity.io/images/test-project/test/0123456789ABCDEF0123456789abcdef01234567-1200x630.JPG").kind === "unsupported", "classify: a mis-cased Sanity URL is refused (it would reference an asset that does not exist)");

  const good = await png();
  const info = await images.validateCoverImage(good);
  ok(info.format === "png" && info.mime_type === "image/png" && info.extension === ".png" && info.width === 40, "validate: a real PNG is accepted with its detected type");
  ok((await images.validateCoverImage(await sharp(good).jpeg().toBuffer())).mime_type === "image/jpeg", "validate: JPEG is accepted");
  ok((await images.validateCoverImage(await sharp(good).webp().toBuffer())).mime_type === "image/webp", "validate: WebP is accepted");
  const refuse = async (buffer, status, code, label) => {
    let caught = null;
    try { await images.validateCoverImage(buffer); } catch (err) { caught = err; }
    ok(caught && caught.statusCode === status && caught.code === code, `validate: refused ${label} (${status})`);
  };
  await refuse(Buffer.from("<html><script>alert(1)</script></html>".padEnd(64, " ")), 415, "unsupported_image_type", "HTML");
  await refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 415, "unsupported_image_type", "SVG");
  await refuse(await sharp(good).gif().toBuffer(), 415, "unsupported_image_type", "GIF");
  await refuse(Buffer.concat([good.subarray(0, 16), Buffer.alloc(200, 7)]), 422, "image_unreadable", "a PNG signature with garbage after it");
  await refuse(Buffer.alloc(images.COVER_IMAGE_MAX_BYTES + 1, 0xff), 413, "image_too_large", "a file over 10 MB");
  await refuse(Buffer.alloc(0), 400, "image_missing", "an empty file");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(server.address().port); });
  });
}

async function main() {
  await unitChecks();

  const sanity = createFakeSanity();
  const savedEnv = { SANITY_PROJECT_ID: process.env.SANITY_PROJECT_ID, SANITY_DATASET: process.env.SANITY_DATASET, SANITY_API_WRITE_TOKEN: process.env.SANITY_API_WRITE_TOKEN, OFFICE_CONTENT_SCHEDULER_ENABLED: process.env.OFFICE_CONTENT_SCHEDULER_ENABLED };
  Object.assign(process.env, { SANITY_PROJECT_ID: "test-project", SANITY_DATASET: "test", SANITY_API_WRITE_TOKEN: "test-token-not-a-secret" });
  delete process.env.OFFICE_CONTENT_SCHEDULER_ENABLED;
  setSanityClientFactoryForTests(() => sanity.client);

  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "content-image-storage-"));
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["content-image-test-key"], allowedOrigins: [], officeEmailProvider: "", resendApiKey: "", officeStorageDriver: "local", officeStorageDir: storageDir, officePublicBaseUrl: "http://169.254.169.254" };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "writer@ochiga.local", password_hash: hashPassword("writer-pass-123"), role: "ochiga_staff", display_name: "Writer", status: "active" });
  await store.ensureAdminUser({ email: "reviewer@ochiga.local", password_hash: hashPassword("reviewer-pass-123"), role: "ochiga_staff", display_name: "Reviewer", status: "active" });
  await store.ensureAdminUser({ email: "publisher@ochiga.local", password_hash: hashPassword("publisher-pass-123"), role: "super_admin", display_name: "Publisher", status: "active" });
  const webhooks = new WebhookDispatcher({ config });
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks }),
  });
  const base = `http://127.0.0.1:${await listen(server)}`;
  ownOrigin = base;

  async function login(email, password) {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, `login ${email}`);
    return res.headers.get("set-cookie").split(";")[0];
  }
  const request = async (cookie, method, apiPath, body) => {
    const res = await fetch(`${base}/api/lead-agents/admin${apiPath}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const upload = (cookie, buffer, mime, purpose = "content_featured_image") => request(cookie, "POST", "/storage", { data_url: dataUrl(buffer, mime), purpose, filename: "cover", mime_type: mime });
  const storedFiles = async () => (await fs.readdir(storageDir)).sort();

  try {
    const writer = await login("writer@ochiga.local", "writer-pass-123");
    const reviewer = await login("reviewer@ochiga.local", "reviewer-pass-123");
    const publisher = await login("publisher@ochiga.local", "publisher-pass-123");
    const draftOf = (id) => sanity.docs.get(`drafts.post-${id}`);
    const publishedOf = (id) => sanity.docs.get(`post-${id}`);
    const approveAndPublish = async (id) => {
      assert.equal((await request(writer, "POST", `/content/${id}/submit-review`, {})).status, 200);
      assert.equal((await request(reviewer, "POST", `/content/${id}/approve`, {})).status, 200);
      return request(publisher, "POST", `/content/${id}/publish`, {});
    };

    // --- upload validation ---
    const cover = await png(64, 32);
    const up = await upload(writer, cover, "image/png");
    ok(up.status === 201 && /^\/api\/lead-agents\/admin\/storage\/content_featured_image_[0-9a-z]+_[0-9a-f]{12}\.png$/.test(up.data.file.url), "upload: a writer's PNG cover is stored under an Office storage URL");
    ok(up.data.file.mime_type === "image/png" && up.data.file.size === cover.length, "upload: stored with the detected type and size");
    const jpegAsPng = await upload(writer, await sharp(cover).jpeg().toBuffer(), "image/png");
    ok(jpegAsPng.status === 201 && jpegAsPng.data.file.url.endsWith(".jpg") && jpegAsPng.data.file.mime_type === "image/jpeg", "upload: the declared type is ignored -- a JPEG labelled PNG is stored as JPEG");
    const before = await storedFiles();
    const htmlAsImage = await upload(writer, Buffer.from("<html><body><script>document.cookie</script></body></html>"), "image/png");
    ok(htmlAsImage.status === 415 && htmlAsImage.data.reason === "unsupported_image_type", "upload: HTML labelled as an image is refused (415)");
    const svg = await upload(writer, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'), "image/svg+xml");
    ok(svg.status === 415, "upload: SVG is refused (415)");
    const broken = await upload(writer, Buffer.concat([cover.subarray(0, 24), Buffer.alloc(300, 1)]), "image/png");
    ok(broken.status === 422 && broken.data.reason === "image_unreadable", "upload: an unreadable PNG is refused (422)");
    const tooBig = await upload(writer, Buffer.alloc(images.COVER_IMAGE_MAX_BYTES + 1024, 0xff), "image/jpeg");
    ok(tooBig.status === 413 && tooBig.data.reason === "image_too_large", "upload: a file over 10 MB is refused (413)");
    const noData = await request(writer, "POST", "/storage", { purpose: "content_featured_image", data_url: "not a data url" });
    ok(noData.status === 400, "upload: a missing image is refused (400)");
    ok(JSON.stringify(await storedFiles()) === JSON.stringify(before), "upload: nothing is stored for a refused file");
    const recased = await upload(publisher, Buffer.from("<html><body>not an image</body></html>".padEnd(80, " ")), "image/png", "Content Featured Image");
    ok(recased.status === 415 && JSON.stringify(await storedFiles()) === JSON.stringify(before), "upload: a re-cased cover purpose gets the same validation (refused, nothing stored)");
    const devUp = await upload(writer, cover, "image/png", "development_cover_image");
    ok(devUp.status === 403, "upload: development covers still need development.manage");

    // --- private storage stays private ---
    const anonymous = await request(null, "GET", up.data.file.url.replace("/api/lead-agents/admin", ""));
    ok(anonymous.status === 401 || anonymous.status === 403, "storage: an uploaded cover is not served without a session");
    const own = await fetch(`${base}${up.data.file.url}`, { headers: { cookie: writer } });
    ok(own.status === 200 && sha256(Buffer.from(await own.arrayBuffer())) === sha256(cover), "storage: staff with storage.read still see the cover in Office");

    // --- a successful publish carries the uploaded cover ---
    const created = await request(writer, "POST", "/content", { title: "Uploaded cover", body: "Body", featured_image_url: up.data.file.url });
    const id = created.data.item.id;
    const firstUpload = sanity.uploads[sanity.uploads.length - 1];
    ok(created.status === 201 && created.data.sanity.ok && created.data.sanity.warnings.length === 0, "publish: creating a post with an uploaded cover syncs with no warning");
    ok(firstUpload && firstUpload.sha256 === sha256(cover) && firstUpload.options.contentType === "image/png", "publish: the exact uploaded bytes went to Sanity's asset store, as PNG");
    ok(coverRef(draftOf(id)) === firstUpload.id, "publish: the Sanity draft references the uploaded cover");
    const pub = await approveAndPublish(id);
    ok(pub.status === 200 && coverRef(publishedOf(id)) === firstUpload.id, "publish: the published article carries the uploaded cover");

    // --- Replace and Remove ---
    const second = await png(30, 30, { r: 10, g: 120, b: 200 });
    const up2 = await upload(writer, second, "image/png");
    const draftPost = (await request(writer, "POST", "/content", { title: "Replace and remove", body: "Body", featured_image_url: up.data.file.url })).data.item;
    const replaced = await request(writer, "PATCH", `/content/${draftPost.id}`, { featured_image_url: up2.data.file.url });
    ok(replaced.status === 200 && coverRef(draftOf(draftPost.id)) === sanity.uploads[sanity.uploads.length - 1].id && sanity.uploads[sanity.uploads.length - 1].sha256 === sha256(second), "replace: the new upload replaces the Sanity cover");
    const removed = await request(writer, "PATCH", `/content/${draftPost.id}`, { featured_image_url: "" });
    ok(removed.status === 200 && !draftOf(draftPost.id).coverImage && removed.data.sanity.warnings.length === 0, "remove: removing the image removes the Sanity cover without a warning");

    // --- SSRF: URLs are refused on save and never requested ---
    for (const [url, label] of [
      ["http://169.254.169.254/latest/meta-data/", "the cloud metadata service"],
      ["http://127.0.0.1:5432/", "a local port"],
      ["http://localhost/api/lead-agents/admin/storage/content_featured_image_mh2k3_0a1b2c3d4e5f.png", "localhost"],
      ["https://images.example.com/cover.jpg", "an external site"],
      ["file:///etc/passwd", "a file URL"],
      ["/api/lead-agents/admin/storage/staff_photo_mh2k3_0a1b2c3d4e5f.png", "a private Office staff photo"],
      ["/api/lead-agents/admin/storage/..%2Fstore.json", "a storage path traversal"],
    ]) {
      const onCreate = await request(writer, "POST", "/content", { title: `SSRF ${label}`, body: "Body", featured_image_url: url });
      const onEdit = await request(writer, "PATCH", `/content/${draftPost.id}`, { featured_image_url: url });
      ok(onCreate.status === 400 && onCreate.data.reason === "cover_image_not_uploaded" && onEdit.status === 400, `ssrf: ${label} is refused on create and edit`);
    }
    ok((await store.getContentItemById(draftPost.id)).featured_image_url === "", "ssrf: a refused edit changes nothing");

    // --- legacy links already on articles ---
    const legacyCovered = await store.createContentItem({ title: "Legacy with Sanity cover", body: "Body", slug: "legacy-covered", featured_image_url: "http://169.254.169.254/latest/meta-data/cover.jpg", created_by: "writer@ochiga.local" });
    await sanity.client.createOrReplace({ _id: `post-${legacyCovered.id}`, _type: "post", title: "Legacy with Sanity cover", coverImage: { _type: "image", asset: { _type: "reference", _ref: "image-existing-live-cover-800x400-jpg" } } });
    const uploadsBefore = sanity.uploads.length;
    const legacyEdit = await request(writer, "PATCH", `/content/${legacyCovered.id}`, { title: "Legacy with Sanity cover (edited)", featured_image_url: legacyCovered.featured_image_url });
    ok(legacyEdit.status === 200, "legacy: an article whose unchanged cover is a legacy link can still be saved");
    ok(coverRef(draftOf(legacyCovered.id)) === "image-existing-live-cover-800x400-jpg", "legacy: the cover Sanity already has is kept, not silently removed");
    const legacyWarning = legacyEdit.data.sanity.warnings.find((w) => w.startsWith("Featured image not sent"));
    ok(legacyWarning && legacyWarning.includes("169.254.169.254") && legacyWarning.includes("already in Sanity was kept"), "legacy: the save reports the link was not sent and the existing cover was kept");
    ok((await store.getContentItemById(legacyCovered.id)).metadata.sanity_warnings.includes(legacyWarning), "legacy: the warning is stored on the post for the Publishing panel");
    ok(sanity.uploads.length === uploadsBefore, "legacy: nothing was uploaded for the legacy link");
    const legacyPub = await approveAndPublish(legacyCovered.id);
    ok(legacyPub.status === 200 && coverRef(publishedOf(legacyCovered.id)) === "image-existing-live-cover-800x400-jpg" && legacyPub.data.warnings.some((w) => w.startsWith("Featured image not sent")), "legacy: publishing keeps the live cover and reports why");

    const legacyBare = await store.createContentItem({ title: "Legacy without cover", body: "Body", slug: "legacy-bare", featured_image_url: "https://images.example.com/old.jpg", created_by: "writer@ochiga.local" });
    const bareEdit = await request(writer, "PATCH", `/content/${legacyBare.id}`, { excerpt: "now with an excerpt" });
    ok(bareEdit.status === 200 && !draftOf(legacyBare.id).coverImage && bareEdit.data.sanity.warnings.some((w) => w.includes("images.example.com") && w.includes("Sanity has no featured image")), "legacy: with no cover in Sanity, the save says so instead of failing silently");

    const sanityCdnUrl = "https://cdn.sanity.io/images/test-project/test/0123456789abcdef0123456789abcdef01234567-1200x630.jpg";
    const cdnPost = await request(writer, "POST", "/content", { title: "Sanity CDN cover", body: "Body", featured_image_url: sanityCdnUrl });
    ok(cdnPost.status === 201 && coverRef(draftOf(cdnPost.data.item.id)) === "image-0123456789abcdef0123456789abcdef01234567-1200x630-jpg" && cdnPost.data.sanity.warnings.length === 0, "legacy: an image already in this Sanity project is referenced by asset id, without downloading it");

    // --- a Sanity read error never drops the cover ---
    sanity.hooks.failGetDocument = true;
    const readFail = await request(writer, "PATCH", `/content/${legacyCovered.id}`, { title: "Legacy with Sanity cover (edited again)", featured_image_url: legacyCovered.featured_image_url });
    sanity.hooks.failGetDocument = false;
    ok(readFail.status === 200 && readFail.data.sanity.ok === false && coverRef(publishedOf(legacyCovered.id)) === "image-existing-live-cover-800x400-jpg" && !draftOf(legacyCovered.id), "sanity read error: the save stays local and no coverless draft is written");

    // --- an uploaded file that is gone from storage ---
    const missingPost = (await request(writer, "POST", "/content", { title: "Cover deleted from storage", body: "Body", featured_image_url: up2.data.file.url })).data.item;
    const missingRef = coverRef(draftOf(missingPost.id));
    await fs.unlink(path.join(storageDir, path.basename(up2.data.file.url)));
    const missingEdit = await request(writer, "PATCH", `/content/${missingPost.id}`, { excerpt: "edited" });
    ok(missingEdit.status === 200 && coverRef(draftOf(missingPost.id)) === missingRef && missingEdit.data.sanity.warnings.some((w) => w.includes("no longer in Office storage")), "missing file: the existing Sanity cover is kept and the editor is told to upload again");

    // --- development projects use the same path ---
    const devCreate = await request(publisher, "POST", "/development-projects", { name: "Estate One", slug: "estate-one", cover_image_url: "http://169.254.169.254/latest/meta-data/" });
    ok(devCreate.status === 400 && devCreate.data.reason === "cover_image_not_uploaded", "development: a cover link to an internal address is refused");
    const devCover = await upload(publisher, cover, "image/png", "development_cover_image");
    const devProject = (await request(publisher, "POST", "/development-projects", { name: "Estate Two", slug: "estate-two", cover_image_url: devCover.data.file.url, cover_image_alt: "Estate Two" })).data.project;
    const devSync = await request(publisher, "POST", `/development-projects/${devProject.id}/sync`, {});
    const devDoc = sanity.docs.get("development-project-estate-two");
    ok(devSync.status === 200 && devSync.data.sanity.ok && coverRef(devDoc) === sanity.uploads[sanity.uploads.length - 1].id && devDoc.coverImage.alt === "Estate Two" && devSync.data.sanity.warnings.length === 0, "development: an uploaded cover syncs to Sanity from Office storage");
    const devWrongPurpose = await request(publisher, "PATCH", `/development-projects/${devProject.id}`, { cover_image_url: up.data.file.url });
    ok(devWrongPurpose.status === 400, "development: an article's cover file cannot be reused as a project cover");
    const legacyDev = await store.createDevelopmentProject({ name: "Legacy Estate", slug: "legacy-estate", cover_image_url: "https://images.example.com/estate.jpg", created_by: "office" });
    const legacyDevSync = await request(publisher, "POST", `/development-projects/${legacyDev.id}/sync`, {});
    ok(legacyDevSync.status === 200 && legacyDevSync.data.sanity.warnings.some((w) => w.startsWith("Cover image not sent") && w.includes("images.example.com")), "development: a legacy cover link is reported, not fetched");

    ok(outbound.length === 0, `no outbound request was made by the server (${outbound.length})`);
  } finally {
    globalThis.fetch = realFetch;
    setSanityClientFactoryForTests(null);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(storageDir, { recursive: true, force: true });
  }
  console.log(`\n${checks} featured-image checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
