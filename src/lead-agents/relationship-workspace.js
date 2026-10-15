"use strict";

// Unified CRM Relationship Workspace -- authorized READ MODEL.
// Aggregates evidence that already exists in Office (public conversations, CRM activities, lead timeline events, WhatsApp provider status events, Office documents)
// into one deterministic, paginated thread per lead. Nothing here writes or copies data: every entry carries `provenance` (source table + id), and entries that the
// same provider message produced in two tables are merged into one (the other source is listed under `merged_from`). Internal staff messages (staff_messages) are
// never read here.

const crypto = require("node:crypto");
const visibility = require("./whatsapp-inbound-visibility");

const SOURCE_KINDS = Object.freeze({
  whatsapp: { kind: "whatsapp", label: "WhatsApp" },
  linkedin: { kind: "linkedin", label: "LinkedIn" },
  facebook: { kind: "facebook", label: "Facebook" },
  instagram: { kind: "instagram", label: "Instagram" },
  email: { kind: "email", label: "Email" },
  meta: { kind: "meta", label: "Meta" },
  google: { kind: "google", label: "Google" },
  referral: { kind: "referral", label: "Referral" },
  manual: { kind: "manual", label: "Manual entry" },
});

function clean(value) {
  return String(value ?? "").trim();
}

// Original SOURCE (where the relationship came from) and delivery CHANNEL (where messages actually flow) are separate facts. Only values actually stored on the lead
// produce a provider-specific kind; anything else is "unknown" rather than a guessed icon.
function classifySource(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return { kind: "unknown", label: "Unknown", raw: "" };
  if (raw.startsWith("ochiga_website") || raw === "website") return { kind: "ochiga_website", label: "Ochiga Website", raw };
  if (raw === "website_widget" || raw === "widget" || raw === "website_chat") return { kind: "website_widget", label: raw === "website_chat" ? "Website Chat" : "Website Assistant", raw };
  if (raw === "oyi_command_center") return { kind: "oyi", label: "Oyi Command Center", raw };
  if (raw.startsWith("oyi_website") || raw.startsWith("oyi:")) return { kind: "oyi_website", label: "Oyi Website", raw };
  if (raw === "smoke_test") return { kind: "test", label: "Internal / Test", raw };
  const known = SOURCE_KINDS[raw];
  if (known) return { ...known, raw };
  return { kind: "other", label: raw.replace(/[:_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()), raw };
}

function leadSourceInfo(lead) {
  const original = classifySource(lead.source);
  const channelRaw = clean(lead.primary_channel || lead.source_channel);
  const delivery = channelRaw ? classifySource(channelRaw) : lead.whatsapp_phone ? classifySource("whatsapp") : { kind: "unknown", label: "Unknown", raw: "" };
  return { original_source: original, delivery_channel: delivery, source_form: clean(lead.source_form || lead.inquiry_type) || null };
}

function ts(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : 0;
}

function normalizeText(value) {
  return clean(value).replace(/\s+/g, " ").toLowerCase();
}

const STATUS_RANK = { read: 4, delivered: 3, sent: 2, failed: 1 };
function deliveryFromStatuses(statusEvents) {
  let best = null;
  for (const event of statusEvents || []) {
    const state = clean(event.event_type).replace(/^status:/, "").toLowerCase();
    if (!STATUS_RANK[state]) continue;
    if (state === "failed") {
      if (!best) best = state;
    } else if (!best || best === "failed" || STATUS_RANK[state] > STATUS_RANK[best]) {
      best = state;
    }
  }
  return best;
}

// "conversation"/"tool_event" are written by appendConversation as a mirror of the conversations row (shown once, from conversations); the other two are technical logs.
const SKIPPED_TIMELINE_EVENTS = new Set(["lead_updated", "oyi_core_whatsapp_turn", "conversation", "tool_event"]);
const TIMELINE_REASON_TEXT = {
  autonomous_whatsapp_disabled: "Autonomous WhatsApp responses are switched off, so no automatic reply was sent.",
  hard_off_rollback_build: "Autonomous WhatsApp responses are disabled by the emergency build, so no automatic reply was sent.",
  setting_unreadable: "The autonomy setting could not be read, so no automatic reply was sent.",
  human_takeover_active: "A human has taken over this conversation, so no automatic reply was sent.",
  ai_paused: "Oyi is paused for this conversation, so no automatic reply was sent.",
  deferred_to_goal: "An active follow-up goal owns this conversation, so Office sent no separate reply.",
};

function entryId(kind, table, id) {
  return `${kind}:${table}:${id}`;
}

// Deterministic: (occurred_at, kind rank, id).
const KIND_RANK = { form_submission: 0, message: 1, attachment: 2, activity: 3, system: 4 };
function compareEntries(a, b) {
  return ts(a.occurred_at) - ts(b.occurred_at) || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || String(a.id).localeCompare(String(b.id));
}

function encodeCursor(entry) {
  return Buffer.from(`${entry.occurred_at}|${entry.id}`).toString("base64url");
}
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [at, ...rest] = Buffer.from(String(cursor), "base64url").toString("utf8").split("|");
    return { at: ts(at), id: rest.join("|") };
  } catch {
    return null;
  }
}

