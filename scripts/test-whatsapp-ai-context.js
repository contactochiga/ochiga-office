const assert = require("node:assert/strict");
const { buildVerifiedWhatsAppContext, ownershipFingerprint } = require("../src/lead-agents/whatsapp-ai-context");
const { verifyWhatsAppConsent } = require("../src/lead-agents/communication-outbox");

const lead = { id: "lead-1", whatsapp_phone: "2348012345678" };
const at = (seconds) => new Date(seconds * 1000).toISOString();
const inbound = (id, seconds, body, requestId = `req-${id}`) => ({
  id: `event-${id}`, channel: "whatsapp", event_type: "message", lead_id: lead.id,
  external_event_id: id, created_at: at(seconds + 1),
  payload: { id, from: lead.whatsapp_phone, type: "text", timestamp: String(seconds), text: { body } },
  requestId,
});
const sourcesFor = (...events) => ({
  inboundEvents: events.map(({ requestId, ...row }) => row),
  activities: events.map((row) => ({ id: `activity-${row.external_event_id}`, lead_id: lead.id, activity_type: "whatsapp_message",
    body: row.payload.text?.body || "[image]", occurred_at: at(Number(row.payload.timestamp)), created_at: row.created_at,
    metadata: { provider_message_id: row.external_event_id, request_id: row.requestId, channel: "whatsapp", direction: "inbound", ai_replied: false } })),
  manualSends: [], aiTurns: [],
});
const current = (event) => ({ message_id: event.external_event_id, from: lead.whatsapp_phone, text: event.payload.text.body, request_id: event.requestId });
const check = (sources, event) => buildVerifiedWhatsAppContext({ lead, event: current(event), sources });

const now = Math.floor(Date.now() / 1000);
const previous = inbound("wamid.previous", now - 40, "Earlier customer message");
const latest = inbound("wamid.latest", now - 20, "Current customer message");
const goodSources = sourcesFor(previous, latest);
const valid = check(goodSources, latest);
assert.equal(valid.ok, true, valid.reason);
assert.equal(valid.context.version, 1);
assert.equal(valid.context.source, "office_crm");
assert.equal(valid.context.channel, "whatsapp");
assert.equal(valid.context.lead_ref, lead.id);
assert.equal(valid.context.conversation_thread_id, null);
assert.equal(valid.context.current_event_id, latest.external_event_id);
assert.deepEqual(valid.context.messages.map((row) => row.message_id), [previous.external_event_id, latest.external_event_id]);
console.log("Valid verified WhatsApp history and PR #98 schema — PASS");

const shuffled = sourcesFor(latest, previous);
assert.equal(check(shuffled, latest).ok, true);
assert.deepEqual(check(shuffled, latest).context.messages.map((row) => row.message_id), [previous.external_event_id, latest.external_event_id]);
console.log("Out-of-order storage rows normalize into chronological transcript — PASS");

assert.equal(buildVerifiedWhatsAppContext({ lead, event: current(latest), sources: { ...goodSources, inboundEvents: undefined } }).ok, false);
assert.equal(buildVerifiedWhatsAppContext({ lead: { ...lead, id: "wrong-lead" }, event: current(latest), sources: goodSources }).ok, false);
assert.equal(check(goodSources, { ...latest, external_event_id: "wamid.other" }).ok, false);
assert.equal(check(goodSources, { ...latest, payload: { ...latest.payload, text: { body: "stale content" } }, requestId: "other" }).ok, false);
console.log("Unavailable history, wrong CRM lead, wrong thread/event, and latest-message mismatch fail closed — PASS");

const duplicateSources = sourcesFor(previous, latest);
duplicateSources.inboundEvents.push({ ...duplicateSources.inboundEvents[1], id: "duplicate-event" });
const duplicate = check(duplicateSources, latest);
assert.equal(duplicate.ok, true);
assert.equal(duplicate.context.messages.filter((row) => row.message_id === latest.external_event_id).length, 1);
const conflicting = sourcesFor(previous, { ...latest, payload: { ...latest.payload, text: { body: "different body" } } });
assert.equal(check(conflicting, latest).ok, false);
console.log("Duplicate provider IDs deduplicate only when content is identical — PASS");

