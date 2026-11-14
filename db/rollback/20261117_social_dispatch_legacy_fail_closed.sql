-- Apply only when rolling application code back to the pre-D2A release.
-- Preserve the four-argument ownership-aware fence. The legacy caller receives
-- a recognized refusal, so it cannot cross the Meta provider boundary.
begin;

create or replace function public.office_fence_meta_social_dispatch(
  p_send uuid, p_channel text, p_sender_key text
) returns text
language sql
security invoker
set search_path = ''
as $$
  select 'social_dispatch_claim_lost'::text;
$$;

revoke all on function public.office_fence_meta_social_dispatch(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.office_fence_meta_social_dispatch(uuid, text, text)
  to service_role;

commit;
