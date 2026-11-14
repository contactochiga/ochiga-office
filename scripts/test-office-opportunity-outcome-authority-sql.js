// Wave 8 Slice 4 prerequisite -- Office Opportunity Outcome Authority.
// Real-Postgres proof: the migration itself (proposals.opportunity_id),
// and true concurrent-CAS behavior (two genuinely simultaneous,
// contradictory UPDATE statements racing the same WHERE precondition --
// something a single-threaded file-store test cannot exercise). Runs in
// a disposable Postgres container that this test starts (no network,
// synthetic rows only) and always removes. A missing Docker or image
// fails the suite with BLOCKED; it never depends on a container from
// another repository.
const assert = require("assert/strict");
const { spawn, spawnSync } = require("child_process");

const PG_IMAGE = process.env.PG_IMAGE || "public.ecr.aws/supabase/postgres:17.6.1.131";
const LABEL = "office-test=opportunity-outcome-authority-sql";
const container = `office-opportunity-sql-${process.pid}-${Date.now()}`;
const db = "office_wave8_slice4_" + Date.now();
const DEADLINE_MS = Number(process.env.OFFICE_SQL_TEST_DEADLINE_MS) || 5 * 60_000;
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
let removed = false;
function removeContainer() {
  if (removed) return;
  removed = true;
  docker("rm", "-f", container);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { removeContainer(); process.exit(130); });
process.on("exit", removeContainer);

