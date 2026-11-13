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
  - It works on local databases only; there is no remote mode.
  - It checks the target exactly as `pg` will use it. It refuses URLs with query parameters (`?host=`, `hostaddr`, `service`, `options`), several hosts, and socket paths.
  - Every address the host resolves to must be loopback or private. The connection then goes to that checked address, using only host, port, user, password and database, so environment variables cannot redirect it.
  - It refuses hosted Supabase hosts and any ref listed in `OFFICE_DB_PROTECTED_REFS`, an optional extra deny-list kept outside the repository.
  - `--fresh` refuses a non-empty database. It records a marker schema, `office_local_init`, bound to the cluster's system identifier and the database OID.
  - `--reassert` refuses a database whose marker is missing, or was copied from another cluster or database.
  - All modes refuse any role other than `postgres`.
  - The marker is a workflow check, not authentication. A deliberate forgery needs owner write access to the target. The target guard is the safety boundary.

## Existing databases: `npm run crm:apply-schema`

`scripts/apply-supabase-schema.js` is for maintaining an EXISTING database only. It re-applies `lead-agents-schema.sql` to the database named by `SUPABASE_DB_URL` in `.env.lead-agents.local`.

- **Default:** a read-only dry run that reports the table count and every security-gate violation.
- **Fresh databases:** refused. Use `scripts/init-office-database.js --fresh` instead.
- **Applying:** `--apply --confirm-target <host>`. The host must equal the host the connection really uses, and the connection must be made as `postgres`.
- **URL limits:** URL overrides (`?host=`, `hostaddr`, `service`, `options`), several hosts and socket paths are refused. Only `?sslmode=` is accepted.
- **Transaction:** the apply runs in one transaction.
  - Tables and routines the schema creates in that run are secured: RLS on, and nothing for `PUBLIC`, `anon` or `authenticated`.
  - The gate runs before and after. If the apply would add any violation that wasn't already present, the whole transaction is rolled back.
  - Violations that already existed are reported, not repaired. Re-applying the baseline to an existing database is a separate, explicit decision.

## Test fixtures

Postgres test fixtures build their databases from the manifest through `scripts/office-db-fixture.js`. A test that exercises one migration excludes it from the manifest and applies that migration itself.

Both fixtures are registered as `office:catalogue-postgres:test` and `office:intake-receipts-postgres:test`.

`npm run office:regression` runs every script whose name ends in `:test` (`office:test` and every `office:*:test`), discovered from `package.json`, then check, lint, secrets, build, `deployment:validate` and `validate:release`.

The Docker suites fail rather than skip when Docker or an image is missing. `office:regression-registry:test` enforces this, and also that every Postgres suite is registered.

No script applies `db/*.sql` in filename order. `npm run office:legacy-db-entrypoints:test` enforces this. It also shows that filename order replaces the fenced receipt function, while the manifest keeps it.

## Order and later migrations

The baseline runs first, so the owner's default privileges cover every later object. It runs again at the end, followed by the gate.

Default privileges secure grants automatically. RLS on a newly created table is not automatic, and neither is the privilege state of objects created by roles other than `postgres`. After applying any later migration:

1. re-run the baseline;
2. run the gate.

`npm run office:security-baseline:test` proves both cases on a disposable Supabase Postgres and PostgREST.

Do not apply `db/*.sql` in filename order. The Track B files must run `inbound`, then `staff_replies`, then `dispatch_fence`. Filename order runs `dispatch_fence` first, and `staff_replies` then replaces its `office_record_meta_social_receipt`.

`db/lead-agents-schema.sql` now initializes in a single pass. The `facility_workspaces.portfolio_id` foreign key and its index are declared after `office_portfolio_entries`. The resulting schema is unchanged.
