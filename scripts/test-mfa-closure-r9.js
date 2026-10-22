// S7 R9: (1) an enrolled account is never treated as unenrolled on unverifiable factor evidence; (2) the mailbox code of forced enrolment has a persisted, shared, spoof-proof, bounded budget.
// File store + server over HTTP; the PostgreSQL / PostgREST counterpart is scripts/test-mfa-closure-postgres-r9.js.
"use strict";
const fs = require("node:fs");
const L = require("./cert/cert-lib");
const { createMfaCrypto } = require("../src/lead-agents/mfa-crypto");
const { A, boot, seed, recorder } = L;
const R = recorder("mfa-closure-r9"); const { check, eq } = R;
const post = (sys, path, body, headers) => sys.call("POST", `${A}/session/${path}`, { body, headers });

async function challengeFor(sys, user, purpose = "enroll", ttlMs) {
  const row = await sys.store.getAdminUserByEmail(user.email);
  return createMfaCrypto(sys.config).issueChallengeToken({ user: row, purpose, ttlMs });
}
const codeFor = (sys, token) => { const lib = createMfaCrypto(sys.config); const row = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()); return lib.mailboxCodeFor({ jti: row.jti, uid: row.uid }); };

async function main() {
  // ===== (1) factor evidence, file store
  { const sys = await boot({}, {}); const plain = await seed(sys, "plain", "ochiga_staff"); const enrolled = await seed(sys, "enrolled", "ochiga_staff");
    sys.store.state.admin_mfa_credentials.push({ id: "cr1", admin_user_id: enrolled.id, type: "totp", status: "active", label: "t" });
    eq(await sys.store.hasActiveMfa(plain.id), false, "E1 verified zero: an unenrolled account reports no factor");
    eq(await sys.store.hasActiveMfa(enrolled.id), true, "E1 an enrolled account reports a factor");
    const pl = await post(sys, "login", { email: plain.email, password: plain.password }); check(pl.status === 200 && !!pl.cookie, "E1 legitimate unenrolled sign-in is unaffected (200 + session)");
    const en = await post(sys, "login", { email: enrolled.email, password: enrolled.password }); check(en.status === 200 && !en.cookie && !!(en.json && en.json.challenge_token), "E1 an enrolled account gets a second-factor challenge, no session");
    const real = sys.store.state.admin_mfa_credentials;
    for (const [name, corrupt] of [["object instead of a list", {}], ["list containing null", [null]], ["string", "[]"], ["null", null]]) {
      sys.store.state.admin_mfa_credentials = corrupt;
      const r = await post(sys, "login", { email: enrolled.email, password: enrolled.password });
      check(r.status === 503 && !r.cookie && !(r.json && r.json.challenge_token) && !/TypeError|Cannot read/.test(r.text), `E2 corrupt factor population (${name}): 503, no session, no detail (${r.status})`);
      let threw = false; try { await sys.store.hasActiveMfa(enrolled.id); } catch { threw = true; } check(threw, `E2 hasActiveMfa refuses to answer for ${name}`);
    }
    sys.store.state.admin_mfa_credentials = real; await sys.close(); }

  // ===== (2) mailbox code budget
  { const sys = await boot({}, {}); const u = await seed(sys, "mb", "ochiga_staff"); const v = await seed(sys, "mbother", "ochiga_staff");
    const ch = await challengeFor(sys, u); const good = codeFor(sys, ch.token); const bad = good === "00000000" ? "00000001" : "00000000";
    const verify = (token, code, headers) => post(sys, "mfa/enroll/email-verify", { challenge_token: token, email_code: code }, headers);
    const s = [];
    for (let i = 0; i < 8; i++) s.push((await verify(ch.token, bad, { "x-forwarded-for": `10.9.${i}.1` })).status);
    eq(JSON.stringify(s.slice(0, 5)), JSON.stringify([401, 401, 401, 401, 401]), "B1 the first five wrong guesses for a challenge are evaluated (401), whatever the forged forwarding header");
    check(s.slice(5).every((x) => x === 429), `B1 every later attempt is refused (${s.slice(5)})`);
    const after = await verify(ch.token, good, { "x-forwarded-for": "198.51.100.1" }); eq(after.status, 429, "B2 even the CORRECT code is refused once the challenge budget or the account lock is spent");
    const row = fs.readFileSync(sys.store.filePath || sys.store.storePath || sys.store.path, "utf8"); check(/admin_mfa_mailbox_attempts/.test(row) && !new RegExp(good).test(row), "B3 the budget is persisted with the state (survives a restart) and never stores the code");
    const other = await challengeFor(sys, v); const ok = await verify(other.token, codeFor(sys, other.token), {}); eq(ok.status, 200, "B4 another account's challenge is unaffected (cross-account isolation)");
    const replay = await verify(other.token, codeFor(sys, other.token), {}); check(replay.status === 429 || replay.status === 401, `B5 replay: the same correct code is accepted once; the second use is refused (${replay.status})`);
    check(!/token_hash|admin_mfa|attempts/.test(replay.text), "B6 refusals disclose no budget internals");
    // account lock: a NEW challenge for the same account after five failures is still locked (the lock lives on the account, not on the challenge or the address)
    const ch2 = await challengeFor(sys, u); const locked = await verify(ch2.token, codeFor(sys, ch2.token), { "x-forwarded-for": "203.0.113.77" });
    eq(locked.status, 429, "B7 a fresh challenge does not reset the account lock: the correct code is refused while it holds (no budget reset by re-challenging)");
    await sys.close(); }

  // ===== concurrency: a burst of guesses is evaluated at most `max` times
  { const sys = await boot({}, {}); const u = await seed(sys, "burst", "ochiga_staff"); const ch = await challengeFor(sys, u); const bad = "12345678" === codeFor(sys, ch.token) ? "12345679" : "12345678";
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => post(sys, "mfa/enroll/email-verify", { challenge_token: ch.token, email_code: bad }, { "x-forwarded-for": `10.8.${i}.1` })));
    const evaluated = rs.filter((r) => r.status === 401).length, refused = rs.filter((r) => r.status === 429).length;
    check(evaluated <= 5 && evaluated + refused === 30 && !rs.some((r) => r.status >= 500), `C1 30 simultaneous guesses: at most 5 are evaluated (${evaluated}), the rest refused (${refused}), no 5xx`);
    await sys.close(); }

  // ===== expiry: an expired challenge is refused identically to an unknown one
  { const sys = await boot({}, {}); const u = await seed(sys, "exp", "ochiga_staff"); const ch = await challengeFor(sys, u, "enroll", 1000); await new Promise((r) => setTimeout(r, 1300));
    const r = await post(sys, "mfa/enroll/email-verify", { challenge_token: ch.token, email_code: codeFor(sys, ch.token) }); check(r.status === 401 || r.status === 400, `X1 an expired challenge cannot be verified, even with the right code (${r.status})`); await sys.close(); }

  // ===== store outage: fail closed
  { const sys = await boot({}, {}); const u = await seed(sys, "outage", "ochiga_staff"); const ch = await challengeFor(sys, u); const orig = sys.store.recordMailboxAttempt.bind(sys.store);
    sys.store.recordMailboxAttempt = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:5432"); };
    const r = await post(sys, "mfa/enroll/email-verify", { challenge_token: ch.token, email_code: codeFor(sys, ch.token) });
    check(r.status === 503 && !/ECONN|127\.0\.0\.1/.test(r.text), `O1 attempt store down: 503 with the CORRECT code (never evaluated without a budget), no detail (${r.status})`);
    sys.store.recordMailboxAttempt = orig; await sys.close(); }

  const failed = R.done(); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
