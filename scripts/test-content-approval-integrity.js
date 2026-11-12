// Content approval integrity -- an approval covers one exact version of an article. Proves, against the real HTTP routes and the real scheduler pass:
// editing after approval withdraws it (also for scheduled content), a no-op save keeps it, publish and the scheduler refuse anything that is not the approved
// version (stale or missing approval) and return it to review, a version the reviewer never saw cannot be approved, schedule dates are validated, a stale or
// concurrently changed Sanity draft never goes live, and the existing permission and separation-of-duties guards still hold.
// Temporary file store and an in-memory Sanity fake only: no network, no database, no real Sanity project.
"use strict";

const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { setSanityClientFactoryForTests } = require("../src/lead-agents/sanity-adapter");
const integrity = require("../src/lead-agents/content-integrity");

let checks = 0;
const ok = (cond, name) => { assert.ok(cond, name); checks += 1; console.log("PASS " + name); };

// In-memory stand-in for @sanity/client: documents keyed by _id, a new _rev on every write, and a hook that runs before getDocument (to simulate a concurrent
// edit landing between the draft save and the publish).
function createFakeSanity() {
  const docs = new Map();
  const published = [];
  const hooks = { beforeGetDocument: null, failDraftSave: false };
  let rev = 0;
  const client = {
    fetch: async () => null,
    assets: { upload: async () => ({ _id: "image-asset" }) },
    async createOrReplace(doc) {
      if (hooks.failDraftSave && String(doc._id).startsWith("drafts.")) throw new Error("sanity unavailable");
      const stored = { ...doc, _rev: `rev-${++rev}` };
      docs.set(doc._id, stored);
      if (!String(doc._id).startsWith("drafts.")) published.push(stored);
      return stored;
    },
    async getDocument(id) {
      if (hooks.beforeGetDocument) await hooks.beforeGetDocument(id, client);
      return docs.has(id) ? { ...docs.get(id) } : undefined;
    },
    async delete(id) { docs.delete(id); },
    async createIfNotExists(doc) {
      if (!docs.has(doc._id)) docs.set(doc._id, { ...doc, _rev: `rev-${++rev}` });
      return docs.get(doc._id);
    },
  };
  return { client, docs, published, hooks };
}

const bodyText = (doc) => (doc && Array.isArray(doc.body) ? doc.body.map((b) => b.children.map((c) => c.text).join("")).join("\n") : "");

