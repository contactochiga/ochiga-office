// Settings S7.5.7: governed MFA enforcement, grace, preflight, administrator MFA reset and break-glass.
// Contract: docs/settings-domain/34_S7_5_7_MFA_ENFORCEMENT_AND_RECOVERY_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer, runBreakGlass } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword, createAdminSessionToken } = require("../src/lead-agents/auth");
const m = require("../src/lead-agents/mfa-crypto");
const E = require("../src/lead-agents/mfa-enforcement");

const logs = [];
for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (c, ...r) => { logs.push(String(c)); return orig(c, ...r); }; }
// every e-mail the server tries to send is captured (no network)
const mails = []; const realFetch = global.fetch;
global.fetch = async (url, init) => { if (String(url).startsWith("https://api.resend.com")) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "mail_1" }), { status: 200 }); } return realFetch(url, init); };
let passed = 0;
const ok = (c, msg) => { assert.ok(c, msg); passed += 1; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); passed += 1; };
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });
const SESSION = "s7-5-7-session-secret-0123456789abcdef-abcdefghij", K1 = crypto.randomBytes(32).toString("base64");
const A = "/api/lead-agents/admin"; const KEY = "office_mfa_enforcement"; const DAY = 86_400_000;
const responses = [];

async function main() {
  // ===== 1. unit: levels, privileged detection, requirement and grace boundaries
  ok(E.ENFORCEMENT_LEVELS.join() === "off,optional,privileged,all", "four levels, in order");
  for (const v of E.ENFORCEMENT_LEVELS) ok(E.validateEnforcementLevel(v).ok, `level ${v} is valid`);
  for (const bad of ["ALL", "on", "", null, 1, undefined, "privileged ", ["all"]]) ok(!E.validateEnforcementLevel(bad).ok, `invalid level refused: ${JSON.stringify(bad)}`);
  ok(E.isPrivilegedAccount({ role: "super_admin", permission_scopes: [] }) && E.isPrivilegedAccount({ role: "ochiga_admin", permission_scopes: [] }), "super_admin and ochiga_admin hold privileged permissions");
  ok(!E.isPrivilegedAccount({ role: "ochiga_staff", permission_scopes: [] }) && !E.isPrivilegedAccount({ role: "resident", permission_scopes: [] }) && !E.isPrivilegedAccount({ role: "guest", permission_scopes: ["crm.read"] }), "ordinary roles are not privileged");
  for (const scope of E.PRIVILEGED_PERMISSIONS) ok(E.isPrivilegedAccount({ role: "ochiga_staff", permission_scopes: [scope] }), `a role label alone does not decide: the ${scope} scope makes an account privileged`);
  ok(!E.isPrivilegedAccount(null) && !E.isPrivilegedAccount({ role: "nonexistent_role", permission_scopes: [] }), "unknown accounts and roles are not privileged");
  const T0 = Date.UTC(2026, 9, 1); const pol = (level, since = new Date(T0).toISOString()) => ({ level, active: true, effectiveSince: since });
  const priv = { role: "super_admin", permission_scopes: [], created_at: new Date(T0 - 400 * DAY).toISOString() }; const plain = { role: "ochiga_staff", permission_scopes: [], created_at: new Date(T0 - 400 * DAY).toISOString() };
  for (const level of ["off", "optional"]) ok(!E.accountRequirement({ policy: pol(level), user: priv, now: T0 }).required, `${level}: nobody is required`);
  ok(E.accountRequirement({ policy: pol("privileged"), user: priv, now: T0 }).required && !E.accountRequirement({ policy: pol("privileged"), user: plain, now: T0 }).required, "privileged: only privileged accounts");
  ok(E.accountRequirement({ policy: pol("all"), user: plain, now: T0 }).required, "all: everyone");
  ok(!E.accountRequirement({ policy: { ...pol("all"), active: false }, user: plain, now: T0 }).required, "an inactive policy (MFA machinery off) requires nothing");
  const G = E.GRACE_MS; eq(G, 14 * DAY, "grace is 14 days");
  const at = (now) => E.accountRequirement({ policy: pol("all"), user: priv, now });
  ok(at(T0).required && !at(T0).expired && at(T0 + G - 1).expired === false, "inside grace: required, not expired (one millisecond before the deadline)");
  ok(at(T0 + G).expired === true && at(T0 + G + 1).expired === true, "the deadline instant itself is expired");
  eq(at(T0).deadline, T0 + G, "deadline = level start + 14 days");
  const newcomer = { ...plain, created_at: new Date(T0 + 3 * DAY).toISOString() }; eq(E.accountRequirement({ policy: pol("all"), user: newcomer, now: T0 + 3 * DAY }).deadline, T0 + 17 * DAY, "an account created after the level took effect gets its own 14 days");
  const own = { ...plain, mfa_required_after: new Date(T0 - DAY).toISOString() }; ok(E.accountRequirement({ policy: pol("off"), user: own, now: T0 }).expired && E.accountRequirement({ policy: pol("off"), user: own, now: T0 }).source === "account", "a per-account requirement (reset / break-glass) applies even at level off and is already due");
  const both = { ...priv, mfa_required_after: new Date(T0 + DAY).toISOString() }; eq(E.accountRequirement({ policy: pol("all"), user: both, now: T0 }).deadline, T0 + DAY, "the earliest deadline wins");
  ok(!E.accountRequirement({ policy: pol("all"), user: { ...plain, mfa_required_after: "not-a-date" }, now: T0 }).expired, "a malformed per-account value is ignored, not trusted");
  const n = E.enrollmentNotice(at(T0), T0); ok(n.required && n.days_left === 14 && n.grace_ends_at === new Date(T0 + G).toISOString() && n.expired === false, "the notice reports the end of grace and the days left");

  // ===== 2. server fixtures
  const { store } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["s757-api-key-0123456789"], edgeAgentTokens: ["s757-edge-token-0123456789"], allowedOrigins: [], sessionSecret: SESSION, sessionSecretEphemeral: false, mfaMode: "on", mfaKey: K1, mfaKeyId: "k1", mfaKeysPrevious: "", officeEmailProvider: "", resendApiKey: "", webauthnRpId: "", webauthnOrigins: [], mfaFleetAttested: "", mfaRecoveryApproved: false, allowApiKeyPasswordLogin: false, stepUpTtlMs: 5 * 60_000 };
  let n2 = 0; const mkUser = async (label, role = "super_admin", extra = {}) => { n2 += 1; return store.ensureAdminUser({ email: `${label}${n2}@x.test`, password_hash: hashPassword(`${label}${n2} account passphrase number 7`), role, display_name: label, status: "active", ...extra }); };
  const pw = (u) => `${u.email.split("@")[0]} account passphrase number 7`;
  async function startApp(cfg) {
    const rl = (x) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: x });
    const server = buildServer({ config: cfg, store, rateLimiter: rl(9000), publicRateLimiter: rl(9000), officeRateLimiter: rl(9000), loginRateLimiter: rl(2000), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config: cfg, log: () => {}, webhooks: new WebhookDispatcher({ config: cfg }) }) });
    const port = await listen(server); const base0 = `http://127.0.0.1:${port}`;
    const call = async (method, p, { cookie, body, token, apiKey, edge } = {}) => { const r = await fetch(`${base0}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-step-up-token": token } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}), ...(edge ? { "x-edge-token": edge } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); responses.push(text); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
    return { call, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  }
  const app = await startApp(config);
  const login = (u, password) => app.call("POST", `${A}/session/login`, { body: { email: u.email, password: password ?? pw(u) } });
  const stepUpCall = (cookie, u, purpose, mfa) => app.call("POST", `${A}/session/step-up`, { cookie, body: { password: pw(u), purpose, ...(mfa ? { mfa } : {}) } });
  const mfaCall = (p, o) => app.call("POST", `${A}/session/mfa${p}`, o);
  const code = (secret, off = 0) => m.hotp(secret, m.totpCounter(Date.now()) + off);
  const resetStep = async (u) => { for (const c of store.state.admin_mfa_credentials) if (c.admin_user_id === u.id && c.type === "totp") c.totp_last_step = 0; await store.clearMfaFailures(u.id); };
  async function enrollTotp(u) {
    const cookie = (await login(u)).cookie; const g = (await stepUpCall(cookie, u, "mfa_management")).json.step_up.token;
    const b = await mfaCall("/enroll/totp/begin", { cookie, token: g, body: {} }); const secret = m.base32Decode(b.json.secret_base32);
    const c = await mfaCall("/enroll/totp/confirm", { cookie, token: g, body: { credential_id: b.json.credential_id, code: code(secret) } }); eq(c.status, 200, "enrolled");
    return { secret, cookie: c.cookie, codes: c.json.recovery_codes };
  }
  async function signInTotp(u, secret) { await resetStep(u); const l = await login(u); eq(l.json.mfa_required, true, "challenge issued"); const v = await mfaCall("/verify", { body: { challenge_token: l.json.challenge_token, method: "totp", code: code(secret) } }); eq(v.status, 200, "TOTP sign-in"); return v.cookie; }
  const cookieName = (await login(await mkUser("probe"))).cookie.split("=")[0];
  const staleSession = async (u, ageMs) => `${cookieName}=${encodeURIComponent(createAdminSessionToken(await store.getAdminUserById(u.id), config, 3_600_000, { mfaAt: Date.now() - ageMs }))}`;
  const audits = async (action) => (await store.listAuditEvents(99999)).filter((e) => e.action === action);
  const setLevel = async (level) => { E.invalidateEnforcementCache(config); const row = await store.getRuntimeSetting(KEY); await store.writeRuntimeSetting(KEY, level, "test", { expectedVersion: row ? row.version : 0 }); E.invalidateEnforcementCache(config); };
  const backdate = (days) => { store.state.runtime_settings[KEY].updated_at = new Date(Date.now() - days * DAY).toISOString(); E.invalidateEnforcementCache(config); };
  const setCreated = (u, days) => { const row = store.state.admin_users.find((x) => x.id === u.id); row.created_at = new Date(Date.now() - days * DAY).toISOString(); };

  // ===== 3. the registry setting: descriptor, default, permissions
  const boss = await mkUser("boss"); const bossE = await enrollTotp(boss); const second = await mkUser("second"); const secondE = await enrollTotp(second);
  const staffRead = await mkUser("staffread", "ochiga_staff", { permission_scopes: ["staff.manage"] }); const staffNone = await mkUser("staffnone", "ochiga_staff");
  let bossCookie = await signInTotp(boss, bossE.secret);
  const get = (cookie) => app.call("GET", `${A}/settings/${KEY}`, { cookie });
  let g = await get(bossCookie); ok(g.status === 200 && g.json.setting.value === "off" && g.json.setting.default === "off" && g.json.setting.version === 0 && g.json.setting.type === "enum" && g.json.setting.choices.join() === "off,optional,privileged,all", "default off, enum of four levels, version 0");
  ok(g.json.setting.read_permission === "staff.manage" && g.json.setting.write_permission === "team.manage" && g.json.setting.requires_step_up === "security_policy_write" && g.json.setting.requires_confirmation === true, "read staff.manage, write team.manage, security_policy_write step-up, confirmation required");
  eq((await get(await signInPlain(staffRead))).status, 200, "an account with staff.manage can read it");
  async function signInPlain(u) { return (await login(u)).cookie; }
  eq((await get(await signInPlain(staffNone))).status, 403, "an account without staff.manage cannot read it");
  eq((await app.call("GET", `${A}/settings/${KEY}`, { apiKey: config.apiKeys[0] })).status, 200, "(existing behaviour) an API key can read settings");
  ok((await app.call("GET", `${A}/settings`, { cookie: bossCookie })).json.settings.some((s) => s.key === KEY), "listed in the registry");

  // ===== 4. governed write
  const put = async (cookie, value, o = {}) => {
    const token = o.token === undefined ? (await stepUpCall(cookie, boss, o.purpose || "security_policy_write", o.mfa)).json?.step_up?.token : o.token;
    const cur = (await get(cookie)).json?.setting; return app.call("PUT", `${A}/settings/${KEY}`, { cookie, token, body: { value, expected_version: o.version ?? cur?.version ?? 0, ...(o.confirm === false ? {} : { confirm: true }), ...(o.extra || {}) } });
  };
  eq((await put(bossCookie, "optional", { token: null })).json.error, "step_up_required", "no grant: refused");
  eq((await put(bossCookie, "optional", { purpose: "mfa_management" })).json.reason, "wrong_purpose", "a grant for another purpose: refused");
  eq((await put(bossCookie, "optional", { confirm: false })).json.error, "confirmation_required", "no confirmation: refused");
  eq((await put(bossCookie, "optional", { version: -1 })).json.error, "expected_version_required", "no expected version: refused");
  eq((await put(bossCookie, "sometimes")).json.error, "invalid_value", "an unknown level: refused");
  for (const [who, creds] of [["API key", { apiKey: config.apiKeys[0] }], ["edge token", { edge: config.edgeAgentTokens[0] }]]) { const r = await app.call("PUT", `${A}/settings/${KEY}`, { body: { value: "optional", expected_version: 0, confirm: true }, ...creds }); ok([401, 403].includes(r.status), `${who} cannot change MFA enforcement (${r.status})`); }
  const adminOnly = await mkUser("ochigaadmin", "ochiga_admin"); const aE = await enrollTotp(adminOnly); const aCookie = await signInTotp(adminOnly, aE.secret); const aTok = await stepUpCall(aCookie, adminOnly, "security_policy_write"); ok(aTok.status === 403, "an ochiga_admin cannot even obtain a security_policy_write grant");
  const stale = await staleSession(boss, 10 * 60_000); eq((await stepUpCall(stale, boss, "security_policy_write")).status, 401, "(S7.5.6) an enrolled actor needs a fresh factor");
  { const short = await startApp({ ...config, stepUpTtlMs: 40 }); const tok = (await short.call("POST", `${A}/session/step-up`, { cookie: bossCookie, body: { password: pw(boss), purpose: "security_policy_write" } })).json.step_up.token; await new Promise((r) => setTimeout(r, 120)); const exp = await short.call("PUT", `${A}/settings/${KEY}`, { cookie: bossCookie, token: tok, body: { value: "optional", expected_version: 0, confirm: true } }); eq(exp.json.reason, "expired", "an expired grant: refused"); await short.close(); }
  eq((await get(bossCookie)).json.setting.value, "off", "(nothing changed so far)");
  // first raise: optional needs only the machinery
  let r = await put(bossCookie, "optional"); ok(r.status === 200 && r.json.setting.value === "optional" && r.json.setting.version === 1, "off -> optional succeeds (machinery and schema ready)");
  eq((await put(bossCookie, "optional")).json.error, "enforcement_unchanged", "saving the same level again is refused (cannot restart a grace period)");
  ok((await audits("mfa_enforcement_changed")).some((a) => a.status === "success" && a.metadata.new_value === "optional" && a.metadata.version === 1 && a.metadata.previous_version === 0 && a.actor_email === boss.email), "the change is audited with the new level, version and actor (no stored previous row: the default was off)");

  // ===== 5. preflight
  const pre = (cookie, level) => app.call("GET", `${A}/session/mfa/enforcement/preflight?level=${level}`, { cookie });
  let p = await pre(bossCookie, "privileged"); ok(p.status === 200 && p.json.ok === false && p.json.failed.includes("mailbox_delivery") && p.json.failed.includes("fleet_attested") && !p.json.failed.includes("recovery_path") && !p.json.failed.includes("actor_enrolled") && !p.json.failed.includes("actor_recovery_codes") && !p.json.failed.includes("api_key_fallback_off"), `preflight reports exactly what is missing (${p.json.failed})`);
  ok(p.json.counts.active_accounts >= 5 && p.json.counts.covered >= 2 && typeof p.json.counts.unenrolled === "number" && !JSON.stringify(p.json).includes("secret"), "preflight reports affected-account counts and no secrets");
  eq((await pre(bossCookie, "bogus")).status, 400, "an unknown level: 400"); eq((await app.call("GET", `${A}/session/mfa/enforcement/preflight?level=all`, { apiKey: config.apiKeys[0] })).status, 403, "an API key has no actor: refused"); eq((await pre(await signInPlain(staffNone), "all")).status, 403, "staff.manage required to read the preflight");
  eq((await app.call("POST", `${A}/session/mfa/enforcement/preflight?level=all`, { cookie: bossCookie })).status, 405, "GET only");
  r = await put(bossCookie, "privileged"); ok(r.status === 412 && r.json.error === "preflight_failed" && r.json.failed_checks.includes("mailbox_delivery") && r.json.failed_checks.includes("fleet_attested"), "raising to privileged is refused while preflight fails");
  eq((await get(bossCookie)).json.setting.value, "optional", "…and nothing changed");
  ok((await audits("mfa_enforcement_preflight_failed")).length >= 1, "the refusal is audited");
  // each check on its own
  config.officeEmailProvider = "resend"; config.resendApiKey = "re_test_not_real"; config.mfaFleetAttested = E.ENFORCEMENT_RELEASE;
  const failedWith = async (patch, expectId, level = "privileged") => { const saved = {}; for (const k of Object.keys(patch)) saved[k] = config[k]; Object.assign(config, patch); const res = await pre(bossCookie, level); Object.assign(config, saved); ok(res.json.failed.includes(expectId) && res.json.ok === false, `preflight fails on ${expectId} alone`); const others = res.json.failed.filter((x) => x !== expectId); eq(others.length, 0, `…and only on ${expectId} (also: ${others})`); };
  ok((await pre(bossCookie, "privileged")).json.ok === true, "with every prerequisite satisfied the preflight passes");
  await failedWith({ mfaFleetAttested: "s7.5.6" }, "fleet_attested"); await failedWith({ mfaFleetAttested: "" }, "fleet_attested");
  { const saved = config.allowApiKeyPasswordLogin; config.allowApiKeyPasswordLogin = true; const res = await pre(bossCookie, "privileged"); config.allowApiKeyPasswordLogin = saved; ok(res.json.failed.includes("api_key_fallback_off") && res.json.ok === false, "the API-key password fallback blocks the raise (the MFA configuration check refuses that combination too)"); } await failedWith({ officeEmailProvider: "" }, "mailbox_delivery"); await failedWith({ resendApiKey: "" }, "mailbox_delivery");
  await failedWith({ mfaKey: "" }, "mfa_machinery", "optional");
  { const savedMode = config.mfaMode; config.mfaMode = "off"; E.invalidateEnforcementCache(config);
    const res = await pre(bossCookie, "optional"); ok(res.status === 200 && res.json.ok === false && res.json.failed.includes("mfa_machinery"), "with the MFA machinery off no level can be raised (preflight refuses)");
    const tok = (await stepUpCall(bossCookie, boss, "security_policy_write")).json.step_up.token; const w = await app.call("PUT", `${A}/settings/${KEY}`, { cookie: bossCookie, token: tok, body: { value: "privileged", expected_version: 1, confirm: true } }); ok(w.status === 412 && w.json.failed_checks.includes("mfa_machinery"), "…and the settings write is refused too");
    config.mfaMode = savedMode; E.invalidateEnforcementCache(config); }
  // recovery codes and a second administrator
  const lone = await mkUser("lone"); const loneE = await enrollTotp(lone); const loneCookie = await signInTotp(lone, loneE.secret);
  for (const u of [boss, second, adminOnly]) store.state.admin_users.find((x) => x.id === u.id).status = "inactive";
  let lp = await pre(loneCookie, "privileged"); ok(lp.json.failed.includes("recovery_path") && lp.json.failed.length === 1, `single enrolled super administrator: no second administrator and no approved recovery path (${lp.json.failed})`);
  config.mfaRecoveryApproved = true; lp = await pre(loneCookie, "privileged"); ok(lp.json.ok === true, "an approved break-glass path satisfies the recovery requirement"); config.mfaRecoveryApproved = false;
  const loneCodes = store.state.admin_mfa_recovery_codes.filter((c) => c.admin_user_id === lone.id); store.state.admin_mfa_recovery_codes = store.state.admin_mfa_recovery_codes.filter((c) => c.admin_user_id !== lone.id);
  config.mfaRecoveryApproved = true; lp = await pre(loneCookie, "privileged"); ok(lp.json.failed.join() === "actor_recovery_codes", `missing recovery codes block the raise (${lp.json.failed})`); store.state.admin_mfa_recovery_codes.push(...loneCodes); config.mfaRecoveryApproved = false;
  for (const u of [boss, second, adminOnly]) store.state.admin_users.find((x) => x.id === u.id).status = "active";
  // an unenrolled actor
  const bare = await mkUser("bare"); const bareCookie = await signInPlain(bare); const bp = await pre(bareCookie, "privileged"); ok(bp.json.failed.includes("actor_enrolled") && bp.json.failed.includes("actor_recovery_codes"), "an unenrolled actor fails the enrolment and recovery-code checks");
  const bareWrite = await app.call("PUT", `${A}/settings/${KEY}`, { cookie: bareCookie, token: (await stepUpCall(bareCookie, bare, "security_policy_write")).json.step_up.token, body: { value: "privileged", expected_version: 1, confirm: true } }); eq(bareWrite.status, 412, "…and cannot raise the level");
  // the real raise
  bossCookie = await signInTotp(boss, bossE.secret);
  r = await put(bossCookie, "privileged"); ok(r.status === 200 && r.json.setting.value === "privileged", "privileged: raise succeeds when every check passes");
  eq((await get(bossCookie)).json.setting.version, 2, "version advanced"); ok(r.json.setting.updated_at, "the level has an effective time");
  const conflict = await app.call("PUT", `${A}/settings/${KEY}`, { cookie: bossCookie, token: (await stepUpCall(bossCookie, boss, "security_policy_write")).json.step_up.token, body: { value: "all", expected_version: 1, confirm: true } }); eq(conflict.status, 409, "a stale expected version is a conflict"); eq(conflict.json.error, "version_conflict", "version_conflict");
  // lowering needs no preflight even when every check would fail
  const savedFleet = config.mfaFleetAttested; config.mfaFleetAttested = ""; config.officeEmailProvider = ""; r = await put(bossCookie, "optional"); ok(r.status === 200 && r.json.setting.value === "optional", "lowering is immediate and never preflighted"); config.mfaFleetAttested = savedFleet; config.officeEmailProvider = "resend";
  r = await put(bossCookie, "off"); eq(r.json.setting.value, "off", "optional -> off");
  r = await put(bossCookie, "privileged"); eq(r.json.setting.value, "privileged", "off -> privileged directly");
  r = await put(bossCookie, "all"); eq(r.json.setting.value, "all", "privileged -> all");
  // an unreadable policy fails closed, an invalid stored value too
  const memberU = await mkUser("member", "ochiga_staff"); const memberCookie = await signInPlain(memberU);
  { const orig = store.getRuntimeSetting.bind(store); E.invalidateEnforcementCache(config); store.getRuntimeSetting = async (k) => { if (k === KEY) throw new Error("db down"); return orig(k); }; const out = await login(memberU); ok(out.status === 503 && !out.cookie && !/db down/.test(out.text), "database outage while reading the level: sign-in fails closed, no session, no detail"); eq((await app.call("GET", `${A}/session/me`, { cookie: memberCookie })).status, 503, "…and so does session verification"); store.getRuntimeSetting = orig; E.invalidateEnforcementCache(config); }
  { store.state.runtime_settings[KEY].value = "everyone"; E.invalidateEnforcementCache(config); const out = await login(memberU); ok(out.status === 503 && !out.cookie, "an invalid stored level fails closed (never silently off)"); store.state.runtime_settings[KEY].value = "all"; E.invalidateEnforcementCache(config); }

  // ===== 6. behaviour per level (levels set at the store; start times backdated to test grace)
  const priv1 = await mkUser("priv", "super_admin"); const staff1 = await mkUser("staffer", "ochiga_staff"); const scoped = await mkUser("scoped", "ochiga_staff", { permission_scopes: ["settings.manage"] });
  const fresh = async () => { for (const u of [priv1, staff1, scoped]) setCreated(u, 400); };
  await fresh();
  await setLevel("off"); for (const u of [priv1, staff1]) { const l = await login(u); ok(l.status === 200 && l.cookie && !l.json.mfa_enrollment, `level off: ${u.email.split("@")[0]} signs in normally, no notice`); }
  await setLevel("optional"); for (const u of [priv1, staff1]) { const l = await login(u); ok(l.status === 200 && l.cookie && !l.json.mfa_enrollment, "level optional: nobody required"); }
  await setLevel("privileged");
  { const l = await login(priv1); ok(l.status === 200 && l.cookie && l.json.mfa_enrollment.required && l.json.mfa_enrollment.days_left === 14 && l.json.mfa_enrollment.expired === false, "level privileged: a privileged unenrolled admin signs in with a 14-day notice"); const me = await app.call("GET", `${A}/session/me`, { cookie: l.cookie }); ok(me.json.mfa.enrollment && me.json.mfa.enrollment.days_left === 14, "…and /session/me carries it"); }
  { const l = await login(staff1); ok(l.status === 200 && !l.json.mfa_enrollment, "level privileged: an ordinary account is not affected"); const ls = await login(scoped); ok(ls.json.mfa_enrollment && ls.json.mfa_enrollment.required, "…but an account with the settings.manage scope IS (permissions, not role labels)"); }
  await setLevel("all"); { const l = await login(staff1); ok(l.status === 200 && l.json.mfa_enrollment && l.json.mfa_enrollment.days_left === 14, "level all: everyone gets the notice"); }
  // grace boundaries over HTTP
  const legacyPriv = (await login(priv1)).cookie; const legacyStaff = (await login(staff1)).cookie; eq((await app.call("GET", `${A}/users`, { cookie: legacyPriv })).status, 200, "(setup) legacy sessions work inside grace");
  backdate(13); { const l = await login(priv1); ok(l.status === 200 && l.cookie && l.json.mfa_enrollment.days_left === 1, "13 days in: still inside grace, one day left"); eq((await app.call("GET", `${A}/users`, { cookie: legacyPriv })).status, 200, "…existing sessions keep working"); }
  backdate(14.0001); { const l = await login(priv1); ok(l.status === 200 && l.json.mfa_enrollment_required === true && !l.cookie && l.json.challenge_token && l.json.methods.join() === "totp" && !l.json.admin, "after 14 days: NO session is issued, only an enrolment challenge"); eq((await app.call("GET", `${A}/users`, { cookie: legacyPriv })).status, 401, "…and the legacy session ends"); eq((await app.call("GET", `${A}/session/me`, { cookie: legacyStaff })).status, 401, "(every account the level covers)"); const rej = await app.call("GET", `${A}/users`, { cookie: legacyPriv }); eq(rej.json.error, "mfa_enrollment_required", "the reason is reported by category"); }
  ok((await audits("mfa_enrollment_required")).length >= 1, "routing a sign-in to enrolment is audited");
  // a new account created after the level took effect has its own 14 days
  const newbie = await mkUser("newbie", "ochiga_staff"); setCreated(newbie, 0); { const l = await login(newbie); ok(l.status === 200 && l.cookie && l.json.mfa_enrollment.days_left === 14, "an account created after the level took effect gets its own grace"); }
  // a level that does not cover the account at all
  await setLevel("privileged"); backdate(30); { const l = await login(staff1); ok(l.status === 200 && l.cookie && !l.json.mfa_enrollment, "privileged: an ordinary account is never blocked, however old the level is"); const lp2 = await login(scoped); ok(lp2.json.mfa_enrollment_required === true, "(a scoped account is)"); }
  // enrolled administrators are never downgraded
  await setLevel("off"); { const l = await login(boss); ok(l.json.mfa_required === true && !l.cookie, "level off: an enrolled account is STILL challenged (never silently downgraded)"); }
  { const orig = config.mfaMode; config.mfaMode = "off"; E.invalidateEnforcementCache(config); await setLevel("all"); backdate(30); const l = await login(priv1); ok(l.status === 200 && l.cookie && !l.json.mfa_enrollment, "MFA machinery off: the stored level is inert (nothing required, nothing read)"); config.mfaMode = orig; E.invalidateEnforcementCache(config); }
  // per-account requirement (reset / break-glass) independent of the level
  await setLevel("off"); { const x = await mkUser("acct", "ochiga_staff"); await store.updateAdminUser(x.id, { mfa_required_after: new Date(Date.now() + 3 * DAY).toISOString() }); let l = await login(x); ok(l.cookie && l.json.mfa_enrollment.days_left === 3, "a future per-account deadline: sign in with a notice"); await store.updateAdminUser(x.id, { mfa_required_after: new Date(Date.now() - 1000).toISOString() }); l = await login(x); ok(l.json.mfa_enrollment_required === true && !l.cookie, "a due per-account deadline: enrolment before any session, at level off"); }
  // missing MFA key: an account that must enrol cannot be issued a challenge, and never gets a session
  { const keyless = await startApp({ ...config, mfaKey: "" }); const x = await mkUser("nokey", "ochiga_staff"); await store.updateAdminUser(x.id, { mfa_required_after: new Date(Date.now() - 1000).toISOString() }); const l = await keyless.call("POST", `${A}/session/login`, { body: { email: x.email, password: pw(x) } }); ok(l.status >= 500 && !l.cookie && !l.json?.challenge_token, `MFA key unavailable: no session and no challenge (${l.status})`); await keyless.close(); }
  // forced enrolment end to end: mailbox code -> enrol -> sign in with the new factor -> requirement cleared
  { await setLevel("off"); const f = await mkUser("forced", "ochiga_staff"); await store.updateAdminUser(f.id, { mfa_required_after: new Date(Date.now() - 1000).toISOString() }); config.officeEmailProvider = "resend"; mails.length = 0;
    const l = await login(f); const ch = l.json.challenge_token; eq(l.json.mfa_enrollment_required, true, "(setup) routed to enrolment");
    eq((await mfaCall("/enroll/email-code", { body: { challenge_token: ch } })).status, 200, "mailbox code requested"); const mailCode = (mails.at(-1).text.match(/(\d{8})/) || [])[1]; ok(mailCode, "the code went to the account's own mailbox");
    const v = await mfaCall("/enroll/email-verify", { body: { challenge_token: ch, email_code: mailCode } }); eq(v.status, 200, "mailbox verified");
    const b = await mfaCall("/enroll/forced/begin", { body: { enrollment_token: v.json.enrollment_token } }); const sec = m.base32Decode(b.json.secret_base32);
    const c = await mfaCall("/enroll/forced/confirm", { body: { enrollment_token: v.json.enrollment_token, credential_id: b.json.credential_id, code: code(sec) } }); ok(c.status === 200 && !c.cookie && c.json.sign_in_again === true, "enrolled with NO session issued");
    ok(!(await store.getAdminUserById(f.id)).mfa_required_after, "the per-account requirement is cleared by enrolment");
    const after = await signInTotp(f, sec); eq((await app.call("GET", `${A}/session/me`, { cookie: after })).status, 200, "the new factor signs the person in"); }

  // ===== 7. revoked sessions are never revived by a change of level
  { await setLevel("off"); const victim = await mkUser("revived", "ochiga_staff"); const ck = (await login(victim)).cookie; eq((await app.call("GET", `${A}/session/me`, { cookie: ck })).status, 200, "(setup)"); await store.revokeAdminSessions(victim.id, { actor: "test" }); eq((await app.call("GET", `${A}/session/me`, { cookie: ck })).status, 401, "(setup) revoked");
    for (const level of ["optional", "privileged", "all", "off"]) { await setLevel(level); eq((await app.call("GET", `${A}/session/me`, { cookie: ck })).status, 401, `raising or lowering to ${level} does not revive a revoked session`); }
    const before = Number((await store.getAdminUserById(victim.id)).session_generation); await setLevel("all"); eq(Number((await store.getAdminUserById(victim.id)).session_generation), before, "a change of level does not touch session generations"); }

  // ===== 8. administrator MFA reset
  await setLevel("off"); bossCookie = await signInTotp(boss, bossE.secret); const target = await mkUser("target", "ochiga_staff"); const tE = await enrollTotp(target); const tCookie = await signInTotp(target, tE.secret); const tHash = (await store.getAdminUserById(target.id)).password_hash; const bossGen = Number((await store.getAdminUserById(boss.id)).session_generation);
  const reset = async (cookie, id, body, o = {}) => { const token = o.token === undefined ? (await stepUpCall(cookie, o.as || boss, o.purpose || "mfa_management")).json?.step_up?.token : o.token; return app.call("POST", `${A}/users/${id}/mfa/reset`, { cookie, token, body, ...(o.creds || {}) }); };
  const good = { reason: "Lost phone, verified by video call", confirm: true, confirm_email: target.email };
  eq((await reset(bossCookie, target.id, good, { token: null })).json.error, "step_up_required", "no grant: refused");
  eq((await reset(bossCookie, target.id, good, { purpose: "security_policy_write" })).json.reason, "wrong_purpose", "wrong purpose: refused");
  { const short = await startApp({ ...config, stepUpTtlMs: 40 }); const tok = (await short.call("POST", `${A}/session/step-up`, { cookie: bossCookie, body: { password: pw(boss), purpose: "mfa_management" } })).json.step_up.token; await new Promise((r2) => setTimeout(r2, 120)); eq((await short.call("POST", `${A}/users/${target.id}/mfa/reset`, { cookie: bossCookie, token: tok, body: good })).json.reason, "expired", "an expired grant: refused"); await short.close(); }
  for (const [who, creds] of [["API key", { apiKey: config.apiKeys[0] }], ["edge token", { edge: config.edgeAgentTokens[0] }]]) { const rr = await app.call("POST", `${A}/users/${target.id}/mfa/reset`, { body: good, token: "x", ...creds }); ok([401, 403].includes(rr.status), `${who} cannot reset MFA (${rr.status})`); }
  eq((await reset(bossCookie, boss.id, { ...good, confirm_email: boss.email })).json.error, "use_self_service", "self-reset through this route: refused");
  eq((await reset(bossCookie, target.id, { ...good, confirm: false })).json.error, "confirmation_required", "no explicit confirmation: refused");
  eq((await reset(bossCookie, target.id, { ...good, confirm_email: "someone@else.test" })).json.error, "confirmation_mismatch", "a different confirmation e-mail: refused");
  for (const bad of ["", "ab", "x".repeat(501), 42, null]) eq((await reset(bossCookie, target.id, { ...good, reason: bad })).json.error, "reason_required", `a bad audit reason is refused (${JSON.stringify(bad)})`);
  eq((await reset(bossCookie, crypto.randomUUID(), good)).json.error, "user_not_found", "unknown target");
  { const adminCookieX = aCookie; eq((await reset(adminCookieX, target.id, good, { as: adminOnly })).status, 403, "a non-super_admin cannot reset"); }
  { const staleBoss = await staleSession(boss, 10 * 60_000); eq((await stepUpCall(staleBoss, boss, "mfa_management")).status, 401, "(S7.5.6) no fresh factor, no grant"); }
  { // a grant WITHOUT a second factor (account not enrolled yet cannot reset others)
    const unenrolledSuper = await mkUser("unenr", "super_admin"); const uc = await signInPlain(unenrolledSuper); const rr = await reset(uc, target.id, good, { as: unenrolledSuper }); ok(rr.status === 403 && rr.json.reason === "mfa_required", "an actor without an enrolled factor cannot reset anyone"); }
  // the last recoverable super administrator: the guard counts OTHER active super administrators that still hold an active factor
  { const boss2 = await mkUser("boss2", "super_admin"); const b2E = await enrollTotp(boss2);
    const okReset = await reset(bossCookie, boss2.id, { reason: "super administrator reset while another remains", confirm: true, confirm_email: boss2.email }); eq(okReset.status, 200, "a super administrator can be reset while another enrolled super administrator (the actor) remains");
    // simulate the actor's own factor vanishing between the grant and its use: nobody else could recover, so the reset is refused and changes nothing
    const lonely = await mkUser("lonely", "super_admin"); await enrollTotp(lonely);
    const parked = []; for (const u of store.state.admin_users) if (u.role === "super_admin" && u.status === "active" && u.id !== lonely.id && u.id !== boss.id) { parked.push([u, u.status]); u.status = "inactive"; }
    const gtoken = (await stepUpCall(bossCookie, boss, "mfa_management")).json.step_up.token; const bossCreds = store.state.admin_mfa_credentials.filter((c) => c.admin_user_id === boss.id && c.status === "active"); for (const c of bossCreds) c.status = "revoked";
    const lonelyCredsBefore = store.state.admin_mfa_credentials.filter((c) => c.admin_user_id === lonely.id && c.status === "active").length;
    const blocked = await app.call("POST", `${A}/users/${lonely.id}/mfa/reset`, { cookie: bossCookie, token: gtoken, body: { reason: "guard check", confirm: true, confirm_email: lonely.email } });
    ok(blocked.status === 409 && blocked.json.error === "last_recoverable_super_admin", `the last recoverable super administrator is protected (${blocked.status} ${blocked.json?.error})`);
    eq(store.state.admin_mfa_credentials.filter((c) => c.admin_user_id === lonely.id && c.status === "active").length, lonelyCredsBefore, "…and nothing was changed");
    for (const c of bossCreds) c.status = "active"; for (const [u, st] of parked) u.status = st; }
  bossCookie = await signInTotp(boss, bossE.secret);
  // the success path
  mails.length = 0; config.officeEmailProvider = "resend"; const tokenOk = (await stepUpCall(bossCookie, boss, "mfa_management")).json.step_up.token; const sessionsBefore = (await app.call("GET", `${A}/session/me`, { cookie: tCookie })).status; eq(sessionsBefore, 200, "(setup) the target is signed in");
  const done = await app.call("POST", `${A}/users/${target.id}/mfa/reset`, { cookie: bossCookie, token: tokenOk, body: good });
  ok(done.status === 200 && done.json.ok && done.json.credentials_revoked === 1 && done.json.recovery_codes_deleted === 10 && done.json.re_enrollment_required === true && done.json.notification === "sent" && done.json.session_generation > 0, `reset succeeded: credentials revoked, codes deleted, notification sent (${done.text.slice(0, 150)})`);
  eq((await app.call("GET", `${A}/session/me`, { cookie: tCookie })).status, 401, "the target's sessions ended"); eq((await app.call("GET", `${A}/session/me`, { cookie: bossCookie })).status, 200, "the actor's session is unaffected");
  const tAfter = await store.getAdminUserById(target.id); eq(tAfter.password_hash, tHash, "the target's password is untouched"); ok(!(await store.hasActiveMfa(target.id)) && (await store.countMfaRecoveryCodes(target.id)) === 0, "no factor and no recovery codes remain"); ok(tAfter.mfa_required_after && Date.parse(tAfter.mfa_required_after) <= Date.now() && tAfter.mfa_reset_by === boss.email, "the target must re-enrol immediately; the reset is attributed");
  const relog = await login(target); ok(relog.json.mfa_enrollment_required === true && !relog.cookie, "the target is routed to secure re-enrolment at next sign-in (mailbox code first)");
  eq((await login(target, "wrong password wrong password")).status, 401, "(password still gates everything)");
  const evt = (await audits("mfa_reset_by_admin")).find((a) => a.metadata.target_user_id === target.id); ok(evt && evt.metadata.reason === good.reason && evt.metadata.credentials_revoked === 1 && JSON.stringify(evt).includes(boss.email), "audited with actor, target and reason");
  ok(mails.some((x) => x.to === target.email && /reset/i.test(x.subject + x.text)) && mails.every((x) => !/\d{8}/.test(x.text) || /code/i.test(x.text)), "the target is told by e-mail, without any secret");
  ok((await audits("mfa_reset_denied")).length >= 8, "refusals are audited by category");
  // the fresh-factor requirement cannot be met by a recovery code
  { const rc = await stepUpCall(await staleSession(boss, 10 * 60_000), boss, "mfa_management", { method: "recovery_code", code: bossE.codes[0] }); eq(rc.status, 401, "(S7.5.6) a recovery code is not a step-up factor for a reset either"); }

  // ===== 9. break-glass
  const bgConfig = { ...config, mfaRecovery: false, mfaRecoveryEmail: "", mfaRecoveryId: "" };
  const bgAudit = []; const mkAudit = () => async (action, metadata, status) => { bgAudit.push({ action, metadata, status }); };
  eq(await E.applyBreakGlass({ store, config: bgConfig, audit: mkAudit() }), "disabled", "disabled by default (flag unset)"); eq(E.recoverySummary(bgConfig).status, "disabled", "healthz status: disabled"); ok(!E.recoverySummary(bgConfig).lingering, "not lingering");
  eq(await E.applyBreakGlass({ store, config: { ...bgConfig, mfaRecovery: true }, audit: mkAudit() }), "misconfigured", "enabled without e-mail and id: misconfigured, nothing happens");
  eq(await E.applyBreakGlass({ store, config: { ...bgConfig, mfaRecovery: true, mfaRecoveryEmail: "x@y.test" }, audit: mkAudit() }), "misconfigured", "enabled without an id: misconfigured");
  eq(await E.applyBreakGlass({ store, config: { ...bgConfig, mfaRecovery: true, mfaRecoveryEmail: "x@y.test", mfaRecoveryId: "a b" }, audit: mkAudit() }), "misconfigured", "a malformed id: misconfigured");
  eq(await E.applyBreakGlass({ store, config: { ...bgConfig, mfaMode: "off", mfaRecovery: true, mfaRecoveryEmail: boss.email, mfaRecoveryId: "TICKET-1" }, audit: mkAudit() }), "inactive", "MFA off: inactive");
  const bg = await mkUser("glass", "super_admin"); const bgE = await enrollTotp(bg); const bgCookie = await signInTotp(bg, bgE.secret); const bgHash = (await store.getAdminUserById(bg.id)).password_hash; const bgGen = Number((await store.getAdminUserById(bg.id)).session_generation);
  const cfg1 = { ...bgConfig, mfaRecovery: true, mfaRecoveryEmail: bg.email.toUpperCase(), mfaRecoveryId: "TICKET-0001" };
  eq(await E.applyBreakGlass({ store, config: { ...cfg1, mfaRecoveryEmail: "nobody@x.test" }, audit: mkAudit() }), "no_account", "an unknown account: nothing happens"); ok(bgAudit.some((a) => a.action === "mfa_recovery_skipped" && a.metadata.category === "no_account"), "…and it is audited");
  eq(await runBreakGlass(store, cfg1), "applied", "applied at start");
  const bgAfter = await store.getAdminUserById(bg.id); eq(bgAfter.password_hash, bgHash, "the password is preserved"); ok(!(await store.hasActiveMfa(bg.id)) && (await store.countMfaRecoveryCodes(bg.id)) === 0, "factors and recovery codes cleared"); ok(Number(bgAfter.session_generation) > bgGen && bgAfter.mfa_required_after, "sessions revoked and re-enrolment required");
  eq((await app.call("GET", `${A}/session/me`, { cookie: bgCookie })).status, 401, "existing sessions ended");
  ok((await audits("mfa_recovery_applied")).some((a) => a.metadata.recovery_id === "TICKET-0001" && a.metadata.email === bg.email), "audited with the e-mail and the recovery id");
  const sum = E.recoverySummary(cfg1); ok(sum.status === "applied" && sum.enabled && sum.lingering, "healthz status: applied, and lingering while the flag stays set");
  // once per id: the person re-enrols, the process restarts with the flag still set: nothing happens again
  const relogBg = await login(bg); ok(relogBg.json.mfa_enrollment_required, "(setup) the account must re-enrol"); await store.updateAdminUser(bg.id, { mfa_required_after: null });
  const bg2E = await enrollTotp(bg); eq(await runBreakGlass(store, cfg1), "already_applied", "a restart with the same id changes nothing"); ok(await store.hasActiveMfa(bg.id), "…the re-enrolled factor survives");
  eq(await runBreakGlass(store, { ...cfg1, mfaRecoveryId: "TICKET-0002" }), "applied", "a NEW id applies again (explicit owner action)"); ok(!(await store.hasActiveMfa(bg.id)), "…and clears the factor again");
  // two instances starting together: one winner
  const bg3 = await mkUser("glass3", "super_admin"); await enrollTotp(bg3); const cfg3 = { ...bgConfig, mfaRecovery: true, mfaRecoveryEmail: bg3.email, mfaRecoveryId: "TICKET-RACE" };
  const raced = await Promise.all([E.applyBreakGlass({ store, config: { ...cfg3 }, audit: mkAudit() }), E.applyBreakGlass({ store, config: { ...cfg3 }, audit: mkAudit() })]); eq(raced.filter((x) => x === "applied").length, 1, `two simultaneous starts: exactly one applies (${raced})`);
  // marker unavailable: fail closed
  { const bg4 = await mkUser("glass4", "super_admin"); await enrollTotp(bg4); const orig = store.writeRuntimeSetting.bind(store); store.writeRuntimeSetting = async () => { throw Object.assign(new Error("versioning_unavailable"), { code: "versioning_unavailable" }); }; const st = await E.applyBreakGlass({ store, config: { ...bgConfig, mfaRecovery: true, mfaRecoveryEmail: bg4.email, mfaRecoveryId: "TICKET-NOMARK" }, audit: mkAudit() }); store.writeRuntimeSetting = orig; ok(st === "error" && (await store.hasActiveMfa(bg4.id)), "the once-per-id marker cannot be stored: nothing is applied"); }
  { const bg5 = await mkUser("glass5", "super_admin"); await enrollTotp(bg5); const st = await (async () => { const orig = store.resetMfa.bind(store); store.resetMfa = async () => { throw new Error("db down"); }; try { return await E.applyBreakGlass({ store, config: { ...bgConfig, mfaRecovery: true, mfaRecoveryEmail: bg5.email, mfaRecoveryId: "TICKET-FAIL" }, audit: mkAudit() }); } finally { store.resetMfa = orig; } })(); eq(st, "error", "a database failure during the reset is reported, not hidden");  }
  // never an HTTP route
  for (const probe of ["/api/lead-agents/admin/session/mfa/recovery", "/api/lead-agents/admin/mfa/break-glass", "/api/lead-agents/admin/session/mfa/break-glass", "/api/lead-agents/admin/mfa/recovery/apply", "/api/lead-agents/admin/session/mfa/recovery/apply", "/api/lead-agents/admin/break-glass"]) for (const method of ["GET", "POST", "PUT"]) { const rr = await app.call(method, probe, { cookie: bossCookie, apiKey: config.apiKeys[0], body: method === "GET" ? undefined : {} }); ok([401, 403, 404, 405].includes(rr.status) && !(rr.json && rr.json.ok === true), `${method} ${probe.slice(-28)}: no such operation (${rr.status})`); }
  const health = await app.call("GET", "/healthz"); ok(health.json.mfa && health.json.mfa.recovery && typeof health.json.mfa.recovery.status === "string" && !JSON.stringify(health.json).includes(bg.email), "/healthz shows the break-glass readiness status and never an e-mail address");

  // ===== 10. redaction
  const audit = JSON.stringify(await store.listAuditEvents(99999)); const everything = responses.join("\n") + logs.join("\n") + audit + JSON.stringify(mails); const sidebands = logs.join("\n") + audit + JSON.stringify(mails);
  for (const [name, secret] of Object.entries({ key: K1, session: SESSION, bossPw: pw(boss), targetPw: pw(target), targetHash: tHash })) ok(!everything.includes(secret), `no ${name} in any response, log, audit event or e-mail`);
  for (const [name, secret] of Object.entries({ bossCode: bossE.codes[0], bgCode: bgE.codes[0], targetCode: tE.codes[0], bossTotp: m.base32Encode(bossE.secret) })) ok(!sidebands.includes(secret), `no ${name} (shown to its owner once at enrolment) in any log, audit event or e-mail`);
  ok(!JSON.stringify(await store.listAuditEvents(99999)).includes(tokenOk.split(".")[1]), "no grant in the audit");
  await app.close();
  console.log(`S7.5.7 MFA enforcement and administrator recovery: ${passed} assertions PASS`);
}
main().catch((e) => { console.error(e); process.exit(1); });
