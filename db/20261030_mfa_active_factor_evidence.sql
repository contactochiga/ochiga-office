-- S7 R9: independent evidence of how many ACTIVE second factors an account has. ADDITIVE; no credential, hash, account or session is changed.
-- Problem: "does this account have an active factor?" was answered by ONE read of admin_mfa_credentials. An empty, truncated or stale answer from the data API made an enrolled
-- account look unenrolled and let the password alone sign in. Fix: admin_users carries mfa_active_count, kept equal to the number of active credentials by a trigger in the SAME
-- transaction as every change. The application reads it with a second, independent query and refuses to decide when the two disagree (fail closed, 503).
-- Order: after db/20261022_admin_mfa_foundation.sql (needs admin_mfa_credentials) and every earlier migration; independent of 20261027-20261029 and of 20261031.
do $$ begin
  if to_regclass('public.admin_mfa_credentials') is null then
    raise exception 'apply 20261022_admin_mfa_foundation.sql before 20261030_mfa_active_factor_evidence.sql';
  end if;
end $$;

alter table admin_users add column if not exists mfa_active_count integer not null default 0;
alter table admin_users drop constraint if exists admin_users_mfa_active_count_check;
alter table admin_users add constraint admin_users_mfa_active_count_check check (mfa_active_count >= 0);

-- Recompute for one account from the credential table (the source of truth). Quiet when nothing changes (no lock, no updated_at bump).
create or replace function office_mfa_sync_active_count(p_user_id uuid) returns integer language plpgsql as $f$
declare n integer;
begin
  select count(*)::integer into n from admin_mfa_credentials where admin_user_id = p_user_id and status = 'active';
  update admin_users set mfa_active_count = n where id = p_user_id and mfa_active_count is distinct from n;
  return n;
end $f$;

create or replace function office_mfa_active_count_trigger() returns trigger language plpgsql as $f$
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then perform office_mfa_sync_active_count(new.admin_user_id); end if;
  elsif tg_op = 'DELETE' then
    if old.status = 'active' then perform office_mfa_sync_active_count(old.admin_user_id); end if;
  else
    if old.status = 'active' or new.status = 'active' or old.admin_user_id is distinct from new.admin_user_id then
      perform office_mfa_sync_active_count(new.admin_user_id);
      if old.admin_user_id is distinct from new.admin_user_id then perform office_mfa_sync_active_count(old.admin_user_id); end if;
    end if;
  end if;
  return null;
end $f$;

drop trigger if exists admin_mfa_credentials_active_count on admin_mfa_credentials;
create trigger admin_mfa_credentials_active_count after insert or update of status, admin_user_id or delete on admin_mfa_credentials
  for each row execute function office_mfa_active_count_trigger();

-- One-time backfill: accounts that already have active factors. Only rows that differ are touched.
update admin_users u set mfa_active_count = c.n
  from (select admin_user_id, count(*)::integer as n from admin_mfa_credentials where status = 'active' group by admin_user_id) c
 where u.id = c.admin_user_id and u.mfa_active_count is distinct from c.n;

-- Capability probe (PL/pgSQL on purpose, see 20261022: an inlinable constant function would skip the EXECUTE privilege check).
create or replace function office_mfa_evidence_version() returns integer language plpgsql stable as $f$ begin return 1; end $f$;

do $$
declare f text;
begin
  for f in select unnest(array['office_mfa_sync_active_count(uuid)', 'office_mfa_active_count_trigger()', 'office_mfa_evidence_version()']) loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