function unitChecks() {
  const base = { title: "T", slug: "t", excerpt: "", category: null, author: undefined, tags: ["a"], body: "B", featured_image_url: "", seo_title: null, seo_description: "" };
  ok(integrity.contentFingerprint(base) === integrity.contentFingerprint({ ...base, category: "", author: "", seo_title: "" }), "fingerprint: null, undefined and empty string are the same (file vs Supabase store)");
  ok(integrity.contentFingerprint(base) === integrity.contentFingerprint({ ...base, workflow_status: "x", metadata: { a: 1 }, updated_at: "now" }), "fingerprint ignores workflow and bookkeeping fields");
  for (const field of integrity.CONTENT_FIELDS) {
    const changed = { ...base, [field]: field === "tags" ? ["b"] : "changed" };
    ok(integrity.contentFingerprint(base) !== integrity.contentFingerprint(changed), `fingerprint covers ${field}`);
  }
  ok(integrity.editWithdrawsApproval({ ...base, workflow_status: "approved" }, { ...base, body: "B2" }), "a changing edit withdraws an approval");
  ok(integrity.editWithdrawsApproval({ ...base, workflow_status: "scheduled" }, { ...base, title: "T2" }), "a changing edit withdraws a scheduled approval");
  ok(!integrity.editWithdrawsApproval({ ...base, workflow_status: "approved" }, { ...base }), "a no-op save keeps the approval");
  ok(!integrity.editWithdrawsApproval({ ...base, workflow_status: "draft" }, { ...base, body: "B2" }), "draft edits are unaffected");
  ok(!integrity.editWithdrawsApproval({ ...base, workflow_status: "in_review" }, { ...base, body: "B2" }), "in-review edits keep their status (approval binds at approve time)");

  const approved = { ...base, metadata: { approval: integrity.buildApproval(base, "r@x") } };
  ok(integrity.verifyApprovedVersion(approved).ok, "the approved version verifies");
  ok(integrity.verifyApprovedVersion({ ...approved, body: "B2" }).reason === "content_changed_since_approval", "a changed version is refused");
  ok(integrity.verifyApprovedVersion(base).reason === "no_approval_record", "an item with no approval record is refused");
  ok(integrity.verifyApprovedVersion({ ...base, metadata: { approval: { approved_by: "x" } } }).reason === "no_approval_record", "a malformed approval record is refused");
  ok(!("approval" in integrity.withoutApproval(approved.metadata)) && integrity.withoutApproval(null) && typeof integrity.withoutApproval(undefined) === "object", "withoutApproval drops only the approval");

  const now = new Date("2026-11-12T12:00:00Z");
  const v = (value) => integrity.validateScheduledPublishAt(value, now);
  ok(v("2026-11-13T09:00:00Z").ok && v("2026-11-13T09:00:00Z").iso === "2026-11-13T09:00:00.000Z", "a future UTC time is accepted and normalised");
  ok(v("2026-11-13T10:00:00+01:00").iso === "2026-11-13T09:00:00.000Z", "an offset time is converted to UTC");
  ok(v("2026-11-13T09:00Z").ok && v("2026-11-13T09:00:00.123Z").ok, "minutes-only and fractional seconds are accepted");
  const invalid = [
    [undefined, "missing"], [null, "null"], ["", "empty"], ["   ", "blank"], [1767225600000, "a number"], [{}, "an object"],
    ["tomorrow", "free text"], ["2026-11-13", "a date without a time"], ["2026-11-13T09:00:00", "no timezone"], ["2026-11-13 09:00:00Z", "a space instead of T"],
    ["2026-02-30T09:00:00Z", "30 February"], ["2026-13-01T09:00:00Z", "month 13"], ["2026-11-13T24:00:00Z", "hour 24"], ["2026-11-13T09:60:00Z", "minute 60"],
    ["2026-11-12T12:00:00Z", "exactly now"], ["2026-11-12T11:59:59Z", "the past"], ["2027-11-14T12:00:00Z", "more than a year ahead"], ["20266-01-01T09:00:00Z", "a five-digit year"],
  ];
  for (const [value, label] of invalid) ok(!v(value).ok && typeof v(value).error === "string", `schedule date refused: ${label}`);
  ok(v("2028-02-29T09:00:00Z").ok === false && integrity.validateScheduledPublishAt("2028-02-29T09:00:00Z", new Date("2027-12-01T00:00:00Z")).ok, "29 February is valid only in a leap year (and within range)");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(server.address().port); });
  });
}

