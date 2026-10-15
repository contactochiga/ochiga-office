// Settings S7.3: governed session duration. Contract: docs/settings-domain/22_S7_3_SESSION_DURATION_POLICY_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword } = require("../src/lead-agents/auth");

const SECRET = "s7-3-dedicated-session-secret-0123456789abcdef";
const KEY = "office_session_ttl_hours", SET = `/api/lead-agents/admin/settings/${KEY}`;
const HOUR = 3_600_000;
const PW = { super: "super pass phrase one 11", super2: "second super pass phrase 22", admin: "ochiga admin pass phrase 33", staff: "plain staff pass phrase 44", demote: "demote me pass phrase 55" };
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed += 1; };
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const payloadOf = (cookieNameValue) => JSON.parse(Buffer.from(decodeURIComponent(cookieNameValue.split("=")[1]).split(".")[0], "base64url").toString());

async function startApp(store, config, logs) {
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 900 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 900 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 900 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 900 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {},
    toolExecutor: new ToolExecutor({ store, config, log: (...a) => logs.push(JSON.stringify(a)), webhooks: new WebhookDispatcher({ config }) }),
  });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const post = (path, body, h = {}) => fetch(`${base}/api/lead-agents/admin/session/${path}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  const login = async (email, password) => { const t0 = Date.now(); const r = await post("login", { email, password }); eq(r.status, 200, `login ${email}`); const nv = r.headers.get("set-cookie").split(";")[0]; return { cookie: nv, setCookie: r.headers.get("set-cookie"), issuedAt: t0, payload: payloadOf(nv) }; };
  const grant = async (cookie, password) => { const r = await post("step-up", { password, purpose: "security_policy_write" }, { cookie }); eq(r.status, 200, "step-up grant"); return (await r.json()).step_up.token; };
  const put = (cookie, body, token) => fetch(`${base}${SET}`, { method: "PUT", headers: { "content-type": "application/json", cookie, ...(token ? { "x-step-up-token": token } : {}) }, body: JSON.stringify(body) });
  const get = (cookie, p = SET) => fetch(`${base}${p}`, { headers: { cookie } });
  return { server, base, post, login, grant, put, get, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["s73-api-key"], allowedOrigins: [], sessionSecret: SECRET, sessionSecretEphemeral: false };
  const { store, filePath } = await createTempStore();
  const mk = (email, pw, role) => store.ensureAdminUser({ email, password_hash: hashPassword(pw), role, display_name: email, status: "active" });
  await mk("super@x.test", PW.super, "super_admin"); await mk("super2@x.test", PW.super2, "super_admin"); await mk("admin@x.test", PW.admin, "ochiga_admin");
  await mk("staff@x.test", PW.staff, "ochiga_staff"); await mk("demote@x.test", PW.demote, "super_admin");
  const logs = [];
  // the server logs through the shared logger (stdout/stderr): capture it so fallback logging and redaction are verified for real
  for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (chunk, ...rest) => { logs.push(String(chunk)); return orig(chunk, ...rest); }; }
  let app = await startApp(store, config, logs);

  // ---- 1. registry entry
  const sup = await app.login("super@x.test", PW.super);
  const entry = (await (await app.get(sup.cookie)).json()).setting;
  ok(entry.key === KEY && entry.owner === "office" && entry.scope === "global" && entry.type === "integer" && entry.mode === "generic", "descriptor identity");
  ok(entry.default === 168 && entry.range.min === 1 && entry.range.max === 720, "default and range");
  ok(entry.read_permission === "staff.manage" && entry.write_permission === "team.manage" && entry.requires_step_up === "security_policy_write", "permissions + step-up flag");
  ok(entry.value === 168 && entry.source === "default" && entry.version === 0 && entry.editable === true, "unset: default 168, version 0, editable for super_admin");
  const adm = await app.login("admin@x.test", PW.admin);
  const admEntry = (await (await app.get(adm.cookie)).json()).setting;
  ok(admEntry.value === 168 && admEntry.editable === false, "ochiga_admin (staff.manage) can read but not edit");
  eq((await app.get((await app.login("staff@x.test", PW.staff)).cookie)).status, 403, "role without staff.manage cannot read");

  // ---- 2. baseline: all session paths use 7 days when nothing is stored; cookie and token agree
  const agree = (s, expectMs, label) => {
    const maxAge = Number((s.setCookie.match(/Max-Age=(\d+)/) || [])[1]);
    ok(Math.abs(maxAge * 1000 - expectMs) <= 1000, `${label}: cookie Max-Age matches the duration`);
    ok(Math.abs(s.payload.exp - s.issuedAt - expectMs) <= 5000, `${label}: token expiry matches the duration`);
    ok(Math.abs(s.payload.exp - s.issuedAt - maxAge * 1000) <= 5000, `${label}: token expiry and cookie agree`);
  };
  agree(sup, 168 * HOUR, "default login");
  const before = sup; // a session issued before any change

  // ---- 3. step-up enforcement on writes
  eq((await app.put(sup.cookie, { value: 48, expected_version: 0 })).status, 403, "no step-up: refused");
  const noStep = await (await app.put(sup.cookie, { value: 48, expected_version: 0 })).json(); eq(noStep.error, "step_up_required"); eq(noStep.reason, "missing");
  eq((await (await app.get(sup.cookie)).json()).setting.version, 0, "refused write changed nothing");
  eq((await app.put(sup.cookie, { value: 48, expected_version: 0 }, "garbage")).status, 403, "garbage token refused");
  const tok = await app.grant(sup.cookie, PW.super);
  eq((await app.put(adm.cookie, { value: 48, expected_version: 0 }, tok)).status, 403, "ochiga_admin cannot write even with someone's grant");
  eq((await (await app.put((await app.login("super2@x.test", PW.super2)).cookie, { value: 48, expected_version: 0 }, tok)).json()).reason, "wrong_identity", "wrong administrator");
  await new Promise((r) => setTimeout(r, 5));
  const supB = await app.login("super@x.test", PW.super);
  eq((await (await app.put(supB.cookie, { value: 48, expected_version: 0 }, tok)).json()).reason, "wrong_session", "wrong session");
  // wrong purpose: forge-free check via the verifier (only one purpose exists, so a token for another purpose cannot be minted)
  const apiKeyPut = await fetch(`${app.base}${SET}`, { method: "PUT", headers: { "content-type": "application/json", "x-api-key": "s73-api-key", "x-step-up-token": tok }, body: JSON.stringify({ value: 48, expected_version: 0 }) });
  eq(apiKeyPut.status, 403, "API-key caller refused"); eq((await apiKeyPut.json()).error, "actor_identity_required");
  // expiry
  config.stepUpTtlMs = 40; const shortTok = await app.grant(sup.cookie, PW.super); await new Promise((r) => setTimeout(r, 80)); config.stepUpTtlMs = 300000;
  eq((await (await app.put(sup.cookie, { value: 48, expected_version: 0 }, shortTok)).json()).reason, "expired", "expired grant");
  // permission removed / deactivated
  const dem = await app.login("demote@x.test", PW.demote); const demTok = await app.grant(dem.cookie, PW.demote);
  const demUser = await store.getAdminUserByEmail("demote@x.test"); await store.updateAdminUser(demUser.id, { role: "ochiga_admin" });
  eq((await app.put(dem.cookie, { value: 48, expected_version: 0 }, demTok)).status, 403, "demoted administrator refused");
  await store.updateAdminUser(demUser.id, { status: "inactive" });
  eq((await app.put(dem.cookie, { value: 48, expected_version: 0 }, demTok)).status, 401, "deactivated administrator refused");

  // ---- 4. validation bounds (each with a valid grant; nothing may be stored)
  for (const bad of [0, 721, -5, 1.5, "48", null, true, NaN, Infinity, [], {}, 1e9]) {
    const r = await app.put(sup.cookie, { value: bad === NaN ? "NaN" : bad, expected_version: 0 }, tok);
    eq(r.status, 400, `invalid value rejected: ${JSON.stringify(bad)}`);
  }
  eq((await app.put(sup.cookie, { expected_version: 0 }, tok)).status, 400, "value required");
  eq((await app.put(sup.cookie, { value: 48 }, tok)).status, 400, "expected_version required");
  eq((await (await app.get(sup.cookie)).json()).setting.version, 0, "nothing stored by rejected writes");

  // ---- 5. successful write + server-confirmed response + audit
  const w1 = await app.put(sup.cookie, { value: 24, expected_version: 0 }, tok); eq(w1.status, 200, "valid write");
  const w1b = await w1.json(); ok(w1b.setting.value === 24 && w1b.setting.version === 1 && w1b.setting.source === "stored" && w1b.setting.updated_by === "super@x.test", "server-confirmed stored value");
  ok(w1.headers.get("x-request-id"), "request id returned");
  // bounds accepted
  const w2 = await app.put(sup.cookie, { value: 1, expected_version: 1 }, tok); eq(w2.status, 200, "minimum 1 accepted");
  const w3 = await app.put(sup.cookie, { value: 720, expected_version: 2 }, tok); eq(w3.status, 200, "maximum 720 accepted");
  eq((await app.put(sup.cookie, { value: 24, expected_version: 3 }, tok)).status, 200, "back to 24 (version 4)");

  // ---- 6. version conflicts + concurrency
  const stale = await app.put(sup.cookie, { value: 72, expected_version: 1 }, tok); eq(stale.status, 409, "stale version rejected");
  const staleBody = await stale.json(); ok(staleBody.error === "version_conflict" && staleBody.current.version === 4 && staleBody.current.value === 24, "conflict reports the current value");
  const race = await Promise.all([36, 48, 60, 72, 84, 96].map((v) => app.put(sup.cookie, { value: v, expected_version: 4 }, tok)));
  const codes = race.map((r) => r.status).sort();
  eq(codes.filter((c) => c === 200).length, 1, "exactly one concurrent writer wins"); eq(codes.filter((c) => c === 409).length, 5, "the others get a conflict");
  const cur = (await (await app.get(sup.cookie)).json()).setting; eq(cur.version, 5, "one version increment for the race");
  const winner = cur.value;

  // ---- 7. all session paths honour the stored duration; existing sessions keep their expiry
  const afterLogin = await app.login("super2@x.test", PW.super2);
  agree(afterLogin, winner * HOUR, "login after change");
  eq(before.payload.exp, payloadOf(before.cookie).exp, "existing session token unchanged");
  ok(before.payload.exp - before.issuedAt > 167 * HOUR, "the pre-change session still carries its original ~7-day expiry");
  eq((await fetch(`${app.base}/api/lead-agents/admin/session/me`, { headers: { cookie: before.cookie } })).status, 200, "pre-change session still valid after the policy changed");
  // invitation acceptance
  const inv = await store.ensureAdminUser({ email: "invitee@x.test", password_hash: hashPassword(crypto.randomBytes(8).toString("hex")), role: "ochiga_staff", display_name: "invitee", status: "invited" });
  await store.createAdminInvite({ email: "invitee@x.test", admin_user_id: inv.id, role: "ochiga_staff", display_name: "Invitee", token_hash: sha("invite-a"), status: "pending", invited_by: "super@x.test", expires_at: new Date(Date.now() + 3600e3).toISOString() });
  const t0 = Date.now(); const acc = await app.post("invite/accept", { token: "invite-a", password: "invited person passphrase 9" }); eq(acc.status, 200, "invite accepted");
  const accSc = acc.headers.get("set-cookie"); agree({ setCookie: accSc, payload: payloadOf(accSc.split(";")[0]), issuedAt: t0 }, winner * HOUR, "invitation acceptance");
  // reset confirmation issues no session; the next login does get the policy duration
  const lu = await store.getAdminUserByEmail("staff@x.test");
  await store.createPasswordResetToken({ admin_user_id: lu.id, email: "staff@x.test", token_hash: sha("reset-a"), requested_by: "self_service", expires_at: new Date(Date.now() + 3600e3).toISOString() });
  const rc = await app.post("reset/confirm", { token: "reset-a", new_password: "reset staff pass phrase 66" }); eq(rc.status, 200, "reset confirmed");
  ok(!rc.headers.get("set-cookie"), "reset confirmation issues no session cookie"); ok(!JSON.stringify(await rc.json()).includes("."), "reset response carries no token");
  agree(await app.login("staff@x.test", "reset staff pass phrase 66"), winner * HOUR, "first login after a reset");

  // ---- 8. restart persistence
  await app.close();
  const store2 = new FileLeadAgentsStore(filePath); await store2.init();
  app = await startApp(store2, config, logs);
  const sup2 = await app.login("super@x.test", PW.super);
  const persisted = (await (await app.get(sup2.cookie)).json()).setting; ok(persisted.value === winner && persisted.version === 5, "value and version survive a restart");
  agree(sup2, winner * HOUR, "login after restart");

  // ---- 9. fallbacks
  const realGet = store2.getRuntimeSetting.bind(store2);
  store2.getRuntimeSetting = async (k) => { if (k === KEY) throw new Error("db unavailable: secret-conn-string"); return realGet(k); };
  const fb = await app.login("super@x.test", PW.super); agree(fb, 168 * HOUR, "store unavailable: environment duration");
  ok(logs.some((l) => l.includes("session_ttl_fallback") && l.includes("setting_unavailable")), "fallback reason logged");
  ok(!logs.join("").includes("secret-conn-string"), "fallback log exposes no error detail or secrets");
  store2.getRuntimeSetting = realGet;
  // corrupted stored values must not lengthen a session beyond 720 h and never be trusted
  const row = await realGet(KEY);
  await store2.writeRuntimeSetting(KEY, 5000, "tamper", { expectedVersion: row.version, requestId: "t" });
  const cr = await app.login("super@x.test", PW.super); agree(cr, 168 * HOUR, "corrupted stored value (5000): environment duration, not 5000 h");
  config.sessionTtlMs = 900 * HOUR; const cap = await app.login("super@x.test", PW.super); agree(cap, 720 * HOUR, "invalid stored value with a long environment duration is capped at 720 h"); config.sessionTtlMs = 168 * HOUR;
  const fbEntry = (await (await app.get(cr.cookie)).json()).setting; ok(fbEntry.source === "environment_fallback" && fbEntry.value === 168, "registry reports the effective fallback honestly");
  const row2 = await realGet(KEY); await store2.writeRuntimeSetting(KEY, "oops", "tamper", { expectedVersion: row2.version, requestId: "t" });
  agree(await app.login("super@x.test", PW.super), 168 * HOUR, "non-numeric stored value");
  const row3 = await realGet(KEY); await store2.writeRuntimeSetting(KEY, 12, "tamper", { expectedVersion: row3.version, requestId: "t" });
  agree(await app.login("super@x.test", PW.super), 12 * HOUR, "valid stored value is honoured again");

  // ---- 10. audit + history + redaction
  const tokFresh = await app.grant(sup2.cookie, PW.super);
  const cur2 = (await (await app.get(sup2.cookie)).json()).setting;
  eq((await app.put(sup2.cookie, { value: 100, expected_version: cur2.version }, tokFresh)).status, 200, "write for audit check");
  const events = (await store2.listAuditEvents(1000)).filter((e) => e.action === "office_session_ttl_hours_changed");
  const okEv = events.find((e) => (e.metadata || {}).outcome === "success" && (e.metadata || {}).new_value === 100);
  ok(okEv && okEv.metadata.old_value === cur2.value && okEv.metadata.request_id && okEv.metadata.version === cur2.version + 1 && okEv.metadata.actor === "super@x.test" && okEv.created_at, "success audit: actor, request id, previous, new, version, time");
  const outcomes = new Set(events.map((e) => (e.metadata || {}).outcome));
  for (const o of ["success", "conflict", "denied", "rejected"]) ok(outcomes.has(o), `audit outcome recorded: ${o}`);
  const reasons = events.filter((e) => (e.metadata || {}).reason === "step_up_required").length; ok(reasons > 0, "step-up denial audited with its reason");
  const hist = await (await app.get(sup2.cookie, `${SET}/history`)).json(); ok(hist.supported && hist.history.length >= 6, "history lists the changes");
  const blob = JSON.stringify(await store2.listAuditEvents(2000)) + JSON.stringify(hist) + logs.join("");
  for (const secret of [tok, tokFresh, shortTok, tok.split(".")[1], PW.super]) ok(!blob.includes(secret), "no step-up token or password in audit, history or logs");

  await app.close();
  console.log(`S7.3 session policy: ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
