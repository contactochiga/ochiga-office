"use strict";

// Canonical CRM visibility for inbound WhatsApp messages.
//
// Every accepted inbound message is persisted as an `inbound_events` row. The CRM-visible conversation record (a `crm_activities` row of type `whatsapp_message`, carrying
// the provider message id) is written IMMEDIATELY after that row, before any decision about replying -- so Oyi OFF, a paused AI, a human takeover, a Backend goal that owns
// the thread, or a failed generation can never hide a customer's message. Recording is idempotent on the provider message id. The relationship thread additionally reads
// `inbound_events` directly (see relationship-workspace.js), so a message stays visible even if the activity write failed, and `repairInboundVisibility` can back-fill the
// activity from the original event later. Nothing here ever sends a message, and original events are never modified or deleted.

const { createCorporateRecord } = require("./office-operating-system");

const LEGACY_MATCH_WINDOW_MS = 10_000;

function clean(value) {
  return String(value ?? "").trim();
}
function normalizeText(value) {
  return clean(value).replace(/\s+/g, " ").toLowerCase();
}

// Text of a stored Meta message payload (the `raw` message object). Non-text messages get an honest placeholder: media is not ingested.
function inboundMessageText(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const text = p.text && typeof p.text === "object" ? p.text.body : p.text;
  const candidate = clean(text) || clean(p.button?.text) || clean(p.interactive?.button_reply?.title) || clean(p.interactive?.list_reply?.title) || clean(p.caption) || clean(p.image?.caption) || clean(p.document?.caption);
  if (candidate) return candidate;
  const type = clean(p.type) || "unknown";
  return `[${type} message — content not available in Office]`;
}

function inboundOccurredAt(inboundEvent) {
  const seconds = Number(inboundEvent?.payload?.timestamp);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString();
  return inboundEvent?.created_at || new Date().toISOString();
}

function activityProviderId(activity) {
  const meta = activity && activity.metadata && typeof activity.metadata === "object" ? activity.metadata : {};
  return clean(meta.provider_message_id || meta.external_message_id) || null;
}

// Legacy activities (written before provider ids were stored) can only be tied to their inbound event by what both records hold. The match is deliberately strict and
// ONE-TO-ONE: same lead, identical text, within 10 s, each activity used at most once, nearest first. Two identical messages therefore never collapse into one record, and
// a message with no counterpart stays unmatched (which is exactly the visibility gap to repair).
function matchLegacyActivities(inboundEvents, activities, { windowMs = LEGACY_MATCH_WINDOW_MS } = {}) {
  const idsWithActivity = new Set(activities.map(activityProviderId).filter(Boolean));
  const legacy = activities.filter((a) => a.activity_type === "whatsapp_message" && !activityProviderId(a) && (a.metadata?.direction || "inbound") !== "outbound");
  const used = new Set();
  const matches = new Map();
  const candidates = [];
  for (const event of inboundEvents) {
    if (idsWithActivity.has(clean(event.external_event_id))) continue;
    const at = Date.parse(inboundOccurredAt(event)) || 0;
    const text = normalizeText(inboundMessageText(event.payload));
    for (const activity of legacy) {
      if (clean(activity.lead_id) !== clean(event.lead_id)) continue;
      if (normalizeText(activity.body) !== text) continue;
      const delta = Math.abs((Date.parse(activity.occurred_at || activity.created_at) || 0) - at);
      // the activity of a webhook is written a moment after the event (processing time); allow either side within the window, measured against both stored times
      const deltaCreated = Math.abs((Date.parse(activity.occurred_at || activity.created_at) || 0) - (Date.parse(event.created_at) || at));
      const best = Math.min(delta, deltaCreated);
      if (best <= windowMs) candidates.push({ event, activity, best });
    }
  }
  candidates.sort((a, b) => a.best - b.best);
  for (const c of candidates) {
    if (matches.has(c.event.id) || used.has(c.activity.id)) continue;
    matches.set(c.event.id, c.activity);
    used.add(c.activity.id);
  }
  return matches;
}

