-- Office Position (job title, e.g. "CEO", "Sales Director") kept
-- deliberately separate from admin_users.role (system authorization
-- tier) and permission_scopes (module capability grants). Free-text,
-- not an enum — positions are organizational, not something the
-- backend authorizes against.
alter table admin_users add column if not exists office_position text;
alter table admin_invites add column if not exists office_position text;
