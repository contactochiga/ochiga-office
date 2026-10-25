-- Rollback of 20261104_catalogue_media.sql (Phase 2 stage 3).
-- Removes the media FUNCTIONS and the version gallery check, so Office reports media as unavailable (503 media_unavailable) and product
-- saves stop accepting galleries. The TABLES, their rows and the protective triggers on them are KEPT on purpose: product versions
-- written while media was installed still reference these rows, and the history must stay intact and undeletable (same approach as the
-- 20261102 rollback). The storage objects are not touched.
drop trigger if exists catalogue_product_versions_media_check on catalogue_product_versions;
drop function if exists catalogue_version_media_check();
drop function if exists catalogue_remove_media(uuid, text);
drop function if exists catalogue_register_media(uuid, text, text, text, integer, integer, integer, text, jsonb, text);
drop function if exists catalogue_media_schema_version();
-- kept: catalogue_media, catalogue_media_derivatives, catalogue_media_guard() and its triggers, catalogue_refuse_change()