function buildThread({ lead, conversations = [], timeline = [], activities = [], statusEvents = [], documents = [], manualSends = [], inboundEvents = [], opportunityId = "", before = "", limit = 50, search = "" }) {
  const entries = [];
  const conversationKeys = [];
  const statusByMessage = new Map();
  for (const event of statusEvents) {
    const key = clean(event.external_event_id);
    if (!key) continue;
    if (!statusByMessage.has(key)) statusByMessage.set(key, []);
    statusByMessage.get(key).push(event);
  }

  // Correlation rules (evidence only): records are merged ONLY when they share an authoritative identifier -- the exact provider message id, the manual-send/correlation id,
  // a communication id or a source-event id. Similar text and nearby timestamps are never grounds to merge; at most they are flagged as an UNCERTAIN possible duplicate.
  const byKey = new Map();
  const indexKeys = (entry, keys) => { entry.correlation_keys = keys; for (const key of keys) if (!byKey.has(key)) byKey.set(key, entry); };
  for (const row of conversations) {
    const inbound = row.message_role === "user";
    const channel = clean(row.channel) || "whatsapp_or_web";
    const providerId = clean(row.external_message_id);
    const keys = [providerId && `provider:${providerId}`, clean(row.correlation_id) && `corr:${clean(row.correlation_id)}`].filter(Boolean);
    const duplicateOf = keys.map((k) => byKey.get(k)).find(Boolean);
    if (duplicateOf && duplicateOf.provenance.table === "conversations" && (duplicateOf.direction === "inbound") === inbound) {
      duplicateOf.merged_from.push({ table: "conversations", id: row.id });
      continue;
    }
    let delivery = { state: "not_applicable", verified: false };
    if (!inbound && clean(row.channel) === "whatsapp") {
      const state = deliveryFromStatuses(statusByMessage.get(providerId));
      delivery = state ? { state, verified: true } : { state: "unverified", verified: false };
    }
    const staffReply = clean(row.agent_name).includes("@");
    const entry = {
      id: entryId("message", "conversations", row.id),
      kind: "message",
      direction: inbound ? "inbound" : "outbound",
      channel: clean(row.channel) || "website",
      sender: inbound ? "customer" : clean(row.agent_name) || "oyi",
      // a human operator's manual reply is stored with the staff e-mail as agent_name; every other assistant row is an Oyi/agent message
      sender_type: inbound ? "customer" : staffReply ? "staff" : "oyi",
      origin: inbound ? "customer" : staffReply ? "human" : "ai",
      text: clean(row.content),
      occurred_at: row.created_at,
      delivery,
      provider_message_id: providerId || null,
      opportunity_id: null,
      attachments: [],
      provenance: { table: "conversations", id: row.id },
      merged_from: [],
    };
    indexKeys(entry, keys);
    entries.push(entry);
    conversationKeys.push({ entry, text: normalizeText(row.content), at: ts(row.created_at), inbound, channel: clean(row.channel) });
  }

  // Manual WhatsApp sends (durable ledger). A send already represented by its conversation row (same correlation id) is merged into it; otherwise the ledger row itself is the
  // record, shown with its honest state (pending / outcome unknown / rejected / not sent / accepted-but-not-yet-recorded).
  const SEND_DELIVERY = { pending: "pending", outcome_unknown: "outcome_unknown", provider_rejected: "rejected", not_sent: "not_sent" };
  for (const send of manualSends) {
    const twin = byKey.get(`corr:${send.id}`);
    if (twin) {
      twin.merged_from.push({ table: "whatsapp_manual_sends", id: send.id });
      twin.manual_send = { id: send.id, status: send.status, resolved_by: send.resolved_by || null };
      continue;
    }
    const providerId = clean(send.provider_message_id);
    let delivery;
    if (send.status === "provider_accepted") {
      const state = deliveryFromStatuses(statusByMessage.get(providerId));
      delivery = state ? { state, verified: true } : { state: "unverified", verified: false };
    } else {
      delivery = { state: SEND_DELIVERY[send.status] || "unverified", verified: false };
    }
    const entry = {
      id: entryId("message", "whatsapp_manual_sends", send.id),
      kind: "message",
      direction: "outbound",
      channel: clean(send.channel) || "whatsapp",
      sender: clean(send.actor_email),
      sender_type: "staff",
      origin: "human",
      text: clean(send.body),
      occurred_at: send.created_at,
      delivery,
      provider_message_id: providerId || null,
      opportunity_id: null,
      attachments: [],
      manual_send: { id: send.id, status: send.status, resolvable: send.status === "outcome_unknown" || send.status === "pending", failure_reason: send.failure_reason || null, resolved_by: send.resolved_by || null },
      provenance: { table: "whatsapp_manual_sends", id: send.id },
      merged_from: [],
    };
    indexKeys(entry, [`corr:${send.id}`, providerId && `provider:${providerId}`].filter(Boolean));
    entries.push(entry);
  }

  // Inbound message EVENTS are the authoritative record of what Meta delivered. They are read directly so a customer message is visible whatever happened to its CRM
  // activity (reply suppressed, paused, taken over, goal-owned, generation failed, or the activity write failed). A record that shares the provider message id is the same
  // message (merged, provenance kept); a legacy activity without an id is tied to its event only by the strict one-to-one match in whatsapp-inbound-visibility.js.
  const skippedActivityIds = new Set();
  const legacyMatches = visibility.matchLegacyActivities(inboundEvents, activities);
  for (const ev of inboundEvents) {
    const providerId = clean(ev.external_event_id);
    const existing = providerId ? byKey.get(`provider:${providerId}`) : null;
    if (existing && existing.kind === "message" && existing.direction === "inbound") {
      existing.merged_from.push({ table: "inbound_events", id: ev.id });
      continue;
    }
    const legacy = legacyMatches.get(ev.id);
    const entry = {
      id: entryId("message", "inbound_events", ev.id),
      kind: "message",
      direction: "inbound",
      channel: "whatsapp",
      sender: "customer",
      sender_type: "customer",
      origin: "customer",
      text: visibility.inboundMessageText(ev.payload),
      occurred_at: visibility.inboundOccurredAt(ev),
      delivery: { state: "not_applicable", verified: false },
      provider_message_id: providerId || null,
      opportunity_id: legacy?.opportunity_id || null,
      attachments: [],
      provenance: { table: "inbound_events", id: ev.id },
      merged_from: [],
    };
    if (legacy) {
      entry.merged_from.push({ table: "crm_activities", id: legacy.id });
      skippedActivityIds.add(legacy.id);
      const reason = legacy.metadata?.suppressed_reason;
      if (reason) entry.reply_suppressed = { reason, text: TIMELINE_REASON_TEXT[reason] || "No automatic reply was sent." };
    }
    if (providerId) indexKeys(entry, [`provider:${providerId}`]);
    entries.push(entry);
    if (!legacy) conversationKeys.push({ entry, text: normalizeText(entry.text), at: ts(entry.occurred_at), inbound: true, channel: "whatsapp" });
  }

  for (const activity of activities) {
    if (skippedActivityIds.has(activity.id)) continue;
    const meta = activity.metadata && typeof activity.metadata === "object" ? activity.metadata : {};
    const at = activity.occurred_at || activity.created_at;
    const base = {
      occurred_at: at,
      opportunity_id: activity.opportunity_id || null,
      attachments: [],
      provenance: { table: "crm_activities", id: activity.id },
      merged_from: [],
    };
    if (activity.activity_type === "whatsapp_message") {
      const text = normalizeText(activity.body);
      const inboundActivity = meta.direction !== "outbound";
      const activityKeys = [meta.provider_message_id, meta.external_message_id].map(clean).filter(Boolean).map((k) => `provider:${k}`)
        .concat([meta.correlation_id].map(clean).filter(Boolean).map((k) => `corr:${k}`), [meta.communication_id].map(clean).filter(Boolean).map((k) => `comm:${k}`), [meta.source_event_id].map(clean).filter(Boolean).map((k) => `event:${k}`));
      const proven = activityKeys.map((k) => byKey.get(k)).find((e) => e && e.kind === "message" && (e.direction === "inbound") === inboundActivity);
      if (proven) {
        proven.merged_from.push({ table: "crm_activities", id: activity.id });
        if (meta.suppressed_reason) proven.reply_suppressed = { reason: meta.suppressed_reason, text: TIMELINE_REASON_TEXT[meta.suppressed_reason] || "No automatic reply was sent." };
        if (!proven.opportunity_id && activity.opportunity_id) proven.opportunity_id = activity.opportunity_id;
        continue;
      }
      // No shared identifier: keep BOTH records. If a conversation row looks similar, say so honestly instead of merging.
      const lookalike = conversationKeys.find((c) => c.channel === "whatsapp" && c.inbound === inboundActivity && c.text === text && Math.abs(c.at - ts(at)) <= 120000);
      entries.push({
        ...base,
        id: entryId("message", "crm_activities", activity.id),
        kind: "message",
        direction: inboundActivity ? "inbound" : "outbound",
        channel: "whatsapp",
        sender: inboundActivity ? "customer" : clean(activity.actor) || "staff",
        sender_type: inboundActivity ? "customer" : "unknown",
        origin: inboundActivity ? "customer" : "unknown",
        text: clean(activity.body),
        delivery: inboundActivity ? { state: "not_applicable", verified: false } : { state: "unverified", verified: false },
        provider_message_id: clean(meta.provider_message_id) || null,
        correlation: lookalike ? "uncertain" : "single_source",
        ...(lookalike ? { possible_duplicate_of: lookalike.entry.id } : {}),
        reply_suppressed: meta.suppressed_reason ? { reason: meta.suppressed_reason, text: TIMELINE_REASON_TEXT[meta.suppressed_reason] || "No automatic reply was sent." } : undefined,
      });
      continue;
    }
    if (activity.activity_type === "website_intake_received") {
      entries.push({
        ...base,
        id: entryId("form_submission", "crm_activities", activity.id),
        kind: "form_submission",
        direction: "inbound",
        channel: "website_form",
        sender: "customer",
        sender_type: "customer",
        origin: "customer",
        title: clean(activity.title) || "Website form submission",
        text: clean(activity.body),
        form: { business_unit: activity.business_unit || meta.business_unit || null, source_site: clean(activity.source) || null },
        delivery: { state: "not_applicable", verified: false },
      });
      continue;
    }
    entries.push({
      ...base,
      id: entryId("activity", "crm_activities", activity.id),
      kind: "activity",
      direction: "internal",
      channel: clean(activity.source) || null,
      sender: clean(activity.actor) || "system",
      sender_type: activity.activity_type === "note" ? "staff" : "system",
      origin: activity.activity_type === "note" ? "human" : "system",
      activity_type: activity.activity_type,
      title: clean(activity.title) || clean(activity.activity_type),
      text: clean(activity.body),
      delivery: { state: "not_applicable", verified: false },
    });
  }

  for (const event of timeline) {
    if (SKIPPED_TIMELINE_EVENTS.has(event.event_type)) continue;
    const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
    let text = clean(event.body);
    if (event.event_type === "whatsapp_autonomous_reply_suppressed") text = TIMELINE_REASON_TEXT[meta.reason] || text || "No automatic reply was sent.";
    entries.push({
      id: entryId("system", "timeline_events", event.id),
      kind: "system",
      direction: "internal",
      channel: null,
      sender: clean(event.actor) || "system",
      sender_type: "system",
      origin: "system",
      event_type: event.event_type,
      title: clean(event.title) || clean(event.event_type),
      text,
      occurred_at: event.created_at,
      delivery: { state: "not_applicable", verified: false },
      opportunity_id: null,
      attachments: [],
      provenance: { table: "timeline_events", id: event.id },
      merged_from: [],
    });
  }

  for (const doc of documents) {
    entries.push({
      id: entryId("attachment", "office_documents", doc.id),
      kind: "attachment",
      direction: "internal",
      channel: null,
      sender: clean(doc.owner) || "office",
      sender_type: "staff",
      origin: "human",
      title: clean(doc.title),
      text: "",
      occurred_at: doc.created_at,
      delivery: { state: "not_applicable", verified: false },
      opportunity_id: doc.related_type === "opportunity" ? doc.related_id : null,
      // No public URL is ever exposed: staff open the document through the authenticated Documents workspace.
      attachments: [{ id: doc.id, title: clean(doc.title), document_type: doc.document_type, status: doc.status, open_route: `documents/${encodeURIComponent(doc.id)}` }],
      provenance: { table: "office_documents", id: doc.id },
      merged_from: [],
    });
  }

  // The autonomy-suppression fact is shown once: inline on the customer message it belongs to (within 15 s after it), and the matching system entry is dropped.
  const suppressedMessages = entries.filter((e) => e.kind === "message" && e.reply_suppressed);
  const deduped = entries.filter((e) => !(e.kind === "system" && e.event_type === "whatsapp_autonomous_reply_suppressed" && suppressedMessages.some((m) => ts(e.occurred_at) >= ts(m.occurred_at) - 1000 && ts(e.occurred_at) - ts(m.occurred_at) <= 15000)));
  entries.length = 0;
  entries.push(...deduped);
  entries.sort(compareEntries);

  let view = entries;
  let unlinked = 0;
  if (opportunityId) {
    unlinked = entries.filter((e) => !e.opportunity_id).length;
    view = entries.filter((e) => e.opportunity_id === opportunityId);
  }
  const needle = normalizeText(search);
  if (needle) view = view.filter((e) => normalizeText(`${e.title || ""} ${e.text || ""} ${e.sender || ""}`).includes(needle));

  const total = view.length;
  const cursor = decodeCursor(before);
  if (cursor) view = view.filter((e) => ts(e.occurred_at) < cursor.at || (ts(e.occurred_at) === cursor.at && String(e.id) < cursor.id));
  const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const page = view.slice(-cappedLimit);
  const hasMore = view.length > page.length;
  return { entries: page, total, has_more: hasMore, next_before: hasMore && page.length ? encodeCursor(page[0]) : null, unlinked_count: opportunityId ? unlinked : undefined };
}

