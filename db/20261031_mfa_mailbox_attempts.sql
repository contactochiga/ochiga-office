-- S7 R9: persisted, shared attempt budget for the mailbox code of forced MFA enrolment. ADDITIVE.
-- The 8-digit code is derived from a signed, stateless enrolment challenge (jti). Until now only a rate limiter bounded guessing. Each attempt is now counted per (account, challenge)
-- in the database: shared by every instance, surviving restarts, immune to forged forwarding headers and to concurrent bursts (one atomic upsert per attempt). A verified challenge
-- is marked used exactly once (replay of a correct code is refused). Rows expire with the challenge and are pruned.
-- Order: after 20261022_admin_mfa_foundation.sql; independent of 20261030.
do $$ begin
  if to_regclass('public.admin_mfa_credentials') is null then
    raise exception 'apply 20261022_admin_mfa_foundation.sql before 20261031_mfa_mailbox_attempts.sql';
  end if;
end $$;

create table if not exists admin_mfa_mailbox_attempts (
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  challenge_id text not null check (challenge_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  attempts integer not null default 0 check (attempts >= 0),
  verified_at timestamptz,
  expires_at timestamptz not null,
  primary key (admin_user_id, challenge_id)
);
create index if not exists admin_mfa_mailbox_attempts_expiry on admin_mfa_mailbox_attempts (expires_at);
alter table admin_mfa_mailbox_attempts enable row level security;   -- no policies: deny by default
revoke all on admin_mfa_mailbox_attempts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on admin_mfa_mailbox_attempts from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on admin_mfa_mailbox_attempts from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, insert, update, delete on admin_mfa_mailbox_attempts to service_role; end if;
end $$;

create or replace function office_mfa_mailbox_version() returns integer language plpgsql stable as $f$ begin return 1; end $f$;

-- One atomic statement per guess. Returns the count INCLUDING this attempt and whether the guess may be evaluated (within budget AND the challenge was not already used).
create or replace function office_mfa_mailbox_attempt(p_user_id uuid, p_challenge_id text, p_expires_at timestamptz, p_max integer)
returns table (attempts integer, allowed boolean) language plpgsql as $f$
declare cap timestamptz := now() + interval '15 minutes';
begin
  if random() < 0.02 then delete from admin_mfa_mailbox_attempts where expires_at < now() - interval '1 hour'; end if;
  return query
  insert into admin_mfa_mailbox_attempts as m (admin_user_id, challenge_id, attempts, expires_at)
  values (p_user_id, p_challenge_id, 1, least(coalesce(p_expires_at, cap), cap))
  on conflict (admin_user_id, challenge_id) do update set attempts = m.attempts + 1
  returning m.attempts, (m.attempts <= greatest(1, coalesce(p_max, 5)) and m.verified_at is null);
end $f$;

-- Marks the challenge used. TRUE exactly once; FALSE for a replay or an unknown challenge.
create or replace function office_mfa_mailbox_verified(p_user_id uuid, p_challenge_id text) returns boolean language plpgsql as $f$
declare n integer;
begin
  update admin_mfa_mailbox_attempts set verified_at = now() where admin_user_id = p_user_id and challenge_id = p_challenge_id and verified_at is null;
  get diagnostics n = row_count;
  return n = 1;
end $f$;

do $$
declare f text;
begin
  for f in select unnest(array['office_mfa_mailbox_version()', 'office_mfa_mailbox_attempt(uuid, text, timestamptz, integer)', 'office_mfa_mailbox_verified(uuid, text)']) loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
