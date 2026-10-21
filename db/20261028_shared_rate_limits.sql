-- S7 R6: rate-limit counters shared by every application instance. ADDITIVE; no existing table, row or function is changed.
-- Keys are keyed digests computed by the application (no e-mail or network address is stored). Rows are short-lived: expired windows are replaced on the next hit and pruned opportunistically.
-- Order: any time after db/lead-agents-schema.sql; independent of the MFA migrations. Until it is applied, instances count in memory (per process) and report that scope.
create table if not exists admin_rate_limits (
  key_digest text primary key check (key_digest ~ '^[0-9a-f]{64}$'),
  hits integer not null default 0 check (hits >= 0),
  window_ends_at timestamptz not null
);
create index if not exists admin_rate_limits_expiry on admin_rate_limits (window_ends_at);
alter table admin_rate_limits enable row level security;   -- no policies: deny by default for every role that bypasses nothing
revoke all on admin_rate_limits from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on admin_rate_limits from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on admin_rate_limits from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, insert, update, delete on admin_rate_limits to service_role; end if;
end $$;

create or replace function office_rate_limit_version() returns integer language plpgsql stable as $f$ begin return 1; end $f$;

-- One atomic statement per hit: a new or expired window restarts at 1, otherwise the counter increases by 1. Returns the count INCLUDING this hit.
create or replace function office_rate_limit_hit(p_key_digest text, p_window_seconds integer) returns table (hits integer, window_ends_at timestamptz) language plpgsql as $f$
begin
  if random() < 0.02 then delete from admin_rate_limits where admin_rate_limits.window_ends_at < now() - interval '1 hour'; end if;
  return query
  insert into admin_rate_limits as r (key_digest, hits, window_ends_at)
  values (p_key_digest, 1, now() + make_interval(secs => greatest(1, least(coalesce(p_window_seconds, 900), 86400))))
  on conflict (key_digest) do update
     set hits = case when r.window_ends_at <= now() then 1 else r.hits + 1 end,
         window_ends_at = case when r.window_ends_at <= now() then now() + make_interval(secs => greatest(1, least(coalesce(p_window_seconds, 900), 86400))) else r.window_ends_at end
  returning r.hits, r.window_ends_at;
end $f$;

-- Read without recording. Zero hits when there is no live window.
create or replace function office_rate_limit_peek(p_key_digest text) returns table (hits integer, window_ends_at timestamptz) language sql stable as $f$
  select coalesce((select r.hits from admin_rate_limits r where r.key_digest = p_key_digest and r.window_ends_at > now()), 0),
         (select r.window_ends_at from admin_rate_limits r where r.key_digest = p_key_digest and r.window_ends_at > now());
$f$;

create or replace function office_rate_limit_reset(p_key_digest text) returns boolean language plpgsql as $f$
begin delete from admin_rate_limits where key_digest = p_key_digest; return true; end $f$;

do $$
declare f text;
begin
  for f in select unnest(array['office_rate_limit_version()', 'office_rate_limit_hit(text, integer)', 'office_rate_limit_peek(text)', 'office_rate_limit_reset(text)']) loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
