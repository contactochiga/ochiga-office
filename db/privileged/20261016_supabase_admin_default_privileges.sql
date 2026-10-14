-- OPTIONAL, must be executed as the role `supabase_admin` (the `postgres` role of a hosted Supabase project cannot do this; Supabase support or a
-- supabase_admin connection is needed). Closes the ACL-level gap for objects that supabase_admin itself creates in schema public. Until it is run, such
-- objects would carry anon/authenticated ACL entries but remain unreachable through the Data API because schema public no longer has USAGE for those roles.
alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated;
alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role supabase_admin in schema public revoke all on functions from anon, authenticated;
-- Optional (changes every schema for that creator role, so review first): stops new functions being executable by PUBLIC at the ACL level.
-- alter default privileges for role supabase_admin revoke execute on functions from public;
-- alter default privileges for role postgres revoke execute on functions from public;
