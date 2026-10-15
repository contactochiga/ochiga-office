"use strict";

// Settings S4: allowlisted, bounded integration connection tests and DRY-RUN-ONLY diagnostics. Contract: docs/settings-domain/08_S4_CONTRACT.md.
// Safety model: nothing the caller sends can reach the network or switch an operation out of dry-run. Targets and credentials come from server configuration,
// dry-run is a literal `true` in this file, and the apply paths (reconcile, recover, retry, repair) are never called from here.

const TEST_ROUTE = /^\/api\/lead-agents\/admin\/settings\/integrations\/([^/]+)\/test$/;
const OPS_ROUTE = /^\/api\/lead-agents\/admin\/settings\/operations\/(outbox\/reconcile-preview|visibility\/repair-preview)$/;
const TESTABLE = Object.freeze(["backend", "facility", "consumer", "digital_twin"]);
const LABELS = Object.freeze({ backend: "Oyi Backend control plane", facility: "Oyi Facility API", consumer: "Consumer Smart Building API", digital_twin: "Oyi Digital Twin binding" });
const SAMPLE_LIMIT = 10;
const lastTestAt = new Map();

const tail = (value, n = 8) => { const s = String(value || ""); return s.length > n ? `…${s.slice(-n)}` : s; };
const sendJson = (deps, res, ctx, status, payload) => deps.json(res, status, payload, { "x-request-id": ctx.requestId });

function categoriseError(probe) {
  const e = String(probe.error || "");
  if (/timeout|ETIMEDOUT|ECONNABORTED|aborted/i.test(e)) return "timeout";
  if (/ECONNREFUSED/i.test(e)) return "connection_refused";
  if (/ENOTFOUND|EAI_AGAIN/i.test(e)) return "dns_failure";
  if (probe.http_status && probe.http_status >= 400) return `http_${probe.http_status}`;
  return probe.ok ? null : "request_failed";
}

// Build the (only) request this key may make from server configuration. Returns null when the integration is not configured.
function probePlan(key, config, deps) {
  if (key === "backend") {
    if (!config.officeBackendBaseUrl) return null;
    return { baseUrl: config.officeBackendBaseUrl, path: "/health", headers: config.officeBackendApiKey ? { "x-api-key": config.officeBackendApiKey } : {} };
  }
  if (key === "facility" || key === "consumer") {
    const prefix = key === "facility" ? "officeFacility" : "officeConsumer";
    const hasAuth = Boolean(config[`${prefix}ApiKey`] || config[`${prefix}BearerToken`]);
    if (!config[`${prefix}BaseUrl`] || !hasAuth) return null;
    return { baseUrl: config[`${prefix}BaseUrl`], path: config[`${prefix}ExportPath`] || "/office/export", headers: deps.authHeadersFromConfig(config, prefix) };
  }
  if (key === "digital_twin") {
    if (!config.officeDigitalTwinBaseUrl) return { inProcess: true };
    return { baseUrl: config.officeDigitalTwinBaseUrl, path: "/api/digital-twin/scene", headers: config.officeDigitalTwinApiKey ? { "x-api-key": config.officeDigitalTwinApiKey } : {} };
  }
  return null;
}

async function runConnectionTest(key, config, deps, now = Date.now) {
  const checkedAt = new Date(now()).toISOString();
  const base = { integration: key, label: LABELS[key], checked_at: checkedAt };
  const plan = probePlan(key, config, deps);
  if (plan && plan.inProcess) return { ...base, kind: "in_process", verification: "in_process_binding", available: Boolean(deps.digitalTwinRuntime), reachable: null, http_status: null, latency_ms: null, error: null, note: "Served by this process. No network probe was made." };
  if (!plan) return { ...base, kind: "not_configured", verification: "not_configured", reachable: null, http_status: null, latency_ms: null, error: null, note: "Not configured. No request was made." };
  const timeoutMs = Math.min(Math.max(Number(config.settingsProbeTimeoutMs) || 3500, 100), 5000);
  const started = Date.now();
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve({ checked: true, ok: false, status: "failed", error: "timeout" }), timeoutMs + 500); });
  const probe = await Promise.race([deps.probeEndpoint(plan.baseUrl, plan.path, { headers: plan.headers, timeoutMs }), guard]).finally(() => clearTimeout(timer));
  const error = categoriseError(probe);
  // the probe payload, URL and headers are deliberately dropped here
  return { ...base, kind: "network_probe", verification: "health_probe", reachable: Boolean(probe.ok), http_status: probe.http_status || null, latency_ms: Date.now() - started, error, note: probe.ok ? "The health probe answered." : "The health probe did not succeed." };
}

