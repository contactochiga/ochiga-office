"use strict";
// A12 - mixed-version behaviour: the previous release (SUT_OLD_DIR) and the latest release run side by side with the same session secret and the same accounts
// (each with its own copy of the file store; a shared-database variant is in a13). Documented limitations are reported as INFO lines, not failures.
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a12-mixed-version");

suite.run(async (s) => {
  if (!L.SUT_OLD) throw new L.Blocked("SUT_OLD_DIR is not set");
  const secrets = { sessionSecret: `sess-${L.rand(24)}`, apiKey: `key-${L.rand(16)}`, apiKey2: `key2-${L.rand(16)}`, edgeToken: `edge-${L.rand(16)}`, adminEmail: `boot-${L.rand(3)}@example.test`, adminPassword: L.STRONG() };
  // 1. build accounts on the NEW release, stop it so the store is flushed, copy the store for the OLD release
  const nw = await L.startServer(s, { secrets });
  const cn = new L.Client(nw);
  const admin = await L.adminSession(cn, nw);
  const u1 = await L.makeUser(cn, admin, { role: "ochiga_staff" });
  const u2 = await L.makeUser(cn, admin, { role: "ochiga_staff" });
  const sup = await L.makeUser(cn, admin, { role: "super_admin" });
  await nw.stop();
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "a-old-store-")); s.onCleanup(() => fs.rmSync(oldDir, { recursive: true, force: true }));
  const oldStore = path.join(oldDir, "store.json"); fs.copyFileSync(nw.storePath, oldStore);
  const old = await L.startServer(s, { src: L.SUT_OLD, secrets, storePath: oldStore });
  await nw.restart();
  const co = new L.Client(old);
  const me = (client, cookie, o = {}) => client.get(P.me, { cookie, ...o });

  await s.section("both releases are running and share account state (fixture checks)", async () => {
    const hzOld = await co.get("/healthz"), hzNew = await cn.get("/healthz");
    s.check("A12-001", "both releases report ready", hzOld.status === 200 && hzNew.status === 200, [hzOld.status, hzNew.status]);
    const fromNew = await L.login(cn, u1.email, u1.password);
    const fromOld = await L.login(co, u1.email, u1.password);
    s.check("A12-003", "the same account signs in on both releases", fromNew.status === 200 && fromOld.status === 200, [fromNew.status, fromOld.status]);
    s.check("A12-004", "the token issued by the new release carries a session id; the old release's does not", !!L.decodeToken(fromNew.cookie).claims.sid && !L.decodeToken(fromOld.cookie).claims.sid);
  });

  await s.section("token compatibility in both directions", async () => {
    const fromNew = await L.login(cn, u1.email, u1.password);
    const fromOld = await L.login(co, u1.email, u1.password);
    s.check("A12-010", "a cookie issued by the NEW release is accepted by the OLD release (extra claims ignored)", (await me(co, fromNew.cookie)).status === 200);
    s.check("A12-011", "a cookie issued by the OLD release is accepted by the NEW release", (await me(cn, fromOld.cookie)).status === 200);
    const grantNew = await L.stepUp(cn, sup, "session_revocation");
    const supOnOld = await L.login(co, sup.email, sup.password);
    s.check("A12-012", "a step-up grant issued by the new release for a cookie is accepted by the old release for the same cookie (compatible)", grantNew.token ? (await co.post(P.stepUpCheck, { cookie: sup.cookie, stepUp: grantNew.token, json: { purpose: "session_revocation" } })).status === 200 : false);
    const grantOld = await L.stepUp(co, { cookie: supOnOld.cookie, password: sup.password }, "session_revocation");
    s.check("A12-013", "a step-up grant issued by the old release is accepted by the new release for the same cookie", grantOld.token ? (await cn.post(P.stepUpCheck, { cookie: supOnOld.cookie, stepUp: grantOld.token, json: { purpose: "session_revocation" } })).status === 200 : false);
    const wrong = await cn.post(P.stepUpCheck, { cookie: sup.cookie, stepUp: grantOld.token, json: { purpose: "session_revocation" } });
    s.check("A12-014", "a grant is still bound to its session across releases (grant from another session refused)", wrong.status === 403, wrong.status);
    const forgedForOld = L.mintToken("lead-agents-dev-session-secret", L.decodeToken(sup.cookie).claims);
    s.check("A12-015", "the old release also refuses a token signed with the public default secret", (await me(co, forgedForOld)).status === 401);
    const bad = L.tamperPayload(fromNew.cookie, (c0) => ({ ...c0, sid: "AAAAAAAAAAAAAAAAAAAAAA" }));
    s.check("A12-016", "a tampered new-format token is refused by both releases", (await me(cn, bad)).status === 401 && (await me(co, bad)).status === 401);
  });

  await s.section("logout across releases", async () => {
    const a = await L.login(cn, u2.email, u2.password);
    const lo = await cn.post(P.logout, { cookie: a.cookie, json: {} });
    s.check("A12-020", "new release: logout of a new-format session revokes it (revoked:true) and the copied cookie is refused", lo.body.revoked === true && (await me(cn, a.cookie)).status === 401, lo.body);
    const oldView = await me(co, a.cookie);
    console.log(`INFO A12 an older instance does not know newer revocation records: the logged-out cookie is ${oldView.status === 200 ? "STILL ACCEPTED" : "refused"} by the previous release (documented mixed-version limitation)`);
    const legacy = await L.login(co, u2.email, u2.password);
    const loLegacy = await cn.post(P.logout, { cookie: legacy.cookie, json: {} });
    s.check("A12-021", "new release: logging out a session issued by the OLD release is answered honestly (revoked:false with a reason, never a false revoked:true)", loLegacy.status === 200 && loLegacy.body.revoked === false && loLegacy.body.reason === "not_individually_revocable", loLegacy.body);
    s.check("A12-022", "the browser cookie is still cleared for a non-revocable session", L.attrsOf(loLegacy.setCookies[0] || "")["max-age"] === "0");
    const stillValid = await me(cn, legacy.cookie);
    console.log(`INFO A12 a token issued before per-session revocation existed cannot be revoked individually; after logout it is ${stillValid.status === 200 ? "still accepted until expiry or account-wide revocation" : "refused"} (documented limitation)`);
    const ra = await cn.post(`/api/lead-agents/admin/session/revoke-all`, { cookie: legacy.cookie, json: {} });
    s.check("A12-023", "account-wide revocation ends that non-individually-revocable token", ra.status === 200 && (await me(cn, legacy.cookie)).status === 401, ra.status);
    const oldLogout = await co.post(P.logout, { cookie: (await L.login(co, u1.email, u1.password)).cookie, json: {} });
    s.check("A12-024", "old release: logout makes no revocation claim in its answer (nothing to be dishonest about)", oldLogout.status === 200 && oldLogout.body.revoked !== true, oldLogout.body);
  });

  await s.section("account-wide revocation tokens carry the same claims on both releases", async () => {
    const fn = await L.login(cn, u1.email, u1.password); const fo = await L.login(co, u1.email, u1.password);
    const cnClaims = L.decodeToken(fn.cookie).claims, coClaims = L.decodeToken(fo.cookie).claims;
    s.check("A12-030", "both releases issue generation (sg), password fingerprint (pf) and the same cookie attributes", cnClaims.sg === coClaims.sg && cnClaims.pf === coClaims.pf && L.attrsOf(fn.setCookies[0])["max-age"] === L.attrsOf(fo.setCookies[0])["max-age"], { new: cnClaims, old: coClaims });
    const rev = await cn.post(`/api/lead-agents/admin/session/revoke-all`, { cookie: fn.cookie, json: {} });
    const afterNew = await me(cn, fo.cookie);
    s.check("A12-031", "after a revoke-all on the new release, the new release refuses the old-format cookie too", rev.status === 200 && afterNew.status === 401, afterNew.status);
    const afterOld = await me(co, fo.cookie);
    console.log(`INFO A12 with SEPARATE stores the previous release is unaware of the generation bump (${afterOld.status}); with a shared database it enforces generations (see a13)`);
  });

  await s.section("secrets", async () => {
    const needles = { sessionSecret: secrets.sessionSecret, apiKey: secrets.apiKey, adminPassword: secrets.adminPassword, u1: u1.password };
    s.check("A12-090", "neither release logged a secret or password", L.findLeaks(nw.logs(), needles).length === 0 && L.findLeaks(old.logs(), needles).length === 0);
  });
  s.check("A12-999", "both servers alive", nw.alive() && old.alive());
});
