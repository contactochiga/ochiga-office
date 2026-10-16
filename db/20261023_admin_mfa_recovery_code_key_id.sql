-- Settings S7.5.3: recovery-code key identification. Additive: one nullable column and a replaced function; existing rows, accounts and codes are untouched.
-- Recovery hashes depend on the MFA key that existed when a batch was created; recording its id lets verification try only the right key and lets an operator see exactly how many
-- unused codes still depend on a key before retiring it. Requires 20261022_admin_mfa_foundation.sql.
do $$ begin
  if not exists (select 1 from information_schema.tables where table_schema = current_schema() and table_name = 'admin_mfa_recovery_codes') then
    raise exception 'apply 20261022_admin_mfa_foundation.sql before 20261023_admin_mfa_recovery_code_key_id.sql';
  end if;
end $$;

alter table admin_mfa_recovery_codes add column if not exists key_id text;
alter table admin_mfa_recovery_codes drop constraint if exists admin_mfa_recovery_codes_key_id_check;
alter table admin_mfa_recovery_codes add constraint admin_mfa_recovery_codes_key_id_check check (key_id is null or key_id ~ '^[A-Za-z0-9._-]{1,32}$');
create index if not exists admin_mfa_recovery_codes_key on admin_mfa_recovery_codes (key_id) where used_at is null;

-- The 3-argument form is replaced (not overloaded): callers that omit p_key_id keep working through the default.
drop function if exists office_mfa_replace_recovery_codes(uuid, uuid, text[]);
create or replace function office_mfa_replace_recovery_codes(p_user_id uuid, p_batch_id uuid, p_hmacs text[], p_key_id text default null) returns integer language plpgsql as $f$
declare inserted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('office_mfa_recovery:' || p_user_id::text, 0));
  delete from admin_mfa_recovery_codes where admin_user_id = p_user_id and used_at is null;
  insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac, key_id) select p_user_id, p_batch_id, h, p_key_id from unnest(p_hmacs) as h;
  get diagnostics inserted = row_count;
  return inserted;
end $f$;

do $$
declare f text := 'office_mfa_replace_recovery_codes(uuid, uuid, text[], text)';
begin
  execute format('revoke all on function %s from public', f);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
end $$;