function shapeReconcile(r) {
  return { dry_run: true, window_minutes: r.window_minutes, scanned_events: r.scanned_events, already_queued: r.already_queued, missing_deliveries: r.missing_deliveries, would_enqueue_sample: (r.would_enqueue || []).slice(0, SAMPLE_LIMIT).map((w) => ({ delivery_key: w.delivery_key, event_type: w.event_type, occurred_at: w.occurred_at || null })), sample_truncated: (r.would_enqueue || []).length > SAMPLE_LIMIT };
}
function shapeRepair(r) {
  return {
    dry_run: true, raw_event_rows: r.raw_event_rows, distinct_provider_ids: r.distinct_provider_ids, already_represented_messages: r.already_represented_messages, raw_missing_event_rows: r.raw_missing_event_rows, unique_missing_messages: r.unique_missing_messages,
    duplicate_event_rows: r.duplicate_event_rows, invalid_records: r.invalid_records, conflicting_lead_groups: r.conflicting_lead_groups, proposed_activities: r.proposed_activities,
    proposed_sample: (r.would_create_for || []).slice(0, SAMPLE_LIMIT).map((w) => ({ provider_message_id: tail(w.provider_message_id), lead: tail(w.lead_id, 6), occurred_at: w.occurred_at || null })),
    conflicts_sample: (r.conflicts || []).slice(0, SAMPLE_LIMIT).map((c) => ({ provider_message_id: tail(c.provider_message_id), lead_count: (c.lead_ids || []).length })),
    invalid_sample: (r.invalid || []).slice(0, SAMPLE_LIMIT).map((c) => ({ provider_message_id: tail(c.provider_message_id), reason: c.reason })),
    sample_truncated: (r.would_create_for || []).length > SAMPLE_LIMIT,
  };
}

const clampInt = (value, min, max, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback; };

