"use strict";

// Office-owned communication delivery OUTBOX.
//
// Office stores every authenticated WhatsApp inbound event (message or provider status) and must eventually hand it to Oyi Backend (`POST /office/communications/webhook-event`),
// including while the Backend instance is cold-starting. This module is a durable queue of that EVIDENCE -- it is not a scheduler and never causes a customer reply:
//   * identity: one entry per `delivery_key` (`whatsapp:message:<provider id>` / `whatsapp:status:<provider id>:<status>`); the unique key prevents duplicate pending entries;
//   * the FIRST attempt is made inline (live semantics: Backend may wake a goal exactly as before, preserving the single-responder decision); every LATER attempt, and every
//     reconciled/historical entry, is sent with `replay:true` (Backend persists + classifies + honours STOP but NEVER wakes goals or sends anything) and its `goal_active`
//     answer is ignored;
//   * an ambiguous outcome (timeout, dropped connection) is treated as "possibly delivered": the entry stays pending and is retried; Backend is idempotent on the provider id;
//   * an entry becomes `delivered` only after a valid acknowledgement (HTTP 200 with `ok:true`); a permanent refusal or exhausted retries become `dead` (dead letter);
//   * retries use bounded exponential backoff with jitter; a lease (compare-and-set on `attempts`) guarantees two workers never forward the same entry simultaneously, and a
//     crashed worker's lease simply expires.

const axios = require("axios");
const crypto = require("node:crypto");

const DEFAULTS = Object.freeze({
  inlineTimeoutMs: 8_000,    // first, inline attempt (same budget the webhook always had)
  workerTimeoutMs: 45_000,   // background attempts: long enough to ride out a Render cold start
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
  jitter: 0.2,
  maxAttempts: 12,           // about 5-6 hours of retrying before dead-lettering
  leaseMs: 90_000,
  tickMs: 15_000,
  batch: 5,
});
const settings = (config) => ({ ...DEFAULTS, ...((config && config.communicationOutbox) || {}) });

// Backend answers 200 {ok:false, reason} for requests it can never accept; these are not worth retrying.
const PERMANENT_REASONS = new Set(["unsupported_or_missing_fields", "missing_sender", "unrecognized_status"]);

function clean(value) { return String(value ?? "").trim(); }

function deliveryKey(kind, providerMessageId, status = "") {
  return kind === "status" ? `whatsapp:status:${clean(providerMessageId)}:${clean(status).toLowerCase()}` : `whatsapp:message:${clean(providerMessageId)}`;
}

// Bounded exponential backoff with jitter. `attempts` = attempts already made (>= 1).
function backoffDelayMs(attempts, options = {}, random = Math.random) {
  const o = { ...DEFAULTS, ...options };
  const exponential = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** Math.max(0, attempts - 1));
  const spread = exponential * o.jitter;
  return Math.max(0, Math.round(exponential - spread + random() * 2 * spread));
}

// Backend-bound request body for a stored inbound event (original provider id, sender, text, lead and PROVIDER timestamp -- never a new one).
function payloadFromInboundEvent(event) {
  const raw = event.payload && typeof event.payload === "object" ? event.payload : {};
  const seconds = Number(raw.timestamp);
  const occurredAt = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : event.created_at;
  if (clean(event.event_type).startsWith("status:")) {
    const error = Array.isArray(raw.errors) ? raw.errors[0] : null;
    return { channel: "whatsapp", provider_event_type: "status", provider_message_id: clean(raw.id || event.external_event_id), status: clean(raw.status || event.event_type.slice(7)), error_code: error?.code ?? null, error_title: error?.title || error?.message || null, occurred_at: occurredAt };
  }
  const text = raw.text && typeof raw.text === "object" ? raw.text.body : raw.text;
  return { channel: "whatsapp", provider_event_type: "message", provider_message_id: clean(event.external_event_id || raw.id), from: clean(raw.from), text: clean(text) || clean(raw.button?.text) || clean(raw.interactive?.button_reply?.title) || clean(raw.interactive?.list_reply?.title) || "", lead_id: event.lead_id || null, occurred_at: occurredAt };
}

