-- Rollback (only if no manual send has ever been recorded; otherwise keep the table as the durable record of what was sent to customers).
drop index if exists conversations_correlation_id_uidx;
alter table conversations drop column if exists correlation_id;
drop table if exists whatsapp_manual_sends;
