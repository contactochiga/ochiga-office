-- Rollback of 20261102_catalogue_foundation. NON-DESTRUCTIVE: only the catalogue functions are removed, so the Office catalogue API
-- answers 503 catalogue_unavailable while every other Office feature is unaffected. Every table, row, version and history record is KEPT,
-- and so is catalogue_refuse_change() with its append-only/no-truncate triggers: the history stays immutable while rolled back.
-- Re-applying 20261102 restores the functions (idempotent; the seed is not duplicated).
-- OPTIONAL teardown, only after the catalogue data has been exported and the owner has approved deleting it, is a separate reviewed script.
drop function if exists catalogue_update_inventory(uuid, integer, jsonb, text, text);
drop function if exists catalogue_publish_price_change(uuid, text);
drop function if exists catalogue_decide_price_change(uuid, text, text, text);
drop function if exists catalogue_request_price_change(uuid, bigint, text, integer, text, text);
drop function if exists catalogue_transition(uuid, integer, text, text, text, text);
drop function if exists catalogue_save_version(uuid, integer, text, uuid, uuid, jsonb, text, text);
drop function if exists catalogue_create_product(text, uuid, uuid, jsonb, text);
drop function if exists catalogue_register_variants(uuid, jsonb);
drop function if exists catalogue_state_changed(uuid);
drop function if exists catalogue_schema_version();
