-- Rollback: removes only the claims table. inbound_events and every customer record are untouched.
drop table if exists whatsapp_inbound_claims;
