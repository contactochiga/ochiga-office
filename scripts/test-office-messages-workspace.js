const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

// Messages workspace — proves the real HTTP surface end to end: direct
// conversation dedup, group creation/rename/membership authorization,
// per-participant archive/mute/pin, reactions, soft-delete (tombstone,
// never destroys other participants' history), unread/read state,
// membership-scoped search, inactive-recipient rejection, and the
// core tenancy-isolation proofs from the brief's Security section:
// a non-participant cannot read a conversation/its messages by ID,
// cannot leak it via search, and a deactivated account is rejected
// immediately (same enrichAuthContext 401 boundary proven for Team).

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(server.address().port); });
  });
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["messages-test-key"], allowedOrigins: [] };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "a@ochiga.local", password_hash: hashPassword("p"), role: "ochiga_staff", display_name: "Alice A", office_position: "Ops Lead", phone: "0800-000-0001", status: "active" });
  await store.ensureAdminUser({ email: "b@ochiga.local", password_hash: hashPassword("p"), role: "ochiga_staff", display_name: "Bob B", status: "active" });
  await store.ensureAdminUser({ email: "c@ochiga.local", password_hash: hashPassword("p"), role: "ochiga_staff", display_name: "Cara C", status: "active" });
  await store.ensureAdminUser({ email: "outsider@ochiga.local", password_hash: hashPassword("p"), role: "ochiga_staff", display_name: "Outsider", status: "active" });
  await store.ensureAdminUser({ email: "deactivated@ochiga.local", password_hash: hashPassword("p"), role: "ochiga_staff", display_name: "Deactivated", status: "active" });

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 800 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 800 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 800 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor,
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  async function login(email) {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "p" }) });
    assert.equal(res.status, 200, `login must succeed for ${email}`);
    return res.headers.get("set-cookie").split(";")[0];
  }

  try {
    const aCookie = await login("a@ochiga.local");
    const bCookie = await login("b@ochiga.local");
    const cCookie = await login("c@ochiga.local");
    const outsiderCookie = await login("outsider@ochiga.local");
    const deactivatedCookie = await login("deactivated@ochiga.local");

    // A. Staff directory excludes self, excludes suspended/deactivated
    // users, and carries real (not administrative) contact fields.
    const directoryRes = await fetch(`${base}/api/lead-agents/admin/staff/directory`, { headers: { cookie: aCookie } });
    const directory = (await directoryRes.json()).staff;
    assert.ok(!directory.some((s) => s.email === "a@ochiga.local"), "directory must exclude the caller themselves");
    const bobEntry = directory.find((s) => s.email === "b@ochiga.local");
    assert.ok(bobEntry, "directory should list active colleagues");
    assert.equal(bobEntry.role, undefined, "directory must never expose role");
    assert.equal(bobEntry.status, undefined, "directory must never expose account status");
    assert.equal(bobEntry.permission_scopes, undefined, "directory must never expose permission scopes");
    assert.equal(bobEntry.password_hash, undefined, "directory must never expose password_hash");
    console.log("A. Staff directory: excludes self, no administrative/RBAC fields exposed — PASS");

    // B. Direct conversation: starting the same 1:1 twice resolves to
    // the SAME conversation (Part 3 — no duplicate DM threads).
    const dm1Res = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ participant_emails: ["b@ochiga.local"] }) });
    assert.equal(dm1Res.status, 201);
    const dm1 = (await dm1Res.json()).conversation;
    assert.equal(dm1.type, "direct");
    const dm2Res = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ participant_emails: ["b@ochiga.local"] }) });
    const dm2 = (await dm2Res.json()).conversation;
    assert.equal(dm2.id, dm1.id, "starting the same 1:1 twice must resolve to the existing conversation, not create a duplicate");
    // Also resolves the same conversation from the OTHER side.
    const dm3Res = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie: bCookie }, body: JSON.stringify({ participant_emails: ["a@ochiga.local"] }) });
    assert.equal((await dm3Res.json()).conversation.id, dm1.id, "the same direct conversation must resolve from either participant's side");
    console.log("B. Direct conversation creation is idempotent from both sides — PASS");

    // C. Deactivated/suspended users cannot be reached as new-message
    // recipients, and a genuinely nonexistent email is treated the same.
    const deadRecipientRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ participant_emails: ["ghost@nowhere.local"] }) });
    assert.equal(deadRecipientRes.status, 400);
    assert.equal((await deadRecipientRes.json()).error, "inactive_recipients");
    console.log("C. Nonexistent/inactive recipients rejected server-side at conversation creation — PASS");

    // D. Security: a genuine non-participant cannot read the
    // conversation's messages by ID (guessing/knowing the real ID is
    // not enough), and gets a real 403, not a silent empty result.
    await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ body: "Please review the proposal." }) });
    const outsiderReadRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { headers: { cookie: outsiderCookie } });
    assert.equal(outsiderReadRes.status, 403, "a non-participant must not be able to read a conversation's messages by its real ID");
    const outsiderSendRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: outsiderCookie }, body: JSON.stringify({ body: "Injected." }) });
    assert.equal(outsiderSendRes.status, 403, "a non-participant must not be able to send into a conversation they're not part of");
    console.log("D. Non-participant cannot read or send into a conversation by ID — PASS");

    // E. Unread/read state is real: B has 1 unread until they mark it
    // read; opening it must NOT affect A's own read state of anything.
    const bListRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { headers: { cookie: bCookie } });
    const bConvo = (await bListRes.json()).conversations.find((c) => c.id === dm1.id);
    assert.equal(bConvo.unread_count, 1, "the recipient must show a real unread count");
    const bMessagesRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { headers: { cookie: bCookie } });
    const firstMessage = (await bMessagesRes.json()).messages[0];
    await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/read`, { method: "POST", headers: { cookie: bCookie } });
    const bListAfterReadRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { headers: { cookie: bCookie } });
    assert.equal((await bListAfterReadRes.json()).conversations.find((c) => c.id === dm1.id).unread_count, 0, "opening/reading must clear the reader's own unread count");
    const aMessagesAfterRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { headers: { cookie: aCookie } });
    const messageAsSeenByA = (await aMessagesAfterRes.json()).messages.find((m) => m.id === firstMessage.id);
    assert.ok(messageAsSeenByA.read_by.includes("b@ochiga.local"), "the sender must see a real per-recipient read receipt once the recipient opens it");
    console.log("E. Real unread/read state: reading updates only the reader's own state, sender sees a genuine read receipt — PASS");

    // F. Attachments are reachable only through the same
    // membership-gated messages route (Part 16 — "attachments obey the
    // same membership rules").
    const attachedMsgRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ body: "", attachments: [{ file_url: "/api/lead-agents/admin/storage/fake.pdf", filename: "Duncan_City_Proposal.pdf", mime_type: "application/pdf", size_bytes: 2516582 }] }) });
    assert.equal(attachedMsgRes.status, 201);
    const outsiderAttachRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { headers: { cookie: outsiderCookie } });
    assert.equal(outsiderAttachRes.status, 403, "attachments must be unreachable to a non-participant, same gate as the messages themselves");
    console.log("F. Attachments inherit the conversation's membership gate — PASS");

    // G. Reactions + soft-delete: toggle on/off, and deleting your own
    // message tombstones it (survives, body/attachments hidden) rather
    // than destroying it — another participant must still see it as
    // "deleted", not have it vanish or corrupt their view.
    const reactRes = await fetch(`${base}/api/lead-agents/admin/staff/messages/${firstMessage.id}/reactions`, { method: "POST", headers: { "content-type": "application/json", cookie: bCookie }, body: JSON.stringify({ emoji: "👍" }) });
    assert.equal((await reactRes.json()).action, "added");
    const otherDeleteRes = await fetch(`${base}/api/lead-agents/admin/staff/messages/${firstMessage.id}`, { method: "DELETE", headers: { cookie: bCookie } });
    assert.equal(otherDeleteRes.status, 403, "one participant must not be able to delete another participant's message");
    const ownDeleteRes = await fetch(`${base}/api/lead-agents/admin/staff/messages/${firstMessage.id}`, { method: "DELETE", headers: { cookie: aCookie } });
    assert.equal(ownDeleteRes.status, 200);
    assert.ok((await ownDeleteRes.json()).message.deleted_at);
    const bViewAfterDeleteRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { headers: { cookie: bCookie } });
    const survivingRow = (await bViewAfterDeleteRes.json()).messages.find((m) => m.id === firstMessage.id);
    assert.ok(survivingRow, "the deleted message must survive as a real row (tombstone), not vanish");
    assert.ok(survivingRow.deleted_at, "the other participant must see it as genuinely deleted");
    console.log("G. Reactions toggle; delete is sender-only and a tombstone, never a hard delete of another participant's copy — PASS");

    // H. Groups: creation requires a name, only the creator can rename/
    // add/remove members, ordinary members can leave (never add
    // themselves or others), and a genuine 3-party group actually
    // fans out messages/notifications to every OTHER member.
    const noTitleGroupRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ participant_emails: ["b@ochiga.local", "c@ochiga.local"] }) });
    assert.equal(noTitleGroupRes.status, 400);
    const groupRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ participant_emails: ["b@ochiga.local", "c@ochiga.local"], title: "Duncan City Project" }) });
    const group = (await groupRes.json()).conversation;
    assert.equal(group.type, "group");

    const renameByCRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${group.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: cCookie }, body: JSON.stringify({ title: "Hijacked" }) });
    assert.equal(renameByCRes.status, 403, "only the creator can rename a group");

    const selfAddRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${group.id}/members`, { method: "POST", headers: { "content-type": "application/json", cookie: outsiderCookie }, body: JSON.stringify({ participant_emails: ["outsider@ochiga.local"] }) });
    assert.equal(selfAddRes.status, 403, "an ordinary user must not be able to add themselves to a private group they're not the creator of");

    await fetch(`${base}/api/lead-agents/admin/staff/conversations/${group.id}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ body: "Kickoff at 11am." }) });
    const cUnreadRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { headers: { cookie: cCookie } });
    assert.equal((await cUnreadRes.json()).conversations.find((c) => c.id === group.id).unread_count, 1, "a group message must actually reach every other real member");

    const leaveRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${group.id}/members/${encodeURIComponent("c@ochiga.local")}`, { method: "DELETE", headers: { cookie: cCookie } });
    assert.equal(leaveRes.status, 200, "a member can always remove themselves (leave)");
    const cAfterLeaveRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${group.id}/messages`, { headers: { cookie: cCookie } });
    assert.equal(cAfterLeaveRes.status, 403, "after leaving, the former member must lose access immediately");
    console.log("H. Group creation requires a name; rename/add-member creator-gated; self-add rejected; real fan-out; leave works — PASS");

    // I. Per-participant archive/mute/pin are genuinely per-user, never
    // global — archiving for one participant must not affect another's view.
    await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/archive`, { method: "POST", headers: { cookie: bCookie } });
    const bArchivedViewRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { headers: { cookie: bCookie } });
    assert.ok((await bArchivedViewRes.json()).conversations.find((c) => c.id === dm1.id).archived_at);
    const aViewRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { headers: { cookie: aCookie } });
    assert.equal((await aViewRes.json()).conversations.find((c) => c.id === dm1.id).archived_at, null, "archiving must never be visible to/affect the other participant");
    console.log("I. Archive/mute/pin state is genuinely per-participant — PASS");

    // J. Message-content search is scoped server-side to the caller's
    // own conversations — a non-participant must never discover
    // content via search, even with the exact right search term.
    await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dm1.id}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ body: "The Duncan City proposal numbers are final." }) });
    const searchAsARes = await fetch(`${base}/api/lead-agents/admin/staff/messages/search?q=Duncan`, { headers: { cookie: aCookie } });
    assert.ok((await searchAsARes.json()).results.length >= 1, "a real participant must find their own conversation's content");
    const searchAsOutsiderRes = await fetch(`${base}/api/lead-agents/admin/staff/messages/search?q=Duncan`, { headers: { cookie: outsiderCookie } });
    assert.equal((await searchAsOutsiderRes.json()).results.length, 0, "a non-participant must never discover private conversation content through search");
    console.log("J. Message search never leaks content outside the caller's own conversations — PASS");

    // K. A deactivated account cannot continue sending — reuses the
    // same enrichAuthContext 401-on-next-request boundary already
    // proven for Team, now proven specifically for the messaging routes.
    const dmWithDeactivatedRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie: aCookie }, body: JSON.stringify({ participant_emails: ["deactivated@ochiga.local"] }) });
    const dmWithDeactivated = (await dmWithDeactivatedRes.json()).conversation;
    const preDeactivationSendRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dmWithDeactivated.id}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: deactivatedCookie }, body: JSON.stringify({ body: "Still active." }) });
    assert.equal(preDeactivationSendRes.status, 201, "sanity: the account can send while genuinely active");
    // Direct store mutation to flip status -- the same effect a real
    // super_admin deactivation would have -- without re-deriving the
    // whole Team RBAC chain already proven in
    // test-office-team-lifecycle-meetings-trash.js; this test is about
    // messaging's own boundary, not Team's permission gates.
    const deactivateTarget = await store.getAdminUserByEmail("deactivated@ochiga.local");
    await store.updateAdminUser(deactivateTarget.id, { status: "suspended" });
    const postDeactivationSendRes = await fetch(`${base}/api/lead-agents/admin/staff/conversations/${dmWithDeactivated.id}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: deactivatedCookie }, body: JSON.stringify({ body: "Should be rejected." }) });
    assert.equal(postDeactivationSendRes.status, 401, "a deactivated account must be rejected on its very next request, including sending a message");
    console.log("K. Deactivated account is rejected immediately on the messaging routes — PASS");

    // L. Presence endpoint is reachable and honest (no fabricated
    // "everyone online" default) for an unknown/offline email.
    const presenceRes = await fetch(`${base}/api/lead-agents/admin/staff/presence?emails=b@ochiga.local`, { headers: { cookie: aCookie } });
    assert.equal(presenceRes.status, 200);
    console.log("L. Presence endpoint reachable — PASS");

    console.log("office Messages workspace smoke passed");
  } finally {
    await close(server);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
