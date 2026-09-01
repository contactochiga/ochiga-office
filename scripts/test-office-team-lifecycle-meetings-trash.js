const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

// Team Permissions / Deletion Lifecycle + Meetings Trash -- proves the
// real HTTP surface for the privilege-escalation fix (team.manage is
// now genuinely narrower than staff.manage/ochiga_admin), the self-
// service profile boundary, the Active -> Deactivated -> Removed ->
// Permanently Deleted lifecycle, and the Meetings trash lifecycle that
// reuses the same additive trashed_at/trashed_by pattern as Documents.

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["team-lifecycle-test-key"], allowedOrigins: [] };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super Test", status: "active" });
  await store.ensureAdminUser({ email: "admin@ochiga.local", password_hash: hashPassword("admin-pass-123"), role: "ochiga_admin", display_name: "Admin Test", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff Test", phone: "0800-000-0000", status: "active" });
  await store.ensureAdminUser({ email: "victim@ochiga.local", password_hash: hashPassword("victim-pass-123"), role: "ochiga_staff", display_name: "Victim Test", status: "active" });
  await store.ensureAdminUser({ email: "meetingstaff@ochiga.local", password_hash: hashPassword("meeting-pass-123"), role: "ochiga_staff", display_name: "Meeting Staff Test", status: "active" });

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor,
  });

  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  async function login(email, password) {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `login must succeed for ${email}`);
    return res.headers.get("set-cookie").split(";")[0];
  }

  try {
    const superCookie = await login("super@ochiga.local", "super-pass-123");
    const adminCookie = await login("admin@ochiga.local", "admin-pass-123");
    const staffCookie = await login("staff@ochiga.local", "staff-pass-123");

    const usersRes = await fetch(`${base}/api/lead-agents/admin/users`, { headers: { cookie: superCookie } });
    const users = (await usersRes.json()).users;
    const staffUser = users.find((u) => u.email === "staff@ochiga.local");
    const victimUser = users.find((u) => u.email === "victim@ochiga.local");
    const adminUser = users.find((u) => u.email === "admin@ochiga.local");

    // A. An ordinary staff member cannot edit ANOTHER user's org fields
    // (role/status/office_position/avatar) via the shared admin PATCH.
    const crossEditRes = await fetch(`${base}/api/lead-agents/admin/users/${victimUser.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ role: "ochiga_admin", office_position: "CFO" }),
    });
    assert.equal(crossEditRes.status, 403, "ordinary staff must not PATCH another user's org fields");
    console.log("A. Ordinary user cannot edit another user's role/org fields — PASS");

    // B. ochiga_admin -- the previous privilege-escalation gap -- is now
    // ALSO forbidden from team.manage-gated mutations. Before team.manage
    // existed, super_admin and ochiga_admin were identical grants.
    const adminEditRes = await fetch(`${base}/api/lead-agents/admin/users/${victimUser.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ role: "super_admin" }),
    });
    assert.equal(adminEditRes.status, 403, "ochiga_admin must no longer be able to edit Team org fields or escalate roles");
    const adminInviteRes = await fetch(`${base}/api/lead-agents/admin/users/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ email: "new-hire@ochiga.local", role: "ochiga_staff" }),
    });
    assert.equal(adminInviteRes.status, 403, "ochiga_admin must no longer be able to invite a team member");
    const adminRemoveRes = await fetch(`${base}/api/lead-agents/admin/users/${victimUser.id}/remove`, { method: "POST", headers: { cookie: adminCookie } });
    assert.equal(adminRemoveRes.status, 403, "ochiga_admin must not be able to remove a team member");
    // ochiga_admin still retains staff.manage (view) -- the list itself
    // must remain reachable, only mutation is narrowed.
    const adminViewRes = await fetch(`${base}/api/lead-agents/admin/users`, { headers: { cookie: adminCookie } });
    assert.equal(adminViewRes.status, 200, "ochiga_admin must still be able to VIEW the Team list");
    console.log("B. ochiga_admin (former escalation gap) blocked from org-field edits/invite/remove, view still works — PASS");

    // C. Self-service: a user CAN update their own phone via the new
    // narrow /session/profile route, and that route accepts nothing
    // else (role/status are simply never read off the body).
    const selfProfileRes = await fetch(`${base}/api/lead-agents/admin/session/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ phone: "0801-234-5678", role: "super_admin", status: "suspended" }),
    });
    assert.equal(selfProfileRes.status, 200, "a user can PATCH their own phone via /session/profile");
    const selfProfileBody = await selfProfileRes.json();
    assert.equal(selfProfileBody.user.phone, "0801-234-5678", "the real phone value must persist");
    assert.equal(selfProfileBody.user.role, "ochiga_staff", "role must be completely unreachable through the self-service route, even when smuggled in the body");
    const selfStatusCheckRes = await fetch(`${base}/api/lead-agents/admin/users`, { headers: { cookie: superCookie } });
    const stillActiveStaff = (await selfStatusCheckRes.json()).users.find((u) => u.email === "staff@ochiga.local");
    assert.equal(stillActiveStaff.status, "active", "status must be completely unreachable through the self-service route");
    console.log("C. Self-service /session/profile updates own phone only, role/status fields ignored — PASS");

    // D. super_admin (team.manage) CAN manage organisation fields.
    const superEditRes = await fetch(`${base}/api/lead-agents/admin/users/${staffUser.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({ office_position: "Senior Associate" }),
    });
    assert.equal(superEditRes.status, 200, "super_admin (team.manage) can edit organisation fields");
    assert.equal((await superEditRes.json()).user.office_position, "Senior Associate");
    console.log("D. super_admin can manage organisation-controlled fields — PASS");

    // E. Deactivation revokes Office access immediately -- the very
    // next authenticated request from that session must 401.
    await fetch(`${base}/api/lead-agents/admin/users/${staffUser.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({ status: "suspended" }),
    });
    const deactivatedNextReqRes = await fetch(`${base}/api/lead-agents/admin/session/me`, { headers: { cookie: staffCookie } });
    assert.equal(deactivatedNextReqRes.status, 401, "a deactivated user's next request must be rejected immediately");
    console.log("E. Deactivation revokes Office access on the very next request — PASS");

    // F. Remove from Team: cannot remove self; removing someone else
    // hides them from the ACTIVE list (client-side split, row still
    // present in the full listing) and immediately revokes their access.
    const selfRemoveRes = await fetch(`${base}/api/lead-agents/admin/users/${(await (await fetch(`${base}/api/lead-agents/admin/users`, { headers: { cookie: superCookie } })).json()).users.find((u) => u.email === "super@ochiga.local").id}/remove`, {
      method: "POST", headers: { cookie: superCookie },
    });
    assert.equal(selfRemoveRes.status, 400, "an admin must not be able to remove themselves");
    assert.equal((await selfRemoveRes.json()).error, "cannot_remove_self");

    const victimLoginRes = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "victim@ochiga.local", password: "victim-pass-123" }),
    });
    const victimCookie = victimLoginRes.headers.get("set-cookie").split(";")[0];

    // Authored by the victim WHILE still active -- owner is always the
    // real acting session's email, never a client-supplied value, so
    // this is a genuine historical record to check survives deletion.
    const historicalDocRes = await fetch(`${base}/api/lead-agents/admin/documents/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: victimCookie },
      body: JSON.stringify({ title: "Pre-Deletion Historical Doc", document_type: "letter", body: "Authored before removal." }),
    });
    assert.equal(historicalDocRes.status, 201);
    const historicalDoc = (await historicalDocRes.json()).document;
    assert.equal(historicalDoc.owner, "victim@ochiga.local", "the document's real owner must be the actual authoring session");

    const removeRes = await fetch(`${base}/api/lead-agents/admin/users/${victimUser.id}/remove`, { method: "POST", headers: { cookie: superCookie } });
    assert.equal(removeRes.status, 200);
    const removed = (await removeRes.json()).user;
    assert.ok(removed.removed_at, "remove must set removed_at");
    assert.equal(removed.status, "removed");

    const listAfterRemoveRes = await fetch(`${base}/api/lead-agents/admin/users`, { headers: { cookie: superCookie } });
    const listAfterRemove = (await listAfterRemoveRes.json()).users;
    const removedRow = listAfterRemove.find((u) => u.id === victimUser.id);
    assert.ok(removedRow, "the removed user's row must still exist server-side (recoverable, not deleted)");
    assert.ok(removedRow.removed_at, "removed_at must be visible so the client can split active vs removed lists");

    const victimNextReqRes = await fetch(`${base}/api/lead-agents/admin/session/me`, { headers: { cookie: victimCookie } });
    assert.equal(victimNextReqRes.status, 401, "removal must revoke access immediately, same as deactivation");
    console.log("F. Remove from Team: self-removal blocked, row survives removal (recoverable), access revoked immediately — PASS");

    // G. Permanent delete is governed: requires team.manage, requires
    // the account to already be removed, requires explicit action (no
    // implicit hard-delete from any other endpoint).
    const permDeleteForbiddenRes = await fetch(`${base}/api/lead-agents/admin/users/${victimUser.id}/permanent`, { method: "DELETE", headers: { cookie: adminCookie } });
    assert.equal(permDeleteForbiddenRes.status, 403, "ochiga_admin must not be able to permanently delete a team member");

    const notRemovedUser = users.find((u) => u.email === "admin@ochiga.local");
    const permDeleteNotRemovedRes = await fetch(`${base}/api/lead-agents/admin/users/${notRemovedUser.id}/permanent`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(permDeleteNotRemovedRes.status, 409, "permanent delete must require the account to already be removed");
    assert.equal((await permDeleteNotRemovedRes.json()).error, "user_not_removed");

    // H. Historical attribution: the document created by the victim
    // BEFORE removal must still show their email afterward -- the core
    // "does not corrupt historical business records" guarantee.
    const permDeleteRes = await fetch(`${base}/api/lead-agents/admin/users/${victimUser.id}/permanent`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(permDeleteRes.status, 200, "team.manage holder can permanently delete an already-removed account");
    assert.equal((await permDeleteRes.json()).deleted, true);

    const listAfterDeleteRes = await fetch(`${base}/api/lead-agents/admin/users`, { headers: { cookie: superCookie } });
    const listAfterDelete = (await listAfterDeleteRes.json()).users;
    assert.ok(!listAfterDelete.some((u) => u.id === victimUser.id), "the admin_users row must actually be gone after permanent delete");

    const docsAfterDeleteRes = await fetch(`${base}/api/lead-agents/admin/office/documents`, { headers: { cookie: superCookie } });
    const docsAfterDelete = (await docsAfterDeleteRes.json()).collection;
    const survivingDoc = docsAfterDelete.find((d) => d.id === historicalDoc.id);
    assert.ok(survivingDoc, "the document authored by the now-deleted user must still exist");
    assert.equal(survivingDoc.owner, "victim@ochiga.local", "the historical owner email must remain intact after the account row is physically deleted");

    const auditAfterDeleteRes = await fetch(`${base}/api/lead-agents/admin/audit`, { headers: { cookie: superCookie } });
    const auditAfterDelete = (await auditAfterDeleteRes.json()).audit;
    assert.ok(auditAfterDelete.some((e) => e.action === "admin_user_permanently_deleted" && e.target_id === victimUser.id), "the permanent-delete action itself must be audited");
    console.log("H. Permanent delete governed (team.manage + must be removed first); historical document/audit attribution survives the physical delete — PASS");

    // ---------------------------------------------------------------
    // Meetings Trash lifecycle
    // ---------------------------------------------------------------
    // A fresh staff session (staffCookie's account was deactivated in
    // step E above) with meetings.manage but not crm.manage, to prove
    // the dual-grant governance on permanent delete below.
    const meetingStaffCookie = await login("meetingstaff@ochiga.local", "meeting-pass-123");
    const meetingGenRes = await fetch(`${base}/api/lead-agents/admin/office/meetings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({ title: "Smoke Test Meeting", business_unit: "operations", owner: "super@ochiga.local" }),
    });
    assert.equal(meetingGenRes.status, 201, "meeting creation must still work unchanged");
    const meeting = (await meetingGenRes.json()).record;

    // I. Move to Trash / Restore round-trip, never touching the
    // business status field.
    const meetingTrashRes = await fetch(`${base}/api/lead-agents/admin/meetings/${meeting.id}/trash`, { method: "POST", headers: { cookie: superCookie } });
    assert.equal(meetingTrashRes.status, 200);
    const trashedMeeting = (await meetingTrashRes.json()).meeting;
    assert.ok(trashedMeeting.trashed_at, "trash must set trashed_at");

    const meetingsListRes = await fetch(`${base}/api/lead-agents/admin/office/meetings`, { headers: { cookie: superCookie } });
    const meetingsList = (await meetingsListRes.json()).collection;
    const trashedRow = meetingsList.find((m) => m.id === meeting.id);
    assert.equal(trashedRow.status, meeting.status, "trashing a meeting must never rewrite its business status field");

    const meetingRestoreRes = await fetch(`${base}/api/lead-agents/admin/meetings/${meeting.id}/restore`, { method: "POST", headers: { cookie: superCookie } });
    assert.equal(meetingRestoreRes.status, 200);
    assert.equal((await meetingRestoreRes.json()).meeting.trashed_at, null, "restore must clear trashed_at");
    console.log("I. Meetings: Move to Trash / Restore round-trip, business status untouched — PASS");

    // J. Trash/Restore require meetings.manage; Permanent Delete requires
    // meetings.manage AND crm.manage, and must be trashed first.
    const permDeleteUntrashedRes = await fetch(`${base}/api/lead-agents/admin/meetings/${meeting.id}/permanent`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(permDeleteUntrashedRes.status, 409, "permanent delete must require the meeting to already be trashed");
    assert.equal((await permDeleteUntrashedRes.json()).error, "meeting_not_trashed");

    const staffMeetingTrashRes = await fetch(`${base}/api/lead-agents/admin/meetings/${meeting.id}/trash`, { method: "POST", headers: { cookie: meetingStaffCookie } });
    // ochiga_staff DOES hold meetings.manage in this role's grant list,
    // so this should succeed.
    assert.equal(staffMeetingTrashRes.status, 200, "meetings.manage holder (ochiga_staff) can trash a meeting");

    const permDeleteWrongGrantRes = await fetch(`${base}/api/lead-agents/admin/meetings/${meeting.id}/permanent`, { method: "DELETE", headers: { cookie: meetingStaffCookie } });
    // ochiga_staff holds meetings.manage but NOT crm.manage -- the dual
    // grant required for a hard delete.
    assert.equal(permDeleteWrongGrantRes.status, 403, "meetings.manage alone must not authorize permanent delete (crm.manage also required)");

    const meetingPermDeleteRes = await fetch(`${base}/api/lead-agents/admin/meetings/${meeting.id}/permanent`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(meetingPermDeleteRes.status, 200, "super_admin (both grants) can permanently delete an already-trashed meeting");
    const meetingsListAfterDeleteRes = await fetch(`${base}/api/lead-agents/admin/office/meetings`, { headers: { cookie: superCookie } });
    const meetingsListAfterDelete = (await meetingsListAfterDeleteRes.json()).collection;
    assert.ok(!meetingsListAfterDelete.some((m) => m.id === meeting.id), "the meeting record must actually be gone");
    console.log("J. Meetings: permanent delete requires trashed_at first and the dual meetings.manage+crm.manage grant — PASS");

    // K. Reports: old bespoke report routes remain fully functional
    // (this task moved Reports in the SPA nav/routing only -- the
    // backend routes and data are untouched, so old deep links still
    // resolve to real data server-side).
    const reportCreateRes = await fetch(`${base}/api/lead-agents/admin/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({ title: "Smoke Test Report", body: "Report body." }),
    });
    assert.equal(reportCreateRes.status, 201, "report creation route must be unaffected by the navigation move");
    const report = (await reportCreateRes.json()).report;
    const reportGetRes = await fetch(`${base}/api/lead-agents/admin/reports/${report.id}`, { headers: { cookie: superCookie } });
    assert.equal(reportGetRes.status, 200, "an old direct report link must still resolve to real data server-side");
    console.log("K. Reports backend routes unaffected by the Documents navigation move — PASS");

    console.log("office Team lifecycle / permissions / meetings trash smoke passed");
  } finally {
    await close(server);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
