"use strict";
// A09 - unauthenticated sweep of every route found in the server source (routes.json, generated once from the route table of the SUT's server.js; no runtime
// dependency on the SUT sources). In the production authentication mode, and in the fail-open-prone modes (unset mode, typo, "off"), an anonymous caller must never
// receive data (2xx) or a server fault (5xx) from a protected route. Public routes (static pages, widget, sign-in surface, webhooks, bridge) are exempted explicitly.
const fs = require("fs");
const path = require("path");
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a09-anonymous-sweep");

const routes = JSON.parse(fs.readFileSync(path.join(__dirname, "routes.json"), "utf8"));
const PUBLIC_EXACT = new Set(["/", "/healthz", "/office", "/office/", "/office.js", "/dashboard", "/dashboard/", "/dashboard.js", "/widget", "/widget/", "/widget.js", "/plan-studio", "/plan-studio/", "/plan-studio/app.js", "/digital-twin", "/digital-twin/", "/digital-twin/app.js", "/api/digital-twin/scene", "/webhooks/whatsapp", "/assets/ochiga-logo.png"]);
const PUBLIC_PREFIX = ["/office/", "/digital-twin/", "/api/lead-agents/public/", "/api/lead-agents/documents/shared/"];
const PUBLIC_SESSION = new Set(["login", "mfa/verify", "mfa/webauthn/auth/options", "mfa/enroll/email-code", "mfa/enroll/email-verify", "mfa/enroll/forced/begin", "mfa/enroll/forced/confirm", "logout", "me", "reset/request", "invite/accept", "reset/confirm"].map((x) => `/api/lead-agents/admin/session/${x}`));
const BRIDGE = new Set(["/api/lead-agents/admin/communications/whatsapp/send", "/api/lead-agents/admin/communications/whatsapp/templates", "/api/lead-agents/admin/recipients/resolve", "/api/lead-agents/admin/communications/activity", "/api/lead-agents/admin/communications/create-task", "/api/lead-agents/admin/communications/handoff-request", "/api/lead-agents/admin/knowledge-pack"]);
const isPublic = (p) => PUBLIC_EXACT.has(p) || PUBLIC_SESSION.has(p) || BRIDGE.has(p) || PUBLIC_PREFIX.some((x) => p.startsWith(x));
const HUMAN = routes.filter((p) => /\/admin\/(users|session\/(password|photo|profile|step-up|revoke-all|mfa))|\/admin\/settings|\/admin\/audit|\/admin\/permissions/.test(p) && !PUBLIC_SESSION.has(p) && !BRIDGE.has(p));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
// a body that satisfies the early validation of as many handlers as possible, so an unguarded handler would actually proceed
const KITCHEN = { email: "x@example.test", password: "Zzz-kitchen-sink-123", phone: "+2340000000", photo_data_url: "data:image/png;base64,iVBORw0KGgo=", current_password: "a", new_password: "Zzz-kitchen-sink-456", display_name: "x", role: "viewer", status: "active", value: 1, expected_version: 0, enabled: true, purpose: "security_policy_write", token: "t", title: "t", name: "n", message: "m", reason: "reason text", confirm: true, confirm_email: "x@example.test", credential_id: "00000000-0000-4000-8000-000000000001", code: "123456" };

async function sweep(s, tag, srv, list, opts = {}) {
  const c = new L.Client(srv);
  const bad = []; let count = 0;
  for (const p of list) {
    for (const m of METHODS) {
      const r = await c.call(m, p, { ...(m === "GET" || m === "DELETE" ? {} : { json: KITCHEN }), ...opts });
      count++;
      const status = r.status;
      const cleanUnavailable = status === 503 && r.text.length < 220 && !/Error|Cannot|\bat /.test(r.text);
      if (status === 0 || (status >= 500 && !cleanUnavailable) || (status >= 200 && status < 300) || status === 301 || status === 302) bad.push(`${m} ${p.replace("00000000-0000-4000-8000-000000000001", ":id")} -> ${status} ${r.text.slice(0, 80)}`);
    }
  }
  return { bad, count };
}

