"use strict";

// Governed Settings API (Settings S3): GET /admin/settings, GET|PUT /admin/settings/:key, GET /admin/settings/:key/history.
// Contract: docs/settings-domain/06_S3_REGISTRY_CONTRACT.md. Delegated settings (WhatsApp autonomy, Corporate Letterhead) are readable here but are written only through
// their existing routes, so their validation, confirmation and audit stay in one place.

const { describeEntry, historyValue, publicValue } = require("./settings-registry");

const ROUTE = /^\/api\/lead-agents\/admin\/settings(?:\/([a-z][a-z0-9_.]{0,79}))?(?:\/(history))?$/;

function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function handleSettingsRequest({ req, res, pathname, authContext, store, registry, ctx, deps }) {
  const match = pathname.match(ROUTE);
  if (!match) return false;
  const { json, readJsonBody, appendAuditRecord, authorizePermission } = deps;
  const [, key, sub] = match;
  const headers = { "x-request-id": ctx.requestId };
  const send = (status, payload) => json(res, status, payload, headers);
  const can = (permission) => { if (!permission) return false; try { authorizePermission(authContext, permission); return true; } catch { return false; } };
  const actor = String(authContext?.email || "").trim();
  const audit = (action, resourceId, status, metadata) => appendAuditRecord({ store, authContext, action, resourceType: "setting", resourceId, metadata: { request_id: ctx.requestId, ...metadata }, req, status }).catch(() => null);

  // ---- list ----
  if (!key) {
    if (req.method !== "GET") { send(405, { error: "method_not_allowed", allow: "GET" }); return true; }
    if (!can("office.read")) { send(403, { error: "forbidden" }); return true; }
    const visible = registry.list().filter((d) => can(d.read_permission));
    const settings = await Promise.all(visible.map((d) => describeEntry(d, store, can)));
    send(200, { settings, count: settings.length });
    return true;
  }

  const descriptor = registry.get(key);

  // ---- history ----
  if (sub === "history") {
    if (req.method !== "GET") { send(405, { error: "method_not_allowed", allow: "GET" }); return true; }
    if (!descriptor) { send(404, { error: "unknown_setting" }); return true; }
    if (!can(descriptor.read_permission)) { send(403, { error: "forbidden" }); return true; }
    const url = new URL(req.url, "http://office.local");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    let result;
    try { result = await store.listRuntimeSettingHistory(descriptor.key, { limit }); } catch (error) { send(503, { error: "history_unavailable" }); return true; }
    const rows = (result.rows || []).map((r) => ({ version: r.version, previous_value: descriptor.sensitive ? historyValue(descriptor, r.previous_value) : r.previous_value, new_value: descriptor.sensitive ? historyValue(descriptor, r.new_value) : r.new_value, actor: r.actor, request_id: r.request_id, outcome: r.outcome, reason: r.reason, created_at: r.created_at }));
    send(200, { key: descriptor.key, supported: Boolean(result.supported) && descriptor.mode !== "mirror" && descriptor.key !== "office_letterhead_config", history: rows });
    return true;
  }

  // ---- read one ----
  if (req.method === "GET") {
    if (!descriptor) { send(404, { error: "unknown_setting" }); return true; }
    if (!can(descriptor.read_permission)) { send(403, { error: "forbidden" }); return true; }
    send(200, { setting: await describeEntry(descriptor, store, can) });
    return true;
  }

  if (req.method !== "PUT") { send(405, { error: "method_not_allowed", allow: "GET,PUT" }); return true; }

  // ---- write ----
  // 1. actor identity: API-key sessions pass permission checks but carry no accountable person, so they can never change a setting.
  if (!actor) {
    await audit("settings.write_rejected", key, "failure", { setting_key: key, outcome: "denied", reason: "actor_identity_required" });
    send(403, { error: "actor_identity_required" });
    return true;
  }
  // 2. known key
  if (!descriptor) {
    await audit("settings.write_rejected", key, "failure", { setting_key: key, outcome: "rejected", reason: "unknown_setting" });
    send(404, { error: "unknown_setting" });
    return true;
  }
  const attempt = (outcome, reason, attempted) => (descriptor.mode === "generic" ? store.recordRuntimeSettingAttempt({ key: descriptor.key, actor, requestId: ctx.requestId, outcome, reason, attempted, redact: descriptor.sensitive }).catch(() => null) : null);
  const fail = async (status, error, outcome, extra = {}, attempted) => {
    await attempt(outcome, error, attempted);
    await audit(descriptor.audit_action || "settings.write_rejected", descriptor.key, "failure", { setting_key: descriptor.key, outcome, reason: error, actor });
    send(status, { error, ...extra });
    return true;
  };
  // 3. ownership / mode
  if (descriptor.mode === "delegated") return fail(405, "use_dedicated_endpoint", "rejected", { route: descriptor.delegated_route.path, methods: descriptor.delegated_route.methods, detail: "This setting is changed only through its dedicated, audited endpoint." });
  if (descriptor.mode !== "generic" || descriptor.owner !== "office") return fail(403, "read_only_setting", "rejected", { owner: descriptor.owner, detail: `This setting is owned by ${descriptor.owner} and is read-only in Office.` });
  // 4. permission
  if (!can(descriptor.write_permission)) return fail(403, "forbidden", "denied", { required_permission: descriptor.write_permission });
  // 5. body
  let body;
  try { body = await readJsonBody(req); } catch { return fail(400, "invalid_json", "rejected"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, "value")) return fail(400, "value_required", "rejected");
  if (!Number.isInteger(body.expected_version) || body.expected_version < 0) return fail(400, "expected_version_required", "rejected", { detail: "expected_version must be the version you last read (0 if the setting has never been saved)." }, body.value);
  // 6. value
  const checked = descriptor.validator(body.value);
  if (!checked.ok) return fail(400, "invalid_value", "rejected", { detail: checked.error }, body.value);
  // 7. confirmation
  if (descriptor.requires_confirmation && body.confirm !== true) return fail(400, "confirmation_required", "rejected", { detail: "This change must be explicitly confirmed (confirm: true)." }, checked.value);
  // 8. atomic compare-and-set + history
  let result;
  try {
    result = await store.writeRuntimeSetting(descriptor.key, checked.value, actor, { expectedVersion: body.expected_version, requestId: ctx.requestId, redact: descriptor.sensitive });
  } catch (error) {
    const unavailable = error && error.code === "versioning_unavailable";
    await audit(descriptor.audit_action, descriptor.key, "failure", { setting_key: descriptor.key, outcome: "failed", reason: unavailable ? "versioning_unavailable" : String(error?.message || error).slice(0, 160), actor });
    send(503, unavailable ? { error: "settings_versioning_unavailable", detail: "Setting versioning is not installed. Nothing was changed." } : { error: "setting_not_saved", detail: "The setting could not be saved. Nothing was changed." });
    return true;
  }
  if (result.status === "conflict") {
    const cur = result.current;
    await audit(descriptor.audit_action, descriptor.key, "failure", { setting_key: descriptor.key, outcome: "conflict", expected_version: body.expected_version, current_version: cur ? cur.version : 0, actor });
    send(409, { error: "version_conflict", detail: "The setting changed since you loaded it. Review the current value and try again.", current: { value: cur ? publicValue(descriptor, cur.value) : publicValue(descriptor, descriptor.default), version: cur ? cur.version : 0, updated_by: cur ? cur.updated_by : null, updated_at: cur ? cur.updated_at : null } });
    return true;
  }
  const changed = !result.previous || !sameValue(result.previous.value, result.current.value);
  await audit(descriptor.audit_action, descriptor.key, "success", { setting_key: descriptor.key, outcome: "success", version: result.current.version, previous_version: result.previous ? result.previous.version : 0, old_value: result.previous ? historyValue(descriptor, result.previous.value) : null, new_value: historyValue(descriptor, result.current.value), changed, reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined, actor });
  // server-confirmed: report what is stored now, not what was requested
  send(200, { setting: await describeEntry(descriptor, store, can), changed });
  return true;
}

module.exports = { handleSettingsRequest, ROUTE };
