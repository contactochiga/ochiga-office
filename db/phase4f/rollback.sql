-- Restore the Phase 4E wrapper without removing any Phase 4E objects.
drop function hardware_payment_quote(text,text,uuid);
alter function hardware_financial_phase4e_quote(text,text,uuid) rename to hardware_payment_quote;
revoke all on function hardware_payment_quote(text,text,uuid) from public,anon,authenticated;
grant execute on function hardware_payment_quote(text,text,uuid) to service_role;
