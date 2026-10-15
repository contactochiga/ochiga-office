const crypto = require("crypto");
const { normalizeEmail } = require("./normalize-lead");
const {
  hasPermission,
  permissionsForRole: unifiedPermissionsForRole,
} = require("./permissions");
const { validateAuthConfig } = require("./auth-config");

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(headerValue) {
  return String(headerValue || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const eqIndex = item.indexOf("=");
      if (eqIndex === -1) {
        return acc;
      }
      const key = item.slice(0, eqIndex).trim();
      const value = item.slice(eqIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function sessionSignature(payload, secret) {
  return crypto.createHmac("sha256", String(secret || "")).update(payload).digest("hex");
}

function createAdminSessionToken(adminUser, config, ttlMs) {
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

  const [payload, signature] = String(rawToken).split(".");
  if (!payload || !signature) {
    return null;
  }

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

  if (!decoded || !decoded.email || !decoded.exp || decoded.exp < Date.now()) {
    return null;
  }

  return {
    email: normalizeEmail(decoded.email),
    role: decoded.role || "admin",
    userId: decoded.user_id || "",
    permissionScopes: Array.isArray(decoded.permission_scopes) ? decoded.permission_scopes : [],
    expiresAt: decoded.exp,
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

function hashPassword(password, salt) {
  const actualSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password || ""), actualSalt, 64).toString("hex");
  return `${actualSalt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHash] = String(storedHash || "").split(":");
  if (!salt || !expectedHash) {
    return false;
  }
  const actualHash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return secureEqual(actualHash, expectedHash);
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

function enforceAuth(req, config) {
  if (config.authMode === "off") {
    return;
  }

  const session = readAdminSession(req, config);
  if (session) {
    return {
      type: "session",
      email: session.email,
      role: session.role,
      userId: session.userId,
      permissionScopes: session.permissionScopes,
      permissions: permissionsForRole(session.role, session.permissionScopes),
      sessionBinding: session.binding,
      sessionExpiresAt: session.expiresAt,
    };
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
  authorizePermission,
  clearSessionCookie,
  createAdminSessionToken,
  createSessionCookie,
  enforceAuth,
  hashPassword,
  permissionsForRole,
  readAdminSession,
  verifyPassword,
};
