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
async function recordInboundActivity(store, { lead, event, inboundEvent, requestId = "", log = () => {} }) {
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

// Inbound messages that have no CRM activity (by provider id, nor by the strict legacy match). Read-only.
async function findMissingInboundActivities(store, { limit = 1000 } = {}) {
  const events = await store.listInboundMessageEvents({ limit });
  const activities = await store.listCrmActivitiesForWhatsApp();
  const ids = new Set(activities.map(activityProviderId).filter(Boolean));
  const legacy = matchLegacyActivities(events, activities);
  return events.filter((e) => e.lead_id && !ids.has(clean(e.external_event_id)) && !legacy.has(e.id));
}

// Idempotent historical visibility repair. dryRun (default) only reports. Creates ONLY missing activities, with the original provider id, timestamp and lead; never touches
// inbound_events, never sends anything, safe to re-run (a second run finds nothing missing).
async function repairInboundVisibility(store, { dryRun = true, limit = 1000, log = () => {} } = {}) {
  const missing = await findMissingInboundActivities(store, { limit });
  const summary = { dry_run: dryRun, missing: missing.length, created: 0, failed: 0 };
  if (dryRun) return { ...summary, would_create_for: missing.map((e) => ({ provider_message_id: e.external_event_id, lead_id: e.lead_id, occurred_at: inboundOccurredAt(e) })) };
  for (const e of missing) {
    const recorded = await recordInboundActivity(store, { lead: { id: e.lead_id }, event: { message_id: e.external_event_id }, inboundEvent: e, requestId: "visibility-repair", log });
    if (recorded.ok && recorded.created) summary.created++; else if (!recorded.ok) summary.failed++;
  }
  return summary;
}

module.exports = { inboundMessageText, inboundOccurredAt, activityProviderId, matchLegacyActivities, recordInboundActivity, annotateInboundActivity, findMissingInboundActivities, repairInboundVisibility, LEGACY_MATCH_WINDOW_MS };
