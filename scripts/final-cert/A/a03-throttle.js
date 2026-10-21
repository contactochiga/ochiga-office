"use strict";
// A03 - login throttling and abuse resistance: burst, correct password after the threshold, forwarding-header spoofing, per-account behaviour,
// concurrency, window expiry, reset-request / step-up / password-change guessing, general API limiter, two instances.
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a03-throttle");

const BAD = "Wrong-passphrase-for-throttle-9";
const noRotate = (srv) => new L.Client(srv, { rotate: false });

suite.run(async (s) => {
  // ---------------------------------------------------------------- instance 1: defaults (10 per address+account, 50 failures per account, 15 min)
  const srv = await L.startServer(s);
  const c = noRotate(srv);
  const crot = new L.Client(srv); // rotating-address client for fixture work
  const admin = await L.adminSession(crot, srv);
  const mk = (extra = {}) => L.makeUser(crot, admin, { role: "ochiga_staff", ...extra });

  await s.section("burst from one address against one account", async () => {
    const u = await mk();
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await L.login(c, u.email, BAD)).status);
    s.check("A03-001", "the first 10 wrong attempts are answered 401 (not yet throttled)", statuses.every((x) => x === 401), statuses);
    const eleventh = await L.login(c, u.email, BAD);
    s.check("A03-002", "the 11th attempt from the same address is throttled with 429", eleventh.status === 429, eleventh.status);
    const rightAfter = await L.login(c, u.email, u.password);
    s.check("A03-003", "the CORRECT password after the threshold is also refused with 429 (no bypass)", rightAfter.status === 429 && !rightAfter.cookie && rightAfter.setCookies.length === 0, { status: rightAfter.status, cookie: !!rightAfter.cookie });
    s.check("A03-004", "the 429 answer is identical whatever was sent (same body for right and wrong password)", rightAfter.text === eleventh.text, { right: rightAfter.text, wrong: eleventh.text });
    s.check("A03-005", "the 429 body is generic (no account state, no password hint)", /login_rate_limit_exceeded/.test(eleventh.text) && !/inactive|exist|password is|correct/i.test(eleventh.text.replace(/sign-in attempts/, "")), eleventh.text);
    const other = await mk();
    const otherRes = await L.login(c, other.email, other.password);
    s.check("A03-006", "a different account from the same address is not blocked by this account's budget (positive control)", otherRes.status === 200, otherRes.status);
    const viaProbe = await c.get(P.me, { cookie: u.cookie });
    s.check("A03-007", "throttling a login does not end the user's existing session", viaProbe.status === 200, viaProbe.status);
    const rl = eleventh.headers.get("x-login-ratelimit-reset");
    s.check("A03-008", "the throttled answer says when to retry (x-login-ratelimit-reset is a future timestamp)", rl && Date.parse(rl) > Date.now(), rl);
  });

  await s.section("budget semantics: success resets, case variants share the budget", async () => {
    const u = await mk();
    for (let i = 0; i < 8; i++) await L.login(c, u.email, BAD, { xff: "203.0.113.20" });
    const ok = await L.login(c, u.email, u.password, { xff: "203.0.113.20" });
    s.check("A03-010", "a correct login after 8 failures succeeds (still under the threshold)", ok.status === 200, ok.status);
    const after = [];
    for (let i = 0; i < 9; i++) after.push((await L.login(c, u.email, BAD, { xff: "203.0.113.20" })).status);
    s.check("A03-011", "a successful sign-in resets the per-address counter (9 more failures are still answered 401)", after.every((x) => x === 401), after);
    const v = await mk();
    const variants = [v.email, v.email.toUpperCase(), ` ${v.email}`, v.email + " ", v.email.toUpperCase(), v.email, v.email.toUpperCase(), v.email, ` ${v.email} `, v.email, v.email.toUpperCase()];
    const sts = []; for (const e of variants) sts.push((await L.login(c, e, BAD, { xff: "203.0.113.21" })).status);
    s.check("A03-012", "case and whitespace variants of the e-mail share one budget (11th attempt throttled)", sts[10] === 429 && sts.slice(0, 10).every((x) => x === 401), sts);
    const w = await mk();
    let all200 = true;
    for (let i = 0; i < 22; i++) { const r = await L.login(c, w.email, w.password, { xff: "203.0.113.22" }); if (r.status !== 200) { all200 = false; break; } }
    s.check("A03-013", "22 consecutive correct sign-ins from one address are never throttled (legitimate use is not blocked)", all200);
  });

  await s.section("forwarding-header spoofing", async () => {
    const u = await mk();
    // rotate X-Forwarded-For on every attempt: each looks like a new address
    const sts = [];
    for (let i = 0; i < 60; i++) { const r = await L.login(c, u.email, BAD, { xff: `192.0.2.${i + 1}` }); sts.push(r.status); if (r.status === 429) break; }
    const firstThrottle = sts.indexOf(429) + 1;
    s.check("A03-020", "rotating X-Forwarded-For cannot give unlimited attempts: the account is throttled within 55 attempts", firstThrottle > 0 && firstThrottle <= 55, { firstThrottle, attempts: sts.length });
    const correct = await L.login(c, u.email, u.password, { xff: "192.0.2.250" });
    s.check("A03-021", "after the account threshold a fresh spoofed address with the CORRECT password is still refused", correct.status === 429 && !correct.cookie, correct.status);
    const correct2 = await L.login(c, u.email, u.password);
    s.check("A03-022", "the account threshold also applies to the real address (no forwarding header)", correct2.status === 429 && !correct2.cookie, correct2.status);

    const v = await mk();
    const sts2 = [];
    for (let i = 0; i < 14; i++) sts2.push((await L.login(c, v.email, BAD, { xff: `198.51.100.${i + 1}` })).status);
    s.check("A03-023", "the per-address budget (10) is not refreshed by a forged X-Forwarded-For: attempts 11..14 with new fake addresses are throttled", sts2.slice(10).every((x) => x === 429), sts2);

    for (const hdr of ["x-real-ip", "forwarded", "cf-connecting-ip", "true-client-ip", "x-client-ip", "x-originating-ip", "x-cluster-client-ip", "fastly-client-ip", "x-forwarded", "x-forwarded-host", "client-ip"]) {
      const w = await mk();
      const st = [];
      for (let i = 0; i < 12; i++) st.push((await L.login(c, w.email, BAD, { headers: { [hdr]: hdr === "forwarded" ? `for=192.0.2.${i + 1}` : `192.0.2.${i + 1}` } })).status);
      s.check(`A03-024-${hdr}`, `rotating the ${hdr} header does not give a fresh budget (12th attempt throttled)`, st[10] === 429 || st[11] === 429, st);
    }
    const x = await mk();
    const st3 = [];
    for (let i = 0; i < 12; i++) st3.push((await L.login(c, x.email, BAD, { xff: `203.0.113.${i + 1}, 10.0.0.1, 10.0.0.2` })).status);
    s.check("A03-025", "a multi-hop X-Forwarded-For chain whose first entry rotates does not refresh the per-address budget", st3[10] === 429 || st3[11] === 429, st3);
    const z = await mk();
    const huge = "1.1.1.1, " + "2.2.2.2, ".repeat(5000);
    const hr = await L.login(c, z.email, BAD, { xff: huge });
    s.check("A03-027", "a very large X-Forwarded-For header is handled (no 5xx)", hr.status > 0 && hr.status < 500, hr.status);
    s.check("A03-028", "an empty X-Forwarded-For falls back to the socket address (12 wrong attempts: 11th throttled)", await (async () => { const q = await mk(); const stq = []; for (let i = 0; i < 12; i++) stq.push((await L.login(c, q.email, BAD, { headers: { "x-forwarded-for": "" } })).status); return stq[10] === 429; })());
    s.check("A03-029", "a constant garbage X-Forwarded-For value is treated as one client (12 wrong attempts: 11th throttled)", await (async () => { const q = await mk(); const stq = []; for (let i = 0; i < 12; i++) stq.push((await L.login(c, q.email, BAD, { xff: "not-an-ip" })).status); return stq[10] === 429; })());
  });

  await s.section("concurrent bursts", async () => {
    const u = await mk();
    const res = await Promise.all(Array.from({ length: 40 }, () => L.login(c, u.email, BAD, { xff: "203.0.113.77" })));
    const non429 = res.filter((r) => r.status !== 429);
    s.check("A03-030", "40 concurrent wrong attempts from one address: at most 10 are evaluated, the rest throttled", non429.length <= 10 && res.every((r) => r.status === 401 || r.status === 429), res.map((r) => r.status).join(","));
    const after = await L.login(c, u.email, u.password, { xff: "203.0.113.77" });
    s.check("A03-031", "after the concurrent burst the correct password is still refused (429)", after.status === 429, after.status);
    const v = await mk();
    const res2 = await Promise.all(Array.from({ length: 140 }, (_, i) => L.login(c, v.email, BAD, { xff: `100.64.${Math.floor(i / 250)}.${(i % 250) + 1}` })));
    const evaluated = res2.filter((r) => r.status === 401).length;
    s.check("A03-032", "140 concurrent wrong attempts from 140 forged addresses: no more than 55 are evaluated against the account (account cap holds under concurrency)", evaluated <= 55 && res2.every((r) => r.status === 401 || r.status === 429), { evaluated, throttled: res2.filter((r) => r.status === 429).length });
    const finalTry = await L.login(c, v.email, v.password, { xff: "100.64.200.200" });
    s.check("A03-033", "afterwards the correct password from a new forged address is refused (429)", finalTry.status === 429, finalTry.status);
    const w = await mk();
    const okMix = await Promise.all([...Array.from({ length: 6 }, () => L.login(c, w.email, w.password, { xff: "203.0.113.88" })), ...Array.from({ length: 4 }, () => L.login(c, w.email, BAD, { xff: "203.0.113.88" }))]);
    s.check("A03-034", "a mix of 6 correct and 4 wrong concurrent attempts (10 total) yields no 5xx and no spurious 429", okMix.every((r) => r.status === 200 || r.status === 401), okMix.map((r) => r.status));
  });

  await s.section("other credential-guessing surfaces are throttled", async () => {
    const u = await mk({ role: "super_admin" });
    // password change: guess the current password with a valid session
    const sts = [];
    for (let i = 0; i < 25; i++) { const r = await c.post(P.password, { cookie: u.cookie, json: { current_password: BAD + i, new_password: L.STRONG() }, xff: `203.0.113.${100 + (i % 200)}` }); sts.push(r.status); }
    s.check("A03-040", "guessing the current password through /session/password is throttled (a 429 appears within 25 wrong guesses)", sts.includes(429), sts.join(","));
    const stepSts = [];
    for (let i = 0; i < 25; i++) { const r = await c.post(P.stepUp, { cookie: u.cookie, json: { password: BAD + i, purpose: "security_policy_write" }, xff: `192.0.2.${100 + i}` }); stepSts.push(r.status); }
    s.check("A03-041", "guessing the password through step-up with rotating forged addresses is throttled (a 429 appears within 25 wrong guesses)", stepSts.includes(429), stepSts.join(","));
    const stepFixed = [];
    const u2 = await mk({ role: "super_admin" });
    for (let i = 0; i < 14; i++) stepFixed.push((await c.post(P.stepUp, { cookie: u2.cookie, json: { password: BAD + i, purpose: "security_policy_write" }, xff: "192.0.2.222" })).status);
    s.check("A03-042", "step-up guessing from one address is throttled after 10 wrong attempts (contract S7.2)", stepFixed[10] === 429 || stepFixed.slice(10).includes(429), stepFixed.join(","));
    const goodAfter = await c.post(P.stepUp, { cookie: u2.cookie, json: { password: u2.password, purpose: "security_policy_write" }, xff: "192.0.2.222" });
    s.check("A03-043", "the correct step-up password from the throttled address is refused too", goodAfter.status === 429, goodAfter.status);
    const goodOther = await c.post(P.stepUp, { cookie: u2.cookie, json: { password: u2.password, purpose: "security_policy_write" }, xff: "192.0.2.223" });
    s.check("A03-044", "positive control: the correct step-up password from another address works", goodOther.status === 200, goodOther.status);
  });

  await s.section("password-reset request throttling", async () => {
    const v = await mk();
    const sts = [];
    for (let i = 0; i < 14; i++) sts.push((await c.post(P.resetRequest, { json: { email: v.email }, xff: "203.0.113.150" })).status);
    s.check("A03-050", "reset requests from one address for one account: first 10 accepted (202), 11th throttled (429)", sts.slice(0, 10).every((x) => x === 202) && sts[10] === 429, sts.join(","));
    const w = await mk();
    const sts2 = [];
    for (let i = 0; i < 60; i++) { const r = await c.post(P.resetRequest, { json: { email: w.email }, xff: `192.0.2.${i + 1}` }); sts2.push(r.status); }
    s.check("A03-051", "reset requests for one account with rotating forged addresses are bounded (some 429 within 60 requests)", sts2.includes(429), { accepted: sts2.filter((x) => x === 202).length });
    const store = L.readStore(srv);
    const pending = store ? (store.password_reset_tokens || []).filter((t) => t.email === w.email && t.status === "pending").length : -1;
    s.check("A03-052", "an anonymous caller cannot create more than 20 pending reset tokens for one account", pending >= 0 && pending <= 20, { pending });
  });

  s.check("A03-090", "no secret or password in the server log after the throttle traffic", L.findLeaks(srv.logs(), { sessionSecret: srv.secrets.sessionSecret, apiKey: srv.secrets.apiKey, adminPassword: srv.secrets.adminPassword }).length === 0);
  s.check("A03-091", "server alive after throttle traffic", srv.alive());

  // ---------------------------------------------------------------- instance 2: short window, throttling lifts after the window
  await s.section("window expiry (explicit readiness, no fixed sleep)", async () => {
    const srv2 = await L.startServer(s, { env: { LEAD_AGENTS_LOGIN_RATE_LIMIT_WINDOW_MS: "3000", LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "4" } });
    const c2 = noRotate(srv2); const adm = await L.adminSession(new L.Client(srv2), srv2);
    const u = await L.makeUser(new L.Client(srv2), adm, {});
    const sts = []; for (let i = 0; i < 6; i++) sts.push((await L.login(c2, u.email, BAD, { xff: "203.0.113.9" })).status);
    s.check("A03-060", "configured budget of 4 is honoured (5th attempt throttled)", sts.slice(0, 4).every((x) => x === 401) && sts[4] === 429, sts);
    let lifted = false; const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const r = await L.login(c2, u.email, u.password, { xff: "203.0.113.9" }); if (r.status === 200) { lifted = true; break; } if (r.status !== 429) break; await L.sleep(250); }
    s.check("A03-061", "after the window elapses the correct password signs in again (throttle is temporary, not permanent)", lifted);
  });

  // ---------------------------------------------------------------- instance 3: general API limiter and forwarded header
  await s.section("general API rate limiter and forged forwarding header", async () => {
    const srv3 = await L.startServer(s, { env: { LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "20", LEAD_AGENTS_OFFICE_RATE_LIMIT_WINDOW_MS: "60000" } });
    const c3 = noRotate(srv3);
    const fixed = []; for (let i = 0; i < 30; i++) fixed.push((await c3.get(P.users, { apiKey: srv3.secrets.apiKey })).status);
    s.check("A03-070", "positive control: the general limiter throttles one address after its budget (429 seen in 30 requests, budget 20)", fixed.includes(429), fixed.join(","));
    const spoof = []; for (let i = 0; i < 60; i++) spoof.push((await c3.get(P.users, { apiKey: srv3.secrets.apiKey, xff: `192.0.2.${i + 1}` })).status);
    s.check("A03-071", "forging X-Forwarded-For does not escape the general limiter (some 429 among 60 requests with 60 fake addresses)", spoof.includes(429), spoof.filter((x) => x === 200).length + " of 60 answered 200");
    const wrongKey = []; for (let i = 0; i < 40; i++) wrongKey.push((await c3.get(P.users, { apiKey: "wrong-" + i, xff: `192.0.2.${i + 1}` })).status);
    s.check("A03-072", "invalid API keys are refused (401) and never accepted regardless of address rotation", wrongKey.every((x) => x === 401 || x === 429), wrongKey.join(","));
  });

  // ---------------------------------------------------------------- two instances
  await s.section("two server instances", async () => {
    const shared = { adminEmail: `boot-${L.rand(3)}@example.test`, adminPassword: L.STRONG(), sessionSecret: `sess-${L.rand(24)}`, apiKey: `key-${L.rand(16)}` };
    const a = await L.startServer(s, { secrets: shared });
    const b = await L.startServer(s, { secrets: shared });
    const ca = noRotate(a), cb = noRotate(b);
    const stA = []; for (let i = 0; i < 12; i++) stA.push((await L.login(ca, shared.adminEmail, BAD, { xff: "203.0.113.200" })).status);
    s.check("A03-080", "instance A throttles the address after 10 failures", stA[10] === 429, stA);
    const stB = []; for (let i = 0; i < 3; i++) stB.push((await L.login(cb, shared.adminEmail, shared.adminPassword, { xff: "203.0.113.200" })).status);
    s.check("A03-081", "an address already throttled on instance A is also throttled on instance B (limiter state is shared or equivalent)", stB.every((x) => x === 429), stB);
    const burstB = []; for (let i = 0; i < 30; i++) burstB.push((await L.login(cb, shared.adminEmail, BAD, { xff: `203.0.113.${i + 1}` })).status);
    const burstA = []; for (let i = 0; i < 30; i++) burstA.push((await L.login(ca, shared.adminEmail, BAD, { xff: `203.0.114.${i + 1}` })).status);
    const total401 = burstA.concat(burstB).filter((x) => x === 401).length;
    s.check("A03-082", "the per-account failure budget (50) holds across two instances (at most 55 evaluated failures in total)", total401 <= 55, { evaluatedAcrossInstances: total401 });
  });
});
