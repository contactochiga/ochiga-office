// Office API routing on Vercel: production keeps the former rewrite targets; previews never reach production.
import assert from "node:assert/strict";
import fs from "node:fs";
import route, { apiOriginFor, isApiPath, PRODUCTION_API_ORIGIN } from "../config/office-api-routing.mjs";
let n = 0; const ok = (c, name) => { assert.ok(c, name); n++; console.log("PASS " + name); };
const req = (p) => new Request("https://ochiga-office-abc.vercel.app" + p, { method: "POST" });
const target = (r) => r && r.headers.get("x-middleware-rewrite");

// Production: identical targets to the removed vercel.json rewrites, query preserved.
const prod = { VERCEL_ENV: "production" };
for (const p of ["/api/lead-agents/admin/session/me?x=1", "/api/digital-twin/a/b", "/api/plan-studio/s", "/webhooks/whatsapp", "/healthz"])
  ok(target(route(req(p), prod)) === PRODUCTION_API_ORIGIN + p, "production proxies " + p.split("?")[0]);
ok(target(route(req("/api/lead-agents/x"), { VERCEL_ENV: "production", OFFICE_PREVIEW_API_ORIGIN: "https://staging.example" })) === PRODUCTION_API_ORIGIN + "/api/lead-agents/x", "production ignores the preview origin variable");

// Previews without a staging API: fail closed, never production.
for (const env of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, {}, { VERCEL_ENV: "Production" }]) {
  const r = route(req("/api/lead-agents/admin/session/login"), env);
  ok(r.status === 503 && !target(r) && r.headers.get("x-office-api-route") === "refused", "fail closed for VERCEL_ENV=" + String(env.VERCEL_ENV));
}
// Previews with a staging API: only a safe https non-production origin.
ok(target(route(req("/webhooks/w?y=2"), { VERCEL_ENV: "preview", OFFICE_PREVIEW_API_ORIGIN: "https://office-staging.example.onrender.com" })) === "https://office-staging.example.onrender.com/webhooks/w?y=2", "preview proxies to the configured staging origin");
for (const bad of ["http://staging.example", "https://ochiga-lead-agents.onrender.com", "https://OFFICE.ochiga.com.ng", "https://u:p@staging.example", "https://staging.example/api", "not a url", "https://staging.example?x=1"])
  ok(apiOriginFor({ VERCEL_ENV: "preview", OFFICE_PREVIEW_API_ORIGIN: bad }) === null, "unsafe preview origin refused: " + bad);
// Static Office files are untouched.
for (const p of ["/", "/office/", "/office/office.js", "/apiary", "/api/other", "/healthzz"]) ok(route(req(p), prod) === undefined && !isApiPath(p), "not an API path: " + p);
// No production API target remains in vercel.json; middleware matcher covers exactly the five families.
const vercel = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url)));
ok(!JSON.stringify(vercel).includes("onrender.com") && !vercel.rewrites.some((r) => /^https?:/.test(r.destination)), "vercel.json has no external API rewrite left");
const mw = fs.readFileSync(new URL("../middleware.js", import.meta.url), "utf8");
for (const m of ["/api/lead-agents/:path*", "/api/digital-twin/:path*", "/api/plan-studio/:path*", "/webhooks/:path*", "/healthz"]) ok(mw.includes(`"${m}"`), "middleware matcher includes " + m);
console.log(JSON.stringify({ suite: "office-api-routing", passed: n, failed: 0 }));
