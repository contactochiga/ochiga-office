-- Website intake receipts: exactly-once filing of an intake submission per idempotency key, and retryable recovery when its CRM writes fail.
-- ADDITIVE and IDEMPOTENT: one new table and five functions; no existing table, row, grant or function is changed.
--   * office_intake_claim()  -- one atomic statement decides who may process a key. A second concurrent request with the same key waits on the
--                               primary key, then sees the first one's lease and is told "in_progress"; a completed key answers "duplicate";
--                               a key whose earlier attempt failed (or whose lease expired) is RE-claimed with a higher attempt number.
--   * office_intake_complete() / office_intake_fail() -- fenced by the attempt number, so a stale worker whose lease was taken over can never
--                               mark the key completed or failed after the new owner started.
--   * a key's content digest is fixed at first claim: re-using a key for different content answers "conflict" (never a silent overwrite).
-- Security: RLS enabled with NO policy (deny by default for every role that does not bypass RLS); nothing for PUBLIC/anon/authenticated
-- (table or function); the application uses service_role (PostgREST), which bypasses RLS and gets only what it needs. Keeps the R11
-- rollout-gate baseline (B2/B3/B4/B8) true.
-- Order: any time after db/lead-agents-schema.sql (references leads). Independent of the S7 chain.
do $$ begin
  if to_regclass('public.leads') is null then raise exception 'apply db/lead-agents-schema.sql before 20261101_office_intake_receipts.sql'; end if;
end $$;

create table if not exists office_intake_receipts (
  idempotency_key text primary key check (length(idempotency_key) between 1 and 200),
  client text not null default '' check (length(client) <= 40),
  request_id text not null default '',
  payload_digest text not null check (payload_digest ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('processing', 'completed', 'crm_failed')),
  attempts integer not null default 1 check (attempts >= 1),
  lease_until timestamptz,
  lead_id uuid references leads(id) on delete set null,
  last_error text check (last_error is null or length(last_error) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists office_intake_receipts_status_idx on office_intake_receipts (status, updated_at) where status <> 'completed';

alter table office_intake_receipts enable row level security;
revoke all on office_intake_receipts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on office_intake_receipts from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on office_intake_receipts from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on office_intake_receipts from service_role;
    grant select on office_intake_receipts to service_role;  -- writes go through the functions below only
  end if;
end $$;

create or replace function office_intake_receipts_version() returns integer language sql stable as $f$ select 1 $f$;

create or replace function office_intake_claim(p_key text, p_client text, p_request_id text, p_digest text, p_lease_seconds integer)
returns table (outcome text, status text, attempts integer, lead_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $f$
#variable_conflict use_column
declare r office_intake_receipts%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 600 then raise exception 'invalid_lease' using errcode = '22023'; end if;
  insert into office_intake_receipts (idempotency_key, client, request_id, payload_digest, status, attempts, lease_until)
  values (p_key, coalesce(p_client, ''), coalesce(p_request_id, ''), p_digest, 'processing', 1, now() + make_interval(secs => p_lease_seconds))
  on conflict (idempotency_key) do nothing;
  if found then
    return query select 'claimed'::text, 'processing'::text, 1, null::uuid;
    return;
  end if;
  select * into r from office_intake_receipts where idempotency_key = p_key for update;
  if r.payload_digest <> p_digest then
    return query select 'conflict'::text, r.status, r.attempts, r.lead_id; return;
  end if;
  if r.status = 'completed' then
    return query select 'duplicate'::text, r.status, r.attempts, r.lead_id; return;
  end if;
  if r.status = 'processing' and r.lease_until > now() then
    return query select 'in_progress'::text, r.status, r.attempts, r.lead_id; return;
  end if;
  update office_intake_receipts
     set status = 'processing', attempts = office_intake_receipts.attempts + 1, lease_until = now() + make_interval(secs => p_lease_seconds),
         request_id = coalesce(p_request_id, ''), updated_at = now()
   where idempotency_key = p_key
  returning * into r;
  return query select 'reclaimed'::text, r.status, r.attempts, r.lead_id;
end $f$;

create or replace function office_intake_complete(p_key text, p_attempt integer, p_lead_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  update office_intake_receipts
     set status = 'completed', lead_id = coalesce(p_lead_id, lead_id), lease_until = null, last_error = null, completed_at = now(), updated_at = now()
   where idempotency_key = p_key and status = 'processing' and attempts = p_attempt;
  return found;
end $f$;

create or replace function office_intake_fail(p_key text, p_attempt integer, p_lead_id uuid, p_error text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  update office_intake_receipts
     set status = 'crm_failed', lead_id = coalesce(p_lead_id, lead_id), lease_until = null, last_error = left(coalesce(p_error, 'unknown'), 120), updated_at = now()
   where idempotency_key = p_key and status = 'processing' and attempts = p_attempt;
  return found;
end $f$;

-- Execute rights: service_role only (PostgreSQL grants EXECUTE to PUBLIC by default; revoke it explicitly).
do $$
declare f text;
begin
  foreach f in array array['office_intake_receipts_version()', 'office_intake_claim(text, text, text, text, integer)', 'office_intake_complete(text, integer, uuid)', 'office_intake_fail(text, integer, uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
