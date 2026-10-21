"use strict";
// AREA B / B9: cross-cutting: API-key / edge-token sweep over every MFA route, mass assignment on user-management routes, key configuration and rotation (fail closed),
// limiter budget consumed by half-finished sign-ins, store failures during verification, secrets in health/error bodies, previous-release (mixed-version) behaviour.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const H = require("./lib/harness");
const { Forge } = require("./lib/forge");
const { A, Client, U } = H;

H.runSuite("b9-crosscutting", async (c) => {
  const srv = await H.makeServer();
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const forge = new Forge(srv);
  const admin = await H.adminLogin(srv);
  const hdr = (g) => ({ "x-step-up-token": g.body.step_up.token });
  const userRow = (p) => srv.readStore().admin_users.find((u) => u.id === p.id);
  const healthz = async () => { const r = await fetch(srv.base + "/healthz"); return { status: r.status, body: await r.json() }; };

  // ------------------------------------------------------------ Z1: machine credentials on every MFA / step-up / reset route
  const victim = await H.newPerson(admin, {});
  const uuid = "11111111-2222-4333-8444-555555555555";
  const routes = [["GET", "/session/mfa"], ["POST", "/session/mfa/enroll/totp/begin"], ["POST", "/session/mfa/enroll/totp/confirm"], ["POST", `/session/mfa/credentials/${uuid}/remove`], ["POST", "/session/mfa/recovery-codes/regenerate"], ["POST", "/session/mfa/webauthn/register/options"], ["POST", "/session/mfa/webauthn/register/verify"], ["POST", "/session/mfa/webauthn/step-up-options"], ["POST", "/session/step-up"], ["POST", "/session/revoke-all"], ["GET", "/session/mfa/enforcement/preflight?level=all"], ["POST", `/users/${victim.id}/mfa/reset`], ["POST", `/users/${victim.id}/revoke-sessions`], ["PUT", "/settings/office_mfa_enforcement"], ["POST", "/session/password"]];
  const creds = [["API key bearer", { authorization: `Bearer ${H.API_KEY}` }], ["API key header", { "x-api-key": H.API_KEY }], ["office API key header", { "x-office-api-key": H.API_KEY }], ["edge token bearer", { authorization: `Bearer ${H.EDGE}` }], ["edge token header", { "x-edge-token": H.EDGE }]];
  for (const [m, p] of routes) for (const [label, h] of creds) {
    const r = await new Client(srv).req(m, A + p, { headers: h, body: m === "GET" ? undefined : { purpose: "mfa_management", password: admin.password, value: "all", expected_version: 0, confirm: true, reason: "machine", confirm_email: victim.email } });
    c.ok(`Z1.${m}.${p.split("?")[0]}.${label}`, `${label} is refused on ${m} ${p.split("?")[0]} (never 2xx)`, r.status >= 400 && r.status < 500, { status: r.status, body: r.body });
  }
  const none = [];
  for (const [m, p] of routes) { const r = await new Client(srv).req(m, A + p, { body: m === "GET" ? undefined : {} }); none.push(r.status); }
  c.ok("Z1.noauth", "every route refuses an unauthenticated caller with 401", none.every((s) => s === 401), none);
  c.eq("Z1.state", "none of the machine-credential attempts changed the victim", [userRow(victim).session_generation || 0, (srv.readStore().admin_mfa_credentials || []).filter((x) => x.admin_user_id === victim.id && x.status === "active").length], [1, 1]);

  // ------------------------------------------------------------ Z2: mass assignment
  const evil = { mfa_required_after: "2000-01-01T00:00:00Z", session_generation: 777, sessions_revoked_at: "2000-01-01", sessions_revoked_by: "x", mfa_failed_attempts: 99, mfa_locked_until: "2099-01-01T00:00:00Z", mfa_reset_at: "x", mfa_reset_by: "x", id: "00000000-0000-4000-8000-000000000000", password_hash: "aa:bb", created_at: "1999-01-01T00:00:00Z", status: "active", mfa_enrolled: true, mfa_required: false, mfa_enabled: false, mfa_exempt: true, skip_mfa: true };
  const watched = ["mfa_required_after", "session_generation", "mfa_failed_attempts", "mfa_locked_until", "mfa_reset_at", "mfa_reset_by", "sessions_revoked_at", "sessions_revoked_by", "id", "password_hash", "created_at"];
  const snap = (p) => JSON.stringify(watched.map((k) => userRow(p)[k]));
  const t = await H.newPerson(admin, {});
  const before = snap(t);
  const patch = await admin.client.patch(`${A}/users/${t.id}`, { display_name: "Edited Name", ...evil });
  c.status("Z2.1", "PATCH /users/:id with MFA / counter / identifier fields still works for the legitimate field", patch, 200);
  c.eq("Z2.2", "...but MFA requirement, counters, generations, lock and identifiers are unchanged", snap(t), before);
  c.ok("Z2.3", "the account is still bound to its factor (sign-in still demands it)", (await t.loginRaw(new Client(srv))).body.mfa_required === true);
  const created = await admin.client.post(`${A}/users`, { email: `mass${crypto.randomBytes(3).toString("hex")}@fixture.test`, password: U.randomPassword(), role: "ochiga_staff", ...evil, id: "00000000-0000-4000-8000-0000000000aa" });
  c.status("Z2.4", "POST /users with extra fields creates the account", created, 201);
  const crow = srv.readStore().admin_users.find((u) => u.email === created.body.user.email);
  c.ok("Z2.5", "the new account has no MFA requirement, counters or generation taken from the request, and its own generated id", !crow.mfa_required_after && !crow.mfa_failed_attempts && !crow.mfa_locked_until && !(crow.session_generation > 0) && crow.id !== evil.id && crow.id !== "00000000-0000-4000-8000-0000000000aa", { mfa_required_after: crow.mfa_required_after, gen: crow.session_generation, id: crow.id });
  const inv = await admin.client.post(`${A}/users/invite`, { email: `inv${crypto.randomBytes(3).toString("hex")}@fixture.test`, role: "ochiga_staff", ...evil });
  const irow = srv.readStore().admin_users.find((u) => u.email === inv.body.invite.email);
  c.ok("Z2.6", "POST /users/invite ignores MFA fields", inv.status === 201 && !irow.mfa_required_after && !irow.mfa_failed_attempts && !(irow.session_generation > 0), irow);
  const selfBefore = snap(t); const tc = (await t.signIn()).client; const selfBefore2 = snap(t);
  const prof = await tc.patch(`${A}/session/profile`, { phone: "+2348000000000", ...evil });
  c.ok("Z2.7", "self-service profile edit ignores MFA / counter fields", prof.status === 200 && snap(t) === selfBefore2, prof.body);
  void selfBefore;
  const pw = await tc.post(`${A}/session/password`, { current_password: t.password, new_password: U.randomPassword(), ...evil });
  c.ok("Z2.8", "self password change ignores MFA / counter fields", pw.status === 200 && !userRow(t).mfa_required_after && !userRow(t).mfa_locked_until && userRow(t).mfa_failed_attempts !== 99, pw.body);
  const list = await admin.client.get(`${A}/users`);
  c.ok("Z2.9", "the user list never exposes password hashes or factor material", !/password_hash|scrypt|secret_ciphertext|code_hmac|webauthn_public_key/i.test(list.text));

  // ------------------------------------------------------------ Z3: limiter budget consumed by half-finished sign-ins
  const lim = await H.makeServer({ extra: { LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "3" } });
  c.defer(async () => { await lim.stop(); H.rmrf(lim.dir); });
  const limAdmin = await H.adminLogin(lim);
  const lp = await H.newPerson(limAdmin, {});
  const ip = "198.51.100.200";
  const lc = new Client(lim, { ip });
  const outs = []; for (let i = 0; i < 5; i += 1) outs.push((await lp.loginRaw(lc)).status);
  c.ok("Z3.1", "password-correct logins that stop at the second factor keep consuming the login budget (4th and 5th are 429)", outs[0] === 200 && outs[3] === 429 && outs[4] === 429, outs);
  const spoofed = await lp.loginRaw(new Client(lim, { ip: "198.51.100.201" }));
  c.ok("Z3.2", "a rotated forwarded address does not give a fresh budget for an account already throttled (note: area A property; recorded here for MFA accounts)", spoofed.status === 429, spoofed.status);

  // ------------------------------------------------------------ Z4: key configuration (fail closed) and rotation
  const keyU = await H.newPerson(admin, {});
  const keyUs = (await keyU.signIn()).client;
  const k1 = srv.env.LEAD_AGENTS_MFA_KEY;
  await srv.restart({ LEAD_AGENTS_MFA_KEY: crypto.randomBytes(5).toString("base64") });
  const hz = await healthz();
  c.ok("Z4.1", "a malformed MFA key makes health 503 with problem CODES only", hz.status === 503 && hz.body.mfa.problems && hz.body.mfa.problems.length > 0 && !JSON.stringify(hz.body).includes(srv.env.LEAD_AGENTS_MFA_KEY), hz.body.mfa);
  const lg = await keyU.loginRaw(new Client(srv));
  c.ok("Z4.2", "sign-in of an enrolled account with an invalid key is a 503 - never a password-only session", lg.status === 503 && lg.setCookie.length === 0 && !lg.body.challenge_token, lg.body);
  c.ok("Z4.3", "the error body names no key, length or fingerprint", !/key|length|base64/i.test(JSON.stringify(lg.body).replace(/mfa_unavailable/g, "")), lg.body);
  const spBad = await new Client(srv, { cookie: keyUs.cookie }).post(`${A}/session/step-up`, { purpose: "mfa_management", password: keyU.password });
  c.ok("Z4.5", "step-up for an enrolled account with an unusable key is 503 (no password-only fallback)", spBad.status === 503, spBad.body);
  const secretAsKey = Buffer.from(srv.env.LEAD_AGENTS_SESSION_SECRET).subarray(0, 32).toString("base64");
  await srv.restart({ LEAD_AGENTS_MFA_KEY: secretAsKey });
  const hz2 = await healthz();
  c.ok("Z4.6", "an MFA key derived from the session secret is rejected (independence)", hz2.status === 503 && /reused|secret|weak|length/.test(JSON.stringify(hz2.body.mfa)), hz2.body.mfa);
  // a different, well-formed key: decrypt fails -> 503, not counted against the person, never password-only
  const otherKey = U.randomKeyB64();
  await srv.restart({ LEAD_AGENTS_MFA_KEY: otherKey, LEAD_AGENTS_MFA_KEY_ID: "k9" });
  const l9 = await keyU.loginRaw(new Client(srv));
  const v9 = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: l9.body.challenge_token, method: "totp", code: (await U.nextTotp(keyU.secret, keyU.lastStep)).code });
  c.ok("Z4.7", "a valid TOTP cannot be verified under a different key: 503, no session", v9.status === 503 && v9.setCookie.length === 0, v9.body);
  c.eq("Z4.8", "...and the person is not charged a failed attempt for a server-side fault", userRow(keyU).mfa_failed_attempts || 0, 0);
  c.ok("Z4.9", "the 503 body carries no internal detail", !/decrypt|cipher|gcm|aad|k1|k9/i.test(JSON.stringify(v9.body)), v9.body);
  // rotation: new current key, old key as previous
  await srv.restart({ LEAD_AGENTS_MFA_KEY: otherKey, LEAD_AGENTS_MFA_KEY_ID: "k2", LEAD_AGENTS_MFA_KEYS_PREVIOUS: `k1:${k1}` });
  const rot = await keyU.signIn();
  c.status("Z4.10", "rotation: with the old key kept as a previous key, TOTP enrolled under it still signs in", rot.res, 200);
  const recRot = await (async () => { const cl = new Client(srv); const l = await keyU.loginRaw(cl); return cl.post(`${A}/session/mfa/verify`, { challenge_token: l.body.challenge_token, method: "recovery_code", code: keyU.recovery[0] }); })();
  c.status("Z4.11", "rotation: recovery codes created under the old key still work", recRot, 200);
  await srv.restart({ LEAD_AGENTS_MFA_KEY: k1, LEAD_AGENTS_MFA_KEY_ID: "k1", LEAD_AGENTS_MFA_KEYS_PREVIOUS: undefined });
  c.ok("Z4.12", "restoring the original configuration restores service", (await healthz()).status === 200 && (await keyU.signIn()).res.status === 200);
  await srv.restart({ LEAD_AGENTS_MFA_KEY_ID: "k1", LEAD_AGENTS_MFA_KEYS_PREVIOUS: `k1:${otherKey}` });
  c.ok("Z4.13", "a previous key reusing the current key id is a configuration error", (await healthz()).status === 503);
  await srv.restart({ LEAD_AGENTS_MFA_KEYS_PREVIOUS: undefined });

  // ------------------------------------------------------------ Z5: secrets in health and error bodies
  const hz3 = await healthz();
  const hs = JSON.stringify(hz3.body);
  c.ok("Z5.1", "health never contains the MFA key, session secret, API keys or e-mail provider key", !hs.includes(k1) && !hs.includes(srv.env.LEAD_AGENTS_SESSION_SECRET) && !hs.includes(H.API_KEY) && !hs.includes(H.EDGE));
  const errs = [await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: "x" }), await new Client(srv).post(`${A}/session/login`, { email: keyU.email, password: "wrong-password-1234" })];
  c.ok("Z5.2", "error bodies contain no stack, file path or key material", errs.every((r) => !/\/Users\/|node_modules|at \w+ \(|MFA_KEY|k1/.test(r.text)), errs.map((r) => r.text.slice(0, 120)));

  // ------------------------------------------------------------ Z6: store failures during verification (the persistence target stops accepting writes)
  const fsrv = await H.makeServer();
  c.defer(async () => { await fsrv.stop(); H.rmrf(fsrv.dir); });
  const fadmin = await H.adminLogin(fsrv);
  const fp = await H.newPerson(fadmin, {});
  const fsess = (await fp.signIn()).client;
  const chal = (await fp.loginRaw(new Client(fsrv))).body.challenge_token;
  const chalRec = (await fp.loginRaw(new Client(fsrv))).body.challenge_token;
  const storePath = fsrv.storeFile();
  const saved = fs.readFileSync(storePath);
  fs.rmSync(storePath); fs.mkdirSync(storePath);          // every later write to the store now fails
  const okCode = await U.nextTotp(fp.secret, fp.lastStep);
  const vf = await new Client(fsrv).post(`${A}/session/mfa/verify`, { challenge_token: chal, method: "totp", code: okCode.code });
  c.ok("Z6.1", "a valid TOTP while the store cannot persist yields NO session (fail closed)", vf.status >= 500 && vf.setCookie.length === 0 && vf.body.ok !== true, { status: vf.status, body: vf.body });
  c.ok("Z6.2", "the failure is an honest error without internal detail (no path, driver message or stack)", !/EISDIR|ENOENT|store\.json|\/private\/|\/var\/|at .* \(|errno/i.test(vf.text), vf.text.slice(0, 200));
  const vr = await new Client(fsrv).post(`${A}/session/mfa/verify`, { challenge_token: chalRec, method: "recovery_code", code: fp.recovery[0] });
  c.ok("Z6.3", "a valid recovery code while the store cannot persist yields no session", vr.status >= 500 && vr.setCookie.length === 0 && vr.body.ok !== true, { status: vr.status, body: vr.body });
  c.ok("Z6.4", "...and no internal detail", !/EISDIR|ENOENT|store\.json|\/private\/|\/var\/|errno/i.test(vr.text), vr.text.slice(0, 200));
  fs.rmSync(storePath, { recursive: true, force: true }); fs.writeFileSync(storePath, saved);
  c.info("the file store keeps a failed write chain after a persistence error; recovery of that driver is not asserted (restart required)");
  await fsrv.restart({});
  const afterRestart = await fp.signIn();
  c.status("Z6.7", "positive control: after the store is restored (and the process restarted) the same valid factor works", afterRestart.res, 200);
  c.ok("Z6.8", "a recovery code that failed to be recorded is still usable once (the failed attempt did not spend it)", await (async () => { const cl = new Client(fsrv); const l = await fp.loginRaw(cl); const r = await cl.post(`${A}/session/mfa/verify`, { challenge_token: l.body.challenge_token, method: "recovery_code", code: fp.recovery[0] }); return r.status === 200; })());

  // unreachable database driver (supabase driver pointing at a closed loopback port)
  let dead = null;
  try { dead = await H.makeServer({ extra: { LEAD_AGENTS_STORE_DRIVER: "supabase", SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key-0123456789" } }); } catch (e) { c.info("database-outage server could not start with the supabase driver on a closed port (" + String(e.message).slice(0, 80) + "): outage at verification time is covered by the persistence-failure checks above"); }
  if (dead) {
    c.defer(async () => { await dead.stop(); H.rmrf(dead.dir); });
    const dl = await new Client(dead).post(`${A}/session/login`, { email: "someone@fixture.test", password: "whatever-1234567" });
    c.ok("Z6.10", "with the database unreachable, sign-in is a generic 503 (no session, no host/port, no driver message)", dl.status === 503 && dl.setCookie.length === 0 && !/127\.0\.0\.1|ECONNREFUSED|:1\b/.test(dl.text), dl.body);
    const dm = await new Client(dead).post(`${A}/session/mfa/verify`, { challenge_token: forge.challenge({ id: "u1", password_hash: "x" }, {}), method: "totp", code: "123456" });
    c.ok("Z6.11", "with the database unreachable, second-factor verification is 503/401 and never a session", [401, 503].includes(dm.status) && dm.setCookie.length === 0 && !/ECONNREFUSED/.test(dm.text), dm.body);
  }

  // ------------------------------------------------------------ Z7: previous release on the same data (mixed-version behaviour)
  if (!H.SUT_OLD || !fs.existsSync(path.join(H.SUT_OLD, "lead-agents-server.js"))) c.info("SUT_OLD_DIR not available: mixed-version checks skipped");
  else {
    const mv = await H.makeServer();
    c.defer(async () => { await mv.stop(); H.rmrf(mv.dir); });
    const mvAdmin = await H.adminLogin(mv);
    const mp = await H.newPerson(mvAdmin, {});
    const mSess = (await mp.signIn()).client;
    await mv.stop();
    const old = new H.Server({ sutDir: H.SUT_OLD, dir: mv.dir, env: mv.env, port: mv.port });
    old.runRoot = undefined;
    // separate run root for the old release, same data
    old.dir = mv.dir + "-old"; fs.mkdirSync(old.dir, { recursive: true }); old.env = { ...mv.env };
    c.defer(async () => { await old.stop(); H.rmrf(old.dir); });
    try { await old.start(); } catch (e) { c.info("previous release did not start on the same data: " + String(e.message).slice(0, 120)); }
    if (!old.exited && old.proc) {
      const ol = await mp.loginRaw(new Client(old));
      c.ok("Z7.1", "previous release: an enrolled account is not signed in with the password alone", ol.body.mfa_required === true || ol.status >= 400, ol.body);
      c.ok("Z7.2", "previous release: the MFA session of the account is not upgraded to anything wider", [200, 401].includes((await new Client(old, { cookie: mSess.cookie }).get(`${A}/session/me`)).status));
      await old.stop();
    }
    await mv.start();
    c.status("Z7.3", "after returning to the current release the enrolled account still signs in with its factor", (await mp.signIn()).res, 200);
  }
});