// Same derivation the Office UI uses for the Qualification column (explicit field first, otherwise the stored score band) -- nothing new is inferred.
function qualificationOf(lead) {
  if (clean(lead.qualification_status)) return clean(lead.qualification_status);
  const score = Number(lead.score ?? lead.lead_score);
  if (!Number.isFinite(score) || (lead.score == null && lead.lead_score == null)) return "";
  return score >= 75 ? "qualified" : score >= 50 ? "needs_discovery" : score >= 25 ? "nurture" : "unqualified";
}
function stageOf(lead) {
  return clean(lead.stage || lead.commercial_stage || lead.status) || null;
}

// The latest customer-visible message for a lead, from whichever record exists: the conversation log (when Oyi/staff replied) or a CRM activity (inbound WhatsApp text
// kept while autonomy is OFF, or a website form submission). The newer one wins; nothing is invented when neither exists.
function latestMessageFor({ conversation, activities = [] }) {
  const candidates = [];
  if (conversation) candidates.push({ text: clean(conversation.content), direction: conversation.message_role === "user" ? "inbound" : "outbound", at: conversation.created_at });
  for (const a of activities) {
    if (a.activity_type !== "whatsapp_message" && a.activity_type !== "website_intake_received") continue;
    const meta = a.metadata && typeof a.metadata === "object" ? a.metadata : {};
    candidates.push({ text: clean(a.body) || clean(a.title), direction: meta.direction === "outbound" ? "outbound" : "inbound", at: a.occurred_at || a.created_at });
  }
  candidates.sort((x, y) => ts(y.at) - ts(x.at));
  return candidates[0] || null;
}

