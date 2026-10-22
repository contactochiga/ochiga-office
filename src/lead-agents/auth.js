const crypto = require("crypto");
const { normalizeEmail } = require("./normalize-lead");
const {
  hasPermission,
  permissionsForRole: unifiedPermissionsForRole,
} = require("./permissions");
const { validateAuthConfig } = require("./auth-config");
const { effectiveGeneration, revocationEnabled, passwordFingerprint } = require("./session-generation");

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

// R8: strict, total cookie parsing. A pair with whitespace inside its name, or a value that is not valid percent-encoding, is ignored (never throws, so a hostile header cannot cause a 5xx).
// A name that appears more than once is AMBIGUOUS: it maps to null, so the outcome never depends on the order the browser (or an attacker) sent them in.
const DUPLICATE = null;
function parseCookies(headerValue) {
  const out = Object.create(null);
  for (const item of String(headerValue || "").split(";")) {
    const piece = item.replace(/^\s+/, "");
    const eqIndex = piece.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = piece.slice(0, eqIndex);
    if (/\s/.test(key)) continue;
    const rawValue = piece.slice(eqIndex + 1).trim();
    let value;
    try { value = decodeURIComponent(rawValue); } catch { value = undefined; }
    if (key in out) { out[key] = DUPLICATE; continue; }
    out[key] = value === undefined ? DUPLICATE : value;
  }
  return out;
}

function sessionSignature(payload, secret) {
  return crypto.createHmac("sha256", String(secret || "")).update(payload).digest("hex");
}

function createAdminSessionToken(adminUser, config, ttlMs, extra = {}) {
  // Settings S7.0: never sign with an invalid/absent secret. The error carries a code only, never configuration detail.
  if (!validateAuthConfig(config).valid) {
    const error = new Error("auth_configuration_invalid");
    error.code = "auth_configuration_invalid";
    error.statusCode = 503;
    throw error;
  }
  const payload = Buffer.from(
    JSON.stringify({
      email: normalizeEmail(adminUser.email),
      role: adminUser.role || "admin",
      user_id: adminUser.id || "",
      permission_scopes: Array.isArray(adminUser.permission_scopes)
        ? adminUser.permission_scopes
        : [],
      exp: Date.now() + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : config.sessionTtlMs),
      // S7.4: the account's session generation at issuance; a revocation increments it and orphans every earlier token.
      ...(revocationEnabled(config) ? { sg: effectiveGeneration(adminUser) } : {}),
      // S7.5.0: fingerprint of the password hash this session was authenticated with. Any later change of the hash, in any order relative to the generation bump, ends the session.
      // S7.5.3: set ONLY after a second factor was verified (mf = 1, mft = when). Absent means "password only".
      ...(extra && Number.isFinite(extra.mfaAt) ? { mf: 1, mft: Math.floor(extra.mfaAt) } : {}),
      // R4: identifies THIS session so a logout can revoke it alone. Random, signed, never returned by any API, logged or stored in the clear (the database holds only a keyed digest).
      ...(extra && typeof extra.sessionId === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(extra.sessionId) ? { sid: extra.sessionId } : {}),
      ...(adminUser.password_hash ? { pf: passwordFingerprint(config, adminUser.password_hash) } : {}),
    })
  ).toString("base64url");
  const signature = sessionSignature(payload, config.sessionSecret);
  return `${payload}.${signature}`;
}

function readAdminSession(req, config) {
  if (!validateAuthConfig(config).valid) {
    return null;
  }
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[config.sessionCookieName];
  if (!rawToken) {
    return null;
  }

  // R1 (F-4): exactly two non-empty segments. A token with trailing segments is malformed, not "close enough".
  const segments = String(rawToken).split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return null;
  }
  const [payload, signature] = segments;

  const expected = sessionSignature(payload, config.sessionSecret);
  if (!secureEqual(expected, signature)) {
    return null;
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  // R8: claim TYPES are part of the contract. Expiry must be a finite number in the future; the identity must be an e-mail AND the account id (a token is bound to an account, never to an
  // e-mail alone); a generation claim, when present, must be an integer. Anything else is a malformed token, not "close enough".
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  if (typeof decoded.email !== "string" || !decoded.email.trim()) return null;
  if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp) || decoded.exp <= Date.now()) return null;
  if (typeof decoded.user_id !== "string" || !decoded.user_id.trim()) return null;
  if (decoded.sg !== undefined && !Number.isInteger(decoded.sg)) return null;
  if (decoded.role !== undefined && typeof decoded.role !== "string") return null;
  if (decoded.permission_scopes !== undefined && !Array.isArray(decoded.permission_scopes)) return null;

  return {
    email: normalizeEmail(decoded.email),
    role: decoded.role || "admin",
    userId: decoded.user_id,
    permissionScopes: Array.isArray(decoded.permission_scopes) ? decoded.permission_scopes.filter((scope) => typeof scope === "string") : [],
    expiresAt: decoded.exp,
    // Settings S7.4: null for a legacy token (no generation claim).
    generation: Number.isInteger(decoded.sg) ? decoded.sg : null,
    // Settings S7.5.0: null for a token issued before password binding existed.
    passwordFingerprint: typeof decoded.pf === "string" && decoded.pf ? decoded.pf : null,
    // Settings S7.5.3: second factor verified at sign-in (absent/0 for password-only and legacy tokens).
    mfa: decoded.mf === 1 && Number.isFinite(decoded.mft),
    mfaAt: decoded.mf === 1 && Number.isFinite(decoded.mft) ? decoded.mft : null,
    // R4: absent for tokens issued before per-session revocation (or while its storage was unavailable): those can only be ended account-wide.
    sessionId: typeof decoded.sid === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(decoded.sid) ? decoded.sid : null,
    // Settings S7.2: identifies THIS session token (never the token itself) so step-up authorisations can be bound to it.
    binding: crypto.createHash("sha256").update(String(rawToken)).digest("hex"),
  };
}

