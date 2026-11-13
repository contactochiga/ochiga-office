"use strict";

// WhatsApp webhook ENVELOPE OBSERVATION (shadow mode, evidence for the Asset Guard). For each AUTHENTICATED (signed) callback it records, as aggregate counts
// only, whether each message and each status event carries the configured WhatsApp Business Account id (entry[].id) and phone-number id
// (value.metadata.phone_number_id): match | mismatch | missing | invalid_type. It reads the parsed body and changes nothing: no filtering, routing,
// acknowledgement, persistence or reply change. It never logs an id, customer data, message ids, payloads, headers, raw errors or credentials.
//   * disabled by default: on only while OFFICE_WHATSAPP_ENVELOPE_OBSERVATION_UNTIL (an ISO timestamp) is in the future and no more than MAX_WINDOW_MS ahead;
//   * bounded: at most LINE_CAP lines per process; reaching the cap logs one explicit "cap reached" line, and every line carries a sequence number, so
//     truncated evidence is visible; observation is skipped (counted, not logged) after that.

const EVENT = "whatsapp_webhook.envelope_observation";
const CAP_EVENT = "whatsapp_webhook.envelope_observation_cap_reached";
const LINE_CAP = 500;
const MAX_WINDOW_MS = 7 * 24 * 3600_000;
const OUTCOMES = Object.freeze(["match", "mismatch", "missing", "invalid_type"]);

const state = { lines: 0, capLogged: false, skippedAfterCap: 0 };

function windowOpen(config, nowMs) {
  const until = Date.parse(String((config && config.whatsappEnvelopeObservationUntil) || ""));
  return Number.isFinite(until) && until > nowMs && until - nowMs <= MAX_WINDOW_MS;
}

function classify(value, expected) {
  if (value === undefined || value === null || value === "") return "missing";
  if (typeof value !== "string") return "invalid_type";
  return value === expected ? "match" : "mismatch";
}

function emptyCounts() {
  const counts = {};
  for (const kind of ["message", "status"]) {
    counts[kind] = { events: 0 };
    for (const o of OUTCOMES) { counts[kind][`waba_${o}`] = 0; counts[kind][`phone_${o}`] = 0; }
  }
  return counts;
}

// Pure: aggregate counts for one parsed callback body. Ids are compared, never copied.
function countEnvelope(body, expectedWaba, expectedPhone) {
  const counts = emptyCounts();
  const entries = body && Array.isArray(body.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change && change.value && typeof change.value === "object" ? change.value : {};
      const waba = classify(entry ? entry.id : undefined, expectedWaba);
      const phone = classify(value.metadata && typeof value.metadata === "object" ? value.metadata.phone_number_id : undefined, expectedPhone);
      for (const [kind, list] of [["message", value.messages], ["status", value.statuses]]) {
        const n = Array.isArray(list) ? list.filter((item) => item && typeof item === "object").length : 0;
        if (!n) continue;
        counts[kind].events += n;
        counts[kind][`waba_${waba}`] += n;
        counts[kind][`phone_${phone}`] += n;
      }
    }
  }
  return counts;
}

// Called by the webhook handler AFTER the signature check passed. Never throws; returns what it did (for tests).
function observe(body, config, { log = () => {}, now = Date.now } = {}) {
  try {
    if (!windowOpen(config, now())) return { observed: false, reason: "window_closed" };
    const expectedWaba = String((config && config.whatsappBusinessAccountId) || "").trim();
    const expectedPhone = String((config && config.whatsappPhoneNumberId) || "").trim();
    if (!expectedWaba || !expectedPhone) return { observed: false, reason: "expected_ids_unconfigured" };
    if (state.lines >= LINE_CAP) {
      state.skippedAfterCap += 1;
      if (!state.capLogged) { state.capLogged = true; log("warn", CAP_EVENT, { cap: LINE_CAP, evidence_truncated: true }); }
      return { observed: false, reason: "cap_reached" };
    }
    const counts = countEnvelope(body, expectedWaba, expectedPhone);
    if (!counts.message.events && !counts.status.events) return { observed: false, reason: "no_events" };
    state.lines += 1;
    log("info", EVENT, { sequence: state.lines, cap: LINE_CAP, message: counts.message, status: counts.status });
    return { observed: true, counts };
  } catch {
    return { observed: false, reason: "observer_error" };
  }
}

function _resetForTests() {
  state.lines = 0; state.capLogged = false; state.skippedAfterCap = 0;
}

module.exports = { EVENT, CAP_EVENT, LINE_CAP, MAX_WINDOW_MS, OUTCOMES, windowOpen, classify, countEnvelope, observe, state, _resetForTests };