// Durable entry for one event. Never throws: returns { ok, entry, created, error }.
async function enqueueDelivery(store, { payload, sourceEventId = null, mode = "live", log = () => {} }) {
  try {
    const kind = payload.provider_event_type === "status" ? "status" : "message";
    const key = deliveryKey(kind, payload.provider_message_id, payload.status);
    const result = await store.enqueueCommunicationDelivery({ delivery_key: key, event_type: kind, provider_message_id: clean(payload.provider_message_id), status_value: kind === "status" ? clean(payload.status).toLowerCase() : null, source_event_id: sourceEventId, lead_id: payload.lead_id || null, payload, mode });
    return { ok: true, entry: result.entry, created: result.created };
  } catch (error) {
    log("error", "communication_outbox.enqueue_failed", { provider_message_id: clean(payload?.provider_message_id), error: String(error?.message || error).slice(0, 200) });
    return { ok: false, entry: null, created: false, error };
  }
}

function classify(result) {
  if (result.error) {
    const status = result.error.response?.status;
    if (Number.isInteger(status)) {
      if (status === 401 || status === 403) return { delivered: false, retryable: true, error: `backend_auth_${status}`, http: status };
      if (status === 408 || status === 429 || status >= 500) return { delivered: false, retryable: true, error: `backend_http_${status}`, http: status };
      return { delivered: false, retryable: false, error: `backend_http_${status}`, http: status };
    }
    return { delivered: false, retryable: true, ambiguous: true, error: `ambiguous_${result.error.code || result.error.message || "no_response"}`.slice(0, 120), http: null };
  }
  const data = result.data || {};
  const httpStatus = Number(result.status);
  if (httpStatus === 401 || httpStatus === 403) return { delivered: false, retryable: true, error: `backend_auth_${httpStatus}`, http: httpStatus };
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return { delivered: false, retryable: true, error: `backend_http_${httpStatus}`, http: httpStatus };
  if (httpStatus >= 400) return { delivered: false, retryable: false, error: `backend_http_${httpStatus}`, http: httpStatus };
  if (result.status === 200 && data.ok === true) return { delivered: true, http: 200, goalActive: Boolean(data.goal_active) };
  if (result.status === 200 && data.ok === false && PERMANENT_REASONS.has(clean(data.reason))) return { delivered: false, retryable: false, error: `backend_refused_${clean(data.reason)}`, http: 200 };
  return { delivered: false, retryable: true, error: `backend_not_acknowledged_${clean(data.reason || data.error || result.status)}`.slice(0, 120), http: result.status || null };
}

async function defaultPost(config, body, timeoutMs) {
  try {
    const response = await axios.post(`${config.officeBackendBaseUrl.replace(/\/$/, "")}/office/communications/webhook-event`, body, { headers: { "x-api-key": config.officeBackendApiKey }, timeout: timeoutMs, validateStatus: () => true });
    return { status: response.status, data: response.data };
  } catch (error) {
    return { error };
  }
}

