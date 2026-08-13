const assert = require("node:assert/strict");
const { normalizeLeadInput, normalizeLeadPatch } = require("../src/lead-agents/normalize-lead");

// next_action_at/last_contact_at are `timestamptz` columns in the leads
// table. normalizeText (used for every other free-text field here)
// returns "" for a missing value, and Postgres/PostgREST reject "" as a
// timestamptz — every lead created without an explicit follow-up date
// (i.e. nearly every fresh website intake) failed with a 400 in
// production until this was fixed. This guards the JSON-payload
// contract directly, the same shape createLead/updateLead actually POST.
function main() {
  const withoutTimestamps = normalizeLeadInput({ name: "Test Lead", email: "test@example.com" }, "test_source");
  const json = JSON.stringify(withoutTimestamps);
  assert.equal(json.includes("next_action_at"), false, "next_action_at must be omitted, not sent as \"\"");
  assert.equal(json.includes("last_contact_at"), false, "last_contact_at must be omitted, not sent as \"\"");
  console.log("A. Missing next_action_at/last_contact_at are omitted from the insert payload, not sent as \"\" — PASS");

  const withTimestamps = normalizeLeadInput(
    { name: "Test Lead", email: "test@example.com", next_action_at: "2026-09-01T00:00:00.000Z", last_contact_at: "2026-08-01T00:00:00.000Z" },
    "test_source"
  );
  assert.equal(withTimestamps.next_action_at, "2026-09-01T00:00:00.000Z");
  assert.equal(withTimestamps.last_contact_at, "2026-08-01T00:00:00.000Z");
  console.log("B. Real timestamp values still pass through unchanged — PASS");

  const patch = normalizeLeadPatch({ next_action_at: "" });
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "next_action_at"), false, "an explicit empty-string patch must not forward \"\" either");
  console.log("C. Explicit empty-string PATCH of next_action_at is dropped, not forwarded as \"\" — PASS");

  console.log("normalize-lead timestamp handling smoke passed");
}

main();
