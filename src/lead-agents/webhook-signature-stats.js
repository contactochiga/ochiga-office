"use strict";

// Evidence about Meta webhook signature checks, kept so enforcement can be switched on (and later audited) with proof instead of guesswork.
// Holds counters and timestamps ONLY: no secrets, no signatures, no bodies, no phone numbers. Stored under one runtime-settings key; writes are batched (at most one
// per FLUSH_MS per process) and never block or fail a webhook, so a request flood cannot turn into a database flood.

const STATS_KEY = "whatsapp_webhook_signature_stats";
const FLUSH_MS = 10_000;

const pending = { counts: {}, last_valid_at: null, last_valid_method: null, last_invalid_at: null, last_invalid_reason: null, phone_number_mismatch: 0 };
let lastFlush = 0;
let flushing = false;

function outcomeKey(check) {
  if (check.ok) return check.method === "escaped_unicode" ? "valid_escaped_unicode" : "valid_raw";
  return check.reason || "invalid";
}

function record(check, { mode = "enforce", store = null, now = Date.now(), phoneMismatches = 0 } = {}) {
  const key = outcomeKey(check);
  pending.counts[key] = (pending.counts[key] || 0) + 1;
  const iso = new Date(now).toISOString();
  if (check.ok) { pending.last_valid_at = iso; pending.last_valid_method = check.method || "raw"; } else { pending.last_invalid_at = iso; pending.last_invalid_reason = check.reason || "invalid"; }
  pending.phone_number_mismatch += phoneMismatches;
  if (!store || flushing || now - lastFlush < FLUSH_MS) return;
  flushing = true;
  lastFlush = now;
  flush(store, mode).catch(() => null).finally(() => { flushing = false; });
}

async function flush(store, mode) {
  const row = await store.getRuntimeSetting(STATS_KEY).catch(() => null);
  const previous = row && row.value && typeof row.value === "object" ? row.value : {};
  const counts = { ...(previous.counts || {}) };
  for (const [k, n] of Object.entries(pending.counts)) counts[k] = (counts[k] || 0) + n;
  const value = {
    since: previous.since || new Date().toISOString(),
    mode,
    counts,
    last_valid_at: pending.last_valid_at || previous.last_valid_at || null,
    last_valid_method: pending.last_valid_method || previous.last_valid_method || null,
    last_invalid_at: pending.last_invalid_at || previous.last_invalid_at || null,
    last_invalid_reason: pending.last_invalid_reason || previous.last_invalid_reason || null,
    phone_number_mismatch: (previous.phone_number_mismatch || 0) + pending.phone_number_mismatch,
  };
  pending.counts = {}; pending.phone_number_mismatch = 0;
  await store.setRuntimeSetting(STATS_KEY, value, "webhook-signature-monitor", { history: false });
}

function notePhoneMismatch(count) { pending.phone_number_mismatch += count; }

function resetForTests() { pending.counts = {}; pending.last_valid_at = pending.last_invalid_at = pending.last_valid_method = pending.last_invalid_reason = null; pending.phone_number_mismatch = 0; lastFlush = 0; flushing = false; }

module.exports = { STATS_KEY, record, flush, notePhoneMismatch, resetForTests };
