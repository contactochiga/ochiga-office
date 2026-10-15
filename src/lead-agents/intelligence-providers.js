"use strict";

// Settings S5: read-only AI provider status. The Backend/IQ-11F gateway owns provider state; Office only bridges and normalises it for display.
// Contract: docs/settings-domain/10_S5_CONTRACT.md. Rules enforced here: strict field whitelist, unknown stays unknown, secret-shaped data is dropped, budget quantities
// stay separate, remaining authorized budget is computed only from verified inputs, and activation is NEVER available in this release.

const PROVIDERS = Object.freeze([
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Google Gemini" },
  { id: "anthropic", label: "Anthropic Claude" },
]);

const ENUMS = Object.freeze({
  gateway_status: ["offline_design_only", "shadow", "live"],
  fallback: ["disabled", "enabled"],
  adapter_mode: ["offline_mock_only", "shadow", "live"],
  adapter_protocol: ["responses", "messages", "generateContent-compatibility-profile"],
  credentials: ["not_provisioned", "provisioned_unverified", "verified"],
  model: ["none_selected", "candidate", "approved"],
  qualification: ["not_started", "preparation", "in_progress", "qualified", "failed"],
  operating_mode: ["off", "offline_mock_only", "shadow", "live"],
  enforcement: ["none", "designed", "tested", "verified"],
  data_processing: ["not_reviewed", "pending", "approved", "rejected"],
});

const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{10,}|Bearer\s+\S{8,}|-----BEGIN|\b(?![0-9a-f]{40}\b)[A-Za-z0-9+/]{40,}\b)/;
const MAX_TEXT = 200;
const MAX_LIST = 12;

function makeCleaner() {
  const state = { redactions: 0 };
  const str = (v, max = MAX_TEXT) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t) return null;
    if (SECRET_VALUE.test(t)) { state.redactions += 1; return null; }
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const oneOf = (v, allowed) => (typeof v === "string" && allowed.includes(v) ? v : "unknown");
  const bool = (v) => (typeof v === "boolean" ? v : null);
  const money = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9 ? Math.round(v * 100) / 100 : null);
  const iso = (v) => { if (typeof v !== "string") return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
  const list = (v, max = MAX_LIST, len = MAX_TEXT) => (Array.isArray(v) ? v.slice(0, max).map((x) => str(x, len)).filter(Boolean) : []);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return { state, str, oneOf, bool, money, iso, list, obj };
}

function emptyProvider(def) {
  return {
    id: def.id, label: def.label, reported: false,
    adapter: { registered: null, version: null, protocol: "unknown", mode: "unknown" },
    credentials: { status: "unknown", verified_at: null, reference_recorded: null },
    model: { approved_model: null, candidates: [], status: "unknown" },
    qualification: { status: "unknown", scope: null, evidence_ref: null, verified_at: null },
    operating_mode: "unknown",
    budget: { currency: null, approved_maximum: null, approval_ref: null, approved_at: null, verified_credits: null, credits_verified_at: null, verified_spend: null, spend_verified_at: null, enforcement: "unknown", remaining_authorized: null, remaining_basis: "unknown" },
    data_processing: { status: "unknown", reviewed_at: null, approval_ref: null },
    activation: { contract_available: null, activated: null },
    last_verified_at: null, limitations: [],
  };
}

function normalizeProvider(def, raw, c) {
  const r = c.obj(raw);
  const a = c.obj(r.adapter), cr = c.obj(r.credentials), m = c.obj(r.model), q = c.obj(r.qualification), b = c.obj(r.budget), dp = c.obj(r.data_processing), act = c.obj(r.activation);
  const currency = c.str(b.currency, 8);
  const out = {
    id: def.id, label: def.label, reported: true,
    adapter: { registered: c.bool(a.registered), version: c.str(a.version, 40), protocol: c.oneOf(a.protocol, ENUMS.adapter_protocol), mode: c.oneOf(a.mode, ENUMS.adapter_mode) },
    credentials: { status: c.oneOf(cr.status, ENUMS.credentials), verified_at: c.iso(cr.verified_at), reference_recorded: c.bool(cr.reference_recorded) }, // a reference is reduced to a boolean, never shown
    model: { approved_model: c.str(m.approved_model, 80), candidates: c.list(m.candidates, 6), status: c.oneOf(m.status, ENUMS.model) },
    qualification: { status: c.oneOf(q.status, ENUMS.qualification), scope: c.str(q.scope), evidence_ref: c.str(q.evidence_ref, 80), verified_at: c.iso(q.verified_at) },
    operating_mode: c.oneOf(r.operating_mode, ENUMS.operating_mode),
    budget: {
      currency, approved_maximum: c.money(b.approved_maximum), approval_ref: c.str(b.approval_ref, 80), approved_at: c.iso(b.approved_at),
      verified_credits: c.money(b.verified_credits), credits_verified_at: c.iso(b.credits_verified_at), verified_spend: c.money(b.verified_spend), spend_verified_at: c.iso(b.spend_verified_at),
      enforcement: c.oneOf(c.obj(b.enforcement).status, ENUMS.enforcement), remaining_authorized: null, remaining_basis: "unknown",
    },
    data_processing: { status: c.oneOf(dp.status, ENUMS.data_processing), reviewed_at: c.iso(dp.reviewed_at), approval_ref: c.str(dp.approval_ref, 80) },
    activation: { contract_available: c.bool(act.contract_available), activated: c.bool(act.activated) },
    last_verified_at: c.iso(r.last_verified_at), limitations: c.list(r.limitations, 8),
  };
  // A figure without a currency cannot be interpreted: treat the whole money group as unknown rather than guessing.
  if (!currency) for (const k of ["approved_maximum", "verified_credits", "verified_spend"]) out.budget[k] = null;
  // Remaining authorized budget: computed here, only from a verified expenditure AND an approved maximum. Never from credits, never from the ceiling alone,
  // and a value supplied by the Backend is ignored.
  if (out.budget.approved_maximum !== null && out.budget.verified_spend !== null) {
    out.budget.remaining_authorized = Math.max(0, Math.round((out.budget.approved_maximum - out.budget.verified_spend) * 100) / 100);
    out.budget.remaining_basis = "approved_maximum_minus_verified_spend";
  }
  return out;
}

