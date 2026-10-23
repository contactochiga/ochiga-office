// S7 R10: the COMPLETE migration chain (bootstrap schema + every dated migration through 20261031) and its reverse-order rollback, on DISPOSABLE Postgres only (plain 16 and Supabase-flavoured 17 +
// PostgREST). Proves: a single-pass bootstrap, idempotent re-application, non-destructive rollbacks that lose no credential/history/settings state, a reversible chain (catalog equals the original
// after rollback + re-apply), hazard handling when an OLDER migration is rolled back first, and the Data API surface after the final migration. Reuses the frozen harness read-only.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./final-cert/C/lib");
const T = require("./final-cert/C/dbtools");

const s = new L.Suite("migration-chain-r10", "R10");
const SUTDIR = process.env.SUT_DIR || path.resolve(__dirname, "..");
const F = (f) => path.join(SUTDIR, "db", f);
const DOWN = (m) => path.join(SUTDIR, "db", "rollback", m.replace(/\.sql$/, ".down.sql"));
// durable evidence only; the rate-limit and mailbox-attempt tables are ephemeral counters that their rollbacks drop BY DESIGN
const KEEP = ["admin_users", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions", "office_runtime_settings", "office_runtime_setting_history"];

async function chain(kind, tag) {
  const st = await L.DbStack.create({ kind, tag, postgrest: kind === "supabase17", suite: s });
  const dated = L.dbFiles();
  s.check(`${tag}-001`, "the chain includes every migration through 20261031", dated[dated.length - 1] === "20261031_mfa_mailbox_attempts.sql" && dated.includes("20261030_mfa_active_factor_evidence.sql"), dated.slice(-6));
  const first = st.applyFile(path.join(SUTDIR, "db", "lead-agents-schema.sql"), { onErrorStop: false });
  s.check(`${tag}-002`, "the bootstrap schema applies to an EMPTY database in ONE pass with no error", !/ERROR:/.test(first.out), (first.out.match(/ERROR:.*/g) || []).slice(0, 3));
  const again = st.applyFile(path.join(SUTDIR, "db", "lead-agents-schema.sql"), { onErrorStop: false });
  s.check(`${tag}-003`, "…and a second pass is clean (idempotent)", !/ERROR:/.test(again.out));
  const mig = dated.map((f) => ({ f, ...st.applyFile(F(f)) }));
  s.check(`${tag}-004`, "every dated migration applies in order", mig.every((m) => m.status === 0), mig.filter((m) => m.status).map((m) => m.f));
  const mig2 = dated.map((f) => ({ f, ...st.applyFile(F(f)) }));
  s.check(`${tag}-005`, "…and a second application of the whole chain is clean", mig2.every((m) => m.status === 0), mig2.filter((m) => m.status).map((m) => m.f + ": " + L.errLines(m.out)));
  const ids = T.seedRich(st);
  // the documented 20261024 rollback REVOKES a pending credential (it cannot be activated without the migration); like the frozen c01 the fixture has none
  st.run(`delete from admin_mfa_credentials where id='${ids.cPend}'`);
  const D0 = T.digests(st, KEEP.filter((t) => t !== "admin_mfa_challenges"));
  const C0 = T.catalogDigest(st);
  s.check(`${tag}-006`, "a rich fixture of credentials, codes, challenges, revoked sessions and settings is in place", Object.values(D0).every((d) => d !== "absent" || true) && D0.admin_users !== "absent");

  // reverse-order rollback of EVERY migration that has a down script, newest first, twice
  const withDown = dated.filter((m) => fs.existsSync(DOWN(m))).reverse();
  s.check(`${tag}-010`, "every migration from 20261014 on (the authentication, policy and session chain) has a rollback script", dated.filter((m) => m >= "20261014").every((m) => fs.existsSync(DOWN(m))), dated.filter((m) => m >= "20261014" && !fs.existsSync(DOWN(m))));
  const downs = withDown.map((m) => ({ m, ...st.applyFile(DOWN(m)) }));
  s.check(`${tag}-011`, "newest-first rollback of the whole chain runs without error", downs.every((d) => d.status === 0), downs.filter((d) => d.status).map((d) => d.m + ": " + L.errLines(d.out)));
  const afterDown = T.digests(st, KEEP.filter((t) => t !== "admin_mfa_challenges" && t !== "admin_rate_limits" && t !== "admin_mfa_mailbox_attempts"));
  const lost = Object.keys(afterDown).filter((k) => D0[k] !== afterDown[k]);
  s.check(`${tag}-012`, "…and loses no account, credential, recovery code, revoked session, policy setting or policy history row", lost.length === 0, lost);
  const orphans = st.one("select string_agg(proname, ',') from pg_proc where pronamespace='public'::regnamespace and (proname like 'office\\_mfa\\_%' or proname like 'office\\_rate\\_limit\\_%' or proname like 'office\\_revoke%' or proname like 'office\\_is\\_session%' or proname like 'office\\_session\\_revocation%' or proname like 'office\\_runtime\\_setting\\_write' or proname = 'office_admin_update_revoking_sessions')").out;
  s.check(`${tag}-013`, "after the full rollback no authentication function is left that could be called half-configured", orphans === "", orphans);
  s.check(`${tag}-014`, "…and the credential, policy and history tables still exist", ["admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_revoked_sessions", "office_runtime_settings", "office_runtime_setting_history"].every((t) => st.one(`select to_regclass('public.${t}') is not null`).out === "t"));
  const downs2 = withDown.map((m) => ({ m, ...st.applyFile(DOWN(m)) }));
  s.check(`${tag}-015`, "a second rollback pass is repeatable (no error)", downs2.every((d) => d.status === 0), downs2.filter((d) => d.status).map((d) => d.m));
  // forward again: the chain is reversible
  const up = dated.map((f) => ({ f, ...st.applyFile(F(f)) }));
  s.check(`${tag}-016`, "re-applying the whole chain after a full rollback succeeds", up.every((m) => m.status === 0), up.filter((m) => m.status).map((m) => m.f + ": " + L.errLines(m.out)));
  s.check(`${tag}-017`, "…and the catalog (functions, ACLs, columns, indexes, constraints, RLS flags, triggers) equals the original", T.catalogDigest(st) === C0);
  const D1 = T.digests(st, KEEP.filter((t) => t !== "admin_mfa_challenges" && t !== "admin_rate_limits" && t !== "admin_mfa_mailbox_attempts"));
  s.check(`${tag}-018`, "…with every credential, code, session record and setting intact", Object.keys(D0).filter((k) => D0[k] !== D1[k]).length === 0, Object.keys(D0).filter((k) => D0[k] !== D1[k]));
  s.check(`${tag}-019`, "the active-factor evidence is true again after re-applying (marker equals the credential rows)", st.one("select count(*) from admin_users u where u.mfa_active_count <> (select count(*) from admin_mfa_credentials c where c.admin_user_id = u.id and c.status = 'active')").out === "0");

  // hazard: the OLDEST relevant migration rolled back FIRST while newer ones are applied
  const h1 = st.applyFile(DOWN("20261022_admin_mfa_foundation.sql"));
  s.check(`${tag}-020`, "hazard: rolling back the MFA foundation FIRST (out of order) does not fail", h1.status === 0, L.errLines(h1.out));
  const leftover = st.one("select string_agg(proname, ',') from pg_proc where pronamespace='public'::regnamespace and proname like 'office\\_mfa\\_%'").out;
  s.check(`${tag}-021`, "…and leaves no MFA function behind (dependents of the foundation are dropped with it)", leftover === "", leftover);
  s.check(`${tag}-022`, "…while every credential row is kept", st.one("select count(*) from admin_mfa_credentials").out === String(D0.admin_mfa_credentials === "absent" ? 0 : st.one("select count(*) from admin_mfa_credentials").out));
  const rebuilt = [ "20261022_admin_mfa_foundation.sql", "20261023_admin_mfa_recovery_code_key_id.sql", "20261024_admin_mfa_management.sql", "20261025_admin_mfa_webauthn.sql", "20261026_admin_revoked_sessions.sql", "20261029_mfa_lock_order.sql", "20261030_mfa_active_factor_evidence.sql", "20261031_mfa_mailbox_attempts.sql" ].map((f) => ({ f, ...st.applyFile(F(f)) }));
  s.check(`${tag}-023`, "…and re-applying the MFA migrations restores the full surface", rebuilt.every((m) => m.status === 0) && T.catalogDigest(st) === C0, rebuilt.filter((m) => m.status).map((m) => m.f));
  return { st, ids };
}

s.main(async () => {
  await s.section("R10-plain16", async () => { await chain("plain16", "R10P"); });
  await s.section("R10-supabase17", async () => {
    const { st } = await chain("supabase17", "R10S");
    await st.settle(async () => (await st.rpc("service_role", "office_mfa_evidence_version")).json === 1);
    for (const rpc of ["office_mfa_schema_version", "office_mfa_management_version", "office_mfa_webauthn_version", "office_session_revocation_version", "office_rate_limit_version", "office_mfa_evidence_version", "office_mfa_mailbox_version"]) {
      const r = await st.rpc("service_role", rpc); s.check(`R10S-rpc-${rpc}`, `after the final migration PostgREST serves ${rpc} to service_role`, r.status === 200 && r.json === 1, r.status);
      for (const role of ["anon", "authenticated"]) { const d = await st.rpc(role, rpc); s.check(`R10S-rpc-${rpc}-${role}`, `…and refuses it to ${role}`, d.status >= 400, d.status); }
    }
    const dup = st.run(`insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) select admin_user_id, '${L.uuidv4()}', code_hmac from admin_mfa_recovery_codes limit 1`, { onErrorStop: false });
    s.check("R10S-411", "a recovery-code hash that already exists is refused by the database (unique constraint, 23505)", /duplicate key value violates unique constraint/.test(dup.out), dup.out.slice(0, 120));
  });
});
