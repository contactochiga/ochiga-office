"use strict";
// AREA C / C08: credential redaction. After REAL flows through the application (sign-in, MFA enrolment and verification, recovery codes, step-up, logout,
// password change, invitations, resets, settings, failures) scan every column of every table, every audit row, every API response and every log for plaintext
// secrets, codes, session identifiers, keys and passwords, and for their unsalted hashes.
const crypto = require("crypto");
const L = require("./lib");
const F = require("./appfix");

const s = new L.Suite("c08-redaction", "C");

s.main(async () => {
  // ---- record every response the application gives
  const recorded = []; const origReq = L.Client.prototype.req;
  L.Client.prototype.req = async function (method, p, o = {}) {
    const r = await origReq.call(this, method, p, o);
    recorded.push({ method, path: p, status: r.status, text: r.text || "", headers: [...(r.headers ? r.headers.entries() : [])].filter(([k]) => k !== "set-cookie").map(([k, v]) => `${k}: ${v}`).join("\n"), setCookie: r.rawSetCookie || [], reqBody: o.json ? JSON.stringify(o.json) : o.raw || "" });
    return r;
  };
  s.onCleanup(() => { L.Client.prototype.req = origReq; });

  const fx = await F.buildStack(s, { tag: "c08", instances: 1 });
  const { st, admin, app } = fx;
  const serviceJwt = st.jwt("service_role");
  const q = async (sql) => { const r = await admin.query(sql); if (r.error) throw new Error(r.error.message); return r.rows; };

  // ---- secrets registry: { name, value, kind, issuedAt (index in `recorded`), where }
  const secrets = [];
  const reg = (name, value, kind, extra = {}) => { if (value && String(value).length >= 6) secrets.push({ name, value: String(value), kind, ...extra }); };
  // kinds: never (must appear in no response, no log, no table), once (appears only in the response that issued it), cookie (only in Set-Cookie)
  reg("service-role key", serviceJwt, "never"); reg("session secret", fx.sessionSecret, "never"); reg("api key", fx.apiKey, "never");
  reg("mfa key (base64)", L.MFA_KEY_A, "never"); reg("mfa key (hex)", Buffer.from(L.MFA_KEY_A, "base64").toString("hex"), "never");
  reg("postgrest jwt secret", st.jwtSecret, "never"); reg("database password", st.password, "never");

  // ---- flows
  const newPw = () => "Fl0w!" + L.randomHex(8) + "Xz";
  const user = await L.seedUser(admin, { role: "super_admin", password: newPw() }); reg("password (admin)", user.password, "never");
  const peer = await L.seedUser(admin, { role: "viewer", password: newPw() }); reg("password (peer)", peer.password, "never");
  const c = new L.Client(app.url);

  const wrong = "Wr0ng!" + L.randomHex(8) + "Qq"; reg("wrong password", wrong, "never");
  await c.login(user.email, wrong); await c.login("nobody-" + L.randomHex(3) + "@fixture.test", wrong);
  const l0 = await c.login(user.email, user.password);
  const cookieOf = (cl) => cl.cookie.split("=")[1];
  reg("session cookie (password login)", cookieOf(c), "cookie");
  const sidOf = (cookieVal) => { try { return JSON.parse(Buffer.from(cookieVal.split(".")[0], "base64url").toString("utf8")).sid; } catch { return null; } };
  const sig = (cookieVal) => cookieVal.split(".")[1];
  const regCookie = (name, cookieVal) => { reg(name, cookieVal, "cookie"); reg(name + " signature", sig(cookieVal), "cookie"); const sid = sidOf(cookieVal); if (sid) reg(name + " session id", sid, "never"); return sid; };
  const sid0 = regCookie("session cookie (password login)", cookieOf(c));
  s.check("RED-001", "positive control: the session carries an identifier (so the scan has something to look for)", Boolean(sid0));

  const su = await c.stepUp(user.password, "mfa_management"); reg("step-up grant", su.token, "once", { responseIndex: recorded.length - 1 });
  const h = { "x-step-up-token": su.token };
  const begin = await c.post(`${L.P}/session/mfa/enroll/totp/begin`, {}, { headers: h }); const beginIdx = recorded.length - 1;
  const secretB32 = begin.json.secret_base32;
  reg("TOTP secret (base32)", secretB32, "once", { responseIndex: beginIdx }); reg("TOTP secret (hex)", L.base32Decode(secretB32).toString("hex"), "never"); reg("TOTP secret (base64)", L.base32Decode(secretB32).toString("base64").replace(/=+$/, ""), "never");
  reg("otpauth URI", begin.json.otpauth_uri, "once", { responseIndex: beginIdx });
  const totp = new L.TotpSource(secretB32); const c1 = await totp.next();
  const confirm = await c.post(`${L.P}/session/mfa/enroll/totp/confirm`, { credential_id: begin.json.credential_id, code: c1.code }, { headers: h }); const confirmIdx = recorded.length - 1;
  const codes1 = confirm.json.recovery_codes || [];
  s.eq("RED-002", "positive control: ten recovery codes were issued to the browser once", codes1.length, 10);
  const norm = (x) => x.replace(/[-\s]/g, "");
  codes1.forEach((x, i) => { reg(`recovery code ${i} (as shown)`, x, "once", { responseIndex: confirmIdx }); if (norm(x) !== x) reg(`recovery code ${i} (no separators)`, norm(x), "once", { responseIndex: confirmIdx }); });
  c.cookie = confirm.setCookie || c.cookie; regCookie("session cookie (after enrolment)", cookieOf(c));
  const usedCodes = [{ code: c1.code, note: "enrolment" }];

  // sign out, sign in with password + TOTP
  const lo = await c.logout();
  const c2 = new L.Client(app.url);
  const lp = await c2.post(`${L.P}/session/login`, { email: user.email, password: user.password }); const lpIdx = recorded.length - 1;
  reg("MFA challenge token", lp.json.challenge_token, "once", { responseIndex: lpIdx });
  const c2code = await totp.next(); usedCodes.push({ code: c2code.code, note: "login" });
  const v = await c2.post(`${L.P}/session/mfa/verify`, { challenge_token: lp.json.challenge_token, method: "totp", code: c2code.code }); c2.cookie = v.setCookie;
  const sid2 = regCookie("session cookie (mfa login)", cookieOf(c2));
  // bad second factors and a replay
  await c2.post(`${L.P}/session/mfa/verify`, { challenge_token: lp.json.challenge_token, method: "totp", code: c2code.code });
  const badCode = "000000"; await c2.post(`${L.P}/session/mfa/verify`, { challenge_token: lp.json.challenge_token, method: "totp", code: badCode });
  // recovery-code login
  const lq = await new L.Client(app.url).post(`${L.P}/session/login`, { email: user.email, password: user.password });
  reg("MFA challenge token (recovery)", lq.json.challenge_token, "once", { responseIndex: recorded.length - 1 });
  const rv = await new L.Client(app.url).post(`${L.P}/session/mfa/verify`, { challenge_token: lq.json.challenge_token, method: "recovery_code", code: codes1[0] });
  const c3 = new L.Client(app.url); c3.cookie = rv.setCookie || ""; if (c3.cookie) regCookie("session cookie (recovery login)", cookieOf(c3));
  await new L.Client(app.url).post(`${L.P}/session/mfa/verify`, { challenge_token: lq.json.challenge_token, method: "recovery_code", code: codes1[0] }); // spent
  await new L.Client(app.url).post(`${L.P}/session/mfa/verify`, { challenge_token: lq.json.challenge_token, method: "recovery_code", code: "AAAA-BBBB-CCCC" });
  // regenerate recovery codes (step-up with fresh second factor)
  const c4code = await totp.next(); usedCodes.push({ code: c4code.code, note: "step-up" });
  const lg = c3.cookie ? c3 : c2;
  const su2 = await lg.stepUp(user.password, "mfa_management", { method: "totp", code: c4code.code }); reg("step-up grant (second factor)", su2.token, "once", { responseIndex: recorded.length - 1 });
  const regen = await lg.post(`${L.P}/session/mfa/recovery-codes/regenerate`, {}, { headers: { "x-step-up-token": su2.token } }); const regenIdx = recorded.length - 1;
  (regen.json.recovery_codes || []).forEach((x, i) => { reg(`regenerated code ${i}`, x, "once", { responseIndex: regenIdx }); if (norm(x) !== x) reg(`regenerated code ${i} (no separators)`, norm(x), "once", { responseIndex: regenIdx }); });
  s.eq("RED-003", "positive control: regeneration returned a fresh batch", (regen.json.recovery_codes || []).length, 10);
  // reads that could expose stored material
  await lg.get(`${L.P}/session/mfa`); await lg.get(`${L.P}/session/me`); await lg.get("/api/lead-agents/admin/users"); await lg.get("/api/lead-agents/admin/audit"); await lg.get("/api/lead-agents/admin/settings");
  await new L.Client(app.url).get("/api/lead-agents/admin/users", { headers: { "x-api-key": fx.apiKey } });
  await new L.Client(app.url).get("/api/lead-agents/admin/audit", { headers: { "x-api-key": fx.apiKey } });
  await new L.Client(app.url).get("/healthz");
  // password change
  const c5 = new L.Client(app.url); await c5.login(peer.email, peer.password);
  const peerNew = newPw(); reg("password (peer, new)", peerNew, "never");
  await c5.post(`${L.P}/session/password`, { current_password: peer.password, new_password: peerNew });
  await c5.post(`${L.P}/session/password`, { current_password: wrong, new_password: "Sh0rt!" }); // wrong current + weak new: error paths
  const weak = "weakpw"; reg("rejected weak password", weak + "XYZ", "never");
  await c5.post(`${L.P}/session/password`, { current_password: peerNew, new_password: weak + "XYZ" });
  // invitation, reset request, unknown routes, malformed bodies
  const inviteEmail = "invitee-" + L.randomHex(4) + "@fixture.test";
  const su3 = await lg.stepUp(user.password, "mfa_management", { method: "totp", code: (await totp.next()).code }).catch(() => ({}));
  const inv = await lg.post("/api/lead-agents/admin/users/invite", { email: inviteEmail, role: "ochiga_staff", display_name: "Invitee" }); const invIdx = recorded.length - 1;
  { const m = /token=([0-9a-f]{16,})/.exec(inv.text || ""); if (m) { reg("invitation token", m[1], "once", { responseIndex: invIdx }); reg("invitation link", (/"invite_url":"([^"]+)"/.exec(inv.text) || [])[1], "once", { responseIndex: invIdx }); } }
  await new L.Client(app.url).post(`${L.P}/session/reset/request`, { email: peer.email }); await new L.Client(app.url).post(`${L.P}/session/reset/request`, { email: "nobody@fixture.test" });
  await new L.Client(app.url).req("POST", `${L.P}/session/login`, { raw: "{not json" }); await new L.Client(app.url).req("POST", `${L.P}/session/login`, { raw: JSON.stringify({ email: user.email, password: { $ne: 1 } }) });
  await new L.Client(app.url).get("/api/lead-agents/admin/nope-" + L.randomHex(3));
  // settings and logout
  const brand = "Brand " + L.randomHex(3);
  await lg.put("/api/lead-agents/admin/settings/office_document_brand_name", { value: brand, expected_version: 0 });
  await lg.put("/api/lead-agents/admin/settings/office_document_brand_name", { value: brand + "2", expected_version: 0 });
  const lo2 = await lg.logout(); const lo3 = await c2.logout();
  // use of dead tokens
  await new L.Client(app.url).me({ cookie: "lead_agents_admin=" + cookieOf(c2) });

  // ---- inventory of everything stored
  const tables = (await q("select tablename from pg_tables where schemaname='public' order by 1")).map((r) => r[0]);
  const dump = {};
  for (const t of tables) { const rows = await q(`select row_to_json(x)::text from public."${t}" x`); dump[t] = rows.map((r) => r.join("\t")).join("\n"); }
  const authTables = ["admin_users", "admin_invites", "password_reset_tokens", "audit_events", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions", "office_runtime_settings", "office_runtime_setting_history"];
  s.check("RED-010", "the scan covers every authentication table and found data in each that the flows touch", authTables.every((t) => tables.includes(t)) && ["admin_users", "audit_events", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_revoked_sessions", "admin_invites"].every((t) => dump[t].length > 0), authTables.map((t) => [t, (dump[t] || "").length]));
  s.info(`scanned ${tables.length} tables, ${recorded.length} responses, ${secrets.length} registered secrets`);

  // unsalted hashes and encodings of low-entropy-derivable secrets
  const variants = (v) => {
    const out = new Set([v, v.toLowerCase(), v.toUpperCase()]);
    for (const x of [v, v.toLowerCase(), v.toUpperCase()]) {
      for (const alg of ["md5", "sha1", "sha256", "sha512"]) { const d = crypto.createHash(alg).update(x); const buf = d.digest(); out.add(buf.toString("hex")); out.add(buf.toString("base64")); out.add(buf.toString("base64url")); }
      out.add(Buffer.from(x).toString("base64")); out.add(Buffer.from(x).toString("hex"));
    }
    return [...out].filter((z) => z.length >= 8);
  };
  const derivedFrom = secrets.filter((x) => x.kind !== "once" || /recovery|regenerated|grant|challenge/.test(x.name));
  const mayAppearInDb = (x) => false;

  // ---- tables
  await s.section("TABLES", async () => {
    const hits = [];
    for (const sec of secrets) for (const t of tables) if (dump[t].includes(sec.value)) hits.push(`${sec.name} in ${t}`);
    s.check("RED-100", "no registered secret (password, key, TOTP secret in any encoding, recovery code, cookie, session id, challenge, grant) is stored in plaintext in ANY column of ANY table", hits.length === 0, hits.slice(0, 8));
    const dhits = [];
    for (const sec of derivedFrom) { if (/key|secret \(|jwt/i.test(sec.name) && sec.kind === "never" && !/session id|password|cookie/.test(sec.name)) continue; for (const vv of variants(sec.value)) for (const t of tables) if (vv !== sec.value && dump[t].includes(vv)) dhits.push(`${sec.name} as ${vv.slice(0, 10)}… in ${t}`); }
    s.check("RED-101", "no unsalted hash (md5/sha1/sha256/sha512) or simple encoding of a session cookie, session id, grant, challenge, password or recovery code is stored", dhits.length === 0, dhits.slice(0, 8));
    // recovery codes: the stored value is a keyed digest
    const stored = (await q("select code_hmac from admin_mfa_recovery_codes")).map((r) => r[0]);
    s.check("RED-102", "recovery codes are stored only as keyed digests (none equals any plain hash of any issued code)", stored.length >= 10 && !stored.some((hv) => codes1.some((cd) => variants(cd).concat(variants(norm(cd))).includes(hv))), stored.slice(0, 2));
    const pwh = (await q("select email, password_hash from admin_users where email in ('" + user.email + "','" + peer.email + "')"));
    s.check("RED-103", "stored passwords are salted slow hashes (salt:hash), not plain digests of the password", pwh.every((r) => /^[0-9a-f]{16,}:[0-9a-f]{64,}$/.test(r[1]) && !variants(user.password).concat(variants(peerNew)).includes(r[1].split(":")[1])), pwh.map((r) => r[1].length));
    const cred = await q("select type, secret_ciphertext, secret_nonce, secret_key_id from admin_mfa_credentials where type='totp'");
    s.check("RED-104", "the TOTP secret is stored only as ciphertext with a nonce and a key IDENTIFIER (never the key)", cred.length >= 1 && cred.every((r) => r[1] && r[2] && !r[1].includes(secretB32) && r[3].length <= 32 && !L.MFA_KEY_A.includes(r[3])), cred.map((r) => [r[1].length, r[3]]));
    const rev = await q("select session_digest, admin_user_id from admin_revoked_sessions");
    s.check("RED-105", "revoked-session records hold a keyed digest, not the identifier, and the digest is not the identifier's plain hash", rev.length >= 1 && rev.every((r) => ![sid0, sid2].filter(Boolean).some((sid) => variants(sid).some((vv) => vv.startsWith(r[0]) || r[0].startsWith(vv.slice(0, 16)) || r[0] === sid))), rev.map((r) => r[0]));
    const inviteRow = await q("select token_hash, status from admin_invites order by created_at desc limit 1");
    s.check("RED-106", "an invitation is stored as a hash of its token only", inviteRow.length === 1 && /^[0-9a-f]{40,}$/.test(inviteRow[0][0]), inviteRow);
    const resetRow = await q("select token_hash from password_reset_tokens");
    s.check("RED-107", "reset tokens are stored as hashes only", resetRow.length >= 1 && resetRow.every((r) => /^[0-9a-f]{40,}$/.test(r[0])), resetRow.length);
    const hist = await q("select previous_value::text, new_value::text, actor, reason from office_runtime_setting_history");
    s.check("RED-108", "setting history holds values, actors and category reasons, no credential material", !hist.some((r) => secrets.some((x) => x.kind !== "once" && r.join(" ").includes(x.value))), hist.length);
  });

  // ---- audit
  await s.section("AUDIT", async () => {
    const rows = await q("select action, actor_email, target_type, target_id, metadata::text from audit_events order by action");
    s.check("RED-200", "positive control: the flows produced audit rows for sign-in, MFA, step-up, logout, recovery and password events", ["user.login", "mfa_verified", "step_up_verified", "session_logout", "mfa_recovery_code_used", "password_changed", "user.invited"].every((a) => rows.some((r) => r[0] === a)), [...new Set(rows.map((r) => r[0]))]);
    const keys = new Set(); const walk = (o, d = 0) => { if (o && typeof o === "object" && d < 5) for (const [k, v] of Object.entries(o)) { keys.add(k); walk(v, d + 1); } };
    for (const r of rows) { try { walk(JSON.parse(r[4])); } catch { /* ignore */ } }
    const bad = [...keys].filter((k) => /(^|_)(password|passwd|secret|ciphertext|hmac|cookie|authorization|apikey|api_key|private|plaintext|otp|digest|signature|token_hash)(_|$)/i.test(k) || /^(token|code|challenge|sid|session_id|key)$/i.test(k));
    s.check("RED-201", "no audit field NAME suggests a credential (password, secret, ciphertext, hmac, cookie, token, code, challenge, sid…)", bad.length === 0, bad);
    const flat = rows.map((r) => r.join(" ")).join("\n");
    const leaked = secrets.filter((x) => flat.includes(x.value)).map((x) => x.name);
    s.check("RED-202", "no secret value appears in any audit row (any column, including metadata)", leaked.length === 0, leaked.slice(0, 8));
    const codeLeaks = usedCodes.filter((u) => new RegExp(`"[a-z_]*(code|otp)[a-z_]*"\\s*:\\s*"${u.code}"`, "i").test(flat) || flat.includes(`"${u.code}"`));
    s.check("RED-203", "no submitted one-time code (TOTP) was recorded in the audit trail", codeLeaks.length === 0, codeLeaks);
    s.check("RED-204", "the audit trail does not record the plaintext of the wrong password or malformed bodies", !flat.includes(wrong) && !flat.includes("$ne"));
    const failed = rows.filter((r) => /mfa_failed|session_login_denied|step_up_failed/.test(r[0]));
    s.check("RED-205", "failed-attempt rows carry a failure category and request id, not the attempted value", failed.every((r) => !/\b\d{6}\b"/.test(r[4].replace(/"(at|locked_until|ts)":"[^"]*"/g, ""))), failed.slice(0, 2));
    s.check("RED-206", "the audit rows for the invitation hold no link or token", !/mode=invite|mode=reset|token=/.test(flat), (flat.match(/.{30}(mode=invite|mode=reset|token=).{30}/) || [])[0]);
  });

  // ---- API responses
  await s.section("RESPONSES", async () => {
    const issuedBy = (sec) => sec.responseIndex;
    const bad = []; let sawCookie = 0, sawOnce = 0;
    recorded.forEach((r, i) => {
      for (const sec of secrets) {
        const inBody = r.text.includes(sec.value), inHeaders = r.headers.includes(sec.value), inCookie = r.setCookie.some((ck) => ck.includes(sec.value));
        if (sec.kind === "never" && (inBody || inHeaders || inCookie)) bad.push(`${sec.name} in ${r.method} ${r.path} -> ${r.status} (${inBody ? "body" : inHeaders ? "headers" : "set-cookie"})`);
        if (sec.kind === "cookie") { if (inBody || inHeaders) bad.push(`${sec.name} in ${r.method} ${r.path} -> ${r.status} (${inBody ? "body" : "headers"})`); if (inCookie) sawCookie++; }
        if (sec.kind === "once") { if ((inBody || inHeaders || inCookie) && i !== sec.responseIndex) bad.push(`${sec.name} returned again by ${r.method} ${r.path} -> ${r.status}`); if (i === sec.responseIndex && inBody) sawOnce++; }
      }
    });
    s.check("RED-300", "no response (body or header) ever contains a password, API key, service key, session secret, MFA key or session id", !bad.some((b) => / in /.test(b) && !/returned again/.test(b)) , bad.filter((b) => !/returned again/.test(b)).slice(0, 8));
    s.check("RED-301", "a one-time secret (TOTP secret, recovery codes, step-up grant, challenge) is returned exactly once, by the response that issues it, and never echoed afterwards", !bad.some((b) => /returned again/.test(b)), bad.filter((b) => /returned again/.test(b)).slice(0, 8));
    s.check("RED-302", "positive control: the scan did see the one-time secrets in their issuing responses and the cookies in Set-Cookie", sawOnce >= 20 && sawCookie >= 3, { sawOnce, sawCookie });
    // listing routes
    const users = recorded.find((r) => r.path === "/api/lead-agents/admin/users" && r.method === "GET" && r.status === 200);
    s.check("RED-310", "the staff listing exposes no password hash, TOTP material or recovery-code digests", users && !/password_hash|scrypt|secret|ciphertext|code_hmac|webauthn_public/i.test(users.text) && !pwhs().some((hv) => users.text.includes(hv)), users && (users.text.match(/.{40}(password_hash|scrypt|secret|ciphertext|code_hmac|webauthn_public).{40}/i) || [users.text.slice(0, 100)])[0]);
    function pwhs() { return (global.__pwhs || []); }
    const aud = recorded.find((r) => r.path === "/api/lead-agents/admin/audit" && r.method === "GET" && r.status === 200);
    s.check("RED-311", "the audit listing exposes no credential material", aud && !/password_hash|ciphertext|code_hmac|secret_/i.test(aud.text), aud && aud.text.length);
    const mfaInfo = recorded.find((r) => r.path === `${L.P}/session/mfa` && r.status === 200);
    s.check("RED-312", "the MFA status route shows counts and states, not secrets, ciphertext or digests", mfaInfo && !/ciphertext|nonce|secret|hmac|public_key|key_id/i.test(mfaInfo.text), mfaInfo && mfaInfo.text.slice(0, 200));
    if (users && /mfa_failed_attempts|mfa_locked_until/.test(users.text)) s.info("INFO-STAFFLIST the staff listing (staff.manage) includes mfa_failed_attempts / mfa_locked_until / mfa_required_after of every account: operational state, not a credential");
    const me = recorded.find((r) => r.path === `${L.P}/session/me` && r.status === 200);
    s.check("RED-313", "session/me returns the profile without hash, generation counters or secrets", me && !/"password[a-z_]*"|hash|session_generation|secret/i.test(me.text), me && (me.text.match(/.{40}("password[a-z_]*"|hash|session_generation|secret).{40}/i) || [""])[0]);
    // error responses
    const errs = recorded.filter((r) => r.status >= 400);
    const echo = errs.filter((r) => [wrong, weak + "XYZ", badCode, "AAAA-BBBB-CCCC"].some((v) => r.text.includes(v)) || /\$ne/.test(r.text));
    s.check("RED-320", `error responses (${errs.length}) never echo the submitted password, code or malformed body`, echo.length === 0, echo.map((r) => `${r.method} ${r.path}`));
    const trace = errs.filter((r) => /\bat\s+\S+\s+\(.*:\d+:\d+\)|node_modules|stack/i.test(r.text));
    s.check("RED-321", "error responses carry no stack trace or file path", trace.length === 0, trace.map((r) => `${r.method} ${r.path} ${r.text.slice(0, 100)}`));
    const hdrs = recorded.filter((r) => /x-powered-by|server:\s*[A-Za-z]+\/\d/i.test(r.headers));
    s.check("RED-322", "responses do not announce framework or version", hdrs.length === 0, hdrs.slice(0, 1).map((r) => r.headers));
    const cookies = recorded.flatMap((r) => r.setCookie).filter((ck) => /^lead_agents_admin=[^;]+/.test(ck));
    s.check("RED-323", "session cookies are HttpOnly with SameSite and a Max-Age", cookies.length > 0 && cookies.every((ck) => /HttpOnly/i.test(ck) && /SameSite=(Lax|Strict)/i.test(ck) && /Max-Age=\d+/i.test(ck)), cookies[0]);
    const nostore = recorded.filter((r) => /\/session\/(login|mfa\/verify|step-up|mfa\/enroll\/totp\/(begin|confirm)|mfa\/recovery-codes\/regenerate)$/.test(r.path) && r.status === 200);
    s.check("RED-324", "responses that carry credentials, grants or codes are marked no-store", nostore.length > 0 && nostore.every((r) => /cache-control:\s*[^\n]*no-store/i.test(r.headers)), nostore.filter((r) => !/no-store/i.test(r.headers)).map((r) => r.path));
    const inviteResp = recorded[invIdx];
    s.check("RED-325", "the invitation response does not return the invitation token or link", inviteResp && !/token|mode=invite/i.test(inviteResp.text.replace(/"token_hash"/g, "")) , inviteResp && (inviteResp.text.match(/.{60}(token|mode=invite).{60}/i) || [inviteResp.text.slice(0,200)])[0]);
  });

  // ---- logs
  await s.section("LOGS", async () => {
    const t = app.logText();
    const hit = secrets.filter((x) => t.includes(x.value)).map((x) => x.name);
    s.check("RED-400", "the application log (stdout/stderr) contains none of the secrets, codes, cookies, session ids, grants or passwords", hit.length === 0, hit.slice(0, 8));
    s.check("RED-401", "positive control: the log is not empty (the scan read real output)", t.length > 200, t.length);
    s.check("RED-402", "the log does not echo the email address together with a password field", !/"password"\s*:/.test(t));
    const dockerLogs = (name) => { const r = L.sh("docker", ["logs", name]); return (r.stdout || "") + (r.stderr || ""); };
    const pgl = dockerLogs(st.container); const rstl = dockerLogs(st.pgrstName);
    const dh = secrets.filter((x) => x.kind !== "once" && (pgl.includes(x.value) || rstl.includes(x.value))).filter((x) => x.name !== "postgrest jwt secret" && x.name !== "database password" && x.name !== "service-role key").map((x) => x.name);
    s.check("RED-410", "neither the Postgres nor the PostgREST log holds a user password, cookie, session id, recovery code, step-up grant or TOTP secret", dh.length === 0, dh);
    const dhs = secrets.filter((x) => /^(password|wrong password|TOTP secret|recovery code|regenerated)/.test(x.name) && (pgl.includes(x.value) || rstl.includes(x.value))).map((x) => x.name);
    s.check("RED-411", "...in particular no plaintext password, TOTP secret or recovery code reached the database layer at all (hashing and encryption happen in the application)", dhs.length === 0, dhs.slice(0, 6));
  });
});
