-- Rollback of 20261105_catalogue_public_release.sql (Phase 2 stage 4).
-- Removes the public-release, slug and preview FUNCTIONS and the slug-redirect check on catalogue_products. Office then answers the public
-- catalogue API with 503 (GetOyi shows its "temporarily unavailable" state: nothing is served publicly) and previews stop working.
-- The TABLES, their rows and their protective triggers are KEPT on purpose: release events, redirects and preview grants are history
-- (same approach as the 20261102 and 20261104 rollbacks). Storage objects and catalogue media are not touched.
drop trigger if exists catalogue_products_slug_redirect_check on catalogue_products;
drop function if exists catalogue_slug_redirect_check();
drop function if exists catalogue_revoke_preview_grants(uuid, text);
drop function if exists catalogue_create_preview_grant(uuid, text, integer);
drop function if exists catalogue_public_record_refresh(uuid, integer, text, text);
drop function if exists catalogue_public_request_refresh(uuid);
drop function if exists catalogue_change_slug(uuid, integer, text, text);
drop function if exists catalogue_public_withdraw(uuid, integer, text, text);
drop function if exists catalogue_public_release(uuid, integer, integer, text);
drop function if exists catalogue_public_requirements(uuid);
drop function if exists catalogue_public_schema_version();
-- kept: catalogue_public_listings, catalogue_public_events, catalogue_slug_redirects, catalogue_preview_grants, their guard functions
-- (catalogue_public_listing_guard, catalogue_preview_grant_guard) and triggers, and the catalogue_media_derivatives sha256 index
