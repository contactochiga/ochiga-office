-- Rollback of R6 shared rate limits. Counters are ephemeral, so dropping them loses nothing durable; instances fall back to per-process counting (and report it).
drop function if exists office_rate_limit_reset(text);
drop function if exists office_rate_limit_peek(text);
drop function if exists office_rate_limit_hit(text, integer);
drop function if exists office_rate_limit_version();
drop table if exists admin_rate_limits;
