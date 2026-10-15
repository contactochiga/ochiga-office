-- Settings S3: optimistic versioning + append-only history for office_runtime_settings. Additive and idempotent; existing rows keep their value/updated_by/updated_at and become version 1.
alter table office_runtime_settings add column if not exists version integer not null default 1;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'office_runtime_settings_version_check') then
    alter table office_runtime_settings add constraint office_runtime_settings_version_check check (version >= 1);
  end if;
end $$;

create table if not exists office_runtime_setting_history (
  id uuid primary key default gen_random_uuid(),
  setting_key text not null,
  version integer not null check (version >= 0),
  previous_value jsonb,
  new_value jsonb,
  actor text not null default '',
  request_id text,
  outcome text not null check (outcome in ('success', 'conflict', 'rejected', 'denied', 'failed')),
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists office_runtime_setting_history_key_idx on office_runtime_setting_history (setting_key, created_at desc);
alter table office_runtime_setting_history enable row level security;

-- History is evidence: it can be appended to, never edited or removed (rollback drops the whole table instead).
create or replace function office_runtime_setting_history_immutable() returns trigger language plpgsql as $f$
begin
  raise exception 'office_runtime_setting_history is append-only' using errcode = '42501';
end $f$;
drop trigger if exists office_runtime_setting_history_no_change on office_runtime_setting_history;
create trigger office_runtime_setting_history_no_change before update or delete on office_runtime_setting_history
  for each row execute function office_runtime_setting_history_immutable();

-- Atomic compare-and-set + history. p_expected_version NULL = unconditional (legacy last-write-wins callers); otherwise the write succeeds only when the stored
-- version equals it (0 means "no row yet"). p_history=false skips the success history row (system counters only). p_redact stores "[redacted]" instead of values in history. Returns {status: ok|conflict, previous, current}.
create or replace function office_runtime_setting_write(p_key text, p_value jsonb, p_actor text, p_expected_version integer, p_request_id text, p_redact boolean default false, p_history boolean default true)
returns jsonb language plpgsql as $f$
declare
  prev office_runtime_settings%rowtype;
  cur office_runtime_settings%rowtype;
  had_prev boolean;
  red jsonb := to_jsonb('[redacted]'::text);
begin
  select * into prev from office_runtime_settings where key = p_key for update;
  had_prev := found;
  if not had_prev then
    if p_expected_version is not null and p_expected_version <> 0 then
      insert into office_runtime_setting_history (setting_key, version, previous_value, new_value, actor, request_id, outcome, reason)
        values (p_key, 0, null, case when p_redact then red else p_value end, coalesce(p_actor, ''), p_request_id, 'conflict', 'expected_version_' || p_expected_version || '_but_no_row');
      return jsonb_build_object('status', 'conflict', 'previous', null, 'current', null);
    end if;
    insert into office_runtime_settings (key, value, updated_by, updated_at, version) values (p_key, p_value, coalesce(p_actor, ''), now(), 1)
      on conflict (key) do nothing returning * into cur;
    if cur.key is null then -- a concurrent creator won between our read and insert
      select * into prev from office_runtime_settings where key = p_key;
      insert into office_runtime_setting_history (setting_key, version, previous_value, new_value, actor, request_id, outcome, reason)
        values (p_key, prev.version, case when p_redact then red else prev.value end, case when p_redact then red else p_value end, coalesce(p_actor, ''), p_request_id, 'conflict', 'concurrent_create');
      return jsonb_build_object('status', 'conflict', 'previous', to_jsonb(prev), 'current', to_jsonb(prev));
    end if;
  else
    if p_expected_version is not null and prev.version <> p_expected_version then
      insert into office_runtime_setting_history (setting_key, version, previous_value, new_value, actor, request_id, outcome, reason)
        values (p_key, prev.version, case when p_redact then red else prev.value end, case when p_redact then red else p_value end, coalesce(p_actor, ''), p_request_id, 'conflict', 'expected_version_' || p_expected_version || '_but_current_' || prev.version);
      return jsonb_build_object('status', 'conflict', 'previous', to_jsonb(prev), 'current', to_jsonb(prev));
    end if;
    update office_runtime_settings set value = p_value, updated_by = coalesce(p_actor, ''), updated_at = now(), version = prev.version + 1 where key = p_key returning * into cur;
  end if;
  if p_history then -- high-frequency system counters opt out; every operator-visible change is recorded
    insert into office_runtime_setting_history (setting_key, version, previous_value, new_value, actor, request_id, outcome)
      values (p_key, cur.version, case when not had_prev then null when p_redact then red else prev.value end, case when p_redact then red else cur.value end, coalesce(p_actor, ''), p_request_id, 'success');
  end if;
  return jsonb_build_object('status', 'ok', 'previous', case when had_prev then to_jsonb(prev) else null end, 'current', to_jsonb(cur));
end $f$;

-- Evidence for attempts that never reached the write (validation, permission, missing confirmation, unreadable state). Attaches to the current version.
create or replace function office_runtime_setting_record_attempt(p_key text, p_actor text, p_request_id text, p_outcome text, p_reason text, p_attempted jsonb, p_redact boolean default false)
returns void language plpgsql as $f$
declare v integer;
begin
  select version into v from office_runtime_settings where key = p_key;
  insert into office_runtime_setting_history (setting_key, version, previous_value, new_value, actor, request_id, outcome, reason)
    values (p_key, coalesce(v, 0), null, case when p_redact then to_jsonb('[redacted]'::text) else p_attempted end, coalesce(p_actor, ''), p_request_id, p_outcome, left(coalesce(p_reason, ''), 200));
end $f$;

-- Only the Office server's service credentials may use these objects; never the Data API roles (guarded so the file also applies on plain Postgres test fixtures).
revoke all on function office_runtime_setting_write(text, jsonb, text, integer, text, boolean, boolean) from public;
revoke all on function office_runtime_setting_record_attempt(text, text, text, text, text, jsonb, boolean) from public;
revoke all on function office_runtime_setting_history_immutable() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on office_runtime_setting_history from anon;
    revoke all on function office_runtime_setting_write(text, jsonb, text, integer, text, boolean, boolean) from anon;
    revoke all on function office_runtime_setting_record_attempt(text, text, text, text, text, jsonb, boolean) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on office_runtime_setting_history from authenticated;
    revoke all on function office_runtime_setting_write(text, jsonb, text, integer, text, boolean, boolean) from authenticated;
    revoke all on function office_runtime_setting_record_attempt(text, text, text, text, text, jsonb, boolean) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on office_runtime_setting_history to service_role;
    grant execute on function office_runtime_setting_write(text, jsonb, text, integer, text, boolean, boolean) to service_role;
    grant execute on function office_runtime_setting_record_attempt(text, text, text, text, text, jsonb, boolean) to service_role;
  end if;
end $$;