const mediaOnly = inbound("wamid.media-only", now - 30, "");
mediaOnly.payload = { id: mediaOnly.external_event_id, from: lead.whatsapp_phone, type: "image", timestamp: String(now - 30), image: { id: "media-id" } };
assert.equal(check(sourcesFor(mediaOnly, previous, latest), latest).ok, false);
console.log("Media-only history is not replaced with fabricated transcript text — PASS");

const missingThreadSources = sourcesFor(previous, latest);
missingThreadSources.activities[0].metadata.ai_replied = true;
missingThreadSources.aiTurns.push({ id: "turn-1", lead_id: lead.id, event_type: "oyi_core_whatsapp_turn", body: "Prior answer", created_at: at(now - 39),
  metadata: { request_id: previous.requestId, oyi_thread_id: "" } });
assert.equal(check(missingThreadSources, latest).ok, false);
const conflictingThreads = sourcesFor(previous, latest);
conflictingThreads.activities[0].metadata.ai_replied = true;
conflictingThreads.aiTurns.push({ id: "turn-1", lead_id: lead.id, event_type: "oyi_core_whatsapp_turn", body: "Prior answer", created_at: at(now - 39), metadata: { request_id: previous.requestId, oyi_thread_id: "thread-A" } });
conflictingThreads.activities[1].metadata.ai_replied = true;
conflictingThreads.aiTurns.push({ id: "turn-2", lead_id: lead.id, event_type: "oyi_core_whatsapp_turn", body: "Latest answer", created_at: at(now - 19), metadata: { request_id: latest.requestId, oyi_thread_id: "thread-B" } });
assert.equal(check(conflictingThreads, latest).ok, false);
console.log("Missing and conflicting Oyi thread bindings fail closed — PASS");

const withStaff = sourcesFor(previous, latest);
withStaff.manualSends.push({ id: "send-1", lead_id: lead.id, channel: "whatsapp", actor_email: "staff@example.test", body: "Staff response", recipient: lead.whatsapp_phone,
  provider_message_id: "wamid.staff", status: "provider_accepted", created_at: at(now - 30) });
const staffContext = check(withStaff, latest);
assert.equal(staffContext.ok, true, staffContext.reason);
assert.equal(staffContext.context.messages.find((row) => row.message_id === "wamid.staff").role, "staff");
withStaff.manualSends[0].status = "outcome_unknown";
assert.equal(check(withStaff, latest).ok, false);
console.log("Accepted staff sends are included; unresolved sends invalidate the transcript — PASS");

const revisionA = ownershipFingerprint({ id: "state-1", updated_at: at(now), human_status: "auto", social_ownership_revision: 4 });
const revisionB = ownershipFingerprint({ id: "state-1", updated_at: at(now), human_status: "auto", social_ownership_revision: 5 });
assert.notEqual(revisionA, revisionB);
console.log("Ownership revision changes invalidate the pre-generation snapshot — PASS");

(async () => {
  const config = { officeBackendBaseUrl: "https://backend.invalid", officeBackendApiKey: "test-only" };
  const consentPayload = { channel: "whatsapp", provider_event_type: "message", provider_message_id: "wamid.consent", from: lead.whatsapp_phone };
  let posted;
  const allowed = await verifyWhatsAppConsent(config, consentPayload, { post: async (_config, body) => {
    posted = body;
    return { status: 200, data: { ok: true, opt_out_status: "not_opted_out" } };
  } });
  assert.equal(allowed.status, "not_opted_out");
  assert.equal(posted.replay, true);
  const optedOut = await verifyWhatsAppConsent(config, consentPayload, { post: async () => ({ status: 200, data: { ok: true, opted_out: true } }) });
  assert.equal(optedOut.status, "opted_out");
  const unknown = await verifyWhatsAppConsent(config, consentPayload, { post: async () => ({ status: 503, data: {} }) });
  assert.equal(unknown.status, "unknown");
  const missingConfig = await verifyWhatsAppConsent({}, consentPayload);
  assert.equal(missingConfig.status, "unknown");
  console.log("Fresh consent check uses non-sending replay and fails closed for opt-out/unavailable — PASS");
})().then(() => console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-ai-context" }))).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
