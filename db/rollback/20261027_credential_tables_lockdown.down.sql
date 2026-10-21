-- Rollback of the R5 credential-table lockdown. DELIBERATELY A NO-OP: re-opening admin_users, token digests or the audit trail to the
-- Data API roles would silently re-create finding H1, so it is never done automatically. Nothing was dropped, copied or rewritten by the
-- migration, so there is nothing to restore. An operator who really must re-open a table does so by hand, knowingly:
--   alter table public.<table> disable row level security;  grant select on public.<table> to <role>;
do $$ begin raise notice '20261027 rollback: no changes made (lockdown is intentionally not reverted automatically)'; end $$;