// Writes (or finds) the canonical activity for one stored inbound event. Never throws: returns { ok, activity, created, error }.
async function recordInboundActivity(store, { lead, event, inboundEvent, requestId = "", extraMetadata = null, log = () => {} }) {
  const providerId = clean(event?.message_id || inboundEvent?.external_event_id);
  try {
    if (providerId) {
      const existing = await store.findCrmActivityByProviderMessageId(providerId);
      if (existing) return { ok: true, activity: existing, created: false };
    }
    const payload = inboundEvent?.payload || event?.raw || {};
    const activity = await createCorporateRecord(
      store,
      "activities",
      {
        lead_id: lead.id,
        related_type: "lead",
        related_id: lead.id,
        activity_type: "whatsapp_message",
        title: "WhatsApp message",
        body: inboundMessageText(Object.keys(payload).length ? payload : { type: event?.message_type, text: { body: event?.text } }).slice(0, 2000),
        source: "whatsapp",
        occurred_at: inboundOccurredAt(inboundEvent || { payload: { timestamp: event?.timestamp }, created_at: new Date().toISOString() }),
        metadata: {
          direction: "inbound",
          channel: "whatsapp",
          provider: "meta",
          provider_message_id: providerId || null,
          source_event_id: inboundEvent?.id || null,
          message_type: clean(payload.type || event?.message_type) || null,
          request_id: requestId || null,
          ai_replied: false,
          recorded_by: "inbound_webhook",
          ...(extraMetadata || {}),
        },
      },
      { actorEmail: "whatsapp" }
    );
    if (activity && activity.sync_status === "schema_pending") throw new Error(activity.sync_warning || "crm_activities not available");
    return { ok: true, activity, created: true };
  } catch (error) {
    log("error", "whatsapp_webhook.crm_record_failed", { request_id: requestId, message_id: providerId || null, lead_id: lead?.id || null, error: String(error?.message || error).slice(0, 240) });
    return { ok: false, activity: null, created: false, error };
  }
}

// Annotates the canonical activity with what was decided about replying (suppressed reason, whether Oyi replied). Best effort and never creates a second record.
async function annotateInboundActivity(store, { lead, event, inboundEvent, requestId, patch, log = () => {} }) {
  const providerId = clean(event?.message_id);
  try {
    let activity = providerId ? await store.findCrmActivityByProviderMessageId(providerId) : null;
    if (!activity) {
      const recorded = await recordInboundActivity(store, { lead, event, inboundEvent, requestId, log });
      activity = recorded.activity;
    }
    if (activity && activity.id) await store.mergeCrmActivityMetadata(activity.id, patch);
    return Boolean(activity);
  } catch (error) {
    log("error", "whatsapp_webhook.crm_annotation_failed", { request_id: requestId, message_id: providerId || null, error: String(error?.message || error).slice(0, 240) });
    return false;
  }
}