async function startDatabase() {
  if (docker("image", "inspect", PG_IMAGE).status !== 0) throw new Error(`BLOCKED: Docker or the image ${PG_IMAGE} is not available`);
  // A run killed outright (SIGKILL) cannot clean up; remove its leftovers, which hold only synthetic rows.
  const stale = docker("ps", "-aq", "--filter", `label=${LABEL}`).stdout.trim().split("\n").filter(Boolean);
  if (stale.length) docker("rm", "-f", ...stale);
  const run = docker("run", "-d", "--rm", "--name", container, "--label", LABEL, "--network", "none", "-e", "POSTGRES_PASSWORD=synthetic-test-only", PG_IMAGE);
  if (run.status !== 0) throw new Error("BLOCKED: postgres container: " + run.stderr);
  // The image restarts once during initialization; wait for three consecutive successful queries.
  for (let ok = 0, i = 0; ok < 3; i++) {
    if (i > 400) throw new Error("BLOCKED: postgres container not ready");
    const probe = docker("exec", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-c", "select 1");
    ok = probe.status === 0 && probe.stdout.trim() === "1" ? ok + 1 : 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

// Extracted verbatim from db/lead-agents-schema.sql (crm_contacts/
// crm_organizations/leads omitted -- crm_opportunities/proposals'
// FK references to them are dropped in this throwaway DB, matching the
// existing convention already used by this repository's own migration
// script for narrow, single-table-focused verification).
const BASE_DDL = `
create table if not exists crm_opportunities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid,
  organization_id uuid,
  lead_id uuid,
  business_unit text not null default 'corporate',
  inquiry_type text not null default 'general_enquiry',
  pipeline text not null default 'corporate',
  stage text not null default 'intake_received',
  status text not null default 'open',
  owner text,
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  title text not null,
  tier_name text,
  unit_count integer,
  monthly_price numeric,
  currency text not null default 'NGN',
  status text not null default 'draft',
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

function sql(q, database = db) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(err))));
    p.stdin.end(q);
  });
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log("PASS " + name);
}

const MIGRATION_SQL = `
alter table proposals add column if not exists opportunity_id uuid references crm_opportunities(id) on delete set null;
create index if not exists proposals_opportunity_id_idx on proposals (opportunity_id);
`;

(async function main() {
  const deadline = setTimeout(() => { console.error(`FAIL: exceeded ${DEADLINE_MS / 1000} s`); removeContainer(); process.exit(1); }, DEADLINE_MS);
  deadline.unref();
  await startDatabase();
  await sql(`create database ${db}`, "postgres");
  try {
    console.log("\n=== Migration proof (Section 24) ===");
    await sql(BASE_DDL);

    await sql(`insert into proposals(id, lead_id, title, body) values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Historical proposal', 'body')`);

    await test("migration applies cleanly, additively, on top of existing data", async () => {
      await sql(MIGRATION_SQL);
    });

    await test("migration is idempotent -- applying it again is a no-op, not an error", async () => {
      await sql(MIGRATION_SQL);
    });

    await test("a historical proposal (created before the migration) has NULL opportunity_id -- no speculative backfill", async () => {
      const value = await sql(`select opportunity_id from proposals where id='11111111-1111-1111-1111-111111111111'`);
      assert.equal(value, "");
    });

    await test("a new proposal can reference a real Opportunity", async () => {
      await sql(`insert into crm_opportunities(id, stage) values ('33333333-3333-3333-3333-333333333333', 'intake_received')`);
      await sql(`insert into proposals(id, lead_id, opportunity_id, title, body) values ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'New proposal', 'body')`);
      const value = await sql(`select opportunity_id from proposals where id='44444444-4444-4444-4444-444444444444'`);
      assert.equal(value, "33333333-3333-3333-3333-333333333333");
    });

    await test("an invalid Opportunity FK is rejected by the real constraint", async () => {
      await assert.rejects(
        sql(`insert into proposals(id, lead_id, opportunity_id, title, body) values ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', '99999999-9999-9999-9999-999999999999', 'Bad proposal', 'body')`)
      );
    });

    await test("the index exists in the catalog (a 2-row throwaway table's own planner correctly prefers a sequential scan at this scale -- existence, not the planner's cost choice, is what this proves)", async () => {
      const indexName = await sql(`select indexname from pg_indexes where tablename='proposals' and indexname='proposals_opportunity_id_idx'`);
      assert.equal(indexName, "proposals_opportunity_id_idx");
    });

    console.log("\n=== True concurrent CAS proof (Section 7/25) ===");
    await sql(`insert into crm_opportunities(id, stage, status) values ('66666666-6666-6666-6666-666666666666', 'proposal_sent', 'open')`);

    await test("two genuinely simultaneous, contradictory transitions from the SAME expected stage -- exactly one wins", async () => {
      const opportunityId = "66666666-6666-6666-6666-666666666666";
      // The exact CAS shape transitionOpportunity() issues via
      // store.client.patch(): UPDATE ... WHERE id=... AND stage=...
      // returning the updated row only when the precondition still held.
      const winA = sql(
        `update crm_opportunities set stage='won', status='closed_won', updated_at=now() where id='${opportunityId}' and stage='proposal_sent' returning id`
      );
      const winB = sql(
        `update crm_opportunities set stage='lost', status='closed_lost', updated_at=now() where id='${opportunityId}' and stage='proposal_sent' returning id`
      );
      const [resultA, resultB] = await Promise.all([winA, winB]);
      const aWon = resultA.length > 0;
      const bWon = resultB.length > 0;
      assert.notEqual(aWon, bWon, "exactly one of the two contradictory concurrent transitions must have matched the WHERE precondition, never both, never neither");
      const finalStage = await sql(`select stage from crm_opportunities where id='${opportunityId}'`);
      assert.ok(finalStage === "won" || finalStage === "lost");
      console.log(`    (winner: ${finalStage} -- the loser's own UPDATE affected zero rows, exactly as transitionOpportunity()'s own CAS branch checks for)`);
    });

    await test("a third, later transition attempting the ORIGINAL expected stage is correctly rejected (the state already moved)", async () => {
      const opportunityId = "66666666-6666-6666-6666-666666666666";
      const late = await sql(
        `update crm_opportunities set stage='negotiation', updated_at=now() where id='${opportunityId}' and stage='proposal_sent' returning id`
      );
      assert.equal(late, "", "a stale precondition must match zero rows once the real stage has already changed");
    });

    console.log(`\n=== test-office-opportunity-outcome-authority-sql: ${passed} checks passed ===`);
  } finally {
    await sql(`drop database if exists ${db}`, "postgres").catch(() => {});
    removeContainer();
  }
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  removeContainer();
  process.exit(1);
});