// One delivery attempt for one entry (lease -> POST -> record outcome). Safe to call concurrently from any number of workers/instances for the same entry.
async function attemptDelivery(store, config, entry, { workerId = `worker-${process.pid}`, timeoutMs, now = Date.now, post = defaultPost, random = Math.random, log = () => {} } = {}) {
  const s = settings(config);
  if (!config.officeBackendBaseUrl || !config.officeBackendApiKey) return { skipped: true, reason: "backend_bridge_not_configured" };
  const leased = await store.leaseCommunicationDelivery(entry.id, { workerId, leaseMs: s.leaseMs, now: now() });
  if (!leased) return { skipped: true, reason: "lease_not_acquired" };
  // LIVE semantics only for the very first attempt of a live entry; everything else is a non-sending replay.
  const replay = leased.mode === "replay" || leased.attempts > 1;
  const body = { ...leased.payload, ...(replay ? { replay: true } : {}) };
  const result = await post(config, body, timeoutMs || (leased.attempts > 1 ? s.workerTimeoutMs : s.inlineTimeoutMs));
  const verdict = classify(result);
  const at = new Date(now()).toISOString();
  try {
    if (verdict.delivered) {
      await store.completeCommunicationDelivery(leased.id, { status: "delivered", delivered_at: at, last_error: null, last_http_status: verdict.http, lease_until: null, leased_by: null });
      return { delivered: true, replay, goalActive: replay ? false : verdict.goalActive, attempts: leased.attempts };
    }
    const dead = !verdict.retryable || leased.attempts >= s.maxAttempts;
    const nextAt = new Date(now() + backoffDelayMs(leased.attempts, s, random)).toISOString();
    await store.completeCommunicationDelivery(leased.id, { status: dead ? "dead" : "pending", next_attempt_at: dead ? undefined : nextAt, dead_at: dead ? at : undefined, last_error: verdict.error, last_http_status: verdict.http, lease_until: null, leased_by: null });
    log(dead ? "error" : "warn", dead ? "communication_outbox.dead_letter" : "communication_outbox.retry_scheduled", { entry_id: leased.id, attempts: leased.attempts, error: verdict.error, ambiguous: Boolean(verdict.ambiguous) });
    return { delivered: false, replay, dead, ambiguous: Boolean(verdict.ambiguous), error: verdict.error, attempts: leased.attempts, next_attempt_at: dead ? null : nextAt };
  } catch (error) {
    // the outcome could not be recorded: the lease will expire and the entry will be retried (Backend is idempotent), never lost
    log("error", "communication_outbox.outcome_unrecorded", { entry_id: leased.id, error: String(error?.message || error).slice(0, 200) });
    return { delivered: Boolean(verdict.delivered), outcome_unrecorded: true, attempts: leased.attempts };
  }
}

// Inline path used by the webhook: enqueue, try once with the short timeout, return what the old synchronous forward returned.
async function enqueueAndAttempt(store, config, { payload, sourceEventId, log = () => {}, post, now }) {
  if (!config.officeBackendBaseUrl || !config.officeBackendApiKey) return { forwarded: false, goalActive: false, reason: "backend_bridge_not_configured" };
  const queued = await enqueueDelivery(store, { payload, sourceEventId, mode: "live", log });
  if (!queued.ok) return { forwarded: false, goalActive: false, reason: "enqueue_failed", outbox_recorded: false };
  if (queued.entry.status === "delivered") return { forwarded: true, goalActive: false, reason: "already_delivered", outbox_recorded: true };
  const outcome = await attemptDelivery(store, config, queued.entry, { log, post, now });
  return { forwarded: Boolean(outcome.delivered), goalActive: Boolean(outcome.goalActive), reason: outcome.delivered ? null : outcome.reason || outcome.error || "pending_retry", outbox_recorded: true };
}

// One worker tick: lease and deliver due entries (background, long timeout, replay semantics from the second attempt on).
async function drainOutbox(store, config, { workerId, limit, now = Date.now, post, random, log = () => {} } = {}) {
  const s = settings(config);
  const due = await store.listDueCommunicationDeliveries({ now: now(), limit: limit || s.batch });
  const results = [];
  for (const entry of due) results.push(await attemptDelivery(store, config, entry, { workerId, timeoutMs: s.workerTimeoutMs, now, post, random, log }));
  return results;
}