// ---- Historical visibility repair: works on DISTINCT provider message ids, never on raw (possibly duplicated) event rows ----
//
// Meta delivered some messages more than once before claim-first de-duplication existed, so `inbound_events` can hold several rows for one provider message id. The plan
// groups rows by provider message id, picks ONE canonical row per id by a fixed order (earliest `created_at`, then smallest `id`), and proposes at most one CRM activity per id.
// A message counts as already represented when ANY of its rows has an activity by provider id or by the strict one-to-one legacy match. Rows of one message that name DIFFERENT
// leads are a conflicting identity: they are reported and left alone (never merged automatically). Rows with no lead at all are invalid and reported.
function planInboundVisibilityRepair(events, activities) {
  const providerIdsWithActivity = new Set(activities.map(activityProviderId).filter(Boolean));
  const legacy = matchLegacyActivities(events, activities);
  const order = (a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || String(a.id).localeCompare(String(b.id));
  const groups = new Map();
  for (const event of events) {
    const providerId = clean(event.external_event_id);
    if (!providerId) continue; // no provider id: nothing to key a record on
    if (!groups.has(providerId)) groups.set(providerId, []);
    groups.get(providerId).push(event);
  }
  const plan = { raw_event_rows: events.length, distinct_provider_ids: groups.size, raw_missing_event_rows: 0, unique_missing_messages: 0, duplicate_event_rows: 0, invalid_records: [], conflicting_lead_groups: [], already_represented_messages: 0, would_create: [] };
  for (const [providerId, rows] of [...groups.entries()].sort((x, y) => order(x[1].slice().sort(order)[0], y[1].slice().sort(order)[0]))) {
    rows.sort(order);
    const represented = providerIdsWithActivity.has(providerId) || rows.some((row) => legacy.has(row.id));
    if (represented) { plan.already_represented_messages++; continue; }
    plan.raw_missing_event_rows += rows.length;
    plan.unique_missing_messages++;
    plan.duplicate_event_rows += rows.length - 1;
    const leadIds = [...new Set(rows.map((row) => clean(row.lead_id)).filter(Boolean))];
    if (leadIds.length === 0) { plan.invalid_records.push({ provider_message_id: providerId, reason: "no_lead_on_any_event_row", event_ids: rows.map((r) => r.id) }); continue; }
    if (leadIds.length > 1) { plan.conflicting_lead_groups.push({ provider_message_id: providerId, lead_ids: leadIds, event_ids: rows.map((r) => r.id) }); continue; }
    const canonical = rows[0];
    plan.would_create.push({ provider_message_id: providerId, lead_id: leadIds[0], occurred_at: inboundOccurredAt(canonical), canonical_event_id: canonical.id, duplicate_event_ids: rows.slice(1).map((r) => r.id), canonical_event: canonical });
  }
  return plan;
}

async function findMissingInboundActivities(store, { limit = 1000 } = {}) {
  const events = await store.listInboundMessageEvents({ limit });
  const activities = await store.listCrmActivitiesForWhatsApp();
  return planInboundVisibilityRepair(events, activities);
}

const REPAIR_CLAIM_PREFIX = "visibility-repair:";

// Idempotent historical visibility repair. dryRun (default) only reports. Creates at most ONE activity per distinct provider message id, with the original provider id,
// timestamp and lead; never touches inbound_events, never sends anything and never wakes Oyi (it does not call any reply or Backend path). Safe to re-run (a second run
// finds nothing missing) and safe to run concurrently: each message id is claimed atomically (primary key of whatsapp_inbound_claims, key prefix "visibility-repair:") before
// the find-then-create, so two runs, in one process or several, cannot both create its record.
async function repairInboundVisibility(store, { dryRun = true, limit = 1000, log = () => {} } = {}) {
  const plan = await findMissingInboundActivities(store, { limit });
  const report = {
    dry_run: dryRun,
    raw_event_rows: plan.raw_event_rows,
    distinct_provider_ids: plan.distinct_provider_ids,
    already_represented_messages: plan.already_represented_messages,
    raw_missing_event_rows: plan.raw_missing_event_rows,
    unique_missing_messages: plan.unique_missing_messages,
    duplicate_event_rows: plan.duplicate_event_rows,
    invalid_records: plan.invalid_records.length,
    conflicting_lead_groups: plan.conflicting_lead_groups.length,
    proposed_activities: plan.would_create.length,
    // kept for older callers: the number of records that WOULD be created (one per distinct message)
    missing: plan.would_create.length,
    created: 0, skipped_existing: 0, skipped_claimed_elsewhere: 0, failed: 0,
  };
  const summary = (item) => ({ provider_message_id: item.provider_message_id, lead_id: item.lead_id, occurred_at: item.occurred_at, canonical_event_id: item.canonical_event_id, duplicate_event_ids: item.duplicate_event_ids });
  if (dryRun) return { ...report, would_create_for: plan.would_create.map(summary), invalid: plan.invalid_records, conflicts: plan.conflicting_lead_groups };
  for (const item of plan.would_create) {
    const claimKey = `${REPAIR_CLAIM_PREFIX}${item.provider_message_id}`;
    let claim;
    try {
      claim = await store.claimInboundMessage({ providerMessageId: claimKey, channel: "visibility_repair", requestId: "visibility-repair" });
    } catch (error) {
      report.failed++; log("error", "whatsapp_visibility_repair.claim_failed", { message_id: item.provider_message_id, error: String(error?.message || error).slice(0, 200) }); continue;
    }
    if (claim.status === "duplicate") { report.skipped_claimed_elsewhere++; continue; }
    const recorded = await recordInboundActivity(store, { lead: { id: item.lead_id }, event: { message_id: item.provider_message_id }, inboundEvent: item.canonical_event, requestId: "visibility-repair", extraMetadata: { recorded_by: "visibility_repair", duplicate_event_ids: item.duplicate_event_ids }, log });
    if (!recorded.ok) { report.failed++; continue; }
    if (recorded.created) report.created++; else report.skipped_existing++;
    await store.updateInboundClaim(claimKey, { status: "completed", completed_at: new Date().toISOString() }).catch(() => null);
  }
  return { ...report, invalid: plan.invalid_records, conflicts: plan.conflicting_lead_groups };
}

module.exports = { planInboundVisibilityRepair, REPAIR_CLAIM_PREFIX, inboundMessageText, inboundOccurredAt, activityProviderId, matchLegacyActivities, recordInboundActivity, annotateInboundActivity, findMissingInboundActivities, repairInboundVisibility, LEGACY_MATCH_WINDOW_MS };