suite.run(async (s) => {
  s.check("A09-000", "the route table was loaded (positive control for the sweep)", routes.length > 150, routes.length);
  const protectedRoutes = routes.filter((p) => !isPublic(p));
  const base = await L.startServer(s);
  await s.section("production auth mode (required_api_key): anonymous", async () => {
    const r = await sweep(s, "base", base, protectedRoutes);
    s.check("A09-001", `anonymous callers get 401/403/404/405 from every protected route (${protectedRoutes.length} routes x 5 methods = ${r.count} requests); none returns 2xx or 5xx`, r.bad.length === 0, r.bad.slice(0, 10));
    const wrong = await sweep(s, "wrongkey", base, protectedRoutes.slice(0, 60), { apiKey: "wrong-key-value" });
    s.check("A09-002", "a wrong API key gets the same refusal on a sample of routes", wrong.bad.length === 0, wrong.bad.slice(0, 5));
    const edgeWrong = await sweep(s, "wrongedge", base, protectedRoutes.slice(0, 60), { edge: "wrong-edge-token" });
    s.check("A09-003", "a wrong edge token gets the same refusal on a sample of routes", edgeWrong.bad.length === 0, edgeWrong.bad.slice(0, 5));
    const staffOnly = new L.Client(base);
    const admin = await L.adminSession(staffOnly, base);
    const staff = await L.makeUser(staffOnly, admin, { role: "ochiga_staff" });
    const humanStaff = await sweep(s, "staff", base, HUMAN.filter((p) => !/session\/(password|photo|profile|revoke-all|mfa|step-up)|\/admin\/permissions$/.test(p)), { cookie: staff.cookie });
    const humanBad = humanStaff.bad.filter((x) => !/^GET .*\/admin\/users\/qr/.test(x) && !/whatsapp-autonomy/.test(x));
    s.check("A09-004", "a low-privilege staff session cannot read or write account, settings or audit routes (no 2xx anywhere on them)", humanBad.length === 0, humanBad.slice(0, 8));
  });

  await s.section("fail-open-prone configurations: anonymous reach of human-account routes", async () => {
    const variants = {
      "mode unset (code default)": { LEAD_AGENTS_AUTH_MODE: undefined },
      "mode typo REQUIRED_API_KEY": { LEAD_AGENTS_AUTH_MODE: "REQUIRED_API_KEY" },
      "mode typo required": { LEAD_AGENTS_AUTH_MODE: "required" },
      "mode off": { LEAD_AGENTS_AUTH_MODE: "off" },
      "optional_api_key without keys": { LEAD_AGENTS_AUTH_MODE: "optional_api_key", LEAD_AGENTS_API_KEYS: "" },
    };
    for (const [name, env] of Object.entries(variants)) {
      const v = await L.startServer(s, { env });
      const r = await sweep(s, name, v, HUMAN);
      s.check(`A09-01-${Object.keys(variants).indexOf(name)}`, `${name}: anonymous callers get no 2xx/5xx from any account, session, step-up, MFA, settings or audit route (${r.count} requests)`, r.bad.length === 0, r.bad.slice(0, 6));
      await v.cleanup();
    }
  });

  await s.section("fail-open-prone configurations: full anonymous sweep", async () => {
    const variants = { "mode unset (code default)": { LEAD_AGENTS_AUTH_MODE: undefined }, "mode typo REQUIRED_API_KEY": { LEAD_AGENTS_AUTH_MODE: "REQUIRED_API_KEY" } };
    let i = 0;
    for (const [name, env] of Object.entries(variants)) {
      const v = await L.startServer(s, { env });
      const r = await sweep(s, name, v, protectedRoutes);
      s.check(`A09-02-${i++}`, `${name}: anonymous callers get no 2xx/5xx from any protected route (${r.count} requests)`, r.bad.length === 0, r.bad.slice(0, 10));
      await v.cleanup();
    }
  });

  await s.section("public surface exposure", async () => {
    const c = new L.Client(base);
    const hz = await c.get("/healthz");
    s.check("A09-030", "/healthz does not expose business statistics (store counts) to anonymous callers", !hz.body || !hz.body.stats, hz.body && Object.keys(hz.body.stats || {}));
    s.check("A09-031", "/healthz does not expose configured session cookie name, auth mode, e-mail provider details to anonymous callers", !(hz.body && hz.body.tier1), hz.body && hz.body.tier1 && Object.keys(hz.body.tier1));
    const pub = await c.get("/api/lead-agents/public/session");
    s.check("A09-032", "the public widget session endpoint does not set an administrator session cookie", !pub.cookie && !pub.setCookies.some((x) => x.startsWith(L.COOKIE_NAME + "=")), pub.setCookies);
  });

  s.check("A09-999", "base server alive at the end", base.alive());
});
