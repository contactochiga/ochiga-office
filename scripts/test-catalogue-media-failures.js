// Product gallery: storage and processing failure handling (Phase 2 stage 4 infrastructure audit). The real Office server runs with the
// production "supabase" storage driver pointed at a Supabase Storage stand-in that can fail on demand (Nth upload, every download, every
// delete), with the file store for catalogue data. Checks that a failed upload leaves nothing behind, that failures never leak storage
// details to the caller, and how removal and public serving behave while storage is down.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const { hashPassword } = require("../src/lead-agents/auth");

const ROOT = path.resolve(__dirname, "..");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const SERVICE_KEY = `svc_${crypto.randomBytes(16).toString("hex")}`, FULL_KEY = `full_${crypto.randomBytes(12).toString("hex")}`, CATALOGUE_KEY = `cat_${crypto.randomBytes(16).toString("hex")}`;
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 500)}`); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Supabase Storage stand-in with fault injection
function storageStandIn() {
  const objects = new Map();
  const faults = { failUploadAt: 0, uploads: 0, failGets: false, failDeletes: false };
  const server = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
      const m = req.url.match(/^\/storage\/v1\/object\/([^/]+)\/([^/?]+)$/);
      if (!m || req.headers.authorization !== `Bearer ${SERVICE_KEY}`) { res.writeHead(403); res.end("{}"); return; }
      const name = decodeURIComponent(m[2]);
      if (req.method === "POST") {
        faults.uploads += 1;
        if (faults.failUploadAt && faults.uploads === faults.failUploadAt) { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal","message":"disk /mnt/storage-7 full"}'); return; }
        objects.set(name, { body: Buffer.concat(chunks), type: req.headers["content-type"] }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return;
      }
      if (req.method === "GET") {
        if (faults.failGets) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"message":"upstream storage-node-3 unavailable"}'); return; }
        const o = objects.get(name); if (!o) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"statusCode":"404","error":"not_found"}'); return; }
        res.writeHead(200, { "content-type": o.type }); res.end(o.body); return;
      }
      if (req.method === "DELETE") {
        if (faults.failDeletes) { res.writeHead(500); res.end("{}"); return; }
        objects.delete(name); res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); return;
      }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, objects, faults, close: () => server.close() })));
}

async function main() {
  const storage = await storageStandIn();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-failures-"));
  const now = new Date().toISOString();
  const users = { writer: ["catalogue.write"], writer2: ["catalogue.write"], reviewer: ["catalogue.review"], publisher: ["catalogue.publish"], pricer: ["catalogue.price.approve"], releaser: ["catalogue.public.publish"] };
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({ admin_users: Object.entries(users).map(([n, scopes]) => ({ id: crypto.randomUUID(), email: `${n}@fixture.test`, password_hash: hashPassword(`${n}-Pass-123!`), role: "ochiga_staff", status: "active", display_name: n, permission_scopes: scopes, created_at: now, updated_at: now })) }));
  const port = await freePort();
  const logs = [];
  const proc = spawn(process.execPath, ["lead-agents-server.js"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: dir, NODE_ENV: "test", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port), LEAD_AGENTS_STORE_PATH: path.join(dir, "store.json"),
    LEAD_AGENTS_STORE_DRIVER: "file", OFFICE_STORAGE_DRIVER: "supabase", SUPABASE_URL: storage.url, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: FULL_KEY, LEAD_AGENTS_SESSION_SECRET: crypto.randomBytes(24).toString("hex"),
    LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([{ client: "getoyi-catalogue", key_sha256: sha(CATALOGUE_KEY), scopes: ["catalogue.public.read"] }]),
    OPENAI_API_KEY: "sk-fixture-not-real", OPENAI_BASE_URL: "http://127.0.0.1:9/v1", LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000",
  } });
  proc.stdout.on("data", (d) => logs.push(String(d))); proc.stderr.on("data", (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 300; i += 1) { if (await fetch(`${base}/healthz`).catch(() => null)) break; await sleep(100); }
    const cookies = {};
    for (const n of Object.keys(users)) {
      const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${n}@fixture.test`, password: `${n}-Pass-123!` }) });
      cookies[n] = r.headers.getSetCookie().find((x) => /^lead_agents_admin=/.test(x)).split(";")[0];
    }
    const api = async (who, method, p, body) => { const r = await fetch(`${base}/api/lead-agents/admin/catalogue${p}`, { method, headers: { "content-type": "application/json", origin: base, cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null), text: "" }; };
    const upload = async (pid, buf) => { const r = await fetch(`${base}/api/lead-agents/admin/catalogue/products/${pid}/media?name=x.jpg`, { method: "POST", headers: { "content-type": "image/jpeg", origin: base, cookie: cookies.writer }, body: buf }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json, text }; };
    const img = (bg) => sharp({ create: { width: 900, height: 700, channels: 3, background: bg } }).jpeg().toBuffer();
    const cats = (await api("writer", "GET", "/categories")).json.categories;
    const made = await api("writer", "POST", "/products", { slug: "failure-probe", content: { category_id: cats[0].id, name: "Failure probe", variants: [{ sku: "FP-1", name: "x" }] } });
    const pid = made.json.product.id;
    const fileStore = () => JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8"));

    // F1: the 3rd object (2nd rendition) fails to store -> 502, earlier objects removed, no media row, no office_files left
    storage.faults.uploads = 0; storage.faults.failUploadAt = 3;
    const f1 = await upload(pid, await img("#1d4ed8"));
    const st1 = fileStore();
    check("F1", "storage fails mid-upload (3rd of 5 objects): 502; the two objects already stored are deleted; no media row and no office_files rows remain",
      f1.status === 502 && storage.objects.size === 0 && !((st1.catalogue || {}).media || []).length && !(st1.office_files || []).length, { status: f1.status, objects: storage.objects.size, media: ((st1.catalogue || {}).media || []).length, files: (st1.office_files || []).length });
    check("F1b", "the caller sees a generic error: no storage host, bucket, disk path or upstream message", !/storage-7|disk|mnt|office-media|Supabase|500/.test(f1.text) && f1.json && f1.json.error === "internal_server_error", f1.text);
    storage.faults.failUploadAt = 0;
    const ok = await upload(pid, await img("#1d4ed8"));
    check("F2", "after the fault clears, the same file uploads normally (5 objects, one media row): the failed attempt left no duplicate-blocking state", ok.status === 201 && storage.objects.size === 5 && fileStore().catalogue.media.length === 1, { status: ok.status, objects: storage.objects.size });

    // F3: downloads failing -> rendition request 502 without detail; recovers afterwards
    storage.faults.failGets = true;
    const g = await fetch(`${base}${ok.json.media.urls.thumb}`, { headers: { cookie: cookies.writer } });
    const gText = await g.text();
    storage.faults.failGets = false;
    const g2 = await fetch(`${base}${ok.json.media.urls.thumb}`, { headers: { cookie: cookies.writer } });
    check("F3", "storage read outage: renditions answer 5xx with no upstream detail; they serve again once storage recovers", g.status >= 500 && !/storage-node-3|upstream/.test(gText) && g2.status === 200 && g2.headers.get("content-type") === "image/webp", { g: g.status, gText: gText.slice(0, 120), g2: g2.status });

    // F4: deletes failing during removal of an unused image -> removal recorded (the image can never be used again); objects stay (orphans)
    const spare = await upload(pid, await img("#15803d"));
    const before = storage.objects.size;
    storage.faults.failDeletes = true;
    const rm = await api("writer", "POST", `/media/${spare.json.media.id}/remove`, {});
    storage.faults.failDeletes = false;
    const removed = fileStore().catalogue.media.find((m) => m.id === spare.json.media.id);
    const serveRemoved = await fetch(`${base}/api/lead-agents/admin/catalogue/media/${spare.json.media.id}/thumb`, { headers: { cookie: cookies.writer } });
    check("F4", "storage delete outage during removal: the removal is still recorded and the image no longer serves; its bytes remain as orphans (documented manual cleanup, audit names the media id)",
      rm.status === 200 && removed.status === "removed" && storage.objects.size === before && serveRemoved.status === 404, { rm: rm.status, status: removed && removed.status, objects: [before, storage.objects.size], serve: serveRemoved.status });

    // F5: a public image while storage reads fail -> 502/404 without detail (GetOyi shows its unavailable image handling)
    let d = (await api("writer", "GET", `/products/${pid}`)).json;
    await api("writer", "PATCH", `/products/${pid}`, { expected_row_version: d.product.row_version, content: { ...d.content, media: [{ media_id: ok.json.media.id, cover: true, alt: "Probe" }] } });
    d = (await api("writer", "GET", `/products/${pid}`)).json;
    const s1 = await api("writer2", "POST", `/products/${pid}/submit`, { expected_row_version: d.product.row_version });
    const a1 = await api("reviewer", "POST", `/products/${pid}/approve`, { expected_row_version: s1.json.product.row_version });
    await api("publisher", "POST", `/products/${pid}/publish`, { expected_row_version: a1.json.product.row_version });
    const v = (await api("writer", "GET", `/products/${pid}`)).json.variants[0];
    const pr = await api("writer", "POST", `/variants/${v.id}/price-changes`, { price_ngn_kobo: 100000, vat_treatment: "standard" });
    await api("pricer", "POST", `/price-changes/${pr.json.price_change.id}/approve`);
    await api("publisher", "POST", `/price-changes/${pr.json.price_change.id}/publish`);
    d = (await api("writer", "GET", `/products/${pid}`)).json;
    const rel = await api("releaser", "POST", `/products/${pid}/public/release`, { expected_row_version: d.product.row_version, expected_listing_row_version: 0 });
    const pub = await (await fetch(`${base}/api/public/catalogue/products/failure-probe`, { headers: { "x-api-key": CATALOGUE_KEY } })).json();
    const src = pub.product.cover.src;
    storage.faults.failGets = true;
    const pi = await fetch(`${base}/api/public/catalogue/${src}`, { headers: { "x-api-key": CATALOGUE_KEY } });
    const piText = await pi.text();
    storage.faults.failGets = false;
    const pi2 = await fetch(`${base}/api/public/catalogue/${src}`, { headers: { "x-api-key": CATALOGUE_KEY } });
    check("F5", "public image during a storage read outage: 5xx with no upstream detail and no caching header; serves again (public cache) after recovery; release and refresh status unaffected ('not_configured' here)",
      rel.status === 200 && pi.status >= 500 && !/storage-node-3/.test(piText) && !/public/.test(pi.headers.get("cache-control") || "") && pi2.status === 200 && /public, max-age=300/.test(pi2.headers.get("cache-control") || "") && rel.json.public.listing.refresh_status === "not_configured",
      { rel: rel.status, pi: pi.status, cache: pi.headers.get("cache-control"), pi2: pi2.status, refresh: rel.json && rel.json.public.listing.refresh_status });

    // F6: an image that decodes partially (valid header, corrupt body) is refused before anything is stored
    const good = await img("#a21caf");
    const corrupt = Buffer.concat([good.subarray(0, 600), crypto.randomBytes(good.length - 600)]);
    const objectsBefore = storage.objects.size;
    const f6 = await upload(pid, corrupt);
    check("F6", "a JPEG with a valid header and a corrupt body is refused (422) and nothing reaches storage", f6.status === 422 && storage.objects.size === objectsBefore, { status: f6.status, objects: [objectsBefore, storage.objects.size] });

    const all = logs.join("");
    check("F7", "the server log records the storage failures without the service key", /catalogue.request_failed/.test(all) && !all.includes(SERVICE_KEY) && !all.includes(CATALOGUE_KEY));
  } finally {
    proc.kill("SIGTERM"); storage.close();
  }
  console.log(JSON.stringify({ suite: "catalogue-media-failures", checks, failed: failures }));
  process.exit(failures ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
