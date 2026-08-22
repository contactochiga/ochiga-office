const assert = require("assert");
const { resolveRecipient, resolveRecipientByEntity, looksLikeRolePhrase } = require("../src/lead-agents/recipient-resolution");

// Fake store.client.get -- mirrors store-supabase.js's axios client shape
// (response.data is the array PostgREST returns) so this module's
// search/match/ambiguity logic is tested in isolation from a live DB.
function fakeStore(routes) {
  return {
    client: {
      async get(pathname) {
        for (const [pattern, data] of routes) {
          if (pattern.test(pathname)) return { data };
        }
        return { data: [] };
      },
    },
  };
}

async function main() {
  // ============================= Role-phrase detection =============================
  assert.equal(looksLikeRolePhrase("the Head of Sales"), true);
  assert.equal(looksLikeRolePhrase("Operations Manager"), true);
  assert.equal(looksLikeRolePhrase("Daniel"), false);
  assert.equal(looksLikeRolePhrase("David Okoro"), false);

  // ============================= Unique name match =============================
  {
    const store = fakeStore([
      [/^\/admin_users\?display_name=ilike/, []],
      [/^\/leads\?name=ilike/, [{ id: "lead-1", name: "Daniel Bassey", email: "daniel@example.com", phone: "+2348011111111", whatsapp_phone: "+2348011111111", company: "Bassey Holdings" }]],
      [/^\/crm_contacts\?name=ilike/, []],
      [/^\/crm_organizations/, []],
    ]);
    const result = await resolveRecipient(store, { query: "Daniel", queryType: "auto" });
    assert.equal(result.status, "resolved");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].entity_type, "lead");
    assert.equal(result.candidates[0].email, "daniel@example.com");
    assert.deepEqual(result.candidates[0].available_channels, ["email", "whatsapp", "sms"]);
  }

  // ============================= Ambiguous name match (two people, same first name) =============================
  {
    const store = fakeStore([
      [/^\/admin_users\?display_name=ilike/, []],
      [/^\/leads\?name=ilike/, [{ id: "lead-david-1", name: "David Okoro", email: "david.okoro@abc.com", company: "ABC Ltd" }]],
      [/^\/crm_contacts\?name=ilike/, [{ id: "contact-david-2", name: "David Musa", email: "david.musa@xyz.com", organization_id: "org-xyz" }]],
      [/^\/crm_organizations/, [{ id: "org-xyz", name: "XYZ Ltd" }]],
    ]);
    const result = await resolveRecipient(store, { query: "David", queryType: "auto" });
    assert.equal(result.status, "ambiguous", "two distinct Davids must require disambiguation, never a silent pick");
    assert.equal(result.candidates.length, 2);
    const names = result.candidates.map((c) => `${c.display_name} (${c.organisation_name})`).sort();
    assert.deepEqual(names, ["David Musa (XYZ Ltd)", "David Okoro (ABC Ltd)"]);
  }

  // ============================= Short-token guard (regression) =============================
  // Found via live testing: "he" (a pronoun the caller should have
  // resolved via conversation continuity, not sent here at all) matched
  // "Check"/"Head"/etc. as an ilike substring, producing a false
  // "ambiguous" result out of unrelated records.
  {
    const store = fakeStore([
      [/^\/admin_users\?display_name=ilike/, [{ id: "x", display_name: "Someone With Check In Their Name" }]],
    ]);
    const result = await resolveRecipient(store, { query: "he", queryType: "name" });
    assert.equal(result.status, "not_found", "a 2-character token must never trigger a substring search");
  }

  // ============================= No match =============================
  {
    const store = fakeStore([
      [/^\/admin_users\?display_name=ilike/, []],
      [/^\/leads\?name=ilike/, []],
      [/^\/crm_contacts\?name=ilike/, []],
      [/^\/crm_organizations/, []],
    ]);
    const result = await resolveRecipient(store, { query: "Nobody Real", queryType: "auto" });
    assert.equal(result.status, "not_found");
    assert.equal(result.candidates.length, 0);
  }

  // ============================= Role resolution (dynamic, no name hard-coded) =============================
  {
    const store = fakeStore([
      [/^\/admin_users\?office_position=ilike.*status=eq\.active/, [{ id: "staff-1", display_name: "Whoever Currently Holds It", email: "sales-head@ochiga.com", office_position: "Head of Sales", status: "active" }]],
    ]);
    const result = await resolveRecipient(store, { query: "the Head of Sales", queryType: "auto" });
    assert.equal(result.status, "resolved");
    assert.equal(result.candidates[0].entity_type, "staff");
    assert.equal(result.candidates[0].source, "role_resolution");
    assert.equal(result.candidates[0].display_name, "Whoever Currently Holds It", "role resolution must return WHOEVER the query matched -- no name is hard-coded in the resolver itself");
  }

  // ============================= Inactive staff flagged, not silently redirected =============================
  {
    const store = fakeStore([
      [/^\/admin_users\?display_name=ilike/, [{ id: "staff-2", display_name: "Former Employee", email: "former@ochiga.com", status: "inactive" }]],
      [/^\/leads\?name=ilike/, []],
      [/^\/crm_contacts\?name=ilike/, []],
      [/^\/crm_organizations/, []],
    ]);
    const result = await resolveRecipient(store, { query: "Former Employee", queryType: "name" });
    assert.equal(result.status, "resolved");
    assert.equal(result.candidates[0].active, false, "a deactivated staff member targeted BY NAME must be flagged inactive, not silently redirected to someone else");
  }

  // ============================= resolveRecipientByEntity =============================
  {
    const store = fakeStore([
      [/^\/leads\?id=eq\.lead-1/, [{ id: "lead-1", name: "Daniel Bassey", email: "daniel@example.com", company: "Bassey Holdings" }]],
    ]);
    const candidate = await resolveRecipientByEntity(store, { entityType: "lead", entityId: "lead-1" });
    assert.equal(candidate.display_name, "Daniel Bassey");
    assert.equal(candidate.organisation_name, "Bassey Holdings");
  }

  console.log("test-recipient-resolution: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