function createSessionCookie(token, config, ttlMs) {
  const effectiveMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : config.sessionTtlMs;
  const maxAgeSeconds = Math.max(60, Math.floor(effectiveMs / 1000));
  const secureFlag = config.environment === "production" ? "; Secure" : "";
  return `${config.sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

// R4: random session identifier and its keyed digest (the only form that is ever stored). The key is derived for this purpose from the session secret.
function newSessionId() { return crypto.randomBytes(16).toString("base64url"); }
function sessionIdDigest(config, sessionId) {
  const key = crypto.createHmac("sha256", String(config.sessionSecret || "")).update("ochiga-office/session-id/v1").digest();
  return crypto.createHmac("sha256", key).update(String(sessionId || "")).digest("hex").slice(0, 32);
}

function clearSessionCookie(config) {
  const secureFlag = config.environment === "production" ? "; Secure" : "";
  return `${config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`;
}

function getApiKey(req) {
  const authHeader = String(req.headers.authorization || "");
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return String(req.headers["x-api-key"] || req.headers["x-office-api-key"] || "").trim();
}

// R8: only a real string is a password. An object with a hostile toString, an array, a number or null must never reach String() (a throw there became a 500 with internal detail).
function passwordText(password) { return typeof password === "string" ? password : ""; }
// R8: Node's scrypt takes the password as a C string, so everything after a NUL byte is IGNORED ("pw" and "pw\u0000x" derive the same key). A NUL is never part of a valid password: it is refused on
// verification (without effect on any real password) and by the password policy on creation.
const hasNul = (password) => typeof password === "string" && password.includes("\u0000");

function hashPassword(password, salt) {
  const actualSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(passwordText(password), actualSalt, 64).toString("hex");
  return `${actualSalt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHash] = String(storedHash || "").split(":");
  if (!salt || !expectedHash) {
    return false;
  }
  if (hasNul(password)) {
    return false;
  }
  const actualHash = crypto.scryptSync(passwordText(password), salt, 64).toString("hex");
  return secureEqual(actualHash, expectedHash);
}


// R1 (F-3): a fixed, well-formed hash with the same cost parameters as real ones. Verifying against it when no account exists makes "unknown account" do the same expensive work as "wrong password",
// so the hash is no longer the difference an observer can time. (Other, much smaller differences remain; this is not a constant-time guarantee.)
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString("hex"));
function verifyPasswordOrDummy(password, storedHash) {
  if (typeof storedHash === "string" && storedHash.includes(":")) return verifyPassword(password, storedHash);
  verifyPassword(password, DUMMY_PASSWORD_HASH);
  return false;
}

function permissionsForRole(role, extraScopes) {
  return unifiedPermissionsForRole(role, extraScopes);
}

function authorizeRole(session, allowedRoles) {
  if (!session) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    return session;
  }
  if (allowedRoles.includes(session.role)) {
    return session;
  }
  const error = new Error("forbidden");
  error.statusCode = 403;
  throw error;
}

function authorizePermission(session, permission) {
  if (!session) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
  if (session.type === "api_key") {
    return session;
  }
  if (hasPermission(session, permission)) {
    return session;
  }
  const error = new Error("forbidden");
  error.statusCode = 403;
  throw error;
}

// Settings S7.5.0: the ONE place a session cookie is read and turned into an auth context. enforceAuth (every protected route) and GET /admin/session/me both use it, and
// both then pass the context through server.js enrichAuthContext (the ONE place live account state is checked). An inventory test fails if another reader appears.
function authenticateSessionCookie(req, config) {
  const session = readAdminSession(req, config);
  if (!session) return null;
  return {
    type: "session",
    email: session.email,
    role: session.role,
    userId: session.userId,
    permissionScopes: session.permissionScopes,
    permissions: permissionsForRole(session.role, session.permissionScopes),
    sessionBinding: session.binding,
    sessionId: session.sessionId,
    sessionExpiresAtMs: session.expiresAt,
    sessionGeneration: session.generation,
    sessionPasswordFingerprint: session.passwordFingerprint,
    sessionMfa: session.mfa,
    sessionMfaAt: session.mfaAt,
    sessionExpiresAt: session.expiresAt,
  };
}

function enforceAuth(req, config) {
  if (config.authMode === "off") {
    return;
  }

  const sessionContext = authenticateSessionCookie(req, config);
  if (sessionContext) {
    return sessionContext;
  }

  const apiKey = getApiKey(req);
  if (config.authMode === "required_api_key") {
    const allowed = config.apiKeys.some((candidate) => secureEqual(candidate, apiKey));
    if (!allowed) {
      const error = new Error("unauthorized");
      error.statusCode = 401;
      throw error;
    }
    return {
      type: "api_key",
      role: "admin",
      permissions: permissionsForRole("admin"),
    };
  }

  if (config.authMode === "optional_api_key" && config.apiKeys.length > 0 && apiKey) {
    const allowed = config.apiKeys.some((candidate) => secureEqual(candidate, apiKey));
    if (!allowed) {
      const error = new Error("unauthorized");
      error.statusCode = 401;
      throw error;
    }
    return {
      type: "api_key",
      role: "admin",
      permissions: permissionsForRole("admin"),
    };
  }

  return null;
}

module.exports = {
  authorizeRole,
  authenticateSessionCookie,
  authorizePermission,
  clearSessionCookie,
  createAdminSessionToken,
  createSessionCookie,
  enforceAuth,
  hashPassword,
  permissionsForRole,
  readAdminSession,
  verifyPassword,
  verifyPasswordOrDummy,
  newSessionId,
  sessionIdDigest,
};