function buildInboxEntry({ lead, lastMessage, channelState, opportunities = [] }) {
  const source = leadSourceInfo(lead);
  const preview = lastMessage ? lastMessage.text.slice(0, 140) : clean(lead.summary).slice(0, 140);
  // the inbox is ordered by the lead's own activity clock (updated_at / last_contact_at, bumped on every inbound message), so the time shown is the later of that clock and the
  // last message -- the list is then always in the order of the times it displays
  const leadClock = lead.last_contact_at || lead.updated_at || lead.created_at;
  const last = lastMessage && ts(lastMessage.at) > ts(leadClock) ? lastMessage.at : leadClock;
  return {
    lead_id: lead.id,
    name: lead.name || lead.company || lead.email || lead.phone || lead.whatsapp_phone || "Unnamed lead",
    company: lead.company || null,
    preview,
    preview_direction: lastMessage ? lastMessage.direction : null,
    last_activity_at: last || null,
    original_source: source.original_source,
    delivery_channel: source.delivery_channel,
    stage: stageOf(lead),
    business_unit: lead.business_unit || null,
    qualification: qualificationOf(lead) || null,
    owner: lead.owner || null,
    human_owner: channelState?.human_owner || null,
    human_status: channelState?.human_status || "auto",
    ai_paused: Boolean(channelState?.ai_paused),
    has_opportunity: opportunities.some((o) => o.lead_id === lead.id),
    opportunity_count: opportunities.filter((o) => o.lead_id === lead.id).length,
    unread: Boolean(channelState?.last_inbound_at && (!channelState.last_outbound_at || ts(channelState.last_inbound_at) > ts(channelState.last_outbound_at))),
  };
}