async function handleSettingsOperations({ req, res, pathname, authContext, store, config, ctx, deps }) {
  const testMatch = pathname.match(TEST_ROUTE);
  const opsMatch = testMatch ? null : pathname.match(OPS_ROUTE);
  if (!testMatch && !opsMatch) return false;
  const send = (status, payload) => sendJson(deps, res, ctx, status, payload);
  if (req.method !== "POST") { send(405, { error: "method_not_allowed", allow: "POST" }); return true; }
  const actor = String(authContext?.email || "").trim();
  const audit = (action, resourceType, resourceId, status, metadata) => deps.appendAuditRecord({ store, authContext, action, resourceType, resourceId, metadata: { request_id: ctx.requestId, via: "settings", ...metadata }, req, status }).catch(() => null);
  const rejectedAction = "settings.operation_rejected";
  const resource = testMatch ? "integration" : "settings_operation";
  const target = testMatch ? (() => { try { return decodeURIComponent(testMatch[1]).slice(0, 64); } catch { return "invalid"; } })() : opsMatch[1];

  // identity + permission are checked before anything else, so an unauthorised caller learns nothing about keys or bodies
  if (!actor) { await audit("settings.operation_denied", resource, target, "failure", { reason: "actor_identity_required" }); send(403, { error: "actor_identity_required" }); return true; }
  let permitted = true; try { deps.authorizePermission(authContext, "manage_integrations"); } catch { permitted = false; }
  if (!permitted) { await audit("settings.operation_denied", resource, target, "failure", { reason: "forbidden", actor }); send(403, { error: "forbidden", required_permission: "integrations.manage" }); return true; }

  let body;
  try { body = await deps.readJsonBody(req, 16 * 1024); } catch { await audit(rejectedAction, resource, target, "failure", { reason: "invalid_json", actor }); send(400, { error: "invalid_json" }); return true; }
  if (body === null || typeof body !== "object" || Array.isArray(body)) { await audit(rejectedAction, resource, target, "failure", { reason: "invalid_body", actor }); send(400, { error: "invalid_body" }); return true; }
  const bodyKeys = Object.keys(body);

  // ---- connection test ----
  if (testMatch) {
    const key = target;
    if (!TESTABLE.includes(key)) { await audit(rejectedAction, "integration", key, "failure", { reason: "unknown_integration", actor }); send(404, { error: "unknown_integration" }); return true; }
    if (bodyKeys.length) { await audit(rejectedAction, "integration", key, "failure", { reason: "unexpected_fields", fields: bodyKeys.slice(0, 10), actor }); send(400, { error: "unexpected_fields", detail: "This endpoint accepts no body. The target is fixed by server configuration." }); return true; }
    const now = Date.now(); const minGap = Number.isFinite(Number(config.settingsProbeMinIntervalMs)) ? Number(config.settingsProbeMinIntervalMs) : 3000;
    if (now - (lastTestAt.get(key) || 0) < minGap) { send(429, { error: "too_soon", retry_after_ms: minGap - (now - (lastTestAt.get(key) || 0)) }); return true; }
    lastTestAt.set(key, now);
    let result;
    try { result = await runConnectionTest(key, config, deps); } catch (error) { await audit("settings.integration_test", "integration", key, "failure", { outcome: "failed", actor }); send(503, { error: "test_failed" }); return true; }
    await audit("settings.integration_test", "integration", key, result.reachable === false ? "failure" : "success", { integration: key, kind: result.kind, outcome: result.reachable === false ? "unreachable" : result.kind === "not_configured" ? "not_configured" : "ok", http_status: result.http_status, latency_ms: result.latency_ms, error: result.error, actor });
    send(200, { test: result });
    return true;
  }

  // ---- dry-run-only operations ----
  const allowed = new Set(["window_minutes", "limit", "dry_run"]);
  const forged = bodyKeys.filter((k) => !allowed.has(k));
  if (Object.prototype.hasOwnProperty.call(body, "dry_run") && body.dry_run !== true) {
    await audit(rejectedAction, "settings_operation", target, "failure", { reason: "dry_run_only", attempted_dry_run: String(body.dry_run).slice(0, 12), actor });
    send(400, { error: "dry_run_only", detail: "Settings can only preview. Applying changes is available through the administrator API, not from Settings." });
    return true;
  }
  if (forged.length) {
    await audit(rejectedAction, "settings_operation", target, "failure", { reason: "unexpected_fields", fields: forged.slice(0, 10), actor });
    send(400, { error: forged.some((k) => /apply|replay|force|confirm|mode|recover|retry|execute|dryrun/i.test(k)) ? "dry_run_only" : "unexpected_fields", detail: "Settings can only preview. Applying changes is available through the administrator API, not from Settings." });
    return true;
  }
  try {
    if (opsMatch[1] === "outbox/reconcile-preview") {
      const windowMinutes = clampInt(body.window_minutes, 1, 10080, 180); const limit = clampInt(body.limit, 1, 2000, 500);
      const raw = await deps.communicationOutbox.reconcileOutbox(store, config, { dryRun: true, windowMinutes, limit, log: deps.log });
      const shaped = shapeReconcile(raw);
      await audit("communication.outbox.reconcile", "communication_outbox", "reconcile", "success", { dry_run: true, enforced_dry_run: true, scanned_events: shaped.scanned_events, missing_deliveries: shaped.missing_deliveries, enqueued: 0, operator: actor, actor });
      send(200, { ok: true, enforced: "server", ...shaped });
    } else {
      const limit = clampInt(body.limit, 1, 2000, 1000);
      const raw = await deps.inboundVisibility.repairInboundVisibility(store, { dryRun: true, limit, log: deps.log });
      const shaped = shapeRepair(raw);
      await audit("whatsapp.inbound_visibility.dry_run", "whatsapp_inbound", "inbound_events", "success", { dry_run: true, enforced_dry_run: true, raw_missing_event_rows: shaped.raw_missing_event_rows, unique_missing_messages: shaped.unique_missing_messages, created: 0, operator: actor, actor });
      send(200, { ok: true, enforced: "server", ...shaped });
    }
  } catch (error) {
    await audit(rejectedAction, "settings_operation", target, "failure", { reason: "preview_failed", detail: String(error?.message || error).slice(0, 120), actor });
    send(503, { error: "preview_failed", detail: "The preview could not be computed. Nothing was changed." });
  }
  return true;
}

module.exports = { handleSettingsOperations, runConnectionTest, TESTABLE, TEST_ROUTE, OPS_ROUTE, shapeReconcile, shapeRepair, _resetRateLimit: () => lastTestAt.clear() };