function startOutboxWorker({ store, config, log = () => {}, workerId = `worker-${process.pid}-${crypto.randomBytes(3).toString("hex")}` }) {
  const s = settings(config);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await drainOutbox(store, config, { workerId, log }); } catch (error) { log("error", "communication_outbox.worker_tick_failed", { error: String(error?.message || error).slice(0, 200) }); } finally { running = false; }
  };
  const timer = setInterval(tick, s.tickMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, 2_000).unref?.(); // pick up work left by a previous process soon after start
  return { stop: () => clearInterval(timer), tick, workerId };
}

// Reconciliation of events that have no outbox entry (history, or an enqueue that failed). dryRun (default) only reports. Entries are created as REPLAY deliveries.
async function reconcileOutbox(store, config, { dryRun = true, windowMinutes = 180, limit = 500, now = Date.now, log = () => {} } = {}) {
  const since = new Date(now() - Math.max(1, windowMinutes) * 60_000).toISOString();
  const events = await store.listInboundEventsForOutbox({ since, limit });
  const candidates = events.map((event) => ({ event, payload: payloadFromInboundEvent(event) })).filter((c) => c.payload.provider_message_id);
  const keys = candidates.map((c) => deliveryKey(c.payload.provider_event_type === "status" ? "status" : "message", c.payload.provider_message_id, c.payload.status));
  const existing = new Set((await store.findCommunicationDeliveriesByKeys([...new Set(keys)])).map((e) => e.delivery_key));
  const seen = new Set();
  const missing = [];
  candidates.forEach((c, i) => { if (!existing.has(keys[i]) && !seen.has(keys[i])) { seen.add(keys[i]); missing.push({ key: keys[i], ...c }); } });
  const report = { dry_run: dryRun, window_minutes: windowMinutes, scanned_events: events.length, already_queued: existing.size, missing_deliveries: missing.length, enqueued: 0, failed: 0 };
  if (dryRun) return { ...report, would_enqueue: missing.map((m) => ({ delivery_key: m.key.replace(/^(whatsapp:\w+:).*(.{8}(:\w+)?)$/, "$1…$2"), event_type: m.payload.provider_event_type, occurred_at: m.payload.occurred_at })) };
  for (const m of missing) {
    const queued = await enqueueDelivery(store, { payload: m.payload, sourceEventId: m.event.id, mode: "replay", log });
    if (queued.ok && queued.created) report.enqueued++; else if (!queued.ok) report.failed++;
  }
  return report;
}

// Single-event recovery: re-queue (or create) a replay delivery for one stored message and attempt it now.
async function recoverMessage(store, config, { providerMessageId, now, post, log = () => {} }) {
  const events = await store.findInboundEventsByExternalId(providerMessageId);
  const message = events.filter((e) => e.event_type === "message").sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0];
  if (!message) return { ok: false, error: "inbound_event_not_found" };
  const payload = payloadFromInboundEvent(message);
  const queued = await enqueueDelivery(store, { payload, sourceEventId: message.id, mode: "replay", log });
  if (!queued.ok) return { ok: false, error: "enqueue_failed" };
  let entry = queued.entry;
  if (entry.status === "dead" || (entry.status === "pending" && entry.mode !== "replay")) entry = await store.requeueCommunicationDelivery(entry.id, { mode: "replay", now: (now || Date.now)() });
  if (entry.status === "delivered") return { ok: true, delivered: true, already_delivered: true, entry_id: entry.id };
  const outcome = await attemptDelivery(store, config, entry, { timeoutMs: settings(config).workerTimeoutMs, now, post, log });
  return { ok: true, entry_id: entry.id, delivered: Boolean(outcome.delivered), attempts: outcome.attempts || entry.attempts, replay: true, error: outcome.error || outcome.reason || null, source_event_id: message.id, occurred_at: payload.occurred_at };
}

module.exports = { DEFAULTS, settings, deliveryKey, backoffDelayMs, payloadFromInboundEvent, enqueueDelivery, attemptDelivery, enqueueAndAttempt, drainOutbox, startOutboxWorker, reconcileOutbox, recoverMessage, classify, PERMANENT_REASONS };
