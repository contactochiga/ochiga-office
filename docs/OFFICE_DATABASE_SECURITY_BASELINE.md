# Office database security baseline

Office reaches its database only through trusted server paths: PostgREST as `service_role` (which bypasses RLS) and the migration owner `postgres`. No browser or public client uses the `anon` or `authenticated` roles. The verified production posture is therefore:

- `PUBLIC`, `anon` and `authenticated` have no access to schema `public`, and no privilege on any table, view, sequence, routine or column in it.
- RLS is enabled on every table, with no policies. `service_role` keeps the grants each migration gives it. Some catalogue tables deliberately withhold `UPDATE` or `TRUNCATE`.
- Default privileges of `postgres` in `public` grant new tables, sequences and routines to `service_role` only. `PUBLIC EXECUTE` on new routines is revoked.

The repository did not record this posture. On Supabase's defaults, a fresh database built only from the schema and migrations grants `anon` and `authenticated` full access to the CRM tables. `db/security/` closes that gap.

## Files

- `db/security/office-security-baseline.sql` is idempotent. It must run as `postgres`. It revokes the `PUBLIC`, `anon` and `authenticated` privileges listed above, including column grants, enables RLS on every table, and sets the default privileges. It grants nothing on existing objects except schema `USAGE` to `service_role`.
- `db/security/office-security-verify.sql` is a read-only gate. It fails with a list of every violation it finds:
  - schema access;
  - relation, column, sequence and routine privileges;
  - RLS;
  - owner default privileges;
  - objects not owned by `postgres`;
  - `service_role` read access.
- `db/migration-order.txt` gives the initialization order for a fresh database.
- `scripts/init-office-database.js` applies that order (`--fresh`), re-applies the baseline (`--reassert`) or runs the gate alone (`--verify`).
  - It works on local databases only; there is no remote mode. It checks the target exactly as `pg` will use it, including query parameters such as `?host=`. Every address the target resolves to must be loopback or private. It refuses hosted Supabase hosts and any ref listed in `OFFICE_DB_PROTECTED_REFS`, an optional extra deny-list kept outside the repository.
  - `--fresh` refuses a non-empty database and records a marker schema, `office_local_init`. `--reassert` refuses a database without that marker. All modes refuse any role other than `postgres`.

## Order and later migrations

The baseline runs first, so the owner's default privileges cover every later object. It runs again at the end, followed by the gate.

Default privileges secure grants automatically. RLS on a newly created table is not automatic, and neither is the privilege state of objects created by roles other than `postgres`. After applying any later migration:

1. re-run the baseline;
2. run the gate.

`npm run office:security-baseline:test` proves both cases on a disposable Supabase Postgres and PostgREST.

Do not apply `db/*.sql` in filename order. The Track B files must run `inbound`, then `staff_replies`, then `dispatch_fence`. Filename order runs `dispatch_fence` first, and `staff_replies` then replaces its `office_record_meta_social_receipt`.

`db/lead-agents-schema.sql` now initializes in a single pass. The `facility_workspaces.portfolio_id` foreign key and its index are declared after `office_portfolio_entries`. The resulting schema is unchanged.
