"use strict";
// AREA C / C02: role boundaries enumerated from the catalog of a Supabase Postgres 17 instance and exercised with SET ROLE.
// anon, authenticated and PUBLIC must have no way to read or write authentication tables or call authentication-related functions; the service role must keep working.
const L = require("./lib");
const T = require("./dbtools");

const s = new L.Suite("c02-roles-privileges", "C");

s.main(async () => {
  const st = await L.DbStack.create({ kind: "supabase17", tag: "c02", suite: s });
  const fx = st.applyAll();
  const ids = T.seedRich(st);
  const adm = st.session({ user: "postgres" });
  const q1 = (sql) => adm.scalar(sql);
  const DEMO = L.uuidv4();

  // sample invocations (valid arguments) for every function of the interface
  const u = ids.u2;
  const CALLS = {
    "office_revoke_admin_sessions": `select * from office_revoke_admin_sessions('${u}', 'probe', 'probe')`,
    "office_admin_update_revoking_sessions": `select * from office_admin_update_revoking_sessions('${u}', 'probe', 'x:y')`,
    "office_mfa_schema_version": "select office_mfa_schema_version()",
    "office_mfa_consume_totp_step": `select office_mfa_consume_totp_step('${ids.cTotp}', 99999999)`,
    "office_mfa_consume_recovery_code": `select office_mfa_consume_recovery_code('${ids.u1}', 'hmac-u1-b')`,
    "office_mfa_replace_recovery_codes": `select office_mfa_replace_recovery_codes('${u}', '${DEMO}', array['probe-h1'], 'k1')`,
    "office_mfa_create_challenge": `select * from office_mfa_create_challenge('${u}', 'webauthn_register', 'AAEC', 60)`,
    "office_mfa_consume_challenge": `select office_mfa_consume_challenge('${DEMO}', '${u}', 'webauthn_register')`,
    "office_mfa_record_failure": `select * from office_mfa_record_failure('${u}')`,
    "office_mfa_clear_failures": `select office_mfa_clear_failures('${u}')`,
    "office_mfa_reset": `select * from office_mfa_reset('${ids.u1}', 'probe')`,
    "office_mfa_prune_challenges": "select office_mfa_prune_challenges(interval '0 seconds')",
    "office_mfa_management_version": "select office_mfa_management_version()",
    "office_mfa_activate_credential": `select * from office_mfa_activate_credential('${ids.u1}', '${ids.cPend}', 'probe')`,
    "office_mfa_revoke_credential": `select * from office_mfa_revoke_credential('${ids.u1}', '${ids.cTotp}', 'probe')`,
    "office_mfa_consume_recovery_code_revoking": `select * from office_mfa_consume_recovery_code_revoking('${ids.u1}', 'hmac-u1-c', 'probe')`,
    "office_mfa_webauthn_version": "select office_mfa_webauthn_version()",
    "office_mfa_webauthn_record_use": `select office_mfa_webauthn_record_use('${ids.u1}', '${ids.cWa}', 500)`,
    "office_session_revocation_version": "select office_session_revocation_version()",
    "office_revoke_session": `select office_revoke_session('probe-digest-0123456789ab', '${u}', now() + interval '1 day')`,
    "office_is_session_revoked": "select office_is_session_revoked('digest-seed-0123456789abcdef-1')",
    "office_runtime_setting_write": `select office_runtime_setting_write('office_mfa_enforcement', '"off"'::jsonb, 'probe', null, 'probe', false, true)`,
    "office_runtime_setting_record_attempt": `select office_runtime_setting_record_attempt('office_mfa_enforcement', 'probe', 'probe', 'denied', 'probe', null, false)`,
  };
  const fnName = (sig) => sig.split("(")[0];
  const STATE = ["admin_users", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions", "office_runtime_settings", "office_runtime_setting_history", "audit_events"];
  const stateBefore = T.digests(st, STATE);

  /** Run one statement in a throw-away transaction under a role. */
  async function as(role, stmt, sess = adm) {
    const r = await sess.query(`begin; set local role ${role}; ${stmt}; rollback;`);
    await sess.query("rollback; reset role");
    return r;
  }
  const denied = (r) => !!r.error && r.error.code === "42501";
  const noEffect = (r) => !!r.error || r.rows.length === 0;

  // ---------------------------------------------------------------- 1. enumerate from the catalog
  const catTables = await adm.json(`select c.relname, c.relkind, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      has_table_privilege('anon', c.oid, 'select') anon_select, has_table_privilege('anon', c.oid, 'insert') anon_insert, has_table_privilege('anon', c.oid, 'update') anon_update, has_table_privilege('anon', c.oid, 'delete') anon_delete, has_table_privilege('anon', c.oid, 'truncate') anon_truncate, has_table_privilege('anon', c.oid, 'references') anon_references, has_table_privilege('anon', c.oid, 'trigger') anon_trigger,
      has_table_privilege('authenticated', c.oid, 'select') auth_select, has_table_privilege('authenticated', c.oid, 'insert') auth_insert, has_table_privilege('authenticated', c.oid, 'update') auth_update, has_table_privilege('authenticated', c.oid, 'delete') auth_delete, has_table_privilege('authenticated', c.oid, 'truncate') auth_truncate,
      (select count(*) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0) as public_grants,
      (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') order by 1`);
  s.check("ROLE-001", "the catalog enumeration finds the authentication tables", T.AUTH_TABLES.every((t) => catTables.some((c) => c.relname === t)), T.AUTH_TABLES.filter((t) => !catTables.some((c) => c.relname === t)));
  const byName = Object.fromEntries(catTables.map((c) => [c.relname, c]));

  await s.section("ROLE-2", async () => {
    for (const t of T.AUTH_TABLES) {
      const c = byName[t]; if (!c) continue;
      s.check(`ROLE-201-${t}`, `${t}: row level security is enabled`, c.rls === true, c);
      for (const r of ["anon", "authenticated"]) {
        const p = r === "anon" ? "anon" : "auth";
        s.check(`ROLE-202-${t}-${r}`, `${t}: ${r} holds no SELECT privilege`, c[`${p}_select`] === false);
        s.check(`ROLE-203-${t}-${r}`, `${t}: ${r} holds no INSERT/UPDATE/DELETE privilege`, c[`${p}_insert`] === false && c[`${p}_update`] === false && c[`${p}_delete`] === false);
        s.check(`ROLE-204-${t}-${r}`, `${t}: ${r} holds no TRUNCATE privilege`, c[`${p}_truncate`] === false);
      }
      s.check(`ROLE-205-${t}`, `${t}: anon holds no REFERENCES or TRIGGER privilege`, c.anon_references === false && c.anon_trigger === false);
      s.check(`ROLE-206-${t}`, `${t}: PUBLIC holds no privilege`, Number(c.public_grants) === 0, c.public_grants);
    }
    // column level: the secret columns specifically
    for (const [tbl, col] of [["admin_users", "password_hash"], ["admin_users", "qr_credential"], ["admin_mfa_credentials", "secret_ciphertext"], ["admin_mfa_credentials", "webauthn_public_key"], ["admin_mfa_recovery_codes", "code_hmac"], ["admin_invites", "token_hash"], ["password_reset_tokens", "token_hash"], ["admin_mfa_challenges", "challenge"]]) {
      for (const r of ["anon", "authenticated"]) {
        s.check(`ROLE-207-${tbl}.${col}-${r}`, `${tbl}.${col}: ${r} cannot read the column`, (await q1(`select has_column_privilege('${r}', 'public.${tbl}', '${col}', 'select')`)) === "f");
      }
    }
    // everything else in schema public: no table is open to the Data API roles without row level security
    const open = catTables.filter((c) => c.relkind === "r" && !c.rls && (c.anon_select || c.auth_select || c.anon_insert || c.auth_insert || c.anon_update || c.auth_update || c.anon_delete || c.auth_delete)).map((c) => c.relname);
    s.check("ROLE-210", "no table of schema public is readable or writable by anon/authenticated without row level security", open.length === 0, open);
    const openAuth = open.filter((t) => T.AUTH_TABLES.includes(t));
    s.check("ROLE-211", "none of the authentication tables is among the tables open to anon/authenticated", openAuth.length === 0, openAuth);
    const noPolicyOpen = catTables.filter((c) => c.relkind === "r" && c.rls && c.policies === 0 && (c.anon_select || c.auth_select)).map((c) => c.relname);
    s.check("ROLE-212", "tables with row level security and no policy also carry no privilege for anon/authenticated (defence in depth, as the MFA tables do)", noPolicyOpen.length === 0, noPolicyOpen);
    s.check("ROLE-213", "no authentication table carries a policy that could open it", T.AUTH_TABLES.every((t) => !byName[t] || Number(byName[t].policies) === 0), T.AUTH_TABLES.filter((t) => byName[t] && Number(byName[t].policies) > 0));
  });

  // ---------------------------------------------------------------- 2. functions
  const catFns = await adm.json(`select p.oid::regprocedure::text as sig, p.proname, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.prolang::regclass::text as lang, p.provolatile as vol,
      has_function_privilege('anon', p.oid, 'execute') as anon_exec, has_function_privilege('authenticated', p.oid, 'execute') as auth_exec, has_function_privilege('service_role', p.oid, 'execute') as svc_exec,
      (select count(*) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_exec
    from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`);
  await s.section("ROLE-3", async () => {
    const office = catFns.filter((f) => /^office_/.test(f.proname));
    s.check("ROLE-301", "every authentication function of the interface exists", T.AUTH_FUNCTIONS.every((sig) => office.some((f) => f.proname === fnName(sig))), T.AUTH_FUNCTIONS.filter((sig) => !office.some((f) => f.proname === fnName(sig))));
    const unknown = office.filter((f) => !T.AUTH_FUNCTIONS.some((sig) => fnName(sig) === f.proname)).map((f) => f.sig);
    s.check("ROLE-302", "the catalog holds no office_ function outside the documented interface", unknown.length === 0, unknown);
    for (const f of office) {
      s.check(`ROLE-310-${f.proname}`, `${f.sig}: anon has no EXECUTE`, f.anon_exec === false);
      s.check(`ROLE-311-${f.proname}`, `${f.sig}: authenticated has no EXECUTE`, f.auth_exec === false);
      s.check(`ROLE-312-${f.proname}`, `${f.sig}: PUBLIC has no EXECUTE`, Number(f.public_exec) === 0, f.public_exec);
      s.check(`ROLE-313-${f.proname}`, `${f.sig}: service_role keeps EXECUTE (positive control)`, f.svc_exec === true);
      s.check(`ROLE-314-${f.proname}`, `${f.sig}: is SECURITY INVOKER (a definer function would run with its owner's rights for any caller)`, f.definer === false);
    }
    const anyDefiner = catFns.filter((f) => f.definer && (f.anon_exec || f.auth_exec)).map((f) => f.sig);
    s.check("ROLE-320", "no SECURITY DEFINER function in schema public is executable by anon/authenticated", anyDefiner.length === 0, anyDefiner);
    const exposed = catFns.filter((f) => /^office_|^set_updated_at$/.test(f.proname) && (f.anon_exec || f.auth_exec)).map((f) => f.sig);
    s.check("ROLE-321", "no office_* function (including trigger helpers) is executable by anon/authenticated", exposed.length === 0, exposed);
    // creation rights: a role that can create objects can plant a definer wrapper
    for (const r of ["anon", "authenticated"]) {
      s.check(`ROLE-330-${r}`, `${r} cannot create objects in schema public`, (await q1(`select has_schema_privilege('${r}', 'public', 'create')`)) === "f");
      const cr = await as(r, "create function public.s7c_plant() returns int language sql as 'select 1'");
      s.check(`ROLE-331-${r}`, `${r} cannot plant a function through SQL`, denied(cr), cr.error);
      const ct = await as(r, "create table public.s7c_plant(a int)");
      s.check(`ROLE-332-${r}`, `${r} cannot create a table through SQL`, denied(ct), ct.error);
    }
  });

  // ---------------------------------------------------------------- 3. behaviour: SET ROLE against every table and function, repeated
  await s.section("ROLE-4", async () => {
    for (const role of ["anon", "authenticated"]) {
      // read
      for (const t of T.AUTH_TABLES) {
        const total = Number(await q1(`select count(*) from ${t}`));
        const r = await as(role, `select count(*) from ${t}`);
        const seen = r.error ? 0 : Number(r.rows[0][0]);
        s.check(`ROLE-401-${role}-${t}`, `${role} reads no row of ${t} (table has ${total}; denied or empty expected)`, seen === 0, r.error || { rowsVisible: seen });
      }
      // secret values specifically
      const pw = await as(role, "select password_hash from admin_users limit 1");
      s.check(`ROLE-402-${role}`, `${role} cannot read any password hash`, noEffect(pw), pw.rows.slice(0, 1).map((x) => String(x[0]).slice(0, 10) + "..."));
      const pw2 = await as(role, "select email, password_hash, role, permission_scopes from admin_users");
      s.check(`ROLE-403-${role}`, `${role} cannot list account e-mails and roles`, noEffect(pw2), { rows: pw2.rows.length });
      const rt = await as(role, "select token_hash from password_reset_tokens");
      s.check(`ROLE-404-${role}`, `${role} cannot read reset-token hashes`, noEffect(rt));
      const inv = await as(role, "select token_hash from admin_invites");
      s.check(`ROLE-405-${role}`, `${role} cannot read invite-token hashes`, noEffect(inv));
      // write
      for (const t of T.AUTH_TABLES) {
        const first = (await q1(`select column_name from information_schema.columns where table_schema='public' and table_name='${t}' order by ordinal_position limit 1`));
        const up = await as(role, `update ${t} set ${first} = ${first} returning 1`);
        s.check(`ROLE-410-${role}-${t}`, `${role} updates no row of ${t}`, noEffect(up), up.error || { updated: up.rows.length });
        const de = await as(role, `delete from ${t} returning 1`);
        s.check(`ROLE-411-${role}-${t}`, `${role} deletes no row of ${t}`, noEffect(de), de.error || { deleted: de.rows.length });
      }
      const ins = await as(role, `insert into admin_users (email, password_hash, role) values ('planted-${role}@fixture.test', 'x:y', 'super_admin') returning id`);
      s.check(`ROLE-420-${role}`, `${role} cannot create an administrator account`, noEffect(ins), ins.error || { inserted: ins.rows.length });
      const ins2 = await as(role, `insert into audit_events (actor_email, action, target_type) values ('forged@fixture.test', 'forged_event', 'admin_user') returning id`);
      s.check(`ROLE-421-${role}`, `${role} cannot forge an audit record`, noEffect(ins2), ins2.error || { inserted: ins2.rows.length });
      const insRs = await as(role, `insert into office_runtime_settings (key, value) values ('office_mfa_enforcement_x', '"off"') returning key`);
      s.check(`ROLE-422-${role}`, `${role} cannot write a runtime setting`, noEffect(insRs));
      const elev = await as(role, `update admin_users set role = 'super_admin', status = 'active', password_hash = 'a:b' returning id`);
      s.check(`ROLE-423-${role}`, `${role} cannot escalate or take over an account (role / status / hash rewrite)`, noEffect(elev), elev.error || { updated: elev.rows.length });
      const aud = await as(role, `delete from audit_events returning id`);
      s.check(`ROLE-424-${role}`, `${role} cannot erase audit records`, noEffect(aud), aud.error || { deleted: aud.rows.length });
      // functions, three rounds to defeat caching effects
      for (const sig of T.AUTH_FUNCTIONS) {
        const n = fnName(sig); let allDenied = true; let sample;
        for (let round = 0; round < 3; round++) { const r = await as(role, CALLS[n]); if (!denied(r)) { allDenied = false; sample = r.error || { rows: r.rows.slice(0, 1) }; break; } }
        s.check(`ROLE-430-${role}-${n}`, `${role} is refused (42501) when calling ${n}, three times`, allDenied, sample);
      }
    }
    s.eq("ROLE-450", "no state row of any authentication table changed during the whole anon/authenticated probing", T.digests(st, STATE), stateBefore);
  });

  // ---------------------------------------------------------------- 4. cached plans: PostgREST keeps prepared statements per connection; a constant function must still be checked per call
  await s.section("ROLE-5", async () => {
    const probes = ["office_mfa_schema_version()", "office_mfa_management_version()", "office_mfa_webauthn_version()", "office_session_revocation_version()", "office_is_session_revoked('digest-seed-0123456789abcdef-1')"];
    for (const role of ["anon", "authenticated"]) {
      for (const probe of probes) {
        const one = L.PsqlSession ? st.session({ user: "postgres" }) : null;
        await one.query(`prepare pp as select ${probe}`);
        let firstOk = false; const refusals = [];
        // the generic plan is adopted after five executions: alternate the privileged role and the unprivileged role on the same connection and statement
        for (let i = 0; i < 12; i++) {
          const svc = await one.query("set role service_role; execute pp; reset role");
          if (i === 0) firstOk = !svc.error && svc.rows.length === 1;
          const lo = await one.query(`set role ${role}; execute pp; reset role`);
          refusals.push(denied(lo));
        }
        s.check(`ROLE-501-${role}-${probe.split("(")[0]}`, `service_role may execute the cached ${probe} (positive control)`, firstOk);
        s.check(`ROLE-502-${role}-${probe.split("(")[0]}`, `${role} is refused on every one of 12 executions of the cached ${probe} (no plan-cache bypass)`, refusals.every(Boolean), refusals);
        await one.close();
      }
    }
    // the same through a reused connection that changes role by SESSION AUTHORIZATION-less SET ROLE in a loop
    const loop = st.session({ user: "postgres" });
    let leaks = 0;
    for (let i = 0; i < 40; i++) {
      for (const role of ["anon", "authenticated"]) { const r = await loop.query(`set role ${role}; select count(*) from password_reset_tokens; select count(*) from admin_mfa_credentials; reset role`); if (!r.error && r.rows.some((row) => Number(row[0]) > 0)) leaks++; }
    }
    s.check("ROLE-503", "repeated SET ROLE anon/authenticated on one connection (40 rounds) never exposes a row of the credential tables", leaks === 0, { leaks });
    await loop.close();
  });

  // ---------------------------------------------------------------- 5. the service role boundary works (positive controls) and is tight
  await s.section("ROLE-6", async () => {
    const svc = (stmt) => as("service_role", stmt);
    const sel = await svc("select count(*) from admin_users"); s.check("ROLE-601", "service_role can read admin_users", !sel.error && Number(sel.rows[0][0]) >= 2, sel.error);
    const gen = await svc(`select * from office_revoke_admin_sessions('${ids.u2}', 'svc', 'test')`); s.check("ROLE-602", "service_role can revoke sessions through the function", !gen.error && gen.rows.length === 1, gen.error);
    const cr = await svc(`select * from office_mfa_create_challenge('${ids.u2}', 'webauthn_register', 'AAEC', 60)`); s.check("ROLE-603", "service_role can create a challenge", !cr.error && cr.rows.length === 1, cr.error);
    const tbl = await svc(`select count(*) from admin_mfa_credentials`); s.check("ROLE-604", "service_role can read credentials (for ciphertext handling by the application)", !tbl.error && Number(tbl.rows[0][0]) >= 3, tbl.error);
    const insC = await svc(`insert into admin_mfa_credentials (admin_user_id, type, status, webauthn_credential_id, webauthn_public_key) values ('${ids.u2}', 'webauthn', 'pending', decode('${L.randomHex(8)}','hex'), decode('aa','hex')) returning id`); s.check("ROLE-605", "service_role can insert a pending credential", !insC.error && insC.rows.length === 1, insC.error);
    const delC = await svc(`delete from admin_mfa_credentials where id = '${ids.cRev}' returning id`);
    s.check("ROLE-606", "service_role cannot DELETE credentials (revocation is a status change; deleting would silently downgrade an account)", !!delC.error && delC.error.code === "42501", delC.error || { deleted: delC.rows.length });
    const delAdm = await svc(`delete from admin_mfa_recovery_codes where code_hmac = 'hmac-u2-b' returning 1`); s.check("ROLE-607", "service_role can delete unused recovery codes (needed by regeneration)", !delAdm.error && delAdm.rows.length === 1, delAdm.error);
    const trunc = await svc("truncate admin_mfa_recovery_codes"); s.check("ROLE-608", "service_role cannot TRUNCATE the recovery-code table", !!trunc.error, trunc.error);
    const truncC = await svc("truncate admin_mfa_credentials"); s.check("ROLE-609", "service_role cannot TRUNCATE the credential table", !!truncC.error, truncC.error);
    const ddl = await svc("drop table admin_mfa_credentials cascade"); s.check("ROLE-610", "service_role cannot DROP an authentication table", !!ddl.error, ddl.error);
    const alt = await svc("alter table admin_users disable row level security"); s.check("ROLE-611", "service_role cannot alter table security settings", !!alt.error, alt.error);
    const cf = await svc("create function public.s7c_plant2() returns int language sql as 'select 1'"); s.check("ROLE-612", "service_role cannot create functions in the schema", !!cf.error, cf.error);
    const hist = await svc("update office_runtime_setting_history set actor = 'x'"); s.check("ROLE-613", "service_role cannot rewrite the setting history", !!hist.error, hist.error);
    const histD = await svc("delete from office_runtime_setting_history"); s.check("ROLE-614", "service_role cannot delete setting history", !!histD.error, histD.error);
    const rs = await svc("truncate office_runtime_setting_history"); s.check("ROLE-615", "service_role cannot truncate the append-only setting history", !!rs.error, rs.error);
    const audUp = await svc("update audit_events set action = 'tampered' returning 1");
    s.check("ROLE-616", "service_role cannot rewrite audit records (audit is append-only evidence)", noEffect(audUp), audUp.error || { updated: audUp.rows.length });
    const audDel = await svc("delete from audit_events returning 1");
    s.check("ROLE-617", "service_role cannot delete audit records", noEffect(audDel), audDel.error || { deleted: audDel.rows.length });
    const att = await adm.json("select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname in ('anon','authenticated','authenticator','service_role')");
    const R = Object.fromEntries(att.map((r) => [r.rolname, r]));
    s.check("ROLE-620", "anon, authenticated and authenticator are not superuser and do not bypass row level security", ["anon", "authenticated", "authenticator"].every((n) => !R[n].rolsuper && !R[n].rolbypassrls), att);
    s.check("ROLE-621", "service_role is not a superuser (it bypasses RLS only)", R.service_role.rolsuper === false && R.service_role.rolbypassrls === true, R.service_role);
    s.check("ROLE-622", "none of the Data API roles can create roles or databases", att.every((r) => !r.rolcreaterole && !r.rolcreatedb && !r.rolreplication), att);
    const members = await adm.json("select r.rolname as role, m.rolname as member from pg_auth_members am join pg_roles r on r.oid = am.roleid join pg_roles m on m.oid = am.member where m.rolname in ('authenticator','anon','authenticated','service_role')");
    const grantedToAuthenticator = members.filter((x) => x.member === "authenticator").map((x) => x.role).sort();
    s.check("ROLE-623", "authenticator can become anon, authenticated and service_role and nothing more powerful (not postgres, not supabase_admin, not a superuser)", ["anon", "authenticated", "service_role"].every((x) => grantedToAuthenticator.includes(x)) && !grantedToAuthenticator.some((x) => ["postgres", "supabase_admin", "pg_execute_server_program", "pg_write_server_files", "pg_read_server_files"].includes(x)), grantedToAuthenticator);
    s.check("ROLE-624", "anon and authenticated are not members of service_role or of any privileged role", members.filter((x) => (x.member === "anon" || x.member === "authenticated")).every((x) => !["service_role", "postgres", "supabase_admin"].includes(x.role)), members.filter((x) => x.member === "anon" || x.member === "authenticated"));
    s.eq("ROLE-625", "the service-role probes (inside rolled back transactions) left no trace", T.digests(st, STATE.filter((x) => x !== "audit_events")), Object.fromEntries(Object.entries(stateBefore).filter(([k]) => k !== "audit_events")));
  });

  // ---------------------------------------------------------------- 6. privileges after every rollback and re-apply (functions are re-created; Supabase default privileges grant EXECUTE to anon on new functions)
  await s.section("ROLE-7", async () => {
    const closed = async (label) => {
      const f = await adm.json(`select p.oid::regprocedure::text sig, p.proname, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') b,
         (select count(*) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) pub from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'office_mfa_%' or p.proname like 'office_revoke%' or p.proname like 'office_is_session%' or p.proname like 'office_session%' or p.proname like 'office_admin%'`);
      const bad = f.filter((x) => x.a || x.b || Number(x.pub) > 0).map((x) => x.sig);
      s.check(`ROLE-70-${label}`, `${label}: no authentication function is executable by anon/authenticated/PUBLIC (${f.length} functions inspected)`, bad.length === 0, bad);
      const tb = await adm.json("select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ('admin_mfa_credentials','admin_mfa_recovery_codes','admin_mfa_challenges','admin_revoked_sessions') and (has_table_privilege('anon', c.oid, 'select,insert,update,delete') or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') or not c.relrowsecurity)");
      s.check(`ROLE-71-${label}`, `${label}: the credential tables stay closed (no privilege, RLS on)`, tb.length === 0, tb);
    };
    await closed("initial");
    const chain = ["20261026", "20261025", "20261024", "20261023", "20261022", "20261021", "20261020"].map((x) => L.AUTH_MIGRATIONS.find((m) => m.startsWith(x)));
    for (const m of chain) { const r = st.applyRollback(m); s.check(`ROLE-72-${m.slice(0, 8)}`, `rollback of ${m} runs`, r.status === 0, L.errLines(r.out)); await closed(`after-rollback-${m.slice(0, 8)}`); }
    const re = st.applyMigrations(L.AUTH_MIGRATIONS.filter((m) => m >= "20261020"));
    s.check("ROLE-73", "re-applying all S7 migrations after the rollbacks succeeds", re.every((x) => x.status === 0), re.filter((x) => x.status !== 0).map((x) => x.file + ": " + L.errLines(x.out)));
    await closed("after-reapply");
    for (const m of L.AUTH_MIGRATIONS.filter((x) => x >= "20261020")) { st.applyFile(require("path").join(L.SUT, "db", m)); }
    await closed("after-second-reapply");
    // the settings functions follow the same rule
    const rs = await adm.json("select p.oid::regprocedure::text sig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') b from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'office_runtime_setting%'");
    s.check("ROLE-74", "the runtime-setting functions (write, record_attempt, history guard) are closed to anon/authenticated", rs.every((x) => !x.a && !x.b), rs.filter((x) => x.a || x.b).map((x) => x.sig));
  });

  s.info(`default privileges in schema public for the creating role (environment fact): ${JSON.stringify(await adm.json("select pg_get_userbyid(defaclrole) as creator, defaclobjtype as kind, defaclacl::text as acl from pg_default_acl"))}`);
  s.info(`base schema first pass on an empty database produced ${fx.base.firstErrors} errors (forward reference); applied in two passes for the fixture`);
});
