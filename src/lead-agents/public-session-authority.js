const { createHmac, randomUUID, timingSafeEqual } = require("node:crypto");
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signature(payload, config) {
  const secret = String(config.sessionSecret || "");
  if (!secret || (config.environment === "production" && secret === "lead-agents-dev-session-secret")) {
    throw Object.assign(new Error("public_session_signing_unavailable"), { statusCode: 503 });
  }
  return createHmac("sha256", secret).update(`oyi-public-v1:${payload}`).digest("base64url");
}
function issuePublicSession(config, session, leadId = null, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ v: 1, sid: session.session_id, lid: leadId, tid: session.conversation_thread_id || null, exp: now + TTL_MS })).toString("base64url");
  return `${payload}.${signature(payload, config)}`;
}
function publicRequestIdentity(config, body, now = Date.now()) {
  const token = body.session_token;
  let claims = { sid: randomUUID(), lid: null, tid: null };
  if (token) {
    try {
      if (typeof token !== "string" || token.length > 2048) throw new Error();
      const [payload, mac, extra] = token.split(".");
      const expected = signature(payload, config);
      if (extra || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new Error();
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (claims.v !== 1 || !Number.isFinite(claims.exp) || claims.exp <= now || claims.exp > now + TTL_MS || typeof claims.sid !== "string" || claims.sid.length > 128) throw new Error();
    } catch {
      throw Object.assign(new Error("invalid_public_session"), { statusCode: 401 });
    }
  }
  const profile = {};
  for (const key of ["name", "email", "phone", "company", "location", "role"]) {
    if (typeof body.profile?.[key] === "string") profile[key] = body.profile[key].trim().slice(0, 240);
  }
  // Only a signed session may select CRM identity or a Core thread.
  return { ...body, profile, session_id: claims.sid, public_session_id: claims.sid,
    lead_id: claims.lid, conversation_thread_id: claims.tid, thread_id: claims.tid,
    contact_ref: null, opportunity_ref: null, form_context_ref: null };
}
module.exports = { issuePublicSession, publicRequestIdentity };
