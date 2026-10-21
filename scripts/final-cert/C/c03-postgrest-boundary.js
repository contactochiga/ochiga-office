"use strict";
// AREA C / C03: the Data API boundary. PostgREST v14.12 in front of Supabase Postgres 17, signed JWTs for anon, authenticated and service_role.
const L = require("./lib");
const T = require("./dbtools");

const s = new L.Suite("c03-postgrest-boundary", "C");

s.main(async () => {
  const st = await L.DbStack.create({ kind: "supabase17", tag: "c03", postgrest: true, suite: s });
  st.applyAll();
  let ids = T.seedRich(st);
  const reseed = () => { ids = T.seedRich(st); refreshArgs(); return ids; };
  await st.settle(async () => (await st.rpc("service_role", "office_mfa_schema_version")).json === 1);
  const adm = st.session();
  const before = T.digests(st, ["admin_users", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions", "office_runtime_settings", "office_runtime_setting_history", "audit_events", "admin_invites", "password_reset_tokens"]);
  const blocked = (r) => r.status === 401 || r.status === 403 || r.status === 404 || (r.status === 200 && Array.isArray(r.json) && r.json.length === 0) || (r.status >= 200 && r.status < 300 && Array.isArray(r.json) && r.json.length === 0);
  const noData = (r) => r.status >= 400 || (Array.isArray(r.json) ? r.json.length === 0 : r.status === 204 || r.text === "");
  const ROLES = ["anon", "authenticated"];

  // ------------------------------------------------------------ table reads and writes through the API
  await s.section("API-1", async () => {
    for (const role of ROLES) for (const t of T.SECRET_TABLES) {
      const g = await st.rest(role, "GET", `/${t}?select=*&limit=5`);
      s.check(`API-101-${role}-${t}`, `GET /${t} as ${role} returns no row`, noData(g), { status: g.status, body: g.text.slice(0, 160) });
      const c = await st.rest(role, "GET", `/${t}?select=count`);
      s.check(`API-102-${role}-${t}`, `count of /${t} as ${role} reveals nothing`, c.status >= 400 || !Array.isArray(c.json) || c.json.every((x) => Number(x.count || 0) === 0), { status: c.status, body: c.text.slice(0, 120) });
      const h = await st.rest(role, "HEAD", `/${t}`, { headers: { Prefer: "count=exact" } });
      const cr = h.headers && h.headers.get("content-range");
      s.check(`API-103-${role}-${t}`, `HEAD /${t} as ${role} discloses no row count`, h.status >= 400 || !cr || /\/(0|\*)$/.test(cr), { status: h.status, cr });
    }
    // the credential material specifically, by name
    for (const role of ROLES) {
      const pw = await st.rest(role, "GET", "/admin_users?select=email,password_hash,role");
      s.check(`API-110-${role}`, `${role} cannot fetch e-mails and password hashes`, noData(pw), pw.text.slice(0, 160));
      const filt = await st.rest(role, "GET", `/admin_users?email=like.*&select=id`);
      s.check(`API-111-${role}`, `${role} cannot enumerate accounts with a wildcard filter`, noData(filt), filt.text.slice(0, 120));
      const emb = await st.rest(role, "GET", "/admin_users?select=id,admin_mfa_credentials(*),admin_mfa_recovery_codes(*)");
      s.check(`API-112-${role}`, `${role} cannot reach MFA rows through resource embedding from admin_users`, noData(emb) || !/CIPHERTEXT|hmac-u/.test(emb.text), emb.text.slice(0, 160));
      const emb2 = await st.rest(role, "GET", "/admin_mfa_credentials?select=*,admin_users(*)");
      s.check(`API-113-${role}`, `${role} cannot reach accounts through embedding from a credential table`, noData(emb2), emb2.text.slice(0, 160));
      const rt = await st.rest(role, "GET", "/password_reset_tokens?select=token_hash,email");
      s.check(`API-114-${role}`, `${role} cannot read reset tokens`, noData(rt));
      const lg = await st.rest(role, "GET", "/audit_events?select=*&limit=3");
      s.check(`API-115-${role}`, `${role} cannot read the audit trail`, noData(lg));
    }
    for (const role of ROLES) for (const t of T.SECRET_TABLES) {
      const first = await adm.scalar(`select column_name from information_schema.columns where table_name='${t}' and table_schema='public' order by ordinal_position limit 1`);
      const p = await st.rest(role, "PATCH", `/${t}?${first}=not.is.null`, { body: {}, headers: { Prefer: "return=representation" } });
      s.check(`API-120-${role}-${t}`, `PATCH /${t} as ${role} changes no row`, noData(p), { status: p.status, body: p.text.slice(0, 120) });
      const d = await st.rest(role, "DELETE", `/${t}?${first}=not.is.null`, { headers: { Prefer: "return=representation" } });
      s.check(`API-121-${role}-${t}`, `DELETE /${t} as ${role} removes no row`, noData(d), { status: d.status, body: d.text.slice(0, 120) });
    }
    for (const role of ROLES) {
      const a = await st.rest(role, "POST", "/admin_users", { body: { email: `api-${role}@fixture.test`, password_hash: "x:y", role: "super_admin" }, headers: { Prefer: "return=representation" } });
      s.check(`API-130-${role}`, `${role} cannot create an administrator through the API`, a.status >= 400, { status: a.status, body: a.text.slice(0, 160) });
      const au = await st.rest(role, "POST", "/audit_events", { body: { actor_email: "forged@fixture.test", action: "forged", target_type: "admin_user" }, headers: { Prefer: "return=representation" } });
      s.check(`API-131-${role}`, `${role} cannot add records to the audit trail`, au.status >= 400, { status: au.status, body: au.text.slice(0, 160) });
      const up = await st.rest(role, "POST", "/admin_users?on_conflict=email", { body: { email: await adm.scalar(`select email from admin_users where id='${ids.u1}'`), password_hash: "a:b", role: "super_admin" }, headers: { Prefer: "resolution=merge-duplicates,return=representation" } });
      s.check(`API-132-${role}`, `${role} cannot overwrite an existing account by upsert`, up.status >= 400, { status: up.status, body: up.text.slice(0, 160) });
      const rs = await st.rest(role, "POST", "/office_runtime_settings?on_conflict=key", { body: { key: "office_mfa_enforcement", value: "off" }, headers: { Prefer: "resolution=merge-duplicates,return=representation" } });
      s.check(`API-133-${role}`, `${role} cannot overwrite the MFA enforcement setting`, rs.status >= 400, { status: rs.status, body: rs.text.slice(0, 160) });
    }
    s.eq("API-140", "no row of any authentication table changed during the table probing by anon and authenticated", T.digests(st, Object.keys(before)), before);
  });

  // ------------------------------------------------------------ functions through the API
  let CALL_ARGS; const refreshArgs = () => { CALL_ARGS = buildArgs(); };
  const buildArgs = () => ({
    office_revoke_admin_sessions: { p_user_id: ids.u2, p_actor: "probe", p_reason: null },
    office_admin_update_revoking_sessions: { p_user_id: ids.u2, p_actor: "probe", p_status: "inactive" },
    office_mfa_schema_version: {}, office_mfa_management_version: {}, office_mfa_webauthn_version: {}, office_session_revocation_version: {},
    office_mfa_consume_totp_step: { p_credential_id: ids.cTotp, p_step: 99999999 },
    office_mfa_consume_recovery_code: { p_user_id: ids.u1, p_code_hmac: ids.hm("u1-b") },
    office_mfa_replace_recovery_codes: { p_user_id: ids.u2, p_batch_id: L.uuidv4(), p_hmacs: ["probe-api-h1"], p_key_id: "k1" },
    office_mfa_create_challenge: { p_user_id: ids.u2, p_purpose: "webauthn_register", p_challenge_b64: "AAEC", p_ttl_seconds: 60 },
    office_mfa_consume_challenge: { p_challenge_id: L.uuidv4(), p_user_id: ids.u2, p_purpose: "webauthn_register" },
    office_mfa_record_failure: { p_user_id: ids.u2 }, office_mfa_clear_failures: { p_user_id: ids.u2 },
    office_mfa_reset: { p_user_id: ids.u1, p_actor: "probe" }, office_mfa_prune_challenges: { p_older_than: "0 seconds" },
    office_mfa_activate_credential: { p_user_id: ids.u1, p_credential_id: ids.cPend, p_actor: "probe" },
    office_mfa_revoke_credential: { p_user_id: ids.u1, p_credential_id: ids.cTotp, p_actor: "probe" },
    office_mfa_consume_recovery_code_revoking: { p_user_id: ids.u1, p_code_hmac: ids.hm("u1-c"), p_actor: "probe" },
    office_mfa_webauthn_record_use: { p_user_id: ids.u1, p_credential_id: ids.cWa, p_new_count: 500 },
    office_revoke_session: { p_digest: "probe-digest-0123456789ab", p_user_id: ids.u2, p_expires_at: new Date(Date.now() + 86400000).toISOString() },
    office_is_session_revoked: { p_digest: "digest-seed-0123456789abcdef-1" },
    office_runtime_setting_write: { p_key: "office_mfa_enforcement", p_value: "off", p_actor: "probe", p_expected_version: null, p_request_id: "probe" },
    office_runtime_setting_record_attempt: { p_key: "office_mfa_enforcement", p_actor: "probe", p_request_id: "probe", p_outcome: "denied", p_reason: "probe", p_attempted: null },
  });
  refreshArgs();
  await s.section("API-2", async () => {
    reseed();
    const base2 = T.digests(st, Object.keys(before));
    for (const role of ROLES) for (const [fn, args] of Object.entries(CALL_ARGS)) {
      let all = true; let sample;
      for (let i = 0; i < 4; i++) { // repeated: PostgREST reuses prepared statements per pooled connection
        const r = await st.rpc(role, fn, args);
        if (r.status < 400 || (r.json && r.json.code && !["42501", "PGRST202", "PGRST301"].includes(r.json.code))) { all = false; sample = { status: r.status, body: r.text.slice(0, 200) }; break; }
      }
      s.check(`API-201-${role}-${fn}`, `${role} cannot execute ${fn} through /rpc (4 attempts)`, all, sample);
    }
    // GET form of rpc for functions with no arguments
    for (const role of ROLES) for (const fn of ["office_mfa_schema_version", "office_mfa_management_version", "office_mfa_webauthn_version", "office_session_revocation_version"]) {
      for (let i = 0; i < 6; i++) {
        const g = await st.rest(role, "GET", `/rpc/${fn}`);
        if (i === 5 || g.status < 400) { s.check(`API-202-${role}-${fn}`, `GET /rpc/${fn} as ${role} is refused (6 attempts, cached plans)`, g.status >= 400 && g.json !== 1, { status: g.status, body: g.text.slice(0, 100) }); break; }
      }
    }
    const noJwt = await st.rpc(null, "office_mfa_schema_version", {}, { token: null });
    s.check("API-203", "a request without any credential is treated as anon and refused the probe", noJwt.status >= 400 && noJwt.json !== 1, noJwt.text.slice(0, 100));
    s.eq("API-204", "no authentication state changed during the function probing", T.digests(st, Object.keys(before)), base2);
  });

  // ------------------------------------------------------------ the service role boundary works
  await s.section("API-3", async () => {
    reseed();
    const v = await st.rpc("service_role", "office_mfa_schema_version"); s.check("API-301", "service_role can call the capability probe (positive control)", v.status === 200 && v.json === 1, v.text);
    const g = await st.rest("service_role", "GET", `/admin_users?id=eq.${ids.u1}&select=id,session_generation`); s.check("API-302", "service_role reads an account row", g.status === 200 && g.json.length === 1 && g.json[0].session_generation >= 3, g.text.slice(0, 160));
    const rv = await st.rpc("service_role", "office_revoke_admin_sessions", { p_user_id: ids.u2, p_actor: "api", p_reason: "t" }); s.check("API-303", "service_role revokes sessions through the function (generation increments)", rv.status === 200 && Array.isArray(rv.json) && rv.json[0].session_generation >= 2, rv.text);
    const unk = await st.rpc("service_role", "office_revoke_admin_sessions", { p_user_id: L.uuidv4(), p_actor: "api" }); s.check("API-304", "revoking an unknown account changes nothing and returns no row", unk.status === 200 && Array.isArray(unk.json) && unk.json.length === 0, unk.text);
    const wr = await st.rpc("service_role", "office_runtime_setting_write", { p_key: "office_document_brand_name", p_value: "Brand A", p_actor: "api", p_expected_version: 0, p_request_id: "r1" }); s.check("API-305", "service_role writes a setting with compare-and-set", wr.status === 200 && wr.json.status === "ok", wr.text);
    const cf = await st.rpc("service_role", "office_runtime_setting_write", { p_key: "office_document_brand_name", p_value: "Brand B", p_actor: "api", p_expected_version: 0, p_request_id: "r2" }); s.check("API-306", "a stale expected version is a conflict", cf.status === 200 && cf.json.status === "conflict", cf.text);
    const ex = await st.rest("service_role", "GET", "/rpc/office_session_revocation_version"); s.check("API-307", "service_role GET probe works repeatedly", ex.status === 200 && ex.json === 1);
    const upd = await st.rest("service_role", "PATCH", `/admin_mfa_credentials?id=eq.${ids.cRev}`, { body: { label: "relabelled" }, headers: { Prefer: "return=representation" } });
    s.check("API-309", "service_role can update a credential row (positive control)", upd.status === 200 && upd.json.length === 1, upd.text.slice(0, 120));
    const del = await st.rest("service_role", "DELETE", `/admin_mfa_credentials?id=eq.${ids.cRev}`, { headers: { Prefer: "return=representation" } });
    s.check("API-308", "service_role cannot delete a credential row through the API (revocation is a status change)", del.status >= 400, { status: del.status, body: del.text.slice(0, 120) });
    const openapi = await st.rest("service_role", "GET", "/");
    s.check("API-310", "the schema description is reachable by service_role (positive control)", openapi.status === 200 && openapi.json && openapi.json.paths, openapi.status);
  });

  // ------------------------------------------------------------ tokens
  await s.section("API-4", async () => {
    reseed();
    const probe = (t, extra) => st.rest(null, "GET", "/admin_mfa_recovery_codes?select=id,code_hmac&limit=3", { token: t, ...extra });
    const good = await st.rest("service_role", "GET", "/admin_mfa_recovery_codes?select=id&limit=1"); s.check("API-401", "a correctly signed service_role token is accepted (positive control)", good.status === 200 && good.json.length === 1);
    const wrongKey = L.jwtSign("another-secret-another-secret-another-1", { role: "service_role", exp: L.nowSec() + 600 });
    const r1 = await probe(wrongKey); s.check("API-402", "a service_role token signed with another key is rejected", r1.status === 401, r1.status);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ role: "service_role", exp: L.nowSec() + 600 })).toString("base64url")}.`;
    const r2 = await probe(none); s.check("API-403", "an unsigned (alg none) service_role token is rejected", r2.status === 401, r2.status);
    const expired = st.jwt("service_role", { exp: L.nowSec() - 60 }); const r3 = await probe(expired); s.check("API-404", "an expired service_role token is rejected", r3.status === 401, r3.status);
    const rsa = L.jwtSign(st.jwtSecret, { role: "service_role", exp: L.nowSec() + 600 }, { alg: "HS384", typ: "JWT" }); const r4 = await probe(rsa);
    s.check("API-405", "a token whose header claims another HMAC algorithm is not accepted as service_role", r4.status === 401 || noData(r4), r4.status);
    const sup = st.jwt("supabase_admin"); const r5 = await probe(sup);
    s.check("API-406", "a token (even correctly signed) naming supabase_admin does not expose the account table", noData(r5), { status: r5.status, body: r5.text.slice(0, 120) });
    const pg = st.jwt("postgres"); const r6 = await probe(pg); s.check("API-407", "a token naming postgres does not expose the account table", noData(r6), { status: r6.status, body: r6.text.slice(0, 120) });
    const ghost = st.jwt("no_such_role"); const r7 = await probe(ghost); s.check("API-408", "a token naming a non-existent role is refused", r7.status >= 400, r7.status);
    const trunc = good.status === 200 && wrongKey.slice(0, -3) + "AAA"; const r8 = await probe(trunc); s.check("API-409", "a token with a damaged signature is rejected", r8.status === 401, r8.status);
    const hdr = await st.rest(null, "GET", "/admin_mfa_recovery_codes?select=id,code_hmac&limit=3", { token: null, headers: { apikey: st.jwt("service_role") } }); s.check("API-410", "an apikey header alone is not an authorisation (no service access through it)", noData(hdr), { status: hdr.status, body: hdr.text.slice(0, 100) });
    const role2 = await st.rest("anon", "GET", "/admin_mfa_recovery_codes?select=id,code_hmac&limit=3", { headers: { "Accept-Profile": "auth" } }); s.check("API-411", "asking for another schema profile exposes nothing", role2.status >= 400 || noData(role2), role2.status);
    const bad = await st.rest("anon", "GET", "/admin_users?select=id", { headers: { "Content-Profile": "public", Authorization: `Bearer ${st.jwt("service_role")}x` } }); s.check("API-412", "a garbled bearer token is not downgraded into privileged access", bad.status === 401 || noData(bad), bad.status);
    const claim = st.jwt("anon", { role: "anon", "request.jwt.claims": { role: "service_role" }, user_role: "service_role" }); const r9 = await probe(claim); s.check("API-413", "extra claims in an anon token do not elevate it", noData(r9), r9.text.slice(0, 120));
    const nested = L.jwtSign(st.jwtSecret, { role: "anon", app_metadata: { role: "service_role" }, exp: L.nowSec() + 600 }); const r10 = await probe(nested); s.check("API-414", "metadata claims do not elevate an anon token", noData(r10), r10.text.slice(0, 120));
  });

  // ------------------------------------------------------------ request shapes that try to widen access
  await s.section("API-5", async () => {
    reseed();
    const base5 = T.digests(st, Object.keys(before));
    for (const role of ROLES) {
      const sqlish = await st.rest(role, "GET", `/admin_users?select=id&email=eq.x'%20or%20'1'='1`); s.check(`API-501-${role}`, `${role}: an injection-style filter returns no account`, noData(sqlish));
      const order = await st.rest(role, "GET", "/admin_mfa_recovery_codes?select=code_hmac&order=code_hmac.desc&limit=1"); s.check(`API-502-${role}`, `${role}: ordering by the recovery-code hash column does not reveal it`, noData(order));
      const range = await st.rest(role, "GET", "/admin_mfa_credentials?select=secret_ciphertext", { headers: { Range: "0-99", "Range-Unit": "items" } }); s.check(`API-503-${role}`, `${role}: ranged read of ciphertext returns nothing`, noData(range));
      const csv = await st.rest(role, "GET", "/admin_mfa_recovery_codes?select=*", { headers: { Accept: "text/csv" } }); s.check(`API-504-${role}`, `${role}: a CSV export of recovery-code hashes is refused`, csv.status >= 400 || !/hmac-u/.test(csv.text), csv.text.slice(0, 100));
      const rpcGetAll = await st.rest(role, "POST", "/rpc/office_is_session_revoked", { body: { p_digest: "digest-seed-0123456789abcdef-1" } }); s.check(`API-505-${role}`, `${role}: the revoked-session oracle is closed`, rpcGetAll.status >= 400 && rpcGetAll.json !== true, rpcGetAll.text.slice(0, 100));
    }
    const root = await st.rest("anon", "GET", "/");
    const names = JSON.stringify(root.json || "");
    s.check("API-510", "the anonymous schema description does not advertise the authentication functions or credential tables", root.status >= 400 || !/office_mfa|admin_mfa_|admin_revoked_sessions|office_revoke/.test(names), { status: root.status, hit: (names.match(/office_mfa[a-z_]*|admin_mfa_[a-z_]*/g) || []).slice(0, 5) });
    const rootAuth = await st.rest("authenticated", "GET", "/");
    s.check("API-511", "the schema description for authenticated does not advertise the authentication functions or credential tables", rootAuth.status >= 400 || !/office_mfa|admin_mfa_|admin_revoked_sessions|office_revoke/.test(JSON.stringify(rootAuth.json || "")), (JSON.stringify(rootAuth.json || "").match(/office_mfa[a-z_]*|admin_mfa_[a-z_]*/g) || []).slice(0, 5));
    s.eq("API-512", "no authentication state in the MFA, challenge, session and setting tables changed during the read-shape probing", Object.fromEntries(Object.entries(T.digests(st, Object.keys(before))).filter(([k]) => k.startsWith("admin_mfa") || k.startsWith("office_") || k === "admin_revoked_sessions")), Object.fromEntries(Object.entries(base5).filter(([k]) => k.startsWith("admin_mfa") || k.startsWith("office_") || k === "admin_revoked_sessions")));
  });
});
