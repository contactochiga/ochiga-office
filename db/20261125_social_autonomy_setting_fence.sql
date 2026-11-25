begin;

-- The existing dispatch fence marks social_dispatch_at immediately before
-- Meta I/O. Require an explicitly stored channel switch at that boundary.
-- A missing, malformed or false runtime setting cannot authorize AI dispatch.
create or replace function public.office_require_social_autonomy_setting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  setting_key text;
  setting_value jsonb;
begin
  if old.social_dispatch_at is not null or new.social_dispatch_at is null
     or lower(coalesce(new.actor_email, '')) <> 'oyi_social_autonomy'
     or new.channel not in ('facebook', 'instagram') then
    return new;
  end if;

  setting_key := case new.channel
    when 'facebook' then 'facebook_messenger_autonomous_responses_enabled'
    when 'instagram' then 'instagram_direct_autonomous_responses_enabled'
  end;

  select value into setting_value
    from public.office_runtime_settings
    where key = setting_key
    for share;

  if not found or jsonb_typeof(setting_value) <> 'boolean' or setting_value <> 'true'::jsonb then
    raise exception using errcode = 'P0001', message = 'social_ai_setting_off';
  end if;
  return new;
end;
$$;

revoke all on function public.office_require_social_autonomy_setting() from public, anon, authenticated, service_role;

drop trigger if exists office_social_autonomy_setting_before_dispatch on public.whatsapp_manual_sends;
create trigger office_social_autonomy_setting_before_dispatch
  before update of social_dispatch_at on public.whatsapp_manual_sends
  for each row execute function public.office_require_social_autonomy_setting();

commit;
