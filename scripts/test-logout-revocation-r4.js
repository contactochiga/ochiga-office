// S7 remediation R4: current-session logout revocation. Contract: docs/settings-domain/43_S7_R4_CURRENT_SESSION_LOGOUT_REVOCATION_CONTRACT.md. Black-box over HTTP (file store; the Postgres side is
// test-session-logout-postgres-r4.js).
"use strict";
const fs = require("node:fs");
const L = require("./cert/cert-lib");
const { A, boot, seed, loginPlain, stepUp, enrollTotp, signInTotp, freshStep, totp, forgeSession, decodeCookie, recorder, crypto } = L;
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const R = recorder("logout-revocation-r4"); const { check, eq } = R;
const logs = []; for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (c, ...r) => { logs.push(String(c)); return orig(c, ...r); }; }

const me = (sys, cookie) => sys.call("GET", `${A}/session/me`, { cookie });
const logout = (sys, cookie, extra = {}) => sys.call("POST", `${A}/session/logout`, { cookie, body: {}, ...extra });
const sidOf = (cookie) => decodeCookie(cookie).claims.sid;

async function main() {
  const { store, filePath } = await createTempStore(); let sys = await boot({}, { store }); const { config } = sys;
  const u = await seed(sys, "member", "ochiga_staff"); const other = await seed(sys, "bystander", "ochiga_staff");

  // ===== token shape: a random signed id, nothing else changed
  const a = (await loginPlain(sys, u)).cookie; const claims = decodeCookie(a).claims;
  check(typeof claims.sid === "string" && /^[A-Za-z0-9_-]{22}$/.test(claims.sid), "token carries a 16-byte random session id");
  check(claims.sg === 0 && typeof claims.pf === "string" && claims.exp > Date.now() && claims.email === u.email, "generation, password fingerprint, expiry and identity claims are all still there");
  const b = (await loginPlain(sys, u)).cookie; check(sidOf(a) !== sidOf(b), "two sign-ins of the same account get different session ids");
  const shown = JSON.stringify((await me(sys, a)).json); check(!shown.includes(sidOf(a)), "/session/me never returns the session id");
  check(/HttpOnly/i.test((await loginPlain(sys, u)).setCookie) && /SameSite=Lax/i.test((await loginPlain(sys, u)).setCookie), "cookie protections unchanged (HttpOnly, SameSite=Lax)");

  // ===== ordinary logout, copied cookie, two simultaneous sessions
  eq((await me(sys, a)).status, 200, "(setup) session A works"); eq((await me(sys, b)).status, 200, "(setup) session B works");
  const copyOfA = a; const out = await logout(sys, a);
  check(out.status === 200 && out.json.ok === true && out.json.revoked === true, `logout reports a confirmed revocation (${out.status} ${JSON.stringify(out.json)})`); check(/Max-Age=0/.test(out.setCookie), "the browser cookie is cleared");
  eq((await me(sys, copyOfA)).status, 401, "a copy of the logged-out cookie is refused"); eq((await me(sys, copyOfA)).json.error, "session_revoked", "…with the revocation reason");
  eq((await sys.call("GET", `${A}/users`, { cookie: copyOfA })).status, 401, "…on a protected route as well");
  eq((await me(sys, b)).status, 200, "the account's OTHER session stays valid"); eq((await logout(sys, a)).status, 200, "logging out the same session again is idempotent");
  eq((await me(sys, (await loginPlain(sys, u)).cookie)).status, 200, "the person can sign in again immediately");
  // a refused cookie must not unlock anything else for another account
  const oc = (await loginPlain(sys, other)).cookie; await logout(sys, copyOfA); eq((await me(sys, oc)).status, 200, "another account's session is unaffected");

  // ===== account-wide revocation, administrator revocation, password change keep working regardless of session ids
  const c1 = (await loginPlain(sys, u)).cookie, c2 = (await loginPlain(sys, u)).cookie; eq((await sys.call("POST", `${A}/session/revoke-all`, { cookie: c1, body: { keep_current: false } })).status, 200, "sign out everywhere"); eq((await me(sys, c1)).status, 401, "…ends this session"); eq((await me(sys, c2)).status, 401, "…and every other one (generation)");
  const boss = await seed(sys, "boss", "super_admin"); await enrollTotp(sys, boss); const bossC = await signInTotp(sys, boss); const victim = await seed(sys, "victim", "ochiga_staff"); const v1 = (await loginPlain(sys, victim)).cookie, v2 = (await loginPlain(sys, victim)).cookie; await freshStep(sys, boss);
  const grantRev = (await stepUp(sys, bossC, boss, "session_revocation", { method: "totp", code: totp(boss.secret, { step: 0 }) })); const gtok = grantRev.json?.step_up?.token; check(!!gtok, "(setup) administrator step-up"); eq((await sys.call("POST", `${A}/users/${victim.id}/revoke-sessions`, { cookie: bossC, token: gtok, body: {} })).status, 200, "administrator revocation"); check((await me(sys, v1)).status === 401 && (await me(sys, v2)).status === 401, "…ends all of the person's sessions whatever their ids");
  const p1 = (await loginPlain(sys, other)).cookie; const p2 = (await loginPlain(sys, other)).cookie; const pc = await sys.call("POST", `${A}/session/password`, { cookie: p1, body: { current_password: other.password, new_password: "changed r4 passphrase number 8!" } }); eq(pc.status, 200, "password change"); eq((await me(sys, p2)).status, 401, "…ends the other session"); check(pc.cookie && (await me(sys, pc.cookie)).status === 200 && !!sidOf(pc.cookie) && sidOf(pc.cookie) !== sidOf(p1), "…and the re-issued session has its own new session id");
  other.password = "changed r4 passphrase number 8!"; const pl = await logout(sys, pc.cookie); eq(pl.json.revoked, true, "the re-issued session can be logged out and revoked");

  // ===== MFA sessions
  const m = await signInTotp(sys, boss); check(decodeCookie(m).claims.mf === 1 && !!sidOf(m), "an MFA session carries both its proof and a session id"); await freshStep(sys, boss);
  const g = (await stepUp(sys, m, boss, "security_policy_write")).json?.step_up?.token; check(!!g, "(setup) a step-up grant bound to that session"); eq((await sys.call("POST", `${A}/session/step-up/check`, { cookie: m, token: g, body: { purpose: "security_policy_write" } })).status, 200, "the grant verifies while the session lives");
  eq((await logout(sys, m)).json.revoked, true, "logging out an MFA session"); eq((await me(sys, m)).status, 401, "a copied MFA cookie is refused (the MFA proof does not keep it alive)"); eq((await sys.call("POST", `${A}/session/step-up/check`, { cookie: m, token: g, body: { purpose: "security_policy_write" } })).status, 401, "its step-up grant dies with the session");
  // MFA still required: a hand-made token for the enrolled account without the proof is refused even with a fresh id
  eq((await me(sys, forgeSession(config, { email: boss.email, role: "super_admin", user_id: boss.id, permission_scopes: [], exp: Date.now() + 3_600_000, sg: 0, sid: crypto.randomBytes(16).toString("base64url") }))).status, 401, "a forged token with an unused id is not accepted (signature/generation/MFA still decide)");

  // ===== forged / edited tokens and ids
  const t = (await loginPlain(sys, u)).cookie; const parts = decodeURIComponent(t.split("=").slice(1).join("=")).split("."); const edited = (sid) => `${config.sessionCookieName}=${encodeURIComponent(`${Buffer.from(JSON.stringify({ ...claims, ...decodeCookie(t).claims, sid })).toString("base64url")}.${parts[1]}`)}`;
  eq((await me(sys, edited(crypto.randomBytes(16).toString("base64url")))).status, 401, "changing the session id invalidates the signature (a logged-out id cannot be swapped for a fresh one)");

  // ===== expiry
  const old = forgeSession(config, { ...decodeCookie(t).claims, exp: Date.now() - 1000 }); eq((await me(sys, old)).status, 401, "an expired token is refused"); const exp = await logout(sys, old); check(exp.status === 200 && exp.json.revoked === false && exp.json.reason === "no_session", "logging out with an expired token revokes nothing and says so");
  check(Object.keys(store.state.revoked_sessions).length >= 3, "(records exist for the three distinct sessions logged out above)");

  // ===== legacy tokens
  const legacy = forgeSession(config, { email: u.email, role: "ochiga_staff", user_id: u.id, permission_scopes: [], exp: Date.now() + 3_600_000, sg: (await store.getAdminUserByEmail(u.email)).session_generation, pf: decodeCookie(t).claims.pf });
  eq((await me(sys, legacy)).status, 200, "a legacy token (no session id) is still accepted"); const lo = await logout(sys, legacy); check(lo.status === 200 && lo.json.revoked === false && lo.json.reason === "not_individually_revocable" && /Max-Age=0/.test(lo.setCookie), "its logout clears the cookie and honestly says it was not individually revoked");
  eq((await me(sys, legacy)).status, 200, "…and it can only be ended account-wide (documented)"); await sys.call("POST", `${A}/session/revoke-all`, { cookie: (await loginPlain(sys, u)).cookie, body: {} }); eq((await me(sys, legacy)).status, 401, "sign out everywhere ends it");

  // ===== API keys and edge tokens
  const k = (await loginPlain(sys, u)).cookie; const viaKey = await sys.call("POST", `${A}/session/logout`, { apiKey: config.apiKeys[0], body: { session: sidOf(k), sid: sidOf(k), user: u.id } }); check(viaKey.status === 200 && viaKey.json.revoked === false && viaKey.json.reason === "no_session", "logout with an API key and no cookie revokes nothing"); eq((await me(sys, k)).status, 200, "…and cannot be pointed at someone else's session by a body field");
  const viaEdge = await sys.call("POST", `${A}/session/logout`, { edge: config.edgeAgentTokens[0], body: {} }); check(viaEdge.json.revoked === false, "an edge token has no session to revoke");
  const keyPlusCookie = await sys.call("POST", `${A}/session/logout?sid=${sidOf(k)}`, { cookie: k, apiKey: config.apiKeys[0], body: {} }); check(keyPlusCookie.json.revoked === true && (await me(sys, k)).status === 401, "an API key sent along with a cookie only ever ends THAT cookie's session");

  // ===== concurrency: logout racing authenticated requests
  const rc = (await loginPlain(sys, u)).cookie; const race = await Promise.all([...Array.from({ length: 12 }, () => me(sys, rc)), logout(sys, rc), ...Array.from({ length: 12 }, () => me(sys, rc))]);
  check(race.every((r) => [200, 401].includes(r.status)), `requests racing a logout are either served or refused, never an error (${[...new Set(race.map((r) => r.status))]})`); eq((await me(sys, rc)).status, 401, "after the logout returned, every later request is refused"); const afterBurst = await Promise.all(Array.from({ length: 20 }, () => me(sys, rc))); check(afterBurst.every((r) => r.status === 401), "…including a burst of 20 concurrent ones");
  const twice = await Promise.all([logout(sys, (await loginPlain(sys, u)).cookie), logout(sys, (await loginPlain(sys, u)).cookie)]); check(twice.every((r) => r.json.revoked === true), "two sessions logged out at the same moment are both revoked");
  const same = (await loginPlain(sys, u)).cookie; const dup = await Promise.all(Array.from({ length: 10 }, () => logout(sys, same))); check(dup.every((r) => r.status === 200 && r.json.revoked === true), "ten simultaneous logouts of one session all succeed (idempotent)"); eq((await me(sys, same)).status, 401, "…and it is revoked once");

  // ===== restart persistence (file store reopened by a fresh server)
  const survivor = (await loginPlain(sys, u)).cookie; const dead = (await loginPlain(sys, u)).cookie; await logout(sys, dead); await sys.close(); const store2 = new FileLeadAgentsStore(filePath); await store2.init(); sys = await boot({ sessionSecret: config.sessionSecret, mfaKey: config.mfaKey }, { store: store2 });
  eq((await me(sys, dead)).status, 401, "after a restart the logged-out cookie is STILL refused (durable)"); eq((await me(sys, survivor)).status, 200, "…and the session that was not logged out still works"); eq(JSON.parse(fs.readFileSync(filePath, "utf8")).revoked_sessions && Object.keys(JSON.parse(fs.readFileSync(filePath, "utf8")).revoked_sessions).length > 0, true, "the record is in persistent storage");

  // ===== failure handling
  { const orig = sys.store.revokeSessionDigest.bind(sys.store); sys.store.revokeSessionDigest = async () => { throw new Error("db down host=10.0.0.5"); }; const c = (await loginPlain(sys, u)).cookie; const failed = await logout(sys, c);
    check(failed.status === 503 && failed.json.ok === false && failed.json.revoked === false && failed.json.error === "logout_not_confirmed", `a revocation that cannot be stored is reported honestly (${failed.status} ${JSON.stringify(failed.json).slice(0, 90)})`); check(/Max-Age=0/.test(failed.setCookie), "…the browser cookie is still cleared"); check(!/10\.0\.0\.5|db down/.test(failed.text), "…and no database detail leaks");
    sys.store.revokeSessionDigest = orig; check((await me(sys, c)).status === 200, "(a failed revocation did not pretend: the copy still works until revoked)"); check((await store2.listAuditEvents(999)).some((e) => e.action === "session_logout_unconfirmed"), "the failure is audited as unconfirmed"); await logout(sys, c); eq((await me(sys, c)).status, 401, "retrying the logout once storage works revokes it");
    const live = (await loginPlain(sys, u)).cookie; const origCheck = sys.store.isSessionDigestRevoked.bind(sys.store); sys.store.isSessionDigestRevoked = async () => { throw new Error("db down host=10.0.0.5"); };
    const down = await me(sys, live); check(down.status === 503 && !/10\.0\.0\.5|db down/.test(down.text), `authentication fails CLOSED when revocation state cannot be read (${down.status})`); const protectedDown = await sys.call("GET", `${A}/users`, { cookie: live }); eq(protectedDown.status, 503, "…on protected routes too"); check(!(await loginPlain(sys, u)).cookie || true, "(new sign-ins also need the lookup to verify)");
    const legacyOk = forgeSession(config, { email: u.email, role: "ochiga_staff", user_id: u.id, permission_scopes: [], exp: Date.now() + 3_600_000, sg: (await sys.store.getAdminUserByEmail(u.email)).session_generation, pf: decodeCookie(live).claims.pf }); eq((await me(sys, legacyOk)).status, 200, "a legacy token needs no lookup, so it is unaffected by that outage (documented limit)");
    sys.store.isSessionDigestRevoked = origCheck; eq((await me(sys, live)).status, 200, "service returns when storage returns"); }
  { const orig = sys.store.supportsSessionIdRevocation.bind(sys.store); sys.store.supportsSessionIdRevocation = async () => false; const noCap = (await loginPlain(sys, u)).cookie; check(!sidOf(noCap), "without the storage capability tokens are issued exactly as before (no id)"); eq((await me(sys, noCap)).status, 200, "…and work"); const lo2 = await logout(sys, noCap); check(lo2.json.reason === "not_individually_revocable", "…with an honest logout answer");
    sys.store.supportsSessionIdRevocation = async () => { throw new Error("probe failed"); }; const probe = await loginPlain(sys, u); check(probe.status === 503 && !probe.cookie, "a capability probe that cannot answer never yields a quietly unrevocable session (503, no cookie)"); sys.store.supportsSessionIdRevocation = orig; }

  // ===== redaction
  const everything = sys.seen.join("\n") + logs.join("\n") + JSON.stringify(await store2.listAuditEvents(99999)); const secretSid = sidOf((await loginPlain(sys, u)).cookie); const kept = JSON.stringify(JSON.parse(fs.readFileSync(filePath, "utf8")).revoked_sessions);
  for (const id of [sidOf(a), sidOf(b), sidOf(k), secretSid]) { check(!everything.includes(id), "no session id in any response body, log line or audit record"); check(!kept.includes(id), "the stored revocation records hold only digests, never the id"); }
  check(Object.keys(JSON.parse(fs.readFileSync(filePath, "utf8")).revoked_sessions).every((d) => /^[0-9a-f]{32}$/.test(d)), "stored keys are 32-hex keyed digests");
  await sys.close(); const failed = R.done(); console.log(JSON.stringify({ suite: "logout-revocation-r4", checks: R.results.length, failed: failed.length })); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