function normalizePhoneKey(value) {
  return clean(value).replace(/[^\d]/g, "").replace(/^0+/, "");
}

// Scope a set of leads to a CRM contact / organization / opportunity, with only explicit links: same lead_id, same organization_id, or an identical normalised
// e-mail / phone. Never a fuzzy name match (unrelated customers must not merge).
function leadIdsForScope({ leads, contacts = [], opportunities = [], activities = [], scope = {} }) {
  if (scope.lead_id) return new Set(leads.filter((l) => l.id === scope.lead_id).map((l) => l.id));
  if (scope.opportunity_id) {
    const opp = opportunities.find((o) => o.id === scope.opportunity_id);
    return new Set(opp && opp.lead_id ? [opp.lead_id] : []);
  }
  if (scope.contact_id) {
    const contact = contacts.find((c) => c.id === scope.contact_id);
    if (!contact) return new Set();
    const email = clean(contact.email).toLowerCase();
    const phone = normalizePhoneKey(contact.phone);
    const ids = new Set(leads.filter((l) => (email && clean(l.email).toLowerCase() === email) || (phone && (normalizePhoneKey(l.phone) === phone || normalizePhoneKey(l.whatsapp_phone) === phone))).map((l) => l.id));
    for (const a of activities) if (a.contact_id === contact.id && a.lead_id) ids.add(a.lead_id);
    for (const o of opportunities) if (o.contact_id === contact.id && o.lead_id) ids.add(o.lead_id);
    return ids;
  }
  if (scope.organization_id) {
    const ids = new Set(leads.filter((l) => l.organization_id === scope.organization_id).map((l) => l.id));
    for (const o of opportunities) if (o.organization_id === scope.organization_id && o.lead_id) ids.add(o.lead_id);
    return ids;
  }
  return null;
}

function newRequestKey() {
  return crypto.randomUUID();
}

module.exports = { qualificationOf, stageOf, latestMessageFor, classifySource, leadSourceInfo, buildThread, buildInboxEntry, leadIdsForScope, deliveryFromStatuses, encodeCursor, decodeCursor, newRequestKey };
