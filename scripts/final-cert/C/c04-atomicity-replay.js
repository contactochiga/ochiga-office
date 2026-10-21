"use strict";
// AREA C / C04: atomicity, single use and replay protection under many parallel database connections, and the same through the real application.
// Every single-use operation must have exactly ONE winner; every failure must roll back completely; recovery-code consumption and credential activation must never deadlock.
const L = require("./lib");
const F = require("./appfix");
const P = require("./par");

const s = new L.Suite("c04-atomicity-replay", "C");
const N = 16; // parallel connections per race

s.main(async () => {
  const fx = await F.buildStack(s, { tag: "c04", instances: 1 });
  const st = fx.st; const adm = fx.admin;
  const q = async (sql) => { const r = await adm.query(sql); if (r.error) throw new Error(`sql: ${r.error.message} in ${sql.slice(0, 120)}`); return r.rows; };
  const scalar = async (sql) => { const r = await q(sql); return r[0] ? r[0][0] : null; };
  const num = async (sql) => Number(await scalar(sql));
  const par = (n, f, o) => P.barrier(st, n, f, o);
  const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);

  const newUser = async (role = "viewer") => (await L.seedUser(adm, { role })).id;
  const addTotp = async (uid, { status = "active", step = 0 } = {}) => {
    const id = L.uuidv4();
    await q(`insert into admin_mfa_credentials (id, admin_user_id, type, label, status, secret_ciphertext, secret_nonce, secret_key_id, totp_last_step, activated_at) values ('${id}','${uid}','totp','t','${status}','CT','NO','k1',${step},${status === "active" ? "now()" : "null"})`);
    return id;
  };
  const addWa = async (uid, { status = "active", count = 0 } = {}) => {
    const id = L.uuidv4();
    await q(`insert into admin_mfa_credentials (id, admin_user_id, type, label, status, webauthn_credential_id, webauthn_public_key, webauthn_sign_count, activated_at) values ('${id}','${uid}','webauthn','w','${status}',decode('${L.randomHex(16)}','hex'),decode('${L.randomHex(32)}','hex'),${count},${status === "active" ? "now()" : "null"})`);
    return id;
  };
  const addCodes = async (uid, hmacs) => { for (const h of hmacs) await q(`insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac, key_id) values ('${uid}','${L.uuidv4()}',${lit(h)},'k1')`); };
  const gen = (uid) => num(`select session_generation from admin_users where id='${uid}'`);
  const unusedCodes = (uid) => num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${uid}' and used_at is null`);
  const credStatus = (cid) => scalar(`select status from admin_mfa_credentials where id='${cid}'`);
  const hex = () => L.randomHex(8);
  const userSnapshot = async (uid) => JSON.stringify({
    gen: await gen(uid),
    creds: await q(`select id, status, revoked_reason, totp_last_step, webauthn_sign_count from admin_mfa_credentials where admin_user_id='${uid}' order by id`),
    codes: await q(`select code_hmac, used_at is not null from admin_mfa_recovery_codes where admin_user_id='${uid}' order by code_hmac`),
  });

  // ================================================================== TOTP step
  await s.section("TOTP", async () => {
    const u = await newUser(); const c = await addTotp(u);
    const one = async (step, cid = c) => (await q(`select office_mfa_consume_totp_step('${cid}', ${step})`))[0][0];
    s.eq("TOTP-001", "positive control: a fresh step is accepted", await one(1000), "t");
    s.eq("TOTP-002", "negative control: the same step again is refused", await one(1000), "f");
    s.eq("TOTP-003", "a lower step is refused", await one(999), "f");
    s.eq("TOTP-004", "a higher step is accepted", await one(1001), "t");
    s.eq("TOTP-005", "step zero can never be consumed", await one(0), "f");
    for (let round = 1; round <= 3; round++) {
      const uu = await newUser(); const cc = await addTotp(uu); const S = 5000 + round;
      const rs = await par(N, () => `select office_mfa_consume_totp_step('${cc}', ${S})`);
      s.check(`TOTP-10${round}`, `round ${round}: ${N} parallel connections consuming the same step: exactly one winner`, P.trues(rs) === 1 && P.errors(rs).length === 0, { winners: P.trues(rs), errs: P.errCodes(rs) });
      s.eq(`TOTP-11${round}`, `round ${round}: the stored step is the consumed step`, await num(`select totp_last_step from admin_mfa_credentials where id='${cc}'`), S);
    }
    {
      const uu = await newUser(); const cc = await addTotp(uu);
      const rs = await par(N, (i) => `select office_mfa_consume_totp_step('${cc}', ${7000 + i + 1})`);
      s.check("TOTP-120", "parallel ascending distinct steps: no error", P.errors(rs).length === 0, P.errCodes(rs));
      s.eq("TOTP-121", "the stored step is the highest step (never moves backwards under concurrency)", await num(`select totp_last_step from admin_mfa_credentials where id='${cc}'`), 7000 + N);
      let replays = 0; for (let i = 1; i <= N; i++) if (await one(7000 + i, cc) === "t") replays++;
      s.eq("TOTP-122", "every step that was in the race is now a replay", replays, 0);
    }
    {
      const us = []; for (let i = 0; i < 6; i++) { const uu = await newUser(); us.push(await addTotp(uu)); }
      const rs = await par(6, (i) => `select office_mfa_consume_totp_step('${us[i]}', 9000)`);
      s.eq("TOTP-130", "positive control: the same step on DIFFERENT credentials is independent (all accepted)", P.trues(rs), 6);
    }
    {
      const uu = await newUser(); const pend = await addTotp(uu, { status: "pending" }); const rev = await addTotp(uu, { status: "revoked" });
      const rs = await par(8, (i) => `select office_mfa_consume_totp_step('${i % 2 ? pend : rev}', 9100)`);
      s.eq("TOTP-140", "a pending or revoked credential never consumes a step", P.trues(rs), 0);
      s.eq("TOTP-141", "and its stored step is unchanged", await num(`select count(*) from admin_mfa_credentials where id in ('${pend}','${rev}') and totp_last_step <> 0`), 0);
      const wa = await addWa(uu);
      s.eq("TOTP-142", "a WebAuthn credential id is not accepted as a TOTP credential", (await q(`select office_mfa_consume_totp_step('${wa}', 9200)`))[0][0], "f");
    }
  });

  // ================================================================== recovery codes
  await s.section("RC", async () => {
    // plain consumption
    for (let round = 1; round <= 2; round++) {
      const u = await newUser(); await addCodes(u, [`rc-a-${hex()}`, `rc-b-${hex()}`]); const h = await scalar(`select code_hmac from admin_mfa_recovery_codes where admin_user_id='${u}' order by code_hmac limit 1`);
      const rs = await par(N, () => `select office_mfa_consume_recovery_code('${u}', '${h}')`);
      s.check(`RC-10${round}`, `round ${round}: ${N} parallel consumers of one recovery code: exactly one winner`, P.trues(rs) === 1 && P.errors(rs).length === 0, { winners: P.trues(rs), errs: P.errCodes(rs) });
      s.eq(`RC-11${round}`, `round ${round}: exactly one code is marked used`, await num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${u}' and used_at is not null`), 1);
    }
    // revoking variant: consumption and the generation bump are ONE statement
    {
      const u = await newUser(); const h = `rc-r-${hex()}`; await addCodes(u, [h, `rc-r2-${hex()}`]); const g0 = await gen(u);
      const rs = await par(N, () => `select session_generation from office_mfa_consume_recovery_code_revoking('${u}', '${h}', 'race')`);
      s.check("RC-120", `revoking variant, ${N} parallel: exactly one row (one winner)`, P.withRows(rs) === 1 && P.errors(rs).length === 0, { rows: P.withRows(rs), errs: P.errCodes(rs) });
      s.eq("RC-121", "the session generation moved exactly once (a replayed code cannot revoke sessions again)", (await gen(u)) - g0, 1);
      s.eq("RC-122", "the other code of the account is untouched", await unusedCodes(u), 1);
    }
    {
      const u = await newUser(); const hs = Array.from({ length: 8 }, () => `rc-d-${hex()}`); await addCodes(u, hs); const g0 = await gen(u);
      const rs = await par(8, (i) => `select session_generation from office_mfa_consume_recovery_code_revoking('${u}', '${hs[i]}', 'race')`);
      s.check("RC-130", "eight DISTINCT codes of one account consumed in parallel: all eight succeed, no error", P.withRows(rs) === 8 && P.errors(rs).length === 0, { rows: P.withRows(rs), errs: P.errCodes(rs) });
      s.eq("RC-131", "no generation increment was lost (+8)", (await gen(u)) - g0, 8);
      s.eq("RC-132", "all eight codes are spent exactly once", await unusedCodes(u), 0);
    }
    {
      const a = await newUser(); const b = await newUser(); const h = `rc-x-${hex()}`; await addCodes(a, [h]); const gb = await gen(b); const ga = await gen(a);
      s.eq("RC-140", "negative control: another account cannot consume the code", (await q(`select office_mfa_consume_recovery_code('${b}', '${h}')`))[0][0], "f");
      s.eq("RC-141", "negative control: another account cannot consume it through the revoking form either (no revocation of anyone)", (await q(`select count(*) from office_mfa_consume_recovery_code_revoking('${b}', '${h}', 'x')`))[0][0], "0");
      s.check("RC-142", "the code is still unused and no generation moved", (await unusedCodes(a)) === 1 && (await gen(b)) === gb && (await gen(a)) === ga);
      s.eq("RC-143", "positive control: the owner consumes it", (await q(`select office_mfa_consume_recovery_code('${a}', '${h}')`))[0][0], "t");
    }
    // consumption racing with a replacement of the batch
    for (let round = 1; round <= 2; round++) {
      const u = await newUser(); const old = Array.from({ length: 6 }, () => `rc-o-${hex()}`); await addCodes(u, old);
      const fresh = Array.from({ length: 4 }, () => `rc-n-${hex()}`);
      const rs = await par(7, (i) => (i === 6 ? `select office_mfa_replace_recovery_codes('${u}', '${L.uuidv4()}', array[${fresh.map(lit).join(",")}], 'k1')` : `select office_mfa_consume_recovery_code('${u}', '${old[i]}')`));
      const consumed = P.trues(rs.slice(0, 6)); const usedOld = await num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${u}' and code_hmac like 'rc-o-%' and used_at is not null`);
      s.check(`RC-15${round}`, `round ${round}: consumption racing a batch replacement: no error`, P.errors(rs).length === 0, P.errCodes(rs));
      s.eq(`RC-16${round}`, `round ${round}: every success is recorded as a used code (no code is both reported spent and lost)`, usedOld, consumed);
      s.eq(`RC-17${round}`, `round ${round}: the new batch is complete and no old unused code survives`, [await unusedCodes(u), await num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${u}' and code_hmac like 'rc-o-%' and used_at is null`)], [4, 0]);
    }
    // concurrent replacements: one batch wins as a whole
    {
      const u = await newUser(); await addCodes(u, [`rc-s-${hex()}`]);
      const rs = await par(8, (i) => `select office_mfa_replace_recovery_codes('${u}', '${L.uuidv4()}', array['rb${i}-1-${hex()}','rb${i}-2-${hex()}','rb${i}-3-${hex()}'], 'k1')`);
      s.check("RC-180", "8 concurrent replacements: no error", P.errors(rs).length === 0, P.errCodes(rs));
      const live = await q(`select distinct substr(code_hmac,1,3) from admin_mfa_recovery_codes where admin_user_id='${u}' and used_at is null`);
      s.check("RC-181", "the unused codes come from exactly one batch (no interleaved mixture), complete", live.length === 1 && (await unusedCodes(u)) === 3, { batches: live, count: await unusedCodes(u) });
    }
    // rollback of a failing replacement
    {
      const u = await newUser(); const o = await newUser(); const keep = [`rc-k1-${hex()}`, `rc-k2-${hex()}`, `rc-k3-${hex()}`]; await addCodes(u, keep);
      const foreign = `rc-f-${hex()}`; await addCodes(o, [foreign]);
      const before = await userSnapshot(u);
      const r = await adm.query(`select office_mfa_replace_recovery_codes('${u}', '${L.uuidv4()}', array['rc-new-${hex()}', '${foreign}'], 'k1')`);
      s.check("RC-190", "a replacement that violates uniqueness is refused", Boolean(r.error), r.rows);
      s.eq("RC-191", "and rolls back completely: the old unused codes are all still there", await userSnapshot(u), before);
      const r2 = await adm.query(`select office_mfa_replace_recovery_codes('${u}', '${L.uuidv4()}', array['rc-dup-${hex()}', 'rc-dup-same'] || array['rc-dup-same'], 'k1')`);
      s.check("RC-192", "a batch containing the same hash twice is refused", Boolean(r2.error), r2.rows);
      s.eq("RC-193", "and also rolls back completely", await userSnapshot(u), before);
    }
  });

  // ================================================================== challenges
  await s.section("CH", async () => {
    const u = await newUser(); const other = await newUser();
    const mk = async (user = u, purpose = "webauthn_authenticate") => (await q(`select id from office_mfa_create_challenge('${user}', '${purpose}', 'AAECAwQFBgcICQoLDA0ODw==', 120)`))[0][0];
    for (let round = 1; round <= 2; round++) {
      const id = await mk();
      const rs = await par(N, () => `select office_mfa_consume_challenge('${id}', '${u}', 'webauthn_authenticate')`);
      const got = rs.filter((r) => !r.error && P.first(r) && P.first(r).length > 0);
      s.check(`CH-10${round}`, `round ${round}: ${N} parallel consumers of one challenge: exactly one receives it`, got.length === 1 && P.errors(rs).length === 0, { got: got.length, errs: P.errCodes(rs) });
      s.eq(`CH-11${round}`, `round ${round}: the winner receives the stored challenge value`, got[0] && P.first(got[0]), "AAECAwQFBgcICQoLDA0ODw==");
    }
    {
      const id = await mk();
      const empty = async (sql) => { const r = await q(sql); return r.length === 0 || r[0][0] === "" || r[0][0] === undefined; };
      s.check("CH-120", "negative control: another account cannot consume it", await empty(`select office_mfa_consume_challenge('${id}', '${other}', 'webauthn_authenticate')`));
      s.check("CH-121", "negative control: the other purpose cannot consume it", await empty(`select office_mfa_consume_challenge('${id}', '${u}', 'webauthn_register')`));
      s.check("CH-122", "negative control: an unknown id yields nothing", await empty(`select office_mfa_consume_challenge('${L.uuidv4()}', '${u}', 'webauthn_authenticate')`));
      s.eq("CH-123", "the refused attempts did not consume it", await scalar(`select consumed_at is null from admin_mfa_challenges where id='${id}'`), "t");
      s.eq("CH-124", "positive control: the right account and purpose consume it once", (await q(`select office_mfa_consume_challenge('${id}', '${u}', 'webauthn_authenticate')`))[0][0], "AAECAwQFBgcICQoLDA0ODw==");
      s.check("CH-125", "and never again", await empty(`select office_mfa_consume_challenge('${id}', '${u}', 'webauthn_authenticate')`));
    }
    {
      const id = await mk(); await q(`update admin_mfa_challenges set expires_at = now() - interval '1 second' where id='${id}'`);
      const rs = await par(6, () => `select office_mfa_consume_challenge('${id}', '${u}', 'webauthn_authenticate')`);
      s.check("CH-130", "an expired challenge cannot be consumed by anyone, however many try", rs.every((r) => !r.error && !P.first(r)));
    }
    {
      const rs = await par(N, () => `select id from office_mfa_create_challenge('${u}', 'webauthn_register', 'AAEC', 60)`);
      const ids = new Set(rs.map((r) => P.first(r)));
      s.check("CH-140", "parallel creation yields distinct identifiers without error", ids.size === N && P.errors(rs).length === 0, { distinct: ids.size, errs: P.errCodes(rs) });
      const ttl = (await q(`select extract(epoch from (expires_at - now())) from office_mfa_create_challenge('${u}', 'webauthn_register', 'AAEC', 100000)`))[0][0];
      s.check("CH-141", "the lifetime is capped (an absurd request cannot create an immortal challenge)", Number(ttl) <= 900.5, ttl);
      const ttl0 = (await q(`select extract(epoch from (expires_at - now())) from office_mfa_create_challenge('${u}', 'webauthn_register', 'AAEC', -50)`))[0][0];
      s.check("CH-142", "a non-positive lifetime is raised to a small positive one, never to the past", Number(ttl0) >= 0.9 && Number(ttl0) <= 2, ttl0);
      const bad = await adm.query(`select office_mfa_create_challenge('${u}', 'login', 'AAEC', 60)`);
      s.check("CH-143", "an unknown purpose is refused by the table constraint", Boolean(bad.error));
    }
  });

  // ================================================================== WebAuthn counter
  await s.section("WA", async () => {
    const u = await newUser(); const other = await newUser();
    const rec = (cid, n, user = u) => `select office_mfa_webauthn_record_use('${user}', '${cid}', ${n})`;
    const c = await addWa(u, { count: 5 });
    s.eq("WA-001", "positive control: a higher counter is accepted", (await q(rec(c, 6)))[0][0], "t");
    s.eq("WA-002", "negative control: a repeated counter is refused (cloned authenticator)", (await q(rec(c, 6)))[0][0], "f");
    s.eq("WA-003", "negative control: a lower counter is refused", (await q(rec(c, 3)))[0][0], "f");
    s.eq("WA-004", "another account cannot advance the counter", (await q(rec(c, 50, other)))[0][0], "f");
    s.eq("WA-005", "the refusals changed nothing", await num(`select webauthn_sign_count from admin_mfa_credentials where id='${c}'`), 6);
    for (let round = 1; round <= 3; round++) {
      const cc = await addWa(u, { count: 10 });
      const rs = await par(N, () => rec(cc, 11));
      s.check(`WA-10${round}`, `round ${round}: ${N} parallel assertions with the same counter: exactly one advances it`, P.trues(rs) === 1 && P.errors(rs).length === 0, { winners: P.trues(rs), errs: P.errCodes(rs) });
    }
    {
      const cc = await addWa(u, { count: 100 });
      const rs = await par(N, (i) => rec(cc, 101 + i));
      s.check("WA-110", "parallel distinct counters: no error", P.errors(rs).length === 0, P.errCodes(rs));
      s.eq("WA-111", "the stored counter is the highest value seen (never decreases)", await num(`select webauthn_sign_count from admin_mfa_credentials where id='${cc}'`), 100 + N);
      s.eq("WA-112", "every counter of the race is now a replay", (await q(rec(cc, 100 + 1)))[0][0] === "t" || (await q(rec(cc, 100 + N)))[0][0] === "t", false);
    }
    {
      const cc = await addWa(u, { count: 0 });
      const rs = await par(6, () => rec(cc, 0));
      s.eq("WA-120", "contract: synced passkeys that report 0 and stay at 0 are accepted (positive control, all six)", P.trues(rs), 6);
      s.eq("WA-121", "and the stored counter stays 0", await num(`select webauthn_sign_count from admin_mfa_credentials where id='${cc}'`), 0);
      const up = await q(rec(cc, 1));
      s.eq("WA-122", "a passkey that starts counting is accepted once", up[0][0], "t");
      s.eq("WA-123", "after counting has started a reported 0 is a rollback and is refused", (await q(rec(cc, 0)))[0][0], "f");
    }
    {
      const pend = await addWa(u, { status: "pending", count: 0 }); const rev = await addWa(u, { status: "revoked", count: 0 });
      s.eq("WA-130", "a pending credential cannot record a use", (await q(rec(pend, 5)))[0][0], "f");
      s.eq("WA-131", "a revoked credential cannot record a use", (await q(rec(rev, 5)))[0][0], "f");
      const t = await addTotp(u);
      s.eq("WA-132", "a TOTP credential id is not a WebAuthn credential", (await q(rec(t, 5)))[0][0], "f");
    }
  });

  // ================================================================== credential activation
  await s.section("ACT", async () => {
    const codes = (n) => Array.from({ length: n }, () => `ac-${hex()}`);
    const act = (u, cid, { replace = null, step = null, hm = null, actor = "act" } = {}) => `select session_generation, replaced, recovery_codes from office_mfa_activate_credential('${u}', '${cid}', '${actor}', ${replace ? `'${replace}'` : "null"}, ${step === null ? "null" : step}, ${hm ? `array[${hm.map(lit).join(",")}]` : "null"}, ${hm ? "'k1'" : "null"})`;
    for (let round = 1; round <= 2; round++) {
      const u = await newUser(); const p = await addTotp(u, { status: "pending" }); const g0 = await gen(u);
      const rs = await par(N, () => act(u, p, { step: 4242, hm: codes(10) }));
      s.check(`ACT-10${round}`, `round ${round}: ${N} parallel activations of one pending credential: exactly one winner, no error`, P.withRows(rs) === 1 && P.errors(rs).length === 0, { winners: P.withRows(rs), errs: P.errCodes(rs) });
      s.eq(`ACT-11${round}`, `round ${round}: sessions were revoked exactly once and exactly one batch of 10 recovery codes exists`, [(await gen(u)) - g0, await unusedCodes(u)], [1, 10]);
      s.eq(`ACT-12${round}`, `round ${round}: the credential is active with the recorded step`, [await credStatus(p), await num(`select totp_last_step from admin_mfa_credentials where id='${p}'`)], ["active", 4242]);
    }
    for (let round = 1; round <= 2; round++) {
      const u = await newUser(); const a = await addTotp(u); await addCodes(u, codes(3)); const p = await addTotp(u, { status: "pending" }); const g0 = await gen(u);
      const rs = await par(N, () => act(u, p, { replace: a, step: 77 }));
      s.check(`ACT-20${round}`, `round ${round}: parallel replacement of the active TOTP: exactly one winner, no error`, P.withRows(rs) === 1 && P.errors(rs).length === 0, { winners: P.withRows(rs), errs: P.errCodes(rs) });
      s.eq(`ACT-21${round}`, `round ${round}: the old factor is revoked as replaced, the new one is active, exactly one active TOTP`, [await credStatus(a), await credStatus(p), await num(`select count(*) from admin_mfa_credentials where admin_user_id='${u}' and type='totp' and status='active'`)], ["revoked", "active", 1]);
      s.eq(`ACT-22${round}`, `round ${round}: one generation increment; recovery codes untouched (not passed)`, [(await gen(u)) - g0, await unusedCodes(u)], [1, 3]);
    }
    {
      const u = await newUser(); const ps = []; for (let i = 0; i < 3; i++) ps.push(await addWa(u, { status: "pending" })); const g0 = await gen(u);
      const rs = await par(12, (i) => act(u, ps[i % 3], { hm: codes(5) }));
      s.check("ACT-30", "three distinct pending credentials, each activated four times in parallel: exactly three winners", P.withRows(rs) === 3 && P.errors(rs).length === 0, { winners: P.withRows(rs), errs: P.errCodes(rs) });
      s.eq("ACT-31", "all three are active and the generation moved exactly three times", [await num(`select count(*) from admin_mfa_credentials where admin_user_id='${u}' and status='active'`), (await gen(u)) - g0], [3, 3]);
      const prefixes = await num(`select count(distinct substr(code_hmac, 1, 3)) from admin_mfa_recovery_codes where admin_user_id='${u}' and used_at is null`);
      s.check("ACT-32", "exactly one batch of 5 unused recovery codes remains (each later activation replaced the earlier batch whole)", (await unusedCodes(u)) === 5 && prefixes === 1, { count: await unusedCodes(u) });
      const distinctBatchIds = await num(`select count(distinct batch_id) from admin_mfa_recovery_codes where admin_user_id='${u}' and used_at is null`);
      if (distinctBatchIds > 1) s.info(`INFO-BATCHID activation stores a different batch_id on every recovery code of one batch (${distinctBatchIds} ids for 5 codes); office_mfa_replace_recovery_codes uses one id per batch. Cosmetic inconsistency (Info).`);
    }
    {
      const u = await newUser(); for (let i = 0; i < 10; i++) await addWa(u, { status: "active" });
      const ps = []; for (let i = 0; i < 8; i++) ps.push(await addWa(u, { status: "pending" })); const g0 = await gen(u);
      const rs = await par(8, (i) => act(u, ps[i]));
      s.eq("ACT-40", "ten WebAuthn credentials is the limit: eight parallel activations beyond it all refuse", [P.withRows(rs), P.errors(rs).length], [0, 8]);
      s.check("ACT-41", "the refusal is the documented credential_limit, and the active count stayed at ten", P.errors(rs).every((e) => /credential_limit/.test(e.error.message)) && (await num(`select count(*) from admin_mfa_credentials where admin_user_id='${u}' and status='active'`)) === 10, P.errCodes(rs));
      s.eq("ACT-42", "and the refused activations did not touch the generation", (await gen(u)) - g0, 0);
      const u2 = await newUser(); for (let i = 0; i < 9; i++) await addWa(u2, { status: "active" });
      const p2 = []; for (let i = 0; i < 6; i++) p2.push(await addWa(u2, { status: "pending" }));
      const rs2 = await par(6, (i) => act(u2, p2[i]));
      s.eq("ACT-43", "nine active, six racing for the last slot: exactly one wins and the total is exactly ten", [P.withRows(rs2), await num(`select count(*) from admin_mfa_credentials where admin_user_id='${u2}' and status='active'`)], [1, 10]);
    }
    // rollback
    {
      const u = await newUser(); const a = await addTotp(u); await addCodes(u, codes(3)); const p = await addTotp(u, { status: "pending" });
      const before = await userSnapshot(u);
      const ghost = L.uuidv4();
      const r = await adm.query(act(u, p, { replace: ghost, hm: codes(10) }));
      s.check("ACT-50", "replacing a credential that is not the active one is refused", Boolean(r.error) && /replace_target_not_active/.test(r.error.message), r.error);
      s.eq("ACT-51", "and leaves everything as it was (pending stays pending, old factor active, codes and generation intact)", await userSnapshot(u), before);
      const other = await newUser(); const foreign = `ac-foreign-${hex()}`; await addCodes(other, [foreign]);
      const r2 = await adm.query(act(u, p, { replace: a, step: 9, hm: [`ac-ok-${hex()}`, foreign] }));
      s.check("ACT-52", "a batch that collides with another account's code hash is refused", Boolean(r2.error), r2.error);
      s.eq("ACT-53", "and the replacement, the activation, the code deletion and the generation bump are all rolled back", await userSnapshot(u), before);
      const r3 = await adm.query(act(u, p, { replace: a, step: 9, hm: codes(10) }));
      s.check("ACT-54", "positive control: the same activation with a clean batch succeeds afterwards", !r3.error && r3.rows.length === 1, r3.error || r3.rows);
    }
    {
      const u = await newUser(); const o = await newUser(); const pOther = await addTotp(o, { status: "pending" }); const before = await userSnapshot(o);
      const r = await q(act(u, pOther));
      s.eq("ACT-60", "activating another account's pending credential returns nothing", r.length, 0);
      s.eq("ACT-61", "and changes nothing for either account", await userSnapshot(o), before);
      const rev = await addTotp(u, { status: "revoked" });
      s.eq("ACT-62", "a revoked credential cannot be activated", (await q(act(u, rev))).length, 0);
      s.eq("ACT-63", "an unknown account yields nothing", (await q(act(L.uuidv4(), pOther))).length, 0);
    }
    // activation racing revocation of the same pending credential
    for (let round = 1; round <= 2; round++) {
      const u = await newUser(); await addTotp(u); const p = await addWa(u, { status: "pending" });
      const rs = await par(8, (i) => (i % 2 ? act(u, p) : `select session_generation from office_mfa_revoke_credential('${u}', '${p}', 'x', 'race', false)`));
      s.check(`ACT-7${round}`, `round ${round}: activation racing revocation of the same credential: no error, no deadlock`, P.errors(rs).length === 0, P.errCodes(rs));
      s.eq(`ACT-8${round}`, `round ${round}: the credential ends revoked in every order`, await credStatus(p), "revoked");
    }
    // last-factor guard
    for (let round = 1; round <= 2; round++) {
      const u = await newUser(); const a = await addWa(u); const b = await addWa(u);
      const rs = await par(8, (i) => `select remaining_active from office_mfa_revoke_credential('${u}', '${i % 2 ? a : b}', 'x', 'race', true)`);
      const ok = rs.filter((r) => !r.error && r.rows.length === 1).length; const guard = rs.filter((r) => r.error && /last_active_factor/.test(r.error.message)).length;
      s.check(`ACT-9${round}`, `round ${round}: two factors revoked concurrently with the last-factor guard on: exactly one succeeds`, ok === 1 && guard >= 1, { ok, guard, errs: P.errCodes(rs) });
      s.eq(`ACT-95${round}`, `round ${round}: one active factor always remains`, await num(`select count(*) from admin_mfa_credentials where admin_user_id='${u}' and status='active'`), 1);
    }
  });

  // ================================================================== session revocation (generation, digest), failure counters, administrator reset
  await s.section("REV", async () => {
    const u = await newUser(); const g0 = await gen(u);
    const rs = await par(N, () => `select session_generation from office_revoke_admin_sessions('${u}', 'race', 'r')`);
    s.check("REV-001", `${N} parallel account-wide revocations: none lost, all distinct generations`, (await gen(u)) - g0 === N && new Set(rs.map((r) => P.first(r))).size === N, { delta: (await gen(u)) - g0, errs: P.errCodes(rs) });
    s.eq("REV-002", "an unknown account returns no row and creates nothing", (await q(`select * from office_revoke_admin_sessions('${L.uuidv4()}', 'x', null)`)).length, 0);
    const g1 = await gen(u);
    const rs2 = await par(N, (i) => `select session_generation from office_admin_update_revoking_sessions('${u}', 'race', null, null, 'active', false, null, null)`);
    s.eq("REV-003", "parallel account updates that revoke sessions: no lost increment", [(await gen(u)) - g1, P.errors(rs2).length], [N, 0]);
    // password change and revocation are one statement
    const hashA = L.scryptHash("Old!Passw0rd1"); const hashB = L.scryptHash("New!Passw0rd2");
    await q(`update admin_users set password_hash='${hashA}' where id='${u}'`);
    const g2 = await gen(u);
    const rs3 = await par(6, (i) => `select session_generation from office_admin_update_revoking_sessions('${u}', 'race', '${i === 0 ? hashB : hashA}', now(), null, false, null, null)`);
    const finalHash = await scalar(`select password_hash from admin_users where id='${u}'`);
    s.check("REV-004", "password writes racing each other each revoke sessions and leave one coherent hash (never a mixture)", (await gen(u)) - g2 === 6 && (finalHash === hashA || finalHash === hashB), { delta: (await gen(u)) - g2, errs: P.errCodes(rs3) });

    // digests
    const dg = `dig-${L.randomHex(12)}`; const exp = `now() + interval '1 day'`;
    const rs4 = await par(N, () => `select office_revoke_session('${dg}', '${u}', ${exp})`);
    s.check("REV-010", `${N} parallel revocations of the same session: idempotent (all succeed, no error)`, P.trues(rs4) === N && P.errors(rs4).length === 0, { t: P.trues(rs4), errs: P.errCodes(rs4) });
    s.eq("REV-011", "exactly one record exists and the session reads as revoked", [await num(`select count(*) from admin_revoked_sessions where session_digest='${dg}'`), (await q(`select office_is_session_revoked('${dg}')`))[0][0]], [1, "t"]);
    const rs5 = await par(N, (i) => `select office_revoke_session('digest-${i}-${L.randomHex(8)}', '${u}', ${exp})`);
    s.eq("REV-012", "parallel revocations of distinct sessions are all recorded", [P.trues(rs5), P.errors(rs5).length], [N, 0]);
    s.eq("REV-013", "negative control: an unknown digest is not revoked", (await q(`select office_is_session_revoked('never-revoked-${L.randomHex(8)}')`))[0][0], "f");
    const tooShort = await adm.query(`select office_revoke_session('short', '${u}', ${exp})`);
    s.check("REV-014", "a too-short digest (no identifier material) is refused and stores nothing", Boolean(tooShort.error) && (await num(`select count(*) from admin_revoked_sessions where session_digest='short'`)) === 0, tooShort.error);
    const ghost = await adm.query(`select office_revoke_session('ghost-${L.randomHex(10)}', '${L.uuidv4()}', ${exp})`);
    s.check("REV-015", "a revocation for an account that does not exist is refused and stores nothing", Boolean(ghost.error), ghost.rows);
    await q(`insert into admin_revoked_sessions (session_digest, admin_user_id, expires_at) values ('old-digest-${L.randomHex(8)}-aaaa', '${u}', now() - interval '3 days')`);
    await q(`select office_revoke_session('prune-${L.randomHex(10)}', '${u}', ${exp})`);
    s.eq("REV-016", "records more than a day past their expiry are pruned by the next revocation", await num(`select count(*) from admin_revoked_sessions where expires_at < now() - interval '1 day'`), 0);

    // MFA failure counter
    const f = await newUser(); await q(`update admin_users set mfa_failed_attempts=0, mfa_locked_until=null where id='${f}'`);
    const rs6 = await par(25, () => `select failed_attempts from office_mfa_record_failure('${f}')`);
    s.check("REV-020", "25 parallel failed second factors: the counter is exactly 25 (no lost count), every answer distinct", (await num(`select mfa_failed_attempts from admin_users where id='${f}'`)) === 25 && new Set(rs6.map((r) => P.first(r))).size === 25, { errs: P.errCodes(rs6) });
    const lockMin = await num(`select extract(epoch from (mfa_locked_until - now()))/60 from admin_users where id='${f}'`);
    s.check("REV-021", "at 20 or more failures the lock is about an hour and never permanent", lockMin > 58 && lockMin <= 60.1, lockMin);
    await q(`update admin_users set mfa_locked_until = now() + interval '300 minutes' where id='${f}'`);
    await q(`select office_mfa_record_failure('${f}')`);
    s.check("REV-022", "a longer existing lock is never shortened by a later failure", (await num(`select extract(epoch from (mfa_locked_until - now()))/60 from admin_users where id='${f}'`)) > 290);
    await q(`select office_mfa_clear_failures('${f}')`);
    s.eq("REV-023", "clearing failures resets counter and lock", [await num(`select mfa_failed_attempts from admin_users where id='${f}'`), await scalar(`select mfa_locked_until is null from admin_users where id='${f}'`)], [0, "t"]);
    const f2 = await newUser(); for (let i = 0; i < 4; i++) await q(`select office_mfa_record_failure('${f2}')`);
    s.eq("REV-024", "four failures set no lock (positive control for the threshold)", await scalar(`select mfa_locked_until is null from admin_users where id='${f2}'`), "t");
    await q(`select office_mfa_record_failure('${f2}')`);
    s.eq("REV-025", "the fifth sets a lock", await scalar(`select mfa_locked_until is not null from admin_users where id='${f2}'`), "t");
  });

  await s.section("RST", async () => {
    // administrator reset: one winner for the effective work
    for (let round = 1; round <= 2; round++) {
      const u = await newUser(); const c1 = await addTotp(u); const c2 = await addWa(u); const c3 = await addWa(u, { status: "pending" });
      await addCodes(u, Array.from({ length: 5 }, () => `rs-${hex()}`)); await q(`select office_mfa_record_failure('${u}')`); const g0 = await gen(u);
      const rs = await par(N, () => `select credentials_revoked, codes_deleted from office_mfa_reset('${u}', 'admin')`);
      const sumC = rs.reduce((a, r) => a + (r.rows[0] ? Number(r.rows[0][0]) : 0), 0); const sumD = rs.reduce((a, r) => a + (r.rows[0] ? Number(r.rows[0][1]) : 0), 0);
      const winners = rs.filter((r) => r.rows[0] && Number(r.rows[0][0]) > 0).length;
      s.check(`RST-10${round}`, `round ${round}: ${N} parallel resets: no error`, P.errors(rs).length === 0, P.errCodes(rs));
      s.check(`RST-11${round}`, `round ${round}: the three credentials and five codes are removed exactly once in total (one winner)`, sumC === 3 && sumD === 5 && winners === 1, { sumC, sumD, winners });
      s.eq(`RST-12${round}`, `round ${round}: final state: nothing active or pending, no unused code, failures cleared`, [await credStatus(c1), await credStatus(c2), await credStatus(c3), await unusedCodes(u), await num(`select mfa_failed_attempts from admin_users where id='${u}'`)], ["revoked", "revoked", "revoked", 0, 0]);
      s.eq(`RST-13${round}`, `round ${round}: sessions were revoked (generation moved, none lost)`, (await gen(u)) - g0, N);
    }
    s.eq("RST-020", "an unknown account yields nothing", (await q(`select * from office_mfa_reset('${L.uuidv4()}', 'x')`)).length, 0);
    // reset racing activation
    for (let round = 1; round <= 3; round++) {
      const u = await newUser(); const a = await addTotp(u); const p = await addWa(u, { status: "pending" });
      const rs = await par(8, (i) => (i % 2 ? `select credentials_revoked from office_mfa_reset('${u}', 'admin')` : `select session_generation from office_mfa_activate_credential('${u}', '${p}', 'x', null, null, array['rr-${hex()}-${i}','rr-${hex()}-${i}b'], 'k1')`));
      s.check(`RST-3${round}`, `round ${round}: reset racing activation: no error and no deadlock`, P.errors(rs).length === 0, P.errCodes(rs));
      s.eq(`RST-4${round}`, `round ${round}: after both, the account has no active factor and no unused recovery code (the reset cannot be undone by the racing activation)`, [await num(`select count(*) from admin_mfa_credentials where admin_user_id='${u}' and status in ('active','pending')`), await unusedCodes(u)], [0, 0]);
    }
  });

  // ================================================================== settings
  await s.section("SET", async () => {
    const key = `race_key_${hex()}`;
    const w = (v, ver, reqId = "r") => `select office_runtime_setting_write('${key}', '"${v}"'::jsonb, 'racer', ${ver === null ? "null" : ver}, '${reqId}', false, true)`;
    const stat = (rs) => rs.map((r) => (r.error ? "error" : (JSON.parse(P.first(r)).status)));
    let rs = await par(N, (i) => w(`v${i}`, 0));
    let st1 = stat(rs);
    s.check("SET-001", `${N} parallel creators with expected version 0: exactly one ok, the rest conflict, no error`, st1.filter((x) => x === "ok").length === 1 && st1.filter((x) => x === "conflict").length === N - 1, st1);
    s.eq("SET-002", "stored version is 1 and holds the winner's value", [await num(`select version from office_runtime_settings where key='${key}'`), await scalar(`select value #>> '{}' from office_runtime_settings where key='${key}'`)], [1, "v" + st1.indexOf("ok")]);
    s.eq("SET-003", "history: one success and N-1 conflicts, every attempt accounted for", [await num(`select count(*) from office_runtime_setting_history where setting_key='${key}' and outcome='success'`), await num(`select count(*) from office_runtime_setting_history where setting_key='${key}' and outcome='conflict'`)], [1, N - 1]);
    rs = await par(N, (i) => w(`b${i}`, 1)); st1 = stat(rs);
    s.check("SET-010", "parallel compare-and-set from version 1: exactly one ok", st1.filter((x) => x === "ok").length === 1 && st1.filter((x) => x === "conflict").length === N - 1, st1);
    s.eq("SET-011", "version 2 only", await num(`select version from office_runtime_settings where key='${key}'`), 2);
    const before = await num(`select count(*) from office_runtime_setting_history where setting_key='${key}'`);
    rs = await par(N, (i) => w(`u${i}`, null)); st1 = stat(rs);
    s.check("SET-020", "unconditional writers on an existing row all succeed and none is lost", st1.every((x) => x === "ok") && (await num(`select version from office_runtime_settings where key='${key}'`)) === 2 + N, st1);
    const chain = await q(`select version, previous_value #>> '{}', new_value #>> '{}' from office_runtime_setting_history where setting_key='${key}' and outcome='success' and version > 2 order by version`);
    let linked = chain.length === N; for (let i = 1; i < chain.length; i++) if (chain[i][1] !== chain[i - 1][2]) linked = false;
    s.check("SET-021", "the history of those writes is a gapless chain: each previous value is the one before's new value", linked && (await num(`select count(*) from office_runtime_setting_history where setting_key='${key}'`)) === before + N, chain);
    const key2 = `race_key2_${hex()}`;
    rs = await par(N, (i) => `select office_runtime_setting_write('${key2}', '"c${i}"'::jsonb, 'racer', null, 'r', false, true)`);
    s.check("SET-030", "unconditional concurrent creation of a missing key: no error, one row, every attempt accounted for in the history", P.errors(rs).length === 0 && (await num(`select count(*) from office_runtime_settings where key='${key2}'`)) === 1 && (await num(`select count(*) from office_runtime_setting_history where setting_key='${key2}'`)) === N, { errs: P.errCodes(rs) });
    const neg = JSON.parse((await q(`select office_runtime_setting_write('${key}', '"x"'::jsonb, 'a', -1, 'r', false, true)`))[0][0]);
    s.eq("SET-031", "a negative expected version is a conflict, never an overwrite", neg.status, "conflict");
    const ver = await num(`select version from office_runtime_settings where key='${key}'`);
    s.eq("SET-032", "and the version did not move", ver, 2 + N);
    // history is evidence
    const upd = await adm.query(`update office_runtime_setting_history set outcome='success' where setting_key='${key}'`);
    const del = await adm.query(`delete from office_runtime_setting_history where setting_key='${key}'`);
    s.check("SET-040", "the history cannot be edited, even by the database owner (append-only trigger)", Boolean(upd.error) && upd.error.code === "42501", upd.error);
    s.check("SET-041", "the history cannot be deleted row by row", Boolean(del.error) && del.error.code === "42501", del.error);
    // redaction / history flags
    const key3 = `race_key3_${hex()}`;
    await q(`select office_runtime_setting_write('${key3}', '"top-secret-value"'::jsonb, 'a', 0, 'r', true, true)`);
    await q(`select office_runtime_setting_write('${key3}', '"second-secret"'::jsonb, 'a', 1, 'r', true, true)`);
    await q(`select office_runtime_setting_write('${key3}', '"stale-secret"'::jsonb, 'a', 1, 'r', true, true)`);
    await q(`select office_runtime_setting_record_attempt('${key3}', 'a', 'r', 'denied', 'because', '"attempted-secret"'::jsonb, true)`);
    s.eq("SET-050", "redacted settings never put a value into the history (success, conflict or attempt)", await num(`select count(*) from office_runtime_setting_history where setting_key='${key3}' and (previous_value::text ~ 'secret' or new_value::text ~ 'secret')`), 0);
    const hist0 = await num(`select count(*) from office_runtime_setting_history where setting_key='${key3}'`);
    await q(`select office_runtime_setting_write('${key3}', '"third"'::jsonb, 'a', 2, 'r', true, false)`);
    s.eq("SET-051", "the history flag off writes no success row", await num(`select count(*) from office_runtime_setting_history where setting_key='${key3}'`), hist0);
    rs = await par(N, (i) => `select office_runtime_setting_record_attempt('${key3}', 'a', 'req${i}', 'denied', 'r', null, false)`);
    s.eq("SET-052", "parallel attempt records are all kept", [P.errors(rs).length, await num(`select count(*) from office_runtime_setting_history where setting_key='${key3}' and request_id like 'req%'`)], [0, N]);
  });

  // ================================================================== fault injection: every multi-step operation is all-or-nothing
  await s.section("FI", async () => {
    await q(`create or replace function s7c_boom() returns trigger language plpgsql as $f$ begin raise exception 's7c injected fault' using errcode = 'XX001'; end $f$`);
    const arm = (table, when = "") => q(`create trigger s7c_fault before ${when ? "update" : "update or insert or delete"} on ${table} for each row ${when} execute function s7c_boom()`);
    const disarm = (table) => q(`drop trigger if exists s7c_fault on ${table}`);
    const fail = async (id, text, sql, snapFn, guardedTable, when) => {
      const before = await snapFn();
      await arm(guardedTable, when);
      let r; try { r = await adm.query(sql); } finally { await disarm(guardedTable); }
      s.check(`${id}a`, `${text}: the injected fault surfaces as an error`, Boolean(r.error) && r.error.code === "XX001", r.error || r.rows);
      s.eq(`${id}b`, `${text}: nothing was changed (full rollback)`, await snapFn(), before);
    };
    const gensChanged = "when (new.session_generation is distinct from old.session_generation)";
    {
      const u = await newUser(); const a = await addTotp(u); await addCodes(u, [`fi1-${hex()}`, `fi2-${hex()}`]); const p = await addTotp(u, { status: "pending" });
      await fail("FI-01", "activation with replacement, new recovery codes and the generation bump failing last", `select * from office_mfa_activate_credential('${u}', '${p}', 'x', '${a}', 5, array['fi-new-${hex()}'], 'k1')`, () => userSnapshot(u), "admin_users", `${gensChanged}`);
      const r = await adm.query(`select * from office_mfa_activate_credential('${u}', '${p}', 'x', '${a}', 5, array['fi-new2-${hex()}'], 'k1')`);
      s.check("FI-01c", "positive control: with the fault removed the same call succeeds", !r.error && r.rows.length === 1, r.error);
    }
    {
      const u = await newUser(); const h = `fi-c-${hex()}`; await addCodes(u, [h]);
      await fail("FI-02", "recovery-code consumption whose generation bump fails (code must not be burned without the revocation)", `select * from office_mfa_consume_recovery_code_revoking('${u}', '${h}', 'x')`, () => userSnapshot(u), "admin_users", gensChanged);
      s.eq("FI-02c", "positive control: the code is still usable afterwards", (await q(`select count(*) from office_mfa_consume_recovery_code_revoking('${u}', '${h}', 'x')`))[0][0], "1");
    }
    {
      const u = await newUser(); const a = await addWa(u); await addWa(u); await addCodes(u, [`fi3-${hex()}`]);
      await fail("FI-03", "revocation of an active factor whose generation bump fails", `select * from office_mfa_revoke_credential('${u}', '${a}', 'x', 'r', false)`, () => userSnapshot(u), "admin_users", gensChanged);
    }
    {
      const u = await newUser(); await addTotp(u); await addCodes(u, [`fi4-${hex()}`, `fi5-${hex()}`]);
      await fail("FI-04", "administrator reset whose last step (the account update) fails", `select * from office_mfa_reset('${u}', 'x')`, () => userSnapshot(u), "admin_mfa_recovery_codes", "");
      await fail("FI-05", "administrator reset whose credential revocation fails", `select * from office_mfa_reset('${u}', 'x')`, () => userSnapshot(u), "admin_mfa_credentials", "");
    }
    {
      const u = await newUser(); const snap = async () => JSON.stringify(await q(`select password_hash, status, session_generation from admin_users where id='${u}'`));
      await fail("FI-06", "password change that cannot record the revocation: the password must not change either", `select * from office_admin_update_revoking_sessions('${u}', 'x', '${L.scryptHash("Zzz!Passw0rd9")}', now(), 'inactive', false, null, null)`, snap, "admin_users", gensChanged);
    }
    {
      const key = `fi_key_${hex()}`; await q(`select office_runtime_setting_write('${key}', '"orig"'::jsonb, 'a', 0, 'r', false, true)`);
      const snap = async () => JSON.stringify([await q(`select value::text, version from office_runtime_settings where key='${key}'`), await q(`select version, outcome from office_runtime_setting_history where setting_key='${key}' order by created_at, version`)]);
      await fail("FI-07", "a setting write whose history row cannot be written: the setting itself must not change", `select office_runtime_setting_write('${key}', '"changed"'::jsonb, 'a', 1, 'r', false, true)`, snap, "office_runtime_setting_history", "");
      await fail("FI-08", "a first-time setting write whose history row cannot be written leaves no setting behind", `select office_runtime_setting_write('${key}_new', '"x"'::jsonb, 'a', 0, 'r', false, true)`, async () => JSON.stringify(await q(`select key from office_runtime_settings where key like '${key}%' order by key`)), "office_runtime_setting_history", "");
    }
    {
      const u = await newUser(); const c = await addTotp(u); const w = await addWa(u, { count: 1 });
      await fail("FI-09", "TOTP step consumption whose write fails leaves the step unconsumed", `select office_mfa_consume_totp_step('${c}', 31337)`, () => userSnapshot(u), "admin_mfa_credentials", "");
      s.eq("FI-09c", "positive control: the step is consumable afterwards", (await q(`select office_mfa_consume_totp_step('${c}', 31337)`))[0][0], "t");
      await fail("FI-10", "WebAuthn counter update whose write fails leaves the counter untouched", `select office_mfa_webauthn_record_use('${u}', '${w}', 99)`, () => userSnapshot(u), "admin_mfa_credentials", "");
      const ch = (await q(`select id from office_mfa_create_challenge('${u}', 'webauthn_register', 'AAEC', 60)`))[0][0];
      await fail("FI-11", "challenge consumption whose write fails does not hand out the challenge", `select office_mfa_consume_challenge('${ch}', '${u}', 'webauthn_register')`, async () => JSON.stringify(await q(`select consumed_at is null from admin_mfa_challenges where id='${ch}'`)), "admin_mfa_challenges", "");
    }
    s.eq("FI-90", "no fault trigger is left behind", await num(`select count(*) from pg_trigger where tgname = 's7c_fault'`), 0);
    await q(`drop function s7c_boom()`);
  });

  // ================================================================== deadlocks between recovery-code consumption and credential activation
  await s.section("DL", async () => {
    const mix = async (label, rounds, build) => {
      let deadlocks = 0, other = 0, total = 0, samples = [];
      for (let r = 0; r < rounds; r++) {
        const { n, sql, setup } = await build();
        const rs = await par(n, sql);
        total += n;
        for (const e of P.errors(rs)) { if (e.error.code === "40P01") deadlocks++; else { other++; samples.push(e.error.code + ":" + e.error.message.slice(0, 80)); } }
      }
      return { deadlocks, other, total, samples };
    };
    const codes = (n) => Array.from({ length: n }, () => `dl-${hex()}`);
    // A. consumption (revoking) of several codes vs activation (which deletes unused codes and bumps the generation)
    const A = await mix("consume-vs-activate", 12, async () => {
      const u = await newUser(); await addTotp(u); const hs = codes(6); await addCodes(u, hs); const p = await addWa(u, { status: "pending" });
      return { n: 8, sql: (i) => (i < 6 ? `select * from office_mfa_consume_recovery_code_revoking('${u}', '${hs[i]}', 'dl')` : i === 6 ? `select * from office_mfa_activate_credential('${u}', '${p}', 'dl', null, null, array['dl-n-${hex()}','dl-n2-${hex()}'], 'k1')` : `select * from office_mfa_consume_recovery_code_revoking('${u}', '${hs[0]}', 'dl')`) };
    });
    s.check("DL-001", `recovery-code consumption racing credential activation (12 rounds, ${A.total} calls): no deadlock`, A.deadlocks === 0, { deadlocks: A.deadlocks, other: A.other, samples: A.samples.slice(0, 3) });
    s.check("DL-002", "and no other error", A.other === 0, A.samples.slice(0, 3));
    // B. consumption vs revocation of a factor
    const B = await mix("consume-vs-revoke", 8, async () => {
      const u = await newUser(); const a = await addWa(u); await addWa(u); const hs = codes(5); await addCodes(u, hs);
      return { n: 7, sql: (i) => (i < 5 ? `select * from office_mfa_consume_recovery_code_revoking('${u}', '${hs[i]}', 'dl')` : `select * from office_mfa_revoke_credential('${u}', '${a}', 'dl', 'r', false)`) };
    });
    s.check("DL-003", `recovery-code consumption racing factor revocation (8 rounds, ${B.total} calls): no deadlock`, B.deadlocks === 0 && B.other === 0, { deadlocks: B.deadlocks, other: B.other, samples: B.samples.slice(0, 3) });
    // C. consumption vs administrator reset
    const C = await mix("consume-vs-reset", 8, async () => {
      const u = await newUser(); await addTotp(u); const hs = codes(5); await addCodes(u, hs);
      return { n: 7, sql: (i) => (i < 5 ? `select * from office_mfa_consume_recovery_code_revoking('${u}', '${hs[i]}', 'dl')` : `select * from office_mfa_reset('${u}', 'dl')`) };
    });
    s.check("DL-004", `recovery-code consumption racing an administrator reset (8 rounds, ${C.total} calls): no deadlock`, C.deadlocks === 0 && C.other === 0, { deadlocks: C.deadlocks, other: C.other, samples: C.samples.slice(0, 3) });
    // D. consumption vs replacement of the batch (regeneration)
    const D = await mix("consume-vs-regenerate", 8, async () => {
      const u = await newUser(); const hs = codes(5); await addCodes(u, hs);
      return { n: 7, sql: (i) => (i < 5 ? `select * from office_mfa_consume_recovery_code_revoking('${u}', '${hs[i]}', 'dl')` : `select office_mfa_replace_recovery_codes('${u}', '${L.uuidv4()}', array['dl-r${i}-${hex()}'], 'k1')`) };
    });
    s.check("DL-005", `recovery-code consumption racing batch regeneration (8 rounds, ${D.total} calls): no deadlock`, D.deadlocks === 0 && D.other === 0, { deadlocks: D.deadlocks, other: D.other, samples: D.samples.slice(0, 3) });
    // E. deterministic interleaving: the activation holds the account lock while a consumption has already locked its code row
    {
      const u = await newUser(); await addTotp(u); const h = `dl-det-${hex()}`; await addCodes(u, [h]); const p = await addWa(u, { status: "pending" });
      const holder = st.session(); const consumer = st.session(); const probe = st.session();
      await holder.query("begin"); await holder.query(`set lock_timeout='20s'`);
      await holder.query(`select 1 from admin_users where id='${u}' for update`); // the first thing activate_credential does
      const cons = consumer.send(`set lock_timeout='20s';\nselect * from office_mfa_consume_recovery_code_revoking('${u}', '${h}', 'det')`); // locks the code row, then waits for the account row
      await L.waitFor(async () => Number(await probe.scalar(`select count(*) from pg_locks where not granted`)) >= 1, { timeoutMs: 20000, intervalMs: 50, what: "the consumption to wait for the account lock" });
      const act = await holder.query(`select * from office_mfa_activate_credential('${u}', '${p}', 'det', null, null, array['dl-det-n-${hex()}'], 'k1')`); // then deletes unused codes
      const consRaw = L.PsqlSession.parse(await cons);
      await holder.query("rollback");
      const dead = [act.error, consRaw.error].filter((e) => e && e.code === "40P01").length;
      s.check("DL-010", "deterministic interleaving (account lock held, code row locked by a consumption, then activation deletes the unused codes): no deadlock", dead === 0, { activation: act.error, consumption: consRaw.error });
    }
    // F. the application-level parallel pattern: plain consumption plus a separate generation bump racing activation
    const Fm = await mix("plain-consume-vs-activate", 6, async () => {
      const u = await newUser(); await addTotp(u); const hs = codes(4); await addCodes(u, hs); const p = await addWa(u, { status: "pending" });
      return { n: 6, sql: (i) => (i < 4 ? `select office_mfa_consume_recovery_code('${u}', '${hs[i]}')` : i === 4 ? `select * from office_revoke_admin_sessions('${u}', 'dl', null)` : `select * from office_mfa_activate_credential('${u}', '${p}', 'dl', null, null, array['dl-f-${hex()}'], 'k1')`) };
    });
    s.check("DL-020", `plain consumption, session revocation and activation in parallel (6 rounds, ${Fm.total} calls): no deadlock`, Fm.deadlocks === 0 && Fm.other === 0, { deadlocks: Fm.deadlocks, other: Fm.other, samples: Fm.samples.slice(0, 3) });
  });

  // ================================================================== the same single-use rules through the real application
  await s.section("APP", async () => {
    const mkMfaUser = async (role = "super_admin") => {
      const a = await F.accountWithTotp(fx, { role });
      return a;
    };
    const verifyBody = async (a, method, code) => { const l = await fx.client().post(`${L.P}/session/login`, { email: a.user.email, password: a.user.password }); return { challenge_token: l.json.challenge_token, method, code }; };
    const codesOf = async (uid) => ({ unused: await unusedCodes(uid), used: await num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${uid}' and used_at is not null`) });
    const wins = (rs) => rs.filter((r) => r.status === 200).length;

    // TOTP replay
    {
      const a = await mkMfaUser(); const g0 = await gen(a.user.id);
      const { code, step } = await a.totp.next();
      const body = await verifyBody(a, "totp", code);
      const rs = await Promise.all(Array.from({ length: 10 }, () => fx.client().post(`${L.P}/session/mfa/verify`, body)));
      s.check("APP-101", "one captured TOTP code, one challenge, 10 parallel verifications: exactly one session is issued", wins(rs) === 1, rs.map((r) => r.status));
      s.check("APP-102", "the nine others are refused with a generic 401 (or the lock, 429) and carry no cookie", rs.filter((r) => r.status !== 200).every((r) => (r.status === 401 || r.status === 429) && !r.setCookie), rs.map((r) => r.status));
      s.eq("APP-103", "the database holds the consumed step", await num(`select totp_last_step from admin_mfa_credentials where admin_user_id='${a.user.id}' and status='active'`), step);
      const a2 = await mkMfaUser(); const c2 = await a2.totp.next(); const bodies = [];
      for (let i = 0; i < 6; i++) bodies.push(await verifyBody(a2, "totp", c2.code));
      const rs2 = await Promise.all(bodies.map((b) => fx.client().post(`${L.P}/session/mfa/verify`, b)));
      s.check("APP-104", "the same code against six DIFFERENT challenges in parallel: exactly one session", wins(rs2) === 1, rs2.map((r) => r.status));
      const later = await fx.client().post(`${L.P}/session/mfa/verify`, await verifyBody(a2, "totp", c2.code));
      s.check("APP-105", "negative control: the same code again later is still a replay", later.status !== 200, later.status);
      const a3 = await mkMfaUser(); const c3 = await a3.totp.next(); const ok = await fx.client().post(`${L.P}/session/mfa/verify`, await verifyBody(a3, "totp", c3.code));
      s.eq("APP-106", "positive control: a fresh account's fresh code verifies", ok.status, 200);
    }
    // recovery code replay
    {
      const a = await mkMfaUser(); const [rc1, rc2, rc3] = a.recoveryCodes;
      const s0 = await a.client.me(); const g0 = await gen(a.user.id);
      const body = await verifyBody(a, "recovery_code", rc1);
      const rs = await Promise.all(Array.from({ length: 10 }, () => fx.client().post(`${L.P}/session/mfa/verify`, body)));
      s.check("APP-201", "one recovery code, 10 parallel verifications: exactly one session", wins(rs) === 1, rs.map((r) => r.status));
      const cc = await codesOf(a.user.id);
      s.eq("APP-202", "exactly one code is spent (nine remain) and the account's sessions were revoked exactly once", [cc.used, cc.unused, (await gen(a.user.id)) - g0], [1, 9, 1]);
      s.eq("APP-203", "the session that existed before the recovery code was used is dead (lost-device rule)", (await a.client.me()).status, 401);
      const win = rs.find((r) => r.status === 200);
      const meNew = await fx.client().me({ cookie: win.setCookie });
      s.eq("APP-204", "positive control: the winner's own new session works", meNew.status, 200);
      const replay = await fx.client().post(`${L.P}/session/mfa/verify`, await verifyBody(a, "recovery_code", rc1));
      s.check("APP-205", "negative control: the spent code never works again", replay.status !== 200, replay.status);
      const b = await mkMfaUser(); const [rb1, rb2] = b.recoveryCodes; const g1 = await gen(b.user.id);
      const rs2 = await Promise.all([rb1, rb2].map(async (c) => fx.client().post(`${L.P}/session/mfa/verify`, await verifyBody(b, "recovery_code", c))));
      s.check("APP-206", "two different codes in parallel both work (each is single use, neither blocks the other)", wins(rs2) === 2, rs2.map((r) => r.status));
      s.eq("APP-207", "and each bumped the generation (no lost revocation)", (await gen(b.user.id)) - g1, 2);
    }
    // enrolment activation race
    {
      const u = await L.seedUser(adm, { role: "super_admin" }); const c = fx.client();
      await c.login(u.email, u.password);
      const su = await c.stepUp(u.password, "mfa_management"); const h = { "x-step-up-token": su.token };
      const b = await c.post(`${L.P}/session/mfa/enroll/totp/begin`, {}, { headers: h });
      const totp = new L.TotpSource(b.json.secret_base32); const { code } = await totp.next(); const g0 = await gen(u.id);
      const rs = await Promise.all(Array.from({ length: 10 }, () => c.post(`${L.P}/session/mfa/enroll/totp/confirm`, { credential_id: b.json.credential_id, code }, { headers: h })));
      s.check("APP-301", "10 parallel confirmations of one pending enrolment: exactly one activates", wins(rs) === 1, rs.map((r) => r.status));
      s.check("APP-302", "the others report that the enrolment is no longer pending (409) and carry no recovery codes", rs.filter((r) => r.status !== 200).every((r) => r.status === 409 && !/recovery_codes/.test(r.text)), rs.map((r) => r.status));
      s.eq("APP-303", "exactly one batch of 10 recovery codes exists, one active TOTP, and sessions were revoked once", [await unusedCodes(u.id), await num(`select count(*) from admin_mfa_credentials where admin_user_id='${u.id}' and status='active'`), (await gen(u.id)) - g0], [10, 1, 1]);
      const winner = rs.find((r) => r.status === 200);
      s.eq("APP-304", "the winner received exactly 10 plaintext codes once", winner.json.recovery_codes.length, 10);
    }
    // logout and revocation
    {
      const user = await L.seedUser(adm, { role: "viewer" }); const c1 = fx.client(); const c2 = fx.client();
      const l1 = await c1.login(user.email, user.password); const l2 = await c2.login(user.email, user.password);
      const rs = await Promise.all(Array.from({ length: 10 }, () => fx.client().logout({ cookie: l1.cookie })));
      s.check("APP-401", "10 parallel logouts with the same cookie are all honest successes", rs.every((r) => r.status === 200 && r.json.revoked === true), rs.map((r) => r.status + ":" + (r.json && r.json.revoked)));
      s.eq("APP-402", "exactly one revoked-session record exists for the account (idempotent)", await num(`select count(*) from admin_revoked_sessions where admin_user_id='${user.id}'`), 1);
      s.eq("APP-403", "the copied cookie is refused", (await fx.client().me({ cookie: l1.cookie })).status, 401);
      s.eq("APP-404", "the account's other session survives", (await fx.client().me({ cookie: l2.cookie })).status, 200);
      const sess = []; for (let i = 0; i < 8; i++) sess.push((await fx.client().login(user.email, user.password)).cookie);
      const g0 = await gen(user.id);
      const rv = await Promise.all(sess.map((ck) => fx.client().post(`${L.P}/session/revoke-all`, {}, { cookie: ck })));
      const ok200 = rv.filter((r) => r.status === 200).length;
      s.check("APP-410", "8 sessions of one account revoking everything at once: every answer is 200 or 401, none is a server error", rv.every((r) => r.status === 200 || r.status === 401), rv.map((r) => r.status));
      s.eq("APP-411", "the generation moved exactly once per accepted request (no lost revocation)", (await gen(user.id)) - g0, ok200);
      const dead = await Promise.all([...sess, l2.cookie].map((ck) => fx.client().me({ cookie: ck })));
      s.check("APP-412", "afterwards every earlier session is dead", dead.every((r) => r.status === 401), dead.map((r) => r.status));
    }
    // setting write
    {
      const a = await mkMfaUser("super_admin"); const key = "office_document_brand_name";
      const put = (v, ver) => a.client.put(`/api/lead-agents/admin/settings/${key}`, { value: v, expected_version: ver });
      const base = await a.client.get(`/api/lead-agents/admin/settings/${key}`);
      s.eq("APP-501", "positive control: the setting is readable", base.status, 200);
      const ver = base.json.setting.version;
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => put(`Brand ${i}`, ver)));
      s.check("APP-502", "10 parallel saves from the same version: exactly one 200, the rest 409", wins(rs) === 1 && rs.filter((r) => r.status === 409).length === 9, rs.map((r) => r.status));
      const after = await a.client.get(`/api/lead-agents/admin/settings/${key}`);
      const winner = rs.findIndex((r) => r.status === 200);
      s.eq("APP-503", "the stored value is the winner's and the version moved by exactly one", [after.json.setting.value, after.json.setting.version], [`Brand ${winner}`, ver + 1]);
      s.eq("APP-504", "the audit trail records exactly one success for it", await num(`select count(*) from audit_events where action='office_document_brand_name_changed' and metadata->>'outcome'='success' and metadata->>'version'='${ver + 1}'`), 1);
      s.check("APP-505", "every losing request is recorded as a conflict in the setting history", (await num(`select count(*) from office_runtime_setting_history where setting_key='${key}' and outcome='conflict'`)) >= 9);
    }
    // administrator reset
    {
      const actor = await mkMfaUser("super_admin"); const target = await mkMfaUser("viewer");
      const targetCookie = target.client.cookie;
      const tcode = await actor.totp.next();
      const su = await actor.client.stepUp(actor.user.password, "mfa_management", { method: "totp", code: tcode.code });
      s.check("APP-601", "positive control: the actor obtains a step-up grant carrying a verified second factor", su.status === 200 && su.json.step_up.mfa_verified === true, su.text.slice(0, 200));
      const gT = await gen(target.user.id);
      const body = { reason: "lost device, verified in person", confirm: true, confirm_email: target.user.email };
      const rs = await Promise.all(Array.from({ length: 8 }, () => actor.client.post(`/api/lead-agents/admin/users/${target.user.id}/mfa/reset`, body, { headers: { "x-step-up-token": su.token } })));
      const okRs = rs.filter((r) => r.status === 200);
      const sumC = okRs.reduce((a, r) => a + r.json.credentials_revoked, 0); const sumD = okRs.reduce((a, r) => a + r.json.recovery_codes_deleted, 0);
      s.check("APP-602", "8 parallel resets of one account: none is a server error", rs.every((r) => r.status < 500), rs.map((r) => r.status));
      s.check("APP-603", "the factor and the ten codes are removed exactly once in total (one winner)", sumC === 1 && sumD === 10, { sumC, sumD, statuses: rs.map((r) => r.status) });
      s.eq("APP-604", "the target has no active factor, no unused code, and a re-enrolment requirement", [await num(`select count(*) from admin_mfa_credentials where admin_user_id='${target.user.id}' and status in ('active','pending')`), await unusedCodes(target.user.id), await scalar(`select mfa_required_after is not null from admin_users where id='${target.user.id}'`)], [0, 0, "t"]);
      s.eq("APP-605", "the target's existing session was revoked", (await fx.client().me({ cookie: targetCookie })).status, 401);
      s.check("APP-606", "the reset is audited once per accepted request, naming no secret", (await num(`select count(*) from audit_events where action='mfa_reset_by_admin' and target_id='${target.user.id}'`)) === okRs.length && !/(secret|ciphertext|hmac)/i.test(JSON.stringify(await q(`select metadata from audit_events where action='mfa_reset_by_admin' and target_id='${target.user.id}'`))));
    }
  });
});
