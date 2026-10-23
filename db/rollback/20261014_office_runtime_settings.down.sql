-- Rollback of the runtime-settings table. NON-DESTRUCTIVE (R10): nothing is dropped. office_runtime_settings holds authentication policy state -- the MFA enforcement level, the one-time
-- break-glass applied-id memory (replay protection) and the session duration -- and the WhatsApp autonomy switch. Dropping it would silently downgrade enforcement and let a spent recovery id
-- be replayed. Older Office code simply does not read it, and code that includes the autonomy switch treats an unreadable value as OFF (fail closed).
-- OPTIONAL, non-production only, when every stored setting is to be discarded deliberately:
--   drop table if exists office_runtime_settings;
do $$ begin raise notice '20261014 rollback: no changes made (settings state is intentionally kept)'; end $$;