const met = (ok, known) => (!known ? "unknown" : ok ? "met" : "not_met");

// Derived strictly from provider state. Informational: activation is never available in this release, whatever the result.
function activationReadiness(p) {
  const contract = p.activation.contract_available;
  const qualifiedKnown = p.qualification.status !== "unknown" || p.model.status !== "unknown";
  const credStatus = p.credentials.status, dpStatus = p.data_processing.status, enfStatus = p.budget.enforcement;
  return [
    { key: "activation_contract", label: "Backend-owned activation contract", status: contract === null ? "unknown" : contract ? "met" : "not_met" },
    { key: "qualified_model", label: "Qualified provider and model", status: met(p.qualification.status === "qualified" && p.model.status === "approved" && Boolean(p.model.approved_model), qualifiedKnown) },
    { key: "data_processing", label: "Approved data-processing policy", status: met(dpStatus === "approved", dpStatus !== "unknown") },
    { key: "credentials", label: "Verified credentials", status: met(credStatus === "verified", credStatus !== "unknown") },
    { key: "budget_enforcement", label: "Budget enforcement", status: met(enfStatus === "verified", enfStatus !== "unknown") },
    { key: "administrator_authority", label: "Current administrator authority", status: "deferred" },
    { key: "audit_logging", label: "Audit logging of the activation", status: contract === null ? "unknown" : "not_met" },
    { key: "explicit_confirmation", label: "Explicit confirmation", status: "not_met" },
  ];
}

function buildProviderStatusResponse(result, config = {}) {
  const fetchedAt = new Date().toISOString();
  const office_local = {
    openai: { assistant_configured: Boolean(config.openaiApiKey), assistant_model: config.openaiApiKey ? (String(config.openaiModel || "").slice(0, 80) || null) : null, note: "Office assistant (legacy path). This is not an Oyi Core interpretation qualification." },
    gemini: { assistant_configured: false, assistant_model: null, note: "No Office configuration exists for this provider." },
    anthropic: { assistant_configured: false, assistant_model: null, note: "No Office configuration exists for this provider." },
  };
  const activation = { available: false, note: "Provider activation is not available in Office in this release. Connected does not mean qualified; qualified does not mean activated." };
  const skeleton = { generated_at: fetchedAt, office_local, activation, providers: PROVIDERS.map((def) => ({ ...emptyProvider(def), readiness: activationReadiness(emptyProvider(def)) })), gateway: null, provenance: [], redaction_applied: 0 };
  if (!result || !result.ok) {
    // Classify, never echo: the Backend's own error text is not shown. 401/403 mean the bridge credential or permission was refused.
    const status = result && Number(result.status);
    const raw = result && result.reason;
    const reason = status === 404 ? "endpoint_not_available" : status === 401 || status === 403 ? "backend_rejected" : status >= 500 ? "backend_error" : raw === "not_configured" || raw === "network_error" ? raw : status >= 400 ? "backend_rejected" : "unavailable";
    return { ok: false, available: false, reason, ...skeleton };
  }
  const c = makeCleaner();
  const body = c.obj(result.data);
  const g = c.obj(body.gateway);
  const reported = new Map(Array.isArray(body.providers) ? body.providers.filter((x) => x && typeof x === "object").map((x) => [x.id, x]) : []);
  const providers = PROVIDERS.map((def) => { const p = reported.has(def.id) ? normalizeProvider(def, reported.get(def.id), c) : emptyProvider(def); return { ...p, readiness: activationReadiness(p) }; });
  const provenance = (Array.isArray(body.provenance) ? body.provenance.slice(0, 12) : []).map((x) => { const o = c.obj(x); return { group: c.str(o.group, 40), source_record: c.str(o.source_record, 120), recorded_at: c.iso(o.recorded_at), conflicts: c.list(o.conflicts, 6, 400) }; });
  return {
    ok: true, available: true, reason: null, ...skeleton, providers, provenance,
    source: { schema_version: Number.isInteger(body.schema_version) ? body.schema_version : null, generated_at: c.iso(body.generated_at) },
    gateway: { status: c.oneOf(g.status, ENUMS.gateway_status), live_transport_implemented: c.bool(g.live_transport_implemented), paid_inference_enabled: c.bool(g.paid_inference_enabled), cross_provider_fallback: c.oneOf(g.cross_provider_fallback, ENUMS.fallback), approved_cross_provider_transfers: c.list(g.approved_cross_provider_transfers, 6) },
    redaction_applied: c.state.redactions,
  };
}

module.exports = { PROVIDERS, ENUMS, buildProviderStatusResponse, normalizeProvider, activationReadiness, emptyProvider, SECRET_VALUE };
