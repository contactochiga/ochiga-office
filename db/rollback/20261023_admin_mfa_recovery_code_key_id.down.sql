-- Rollback of S7.5.3 recovery-code key identification. NON-DESTRUCTIVE: the column and every key id recorded in it are KEPT. Only the function is restored to the S7.5.1 3-argument form.
drop function if exists office_mfa_replace_recovery_codes(uuid, uuid, text[], text);
create or replace function office_mfa_replace_recovery_codes(p_user_id uuid, p_batch_id uuid, p_hmacs text[]) returns integer language plpgsql as $f$
declare inserted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('office_mfa_recovery:' || p_user_id::text, 0));
  delete from admin_mfa_recovery_codes where admin_user_id = p_user_id and used_at is null;
  insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) select p_user_id, p_batch_id, h from unnest(p_hmacs) as h;
  get diagnostics inserted = row_count;
  return inserted;
end $f$;
do $$
declare f text := 'office_mfa_replace_recovery_codes(uuid, uuid, text[])';
begin
  execute format('revoke all on function %s from public', f);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
end $$;

-- OPTIONAL, non-production only: alter table admin_mfa_recovery_codes drop column if exists key_id;
