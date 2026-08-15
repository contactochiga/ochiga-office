-- Documents share token (Office v2 completion pass). Storage-served
-- files require an authenticated staff session (view_storage), which
-- means a link emailed to an external client/lead 401s for them —
-- discovered while auditing "share" behavior. This adds a narrow,
-- purpose-built public access path scoped to a single document at a
-- time via an unguessable per-document token, rather than weakening
-- storage auth generally (message attachments and staff photos stay
-- authenticated-only, correctly).
alter table office_documents add column if not exists share_token text;
