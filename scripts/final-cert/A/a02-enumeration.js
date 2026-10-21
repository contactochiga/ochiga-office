"use strict";
// A02 - account enumeration: login, password-reset request, reset confirm, invite accept. Status, body, headers, timing, throttle-count symmetry.
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a02-enumeration");

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const headerNames = (r) => [...r.headers.keys()].filter((h) => !["date", "x-request-id", "content-length", "connection", "keep-alive", "x-login-ratelimit-reset", "x-login-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-remaining"].includes(h)).sort().join(",");

suite.run(async (s) => {
  const srv = await L.startServer(s);
  const c = new L.Client(srv);
  const admin = await L.adminSession(c, srv);
  const active = await L.makeUser(c, admin, { role: "ochiga_staff" });
  const inactive = await L.makeUser(c, admin, { role: "ochiga_staff" });
  await c.patch(`${P.users}/${inactive.id}`, { cookie: admin.cookie, json: { status: "inactive" } });
  const removed = await L.makeUser(c, admin, { role: "ochiga_staff" });
  await c.post(`${P.users}/${removed.id}/remove`, { cookie: admin.cookie, json: {} });
  const invEmail = `invitee-${L.rand(3)}@example.test`;
  await c.post(P.invite, { cookie: admin.cookie, json: { email: invEmail, role: "ochiga_staff" } });
  const BAD = "Wrong-passphrase-for-test-77";

  await s.section("login: status, body and headers identical for every failure cause", async () => {
    const cases = {
      unknown: await L.login(c, `ghost-${L.rand(4)}@example.test`, BAD),
      wrong: await L.login(c, active.email, BAD),
      inactiveWrongPw: await L.login(c, inactive.email, BAD),
      inactiveRightPw: await L.login(c, inactive.email, inactive.password),
      removedWrongPw: await L.login(c, removed.email, BAD),
      removedRightPw: await L.login(c, removed.email, removed.password),
      invited: await L.login(c, invEmail, BAD),
      bootstrapWrong: await L.login(c, srv.secrets.adminEmail, BAD),
      emptyPassword: await L.login(c, active.email, ""),
      noPasswordField: await c.post(P.login, { json: { email: active.email } }),
    };
    const ref = cases.unknown;
    s.check("A02-001", "reference failure (unknown account) is 401", ref.status === 401, ref.status);
    for (const [name, r] of Object.entries(cases)) {
      if (name === "unknown") continue;
      const sameStatusExpected = !["noPasswordField"].includes(name);
      if (sameStatusExpected) {
        s.check(`A02-010-${name}`, `login failure "${name}" has the same status as an unknown account`, r.status === ref.status, { ref: ref.status, got: r.status });
        s.check(`A02-011-${name}`, `login failure "${name}" has a byte-identical body to an unknown account`, r.text === ref.text, { ref: ref.text, got: r.text });
        s.check(`A02-012-${name}`, `login failure "${name}" has the same response header names as an unknown account`, headerNames(r) === headerNames(ref), { ref: headerNames(ref), got: headerNames(r) });
        s.check(`A02-013-${name}`, `login failure "${name}" sets no cookie`, r.setCookies.length === 0);
      }
    }
    s.check("A02-014", "failure body does not distinguish accounts by wording (no 'inactive', 'removed', 'invited', 'not found', 'exists', 'disabled')", !/inactive|removed|invited|not found|no such|exist|disabled|deactivat|suspend|locked/i.test(ref.text), ref.text);
  });

  await s.section("login: timing symmetry", async () => {
    const N = 14;
    const t = { unknown: [], wrong: [], inactive: [], removed: [] };
    await L.login(c, active.email, BAD); // warm up the hash path
    for (let i = 0; i < N; i++) {
      t.unknown.push((await L.login(c, `ghost-${L.rand(5)}@example.test`, BAD)).ms);
      t.wrong.push((await L.login(c, active.email, BAD)).ms);
      t.inactive.push((await L.login(c, inactive.email, inactive.password)).ms);
      t.removed.push((await L.login(c, removed.email, BAD)).ms);
    }
    const m = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, median(v)]));
    const within = (a, b) => a / b >= 0.5 && a / b <= 2.0;
    s.check("A02-020", "median time: unknown account vs wrong password for a real account within 0.5x-2x (password hashed in both)", within(m.unknown, m.wrong), m);
    s.check("A02-021", "median time: deactivated account (correct password) vs unknown account within 0.5x-2x", within(m.inactive, m.unknown), m);
    s.check("A02-022", "median time: removed account vs unknown account within 0.5x-2x", within(m.removed, m.unknown), m);
    s.check("A02-023", "an unknown-account attempt is not an order of magnitude faster than a real one (hash work present)", m.unknown > m.wrong * 0.25, m);
  });

  await s.section("login: throttle count symmetry (same budget whether or not the account exists)", async () => {
    const countUntil429 = async (email) => {
      for (let i = 1; i <= 80; i++) { const r = await L.login(c, email, BAD); if (r.status === 429) return i; if (r.status !== 401) return -r.status; }
      return 999;
    };
    const target = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const nReal = await countUntil429(target.email);
    const nGhost = await countUntil429(`ghost-${L.rand(5)}@example.test`);
    s.check("A02-030", "an existing account and an unknown account become throttled after the same number of failures", nReal === nGhost && nReal > 0 && nReal < 999, { nReal, nGhost });
    const r1 = await L.login(c, target.email, BAD);
    const t1 = await L.login(c, target.email, target.password);
    s.check("A02-032", "throttled existing account refuses even the correct password with the same 429 body as a wrong one", t1.status === 429 && t1.text === r1.text, { t1: t1.status, body1: t1.text, body0: r1.text });
  });

  await s.section("password-reset request is neutral", async () => {
    const send = (email) => c.post(P.resetRequest, { json: { email } });
    const known = await send(active.email);
    const refs = {
      unknown: await send(`ghost-${L.rand(4)}@example.test`),
      inactive: await send(inactive.email),
      removed: await send(removed.email),
      invited: await send(invEmail),
      empty: await send(""),
      weird: await send("not an email"),
      upper: await send(active.email.toUpperCase()),
    };
    s.check("A02-040", "reset request for an active account answers 202 {ok:true}", known.status === 202 && known.body && known.body.ok === true, known.text);
    for (const [name, r] of Object.entries(refs)) {
      s.check(`A02-041-${name}`, `reset request for "${name}" returns the same status and body as for an active account`, r.status === known.status && r.text === known.text, { known: [known.status, known.text], got: [r.status, r.text] });
      s.check(`A02-042-${name}`, `reset request for "${name}" returns the same header names`, headerNames(r) === headerNames(known), { known: headerNames(known), got: headerNames(r) });
    }
    s.check("A02-043", "reset response contains no token, link or delivery metadata", !/token|url|http|delivered|email_delivery|provider/i.test(known.text.replace(/If that Office account exists, a reset link has been sent\./, "")), known.text);
    s.check("A02-044", "reset response sets no cookie (a reset request never signs anyone in)", known.setCookies.length === 0);
    const N = 12; const ta = [], tu = [];
    await send(active.email);
    for (let i = 0; i < N; i++) { ta.push((await send(active.email)).ms); tu.push((await send(`ghost-${L.rand(5)}@example.test`)).ms); }
    const ma = median(ta), mu = median(tu);
    s.check("A02-045", "reset request timing: active account vs unknown account not distinguishable (ratio within 2x or difference under 5 ms)", (ma / mu <= 2 && mu / ma <= 2) || Math.abs(ma - mu) < 5, { active_ms: ma, unknown_ms: mu });
    const bodies = [{}, null, [], "x", 5, { email: { a: 1 } }, { email: ["a@b.c"] }, { email: null }];
    for (const [i, b] of bodies.entries()) {
      const r = await c.post(P.resetRequest, { body: JSON.stringify(b), headers: { "content-type": "application/json" } });
      s.check(`A02-046-${i}`, `reset request with body ${JSON.stringify(b)} is a clean non-5xx answer`, r.status > 0 && r.status < 500 && !/TypeError|Cannot read|\bat .*\(/.test(r.text), { status: r.status, text: r.text.slice(0, 160) });
    }
    const getM = await c.get(P.resetRequest);
    s.check("A02-047", "GET on reset request is 405", getM.status === 405, getM.status);
  });

  await s.section("reset confirm and invite accept: failure causes are indistinguishable", async () => {
    const mk = async (u, hours) => (await c.post(`${P.users}/${u.id}/reset`, { cookie: admin.cookie, json: { expires_in_hours: hours } })).body;
    const used = await mk(active, 1);
    const pw = L.STRONG();
    const first = await c.post(P.resetConfirm, { json: { token: used.reset_token, new_password: pw } });
    s.check("A02-050", "positive control: a valid reset token sets the password", first.status === 200, first.text);
    const expired = await mk(active, -1);
    const confirm = (token) => c.post(P.resetConfirm, { json: { token, new_password: L.STRONG() } });
    const unknownTok = await confirm(L.rand(32));
    const usedTok = await confirm(used.reset_token);
    const expiredTok = await confirm(expired.reset_token);
    const shortTok = await confirm("a");
    s.check("A02-051", "unknown token is refused with a generic 400", unknownTok.status === 400 && /invalid_or_expired_reset/.test(unknownTok.text), unknownTok.text);
    for (const [n, r] of Object.entries({ used: usedTok, expired: expiredTok, short: shortTok })) {
      s.check(`A02-052-${n}`, `"${n}" reset token gives the same status and body as an unknown token`, r.status === unknownTok.status && r.text === unknownTok.text, { ref: unknownTok.text, got: r.text });
    }
    const badPolicy = await c.post(P.resetConfirm, { json: { token: L.rand(32), new_password: "short" } });
    s.check("A02-053", "an invalid token never reveals password-policy results (token is checked first)", badPolicy.status === unknownTok.status && badPolicy.text === unknownTok.text, badPolicy.text);
    const invitee = (await c.get(`${P.users}`, { cookie: admin.cookie })).body.users.find((u) => u.email === invEmail);
    const inv = await c.post(P.invite, { cookie: admin.cookie, json: { email: invEmail, role: "ochiga_staff" } });
    const token = new URL(inv.body.invite_url).searchParams.get("token");
    const accept = (t, p) => c.post(P.inviteAccept, { json: { token: t, password: p || L.STRONG() } });
    const unkInv = await accept(L.rand(32));
    s.check("A02-054", "unknown invite token is refused with a generic 400", unkInv.status === 400 && /invalid_or_expired_invite/.test(unkInv.text), unkInv.text);
    const okInv = await accept(token);
    s.check("A02-055", "positive control: a valid invite token activates the account and signs in", okInv.status === 200 && okInv.cookie, okInv.text);
    const reuse = await accept(token);
    s.check("A02-056", "a used invite token gives the same answer as an unknown one", reuse.status === unkInv.status && reuse.text === unkInv.text, { ref: unkInv.text, got: reuse.text });
    void invitee;
  });

  await s.section("public endpoints do not reveal account existence", async () => {
    const pairs = [["me without cookie", () => c.get(P.me)], ["logout without cookie", () => c.post(P.logout, {})]];
    for (const [i, [name, fn]] of pairs.entries()) { const r = await fn(); s.check(`A02-06${i}`, `${name} is a clean answer`, r.status > 0 && r.status < 500, r.status); }
    const a = await c.post(P.mfaVerify, { json: { challenge_token: "x.y", method: "totp", code: "000000" } });
    const b = await c.post(P.mfaVerify, { json: { challenge_token: L.rand(40), method: "totp", code: "123456" } });
    s.check("A02-065", "mfa/verify answers garbage challenges identically (no oracle)", a.status === b.status && a.text === b.text, { a: a.text, b: b.text });
  });

  const leaks = L.findLeaks(srv.logs(), { sessionSecret: srv.secrets.sessionSecret, apiKey: srv.secrets.apiKey, adminPassword: srv.secrets.adminPassword, active: active.password });
  s.check("A02-090", "server log contains no passwords or secrets after enumeration traffic", leaks.length === 0, leaks);
  s.check("A02-999", "server process alive at the end of the suite", srv.alive());
});