async function main() {
  unitChecks();

  const sanity = createFakeSanity();
  const savedEnv = { SANITY_PROJECT_ID: process.env.SANITY_PROJECT_ID, SANITY_DATASET: process.env.SANITY_DATASET, SANITY_API_WRITE_TOKEN: process.env.SANITY_API_WRITE_TOKEN, OFFICE_CONTENT_SCHEDULER_ENABLED: process.env.OFFICE_CONTENT_SCHEDULER_ENABLED };
  Object.assign(process.env, { SANITY_PROJECT_ID: "test-project", SANITY_DATASET: "test", SANITY_API_WRITE_TOKEN: "test-token-not-a-secret" });
  delete process.env.OFFICE_CONTENT_SCHEDULER_ENABLED; // the timer stays off; scheduler passes are driven explicitly
  setSanityClientFactoryForTests(() => sanity.client);

  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["content-integrity-test-key"], allowedOrigins: [], officeEmailProvider: "", resendApiKey: "" };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "writer@ochiga.local", password_hash: hashPassword("writer-pass-123"), role: "ochiga_staff", display_name: "Writer", status: "active" });
  await store.ensureAdminUser({ email: "reviewer@ochiga.local", password_hash: hashPassword("reviewer-pass-123"), role: "ochiga_staff", display_name: "Reviewer", status: "active" });
  await store.ensureAdminUser({ email: "publisher@ochiga.local", password_hash: hashPassword("publisher-pass-123"), role: "super_admin", display_name: "Publisher", status: "active" });
  const webhooks = new WebhookDispatcher({ config });
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks }),
  });
  const base = `http://127.0.0.1:${await listen(server)}`;

  async function login(email, password) {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, `login ${email}`);
    return res.headers.get("set-cookie").split(";")[0];
  }
  const call = async (cookie, method, path, body) => {
    const res = await fetch(`${base}/api/lead-agents/admin/content${path}`, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  try {
    const writer = await login("writer@ochiga.local", "writer-pass-123");
    const reviewer = await login("reviewer@ochiga.local", "reviewer-pass-123");
    const publisher = await login("publisher@ochiga.local", "publisher-pass-123");
    const item = async (id) => store.getContentItemById(id);
    const audits = (id, action) => store.state.audit_events.filter((e) => e.resource_id === id && e.action === action);
    const publishedFor = (id) => sanity.published.filter((d) => d._id === `post-${id}`);

    // Create -> submit -> reviewer loads (fingerprint) -> approve with that fingerprint.
    async function approvedArticle(title, body = "Approved body") {
      const created = await call(writer, "POST", "", { title, body, excerpt: "Excerpt" });
      assert.equal(created.status, 201);
      const id = created.data.item.id;
      assert.equal((await call(writer, "POST", `/${id}/submit-review`, {})).status, 200);
      const shown = await call(reviewer, "GET", `/${id}`);
      const approved = await call(reviewer, "POST", `/${id}/approve`, { content_fingerprint: shown.data.item.content_fingerprint });
      assert.equal(approved.status, 200, `approve ${title}`);
      return id;
    }

    // 1. Baseline: the approved version is what goes live.
    const a1 = await approvedArticle("Baseline article", "The approved words");
    const a1Item = await item(a1);
    ok(a1Item.workflow_status === "approved" && a1Item.metadata.approval && a1Item.metadata.approval.fingerprint === integrity.contentFingerprint(a1Item) && a1Item.metadata.approval.approved_by === "reviewer@ochiga.local", "approve records the fingerprint of the approved version and the approver");
    ok(audits(a1, "content_approved")[0]?.metadata.content_fingerprint === a1Item.metadata.approval.fingerprint, "the approval audit records the fingerprint");
    const pub1 = await call(publisher, "POST", `/${a1}/publish`, {});
    ok(pub1.status === 200 && pub1.data.item.workflow_status === "published" && pub1.data.item.published_by === "publisher@ochiga.local", "the approved version publishes");
    ok(publishedFor(a1).length === 1 && bodyText(publishedFor(a1)[0]) === "The approved words" && publishedFor(a1)[0].title === "Baseline article", "Sanity's published document is exactly the approved content");
    ok(!sanity.docs.has(`drafts.post-${a1}`), "the draft is removed after publishing (Sanity Studio behaviour unchanged)");

    // 2. Editing after approval withdraws it; the edit cannot be published.
    const a2 = await approvedArticle("Edited after approval", "Approved text");
    const edit = await call(writer, "PATCH", `/${a2}`, { body: "UNREVIEWED text" });
    const a2Item = await item(a2);
    ok(edit.status === 200 && edit.data.approval_withdrawn === true && a2Item.workflow_status === "draft" && !a2Item.metadata.approval, "an edit after approval returns the article to draft and removes the approval");
    ok(a2Item.body === "UNREVIEWED text" && edit.data.item.content_fingerprint === integrity.contentFingerprint(a2Item), "the edit itself is saved (writer's work kept) and the response carries the new fingerprint");
    const withdrawn = audits(a2, "content_approval_withdrawn")[0];
    ok(withdrawn && withdrawn.metadata.reason === "edited_after_approval" && withdrawn.metadata.previous_status === "approved" && withdrawn.actor_email === "writer@ochiga.local", "the withdrawal is audited with reason, previous status and actor");
    ok(audits(a2, "content_edited")[0]?.metadata.fields.join(",") === "body", "the edit audit lists only editorial fields, not the workflow reset");
    const pub2 = await call(publisher, "POST", `/${a2}/publish`, {});
    ok(pub2.status === 400 && publishedFor(a2).length === 0, "the edited article cannot be published; nothing reached Sanity's published document");
    ok((await call(publisher, "POST", `/${a2}/schedule`, { scheduled_publish_at: new Date(Date.now() + 86_400_000).toISOString() })).status === 400, "the edited article cannot be scheduled either");

    // 3. A save that changes nothing keeps the approval (the editor sends every field on Save).
    const a3 = await approvedArticle("No-op save", "Same text");
    const current = await item(a3);
    const noop = await call(writer, "PATCH", `/${a3}`, { title: current.title, slug: current.slug, excerpt: current.excerpt, category: "", author: "", tags: [], body: current.body, featured_image_url: "", seo_title: "", seo_description: "" });
    ok(noop.status === 200 && noop.data.approval_withdrawn === false && (await item(a3)).workflow_status === "approved" && (await item(a3)).metadata.approval, "an unchanged save keeps the approval");
    ok((await call(publisher, "POST", `/${a3}/publish`, {})).status === 200, "and the article still publishes");

    // 4. Scheduled content: an edit takes it off the schedule; the scheduler then publishes nothing.
    const a4 = await approvedArticle("Scheduled then edited", "Scheduled text");
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const sched = await call(publisher, "POST", `/${a4}/schedule`, { scheduled_publish_at: when });
    ok(sched.status === 200 && sched.data.item.workflow_status === "scheduled" && sched.data.item.scheduled_publish_at === when, "an approved article schedules with a valid future time");
    const editScheduled = await call(writer, "PATCH", `/${a4}`, { title: "Scheduled then edited (new title)" });
    const a4Item = await item(a4);
    ok(editScheduled.data.approval_withdrawn === true && a4Item.workflow_status === "draft" && a4Item.scheduled_publish_at === null && !a4Item.metadata.approval, "editing scheduled content withdraws the approval and clears the schedule");
    ok(audits(a4, "content_approval_withdrawn")[0]?.metadata.previous_scheduled_publish_at === when, "the withdrawal audit keeps the cancelled publish time");
    await server.runContentSchedulerTick(new Date(Date.now() + 10 * 86_400_000));
    ok(publishedFor(a4).length === 0 && (await item(a4)).workflow_status === "draft", "the scheduler does not publish the edited article");

    // 5. Stale approval: content changed by a path that did not withdraw the approval (direct store write) -> refused, returned to review, then recoverable.
    const a5 = await approvedArticle("Stale approval", "Approved");
    await store.updateContentItem(a5, { body: "changed outside the edit route" });
    const pub5 = await call(publisher, "POST", `/${a5}/publish`, {});
    ok(pub5.status === 409 && pub5.data.reason === "content_changed_since_approval" && pub5.data.item.workflow_status === "in_review", "publishing a stale approval is refused (409) and the response carries the returned-to-review item");
    ok(publishedFor(a5).length === 0 && !(await item(a5)).metadata.approval, "nothing was published and the stale approval is gone");
    const w5 = audits(a5, "content_approval_withdrawn")[0];
    ok(w5 && w5.metadata.refused_action === "publish" && w5.metadata.reason === "content_changed_since_approval" && w5.actor_email === "publisher@ochiga.local", "the refusal is audited (action, reason, actor)");
    const shown5 = await call(reviewer, "GET", `/${a5}`);
    ok((await call(reviewer, "POST", `/${a5}/approve`, { content_fingerprint: shown5.data.item.content_fingerprint })).status === 200 && (await call(publisher, "POST", `/${a5}/publish`, {})).status === 200, "after re-approval of the current version it publishes");
    ok(bodyText(publishedFor(a5).at(-1)) === "changed outside the edit route", "and what went live is the version that was re-approved");

    // 6. Legacy approval (approved before fingerprints existed): no record -> refused, returned to review (not stuck in "approved").
    const legacy = (await call(writer, "POST", "", { title: "Legacy approved", body: "Old" })).data.item.id;
    await store.updateContentItem(legacy, { workflow_status: "approved", approved_by: "someone@ochiga.local" });
    const pub6 = await call(publisher, "POST", `/${legacy}/publish`, {});
    ok(pub6.status === 409 && pub6.data.reason === "no_approval_record" && (await item(legacy)).workflow_status === "in_review" && publishedFor(legacy).length === 0, "a legacy approval without a fingerprint is refused and returned to review");
    const legacySched = (await call(writer, "POST", "", { title: "Legacy for schedule", body: "Old" })).data.item.id;
    await store.updateContentItem(legacySched, { workflow_status: "approved" });
    const s6 = await call(publisher, "POST", `/${legacySched}/schedule`, { scheduled_publish_at: new Date(Date.now() + 86_400_000).toISOString() });
    ok(s6.status === 409 && s6.data.reason === "no_approval_record" && (await item(legacySched)).workflow_status === "in_review" && audits(legacySched, "content_approval_withdrawn")[0]?.metadata.refused_action === "schedule", "scheduling a legacy approval is refused, audited and returned to review");

    // 7. Scheduler: publishes the approved version (even over a stale Sanity draft); refuses a stale or legacy scheduled item and returns it to review.
    const a7 = await approvedArticle("Scheduler publishes", "Approved for schedule");
    await call(publisher, "POST", `/${a7}/schedule`, { scheduled_publish_at: new Date(Date.now() + 3_600_000).toISOString() });
    sanity.docs.set(`drafts.post-${a7}`, { ...sanity.docs.get(`drafts.post-${a7}`), body: [{ _type: "block", children: [{ text: "STALE DRAFT IN SANITY" }] }], _rev: "stale" });
    const tick7 = await server.runContentSchedulerTick(new Date(Date.now() + 2 * 3_600_000));
    const a7Item = await item(a7);
    ok(tick7.find((r) => r.id === a7)?.ok === true && a7Item.workflow_status === "published" && a7Item.published_by === "scheduler", "the scheduler publishes a due, still-approved article");
    ok(bodyText(publishedFor(a7).at(-1)) === "Approved for schedule", "a stale Sanity draft never goes live: the scheduler publishes the verified approved version");
    ok(audits(a7, "content_published")[0]?.actor_email === "scheduler" && audits(a7, "content_published")[0]?.metadata.via === "scheduler", "the scheduled publish is audited as the scheduler");

    const a7b = await approvedArticle("Scheduler refuses stale", "Approved");
    await call(publisher, "POST", `/${a7b}/schedule`, { scheduled_publish_at: new Date(Date.now() + 3_600_000).toISOString() });
    await store.updateContentItem(a7b, { body: "tampered after scheduling" });
    const tick7b = await server.runContentSchedulerTick(new Date(Date.now() + 2 * 3_600_000));
    const a7bItem = await item(a7b);
    ok(tick7b.find((r) => r.id === a7b)?.reason === "content_changed_since_approval" && publishedFor(a7b).length === 0, "the scheduler refuses a scheduled article whose content changed after approval");
    ok(a7bItem.workflow_status === "in_review" && a7bItem.scheduled_publish_at === null && !a7bItem.metadata.approval && audits(a7b, "content_approval_withdrawn")[0]?.metadata.refused_action === "scheduled_publish", "it is taken off the schedule, returned to review and audited");
    const again = await server.runContentSchedulerTick(new Date(Date.now() + 3 * 3_600_000));
    ok(!again.some((r) => r.id === a7b), "a refused item is not retried on the next scheduler pass");

    const legacyScheduled = (await call(writer, "POST", "", { title: "Legacy scheduled", body: "Old" })).data.item.id;
    await store.updateContentItem(legacyScheduled, { workflow_status: "scheduled", scheduled_publish_at: new Date(Date.now() - 60_000).toISOString() });
    await server.runContentSchedulerTick(new Date());
    ok((await item(legacyScheduled)).workflow_status === "in_review" && publishedFor(legacyScheduled).length === 0, "a legacy scheduled item without an approval record is not published by the scheduler");

    // 8. Schedule date validation at the route; the article stays approved after every refusal.
    const a8 = await approvedArticle("Date validation", "Text");
    const badDates = [[undefined, "missing"], ["", "empty"], ["next tuesday", "free text"], ["2026-12-01T09:00", "no timezone"], ["2026-02-30T09:00:00Z", "30 February"], [new Date(Date.now() - 60_000).toISOString(), "the past"], [new Date(Date.now() + 400 * 86_400_000).toISOString(), "beyond a year"], [12345, "a number"]];
    for (const [value, label] of badDates) {
      const r = await call(publisher, "POST", `/${a8}/schedule`, value === undefined ? {} : { scheduled_publish_at: value });
      ok(r.status === 400 && r.data.reason === "invalid_scheduled_publish_at" && (await item(a8)).workflow_status === "approved", `schedule refused (400) for ${label}; article stays approved`);
    }
    const offsetTime = new Date(Date.now() + 86_400_000);
    const offsetText = new Date(offsetTime.getTime() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+01:00");
    const s8 = await call(publisher, "POST", `/${a8}/schedule`, { scheduled_publish_at: offsetText });
    ok(s8.status === 200 && s8.data.item.scheduled_publish_at === new Date(offsetText).toISOString() && audits(a8, "content_scheduled")[0]?.metadata.scheduled_publish_at === s8.data.item.scheduled_publish_at, "a valid offset time is stored and audited as normalised UTC");
    const sCopy = await call(publisher, "POST", `/${a8}/schedule`, { scheduled_publish_at: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    ok(sCopy.status === 400, "an already-scheduled article cannot be re-scheduled without approval status (existing rule kept)");

    // 9. A version the reviewer never saw cannot be approved; API callers without a fingerprint still work.
    const created9 = (await call(writer, "POST", "", { title: "Changed during review", body: "v1" })).data.item.id;
    await call(writer, "POST", `/${created9}/submit-review`, {});
    const seen = (await call(reviewer, "GET", `/${created9}`)).data.item.content_fingerprint;
    await call(writer, "PATCH", `/${created9}`, { body: "v2 written while the reviewer was reading" });
    const a9 = await call(reviewer, "POST", `/${created9}/approve`, { content_fingerprint: seen });
    ok(a9.status === 409 && a9.data.reason === "content_changed_during_review" && (await item(created9)).workflow_status === "in_review", "approving a stale on-screen version is refused (409) and the article stays in review");
    const a9b = await call(reviewer, "POST", `/${created9}/approve`, {});
    ok(a9b.status === 200 && (await item(created9)).metadata.approval.fingerprint === integrity.contentFingerprint(await item(created9)), "approval without a fingerprint (existing API callers) still works and binds to the current version");

    // 10. A concurrent change to the Sanity draft between saving and publishing is refused.
    const a10 = await approvedArticle("Concurrent draft change", "Approved");
    sanity.hooks.beforeGetDocument = async (id, client) => {
      if (id === `drafts.post-${a10}`) {
        sanity.hooks.beforeGetDocument = null;
        await client.createOrReplace({ ...sanity.docs.get(id), body: [{ _type: "block", children: [{ text: "SNEAKED IN" }] }] });
      }
    };
    const pub10 = await call(publisher, "POST", `/${a10}/publish`, {});
    ok(pub10.status === 502 && /draft_changed_before_publish/.test(pub10.data.error) && publishedFor(a10).length === 0 && (await item(a10)).workflow_status === "approved", "a draft changed between save and publish is refused (502), nothing goes live, status unchanged");
    ok((await call(publisher, "POST", `/${a10}/publish`, {})).status === 200 && bodyText(publishedFor(a10).at(-1)) === "Approved", "a retry publishes the approved version");

    // 11. A failed Sanity draft save never falls through to publishing an older draft.
    const a11 = await approvedArticle("Draft save fails", "Approved");
    sanity.hooks.failDraftSave = true;
    const pub11 = await call(publisher, "POST", `/${a11}/publish`, {});
    sanity.hooks.failDraftSave = false;
    ok(pub11.status === 502 && pub11.data.reason === "draft_save_failed" && publishedFor(a11).length === 0 && (await item(a11)).workflow_status === "approved", "a failed draft save refuses the publish (502) without publishing the previous draft");
    const tickFail = (await call(publisher, "POST", `/${a11}/schedule`, { scheduled_publish_at: new Date(Date.now() + 3_600_000).toISOString() })).status;
    sanity.hooks.failDraftSave = true;
    const tick11 = await server.runContentSchedulerTick(new Date(Date.now() + 2 * 3_600_000));
    sanity.hooks.failDraftSave = false;
    ok(tickFail === 200 && tick11.find((r) => r.id === a11)?.reason === "draft_save_failed" && (await item(a11)).workflow_status === "scheduled", "a transport failure leaves a scheduled article scheduled for the next pass (existing retry behaviour)");

    // 12. Sanity not configured: still 503, after the integrity check.
    const a12 = await approvedArticle("No Sanity", "Approved");
    delete process.env.SANITY_API_WRITE_TOKEN;
    const pub12 = await call(publisher, "POST", `/${a12}/publish`, {});
    process.env.SANITY_API_WRITE_TOKEN = "test-token-not-a-secret";
    ok(pub12.status === 503 && (await item(a12)).workflow_status === "approved", "unconfigured Sanity still answers 503 and changes nothing");

    // 13. Existing permission and separation-of-duties guards are unchanged.
    const own = (await call(writer, "POST", "", { title: "Own draft", body: "x" })).data.item.id;
    await call(writer, "POST", `/${own}/submit-review`, {});
    ok((await call(writer, "POST", `/${own}/approve`, {})).status === 403, "a writer still cannot approve their own draft");
    ok((await call(writer, "POST", `/${a12}/publish`, {})).status === 403 && (await call(reviewer, "POST", `/${a12}/schedule`, { scheduled_publish_at: new Date(Date.now() + 86_400_000).toISOString() })).status === 403, "staff without content.publish still cannot publish or schedule");
    ok((await call(publisher, "POST", `/${a1}/unpublish`, {})).status === 200 && (await item(a1)).workflow_status === "unpublished", "unpublish is unchanged");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setSanityClientFactoryForTests(null);
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }

  // 14. Office UI wiring (static): Approve sends the on-screen fingerprint; a save or refusal redraws state from the server's item.
  const fs = require("node:fs");
  const ui = fs.readFileSync(require("node:path").join(__dirname, "../public/office/office.js"), "utf8");
  ok(/runAction\("approve", item\.content_fingerprint \? \{ content_fingerprint: item\.content_fingerprint \} : \{\}\)/.test(ui), "UI: Approve sends the fingerprint of the version on screen");
  ok(/result\.approval_withdrawn/.test(ui) && /showContentState\(result\.item\)/.test(ui), "UI: a save that withdraws approval says so and redraws the workflow buttons");
  ok(/err\.status === 409 && err\.data\?\.item && onStateChange/.test(ui), "UI: a refused publish/schedule redraws from the returned-to-review item");
  ok(/Pick a date and time to publish\./.test(ui), "UI: an empty schedule date gets a clear message instead of a RangeError");

  console.log(JSON.stringify({ suite: "content-approval-integrity", checks, failed: 0 }));
}

main().catch((error) => { console.error(error); process.exit(1); });
