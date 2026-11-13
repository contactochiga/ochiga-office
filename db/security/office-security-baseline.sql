-- Office database security baseline. Mirrors the posture verified read-only on production
-- (2026-11-13): no public-schema access for PUBLIC/anon/authenticated, no privileges for them on
-- any relation, column, sequence or routine, RLS enabled on every table, and default privileges
-- for the migration owner (postgres) that grant only service_role.
--
-- Office reaches the database only as service_role (PostgREST, BYPASSRLS) and the migration owner
-- postgres. Neither depends on anything revoked here. Existing service_role grants are left as each
-- migration set them (some catalogue tables deliberately withhold UPDATE/TRUNCATE), so this file
-- never grants on existing objects except schema USAGE to service_role.
--
-- Idempotent. Apply it FIRST on a fresh database (so default privileges cover every later object)
-- and AGAIN after every migration batch: default privileges secure grants automatically, but RLS
-- on newly created tables and PUBLIC EXECUTE on routines created by other roles are only fixed by
-- re-applying. Then run office-security-verify.sql, which fails on any drift.
-- Must run as postgres (the migration owner). Order: see db/migration-order.txt.
begin;

do $$
begin
  if current_user <> 'postgres' then
    raise exception 'office-security-baseline must run as postgres (the migration owner), not %', current_user;
  end if;
end;
$$;

-- Schema: only service_role (and the owner) may use public.
revoke all on schema public from public, anon, authenticated;
grant usage on schema public to service_role;

-- Existing objects: remove every PUBLIC/anon/authenticated privilege.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all routines in schema public from public, anon, authenticated;

do $$
declare
  r record;
begin
  -- Column-level grants survive a table-level REVOKE, so remove them explicitly.
  for r in
    select distinct c.oid::regclass as rel, quote_ident(a.attname) as col
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
    cross join lateral aclexplode(a.attacl) x
    where c.relnamespace = 'public'::regnamespace
      and (x.grantee = 0 or x.grantee in ('anon'::regrole, 'authenticated'::regrole))
  loop
    execute format('revoke all (%s) on %s from public, anon, authenticated', r.col, r.rel);
  end loop;

  -- RLS on every table. service_role bypasses RLS; no policy is added, so other roles see nothing.
  for r in
    select c.oid::regclass as rel
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table %s enable row level security', r.rel);
  end loop;
end;
$$;

-- Future objects created by the migration owner: service_role only.
alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke all on routines from public, anon, authenticated;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant execute on routines to service_role;
-- PostgreSQL grants EXECUTE to PUBLIC on new routines unless revoked globally (a per-schema entry
-- cannot remove it). Applies to routines postgres creates in any schema.
alter default privileges for role postgres revoke execute on routines from public;

commit;
