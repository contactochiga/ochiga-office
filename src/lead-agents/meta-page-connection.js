"use strict";

const crypto = require("crypto");
const axios = require("axios");

const CONNECTION_KEY = "office_meta_page_connection_v1";
const PENDING_PREFIX = "office_meta_oauth_candidates_v1:";
const STATE_COOKIE = "office_meta_oauth_state";
const REQUIRED_PERMISSIONS = Object.freeze(["pages_show_list", "pages_manage_metadata"]);
const REQUESTED_PERMISSIONS = Object.freeze([
  "pages_show_list", "pages_manage_metadata", "pages_messaging", "instagram_basic", "instagram_manage_messages",
]);
const PAGE_WEBHOOK_FIELDS = Object.freeze(["messages", "message_deliveries", "message_reads"]);
const MAX_AGE_MS = 10 * 60 * 1000;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
  }
  return "";
}

function tokenKey(config) {
  const encoded = String(config.metaTokenEncryptionKey || "").trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  let key;
  try { key = Buffer.from(encoded, "base64"); } catch { return null; }
  return key.length === 32 && key.toString("base64") === encoded ? key : null;
}

function encryptToken(value, config) {
  const key = tokenKey(config);
  if (!key) throw new Error("meta_token_encryption_not_configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

function decryptToken(envelope, config) {
  const key = tokenKey(config);
  if (!key || !envelope || envelope.v !== 1) throw new Error("meta_token_decryption_failed");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new Error("meta_token_decryption_failed"); }
}

function redirectUri(config) {
  const value = String(config.metaOAuthRedirectUri || "").trim();
  if (!value) throw new Error("meta_oauth_redirect_not_configured");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("meta_oauth_redirect_invalid"); }
  if (parsed.protocol !== "https:" && !(config.environment !== "production" && parsed.hostname === "localhost")) {
    throw new Error("meta_oauth_redirect_must_use_https");
  }
  if (parsed.pathname !== "/api/lead-agents/admin/meta/oauth/callback" || parsed.search || parsed.hash) {
    throw new Error("meta_oauth_redirect_path_invalid");
  }
  return parsed.toString();
}

function graphBase(config) {
  if (!/^v\d+\.\d+$/.test(config.metaSocialGraphVersion || "")) throw new Error("meta_graph_version_not_configured");
  return `https://graph.facebook.com/${config.metaSocialGraphVersion}`;
}

function makeState(config, actorId, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ n: crypto.randomBytes(24).toString("base64url"), a: String(actorId), i: now })).toString("base64url");
  const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(state, cookie, config, actorId, now = Date.now()) {
  if (!state || !cookie || !safeEqual(state, cookie)) return null;
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded.n || decoded.a !== String(actorId) || !Number.isFinite(decoded.i) || now - decoded.i < 0 || now - decoded.i > MAX_AGE_MS) return null;
    return decoded;
  } catch { return null; }
}

function stateCookie(state, config) {
  const secure = ["development", "test"].includes(config.environment) ? "" : "; Secure";
  return `${STATE_COOKIE}=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/api/lead-agents/admin/meta/oauth/callback; Max-Age=600${secure}`;
}

function clearStateCookie(config) {
  const secure = ["development", "test"].includes(config.environment) ? "" : "; Secure";
  return `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/lead-agents/admin/meta/oauth/callback; Max-Age=0${secure}`;
}

function createMetaPageConnection({ config, store, http = axios, now = () => Date.now() }) {
  const safePage = (page) => ({
    id: String(page.id), name: String(page.name || "Facebook Page").slice(0, 200),
    tasks: Array.isArray(page.tasks) ? page.tasks.filter((task) => typeof task === "string").slice(0, 30) : [],
    instagram: (page.instagram_business_account || page.instagram) ? {
      id: String((page.instagram_business_account || page.instagram).id || ""),
      username: String((page.instagram_business_account || page.instagram).username || "").slice(0, 100),
    } : null,
  });
  const callGraph = async (method, path, { params = {}, token } = {}) => {
    let response;
    try {
      response = await http({
        method, url: `${graphBase(config)}/${path}`, params,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        timeout: 10000, maxRedirects: 0, validateStatus: () => true,
      });
    } catch {
      const error = new Error("meta_graph_unavailable");
      error.safeCode = "meta_graph_unavailable";
      throw error;
    }
    if (response.status < 200 || response.status >= 300 || response.data?.error) {
      const rawCode = String(response.data?.error?.code || "");
      const code = /^\d{1,8}$/.test(rawCode) ? rawCode : "";
      const error = new Error("meta_graph_request_failed");
      error.safeCode = code ? `meta_graph_${code}` : `meta_graph_http_${response.status}`;
      error.httpStatus = response.status;
      throw error;
    }
    return response.data;
  };
  const pendingKey = (actorId, reference) => `${PENDING_PREFIX}${crypto.createHash("sha256").update(`${actorId}:${reference}`).digest("hex")}`;

  async function begin(actorId) {
    if (!config.metaAppId || !config.metaAppSecret) throw new Error("meta_app_not_configured");
    if (config.environment === "production" && (String(config.sessionSecret || "").length < 32 || config.sessionSecret === "lead-agents-dev-session-secret")) throw new Error("meta_oauth_session_secret_not_configured");
    graphBase(config);
    if (!tokenKey(config)) throw new Error("meta_token_encryption_not_configured");
    const callback = redirectUri(config);
    const state = makeState(config, actorId, now());
    const url = new URL(`https://www.facebook.com/${config.metaSocialGraphVersion}/dialog/oauth`);
    url.searchParams.set("client_id", config.metaAppId);
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", REQUESTED_PERMISSIONS.join(","));
    return { url: url.toString(), cookie: stateCookie(state, config) };
  }

  async function complete({ code, state, cookie, actorId }) {
    const verified = verifyState(state, cookie, config, actorId, now());
    if (!verified) throw new Error("meta_oauth_state_invalid");
    if (!code || String(code).length > 4096) throw new Error("meta_oauth_code_invalid");
    const callback = redirectUri(config);
    const shortToken = await callGraph("GET", "oauth/access_token", { params: {
      client_id: config.metaAppId, client_secret: config.metaAppSecret, redirect_uri: callback, code: String(code),
    } });
    if (!shortToken.access_token) throw new Error("meta_oauth_exchange_failed");
    let userToken = shortToken.access_token;
    const longToken = await callGraph("GET", "oauth/access_token", { params: {
      grant_type: "fb_exchange_token", client_id: config.metaAppId, client_secret: config.metaAppSecret, fb_exchange_token: userToken,
    } });
    if (longToken.access_token) userToken = longToken.access_token;
    const dataAccessExpiresAt = Number.isFinite(Number(longToken.data_access_expiration_time)) && Number(longToken.data_access_expiration_time) > 0
      ? new Date(Number(longToken.data_access_expiration_time) * 1000).toISOString() : null;

    const permissionResult = await callGraph("GET", "me/permissions", { params: { fields: "permission,status" }, token: userToken });
    const granted = (permissionResult.data || []).filter((item) => item.status === "granted").map((item) => String(item.permission));
    const missing = REQUIRED_PERMISSIONS.filter((permission) => !granted.includes(permission));
    if (missing.length) {
      const error = new Error("meta_required_permissions_missing");
      error.missingPermissions = missing;
      throw error;
    }
    const accountRows = [];
    let cursor = "";
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const accountResult = await callGraph("GET", "me/accounts", { params: {
        fields: "id,name,access_token,tasks,instagram_business_account{id,username}", limit: 100,
        ...(cursor ? { after: cursor } : {}),
      }, token: userToken });
      accountRows.push(...(Array.isArray(accountResult.data) ? accountResult.data : []));
      const nextCursor = String(accountResult.paging?.cursors?.after || "");
      if (!accountResult.paging?.next) break;
      if (!nextCursor || nextCursor === cursor || pageNumber === 19) throw new Error("meta_page_list_pagination_incomplete");
      cursor = nextCursor;
    }
    const pages = accountRows.filter((page) => /^\d{1,32}$/.test(String(page.id || "")) && typeof page.access_token === "string" && page.access_token)
      .map((page) => ({ ...safePage(page), encryptedToken: encryptToken(page.access_token, config) }));
    const record = { actor_id: String(actorId), reference: verified.n, created_at: new Date(now()).toISOString(), expires_at: new Date(now() + MAX_AGE_MS).toISOString(), data_access_expires_at: dataAccessExpiresAt, granted_permissions: granted, pages };
    await store.setRuntimeSetting(pendingKey(actorId, verified.n), record, String(actorId));
    return { pageCount: pages.length, reference: verified.n, dataAccessExpiresAt, grantedPermissions: granted.filter((permission) => REQUESTED_PERMISSIONS.includes(permission)) };
  }

  async function listCandidates(actorId, reference) {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(String(reference || ""))) return { pages: [], expired: false };
    const row = await store.getRuntimeSetting(pendingKey(actorId, reference));
    const value = row?.value;
    const expiresAt = Date.parse(value?.expires_at || "");
    if (!value || value.actor_id !== String(actorId) || value.reference !== reference || !Number.isFinite(expiresAt) || expiresAt <= now() || !Array.isArray(value.pages)) return { pages: [], expired: Boolean(value) };
    return { pages: (value.pages || []).map((page) => ({
      ...safePage(page),
      can_manage_metadata: value.granted_permissions.includes("pages_manage_metadata") && page.tasks.some((task) => ["MANAGE", "CREATE_CONTENT", "MODERATE"].includes(task)),
      can_show_pages: value.granted_permissions.includes("pages_show_list"),
      has_messaging_task: page.tasks.includes("MESSAGING"),
      can_message: value.granted_permissions.includes("pages_messaging"),
      can_instagram_message: page.instagram?.id === String(config.instagramBusinessAccountId || "") &&
        value.granted_permissions.includes("instagram_basic") && value.granted_permissions.includes("instagram_manage_messages"),
      connected_instagram: page.instagram?.id === String(config.instagramBusinessAccountId || "") && Boolean(config.instagramBusinessAccountId),
    })) };
  }

  async function selectPage(actorId, pageId, reference) {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(String(reference || ""))) throw new Error("meta_page_selection_expired");
    const row = await store.getRuntimeSetting(pendingKey(actorId, reference));
    const pending = row?.value;
    const expiresAt = Date.parse(pending?.expires_at || "");
    if (!pending || pending.actor_id !== String(actorId) || pending.reference !== reference || !Number.isFinite(expiresAt) || expiresAt <= now() || !Array.isArray(pending.pages)) throw new Error("meta_page_selection_expired");
    const selected = (pending.pages || []).find((page) => page.id === String(pageId));
    if (!selected) throw new Error("meta_page_not_in_authorized_list");
    if (config.facebookPageId && config.facebookPageId !== selected.id) throw new Error("meta_page_differs_from_active_page");
    if (!pending.granted_permissions.includes("pages_show_list") || !pending.granted_permissions.includes("pages_manage_metadata")) throw new Error("meta_page_permissions_missing");
    if (!selected.tasks.includes("MESSAGING")) throw new Error("meta_page_messaging_task_missing");
    if (!selected.tasks.some((task) => ["MANAGE", "CREATE_CONTENT", "MODERATE"].includes(task))) throw new Error("meta_page_management_task_missing");
    if (!pending.granted_permissions.includes("pages_messaging")) throw new Error("meta_pages_messaging_permission_missing");
    if (config.instagramBusinessAccountId && selected.instagram?.id === String(config.instagramBusinessAccountId) &&
        (!pending.granted_permissions.includes("instagram_basic") || !pending.granted_permissions.includes("instagram_manage_messages"))) {
      throw new Error("meta_instagram_messaging_permissions_missing");
    }
    const pageToken = decryptToken(selected.encryptedToken, config);
    const record = {
      version: 1, page: safePage(selected), granted_permissions: pending.granted_permissions,
      connected_by: String(actorId), connected_at: new Date(now()).toISOString(), data_access_expires_at: pending.data_access_expires_at || null,
      encrypted_page_token: selected.encryptedToken,
    };
    await store.setRuntimeSetting(CONNECTION_KEY, record, String(actorId));
    await store.setRuntimeSetting(pendingKey(actorId, reference), { ...pending, expires_at: new Date(now()).toISOString(), pages: [] }, String(actorId));
    config.facebookPageId = selected.id;
    config.facebookPageAccessToken = pageToken;
    config.metaPageConnection = { page: safePage(selected), grantedPermissions: pending.granted_permissions, connectedAt: record.connected_at, dataAccessExpiresAt: record.data_access_expires_at };
    return publicConnection(config.metaPageConnection, config);
  }

  async function loadStoredConnection() {
    const row = await store.getRuntimeSetting(CONNECTION_KEY);
    const record = row?.value;
    if (!record || record.version !== 1 || !record.page?.id) return null;
    if (config.facebookPageId && config.facebookPageId !== record.page.id) return { mismatch: true, page: safePage(record.page) };
    const pageToken = decryptToken(record.encrypted_page_token, config);
    config.facebookPageId = record.page.id;
    config.facebookPageAccessToken = pageToken;
    config.metaPageConnection = { page: safePage(record.page), grantedPermissions: record.granted_permissions || [], connectedAt: record.connected_at, dataAccessExpiresAt: record.data_access_expires_at || null };
    return config.metaPageConnection;
  }

  async function webhookStatus() {
    const connection = config.metaPageConnection;
    if (!connection || !config.facebookPageAccessToken) throw new Error("meta_page_not_connected");
    const [pageApps, appSubscriptions] = await Promise.all([
      callGraph("GET", `${connection.page.id}/subscribed_apps`, { params: { fields: "id,name,subscribed_fields" }, token: config.facebookPageAccessToken }),
      callGraph("GET", `${config.metaAppId}/subscriptions`, { params: { fields: "object,callback_url,fields", access_token: `${config.metaAppId}|${config.metaAppSecret}` } }),
    ]);
    const pageFields = new Set((pageApps.data || []).flatMap((app) => app.subscribed_fields || []));
    const pageSubscribed = PAGE_WEBHOOK_FIELDS.filter((field) => pageFields.has(field));
    const appPage = (appSubscriptions.data || []).find((item) => item.object === "page");
    const appInstagram = (appSubscriptions.data || []).find((item) => item.object === "instagram");
    const appWhatsApp = (appSubscriptions.data || []).find((item) => item.object === "whatsapp_business_account");
    const callbackExpected = config.metaSocialWebhookCallbackUrl || config.metaSocialWebhookUrl || "";
    const appFields = new Set((appPage?.fields || []).map((field) => typeof field === "string" ? field : field.name));
    const instagramFields = new Set((appInstagram?.fields || []).map((field) => typeof field === "string" ? field : field.name));
    const appHasMessages = appFields.has("messages");
    const appCallbackMatches = Boolean(callbackExpected && appPage?.callback_url === callbackExpected);
    const instagramCallbackMatches = Boolean(callbackExpected && appInstagram?.callback_url === callbackExpected);
    const repairFields = PAGE_WEBHOOK_FIELDS.filter((field) => appFields.has(field));
    return {
      page: { subscribed_fields: pageSubscribed, complete: pageFields.has("messages"), missing_optional_receipt_fields: PAGE_WEBHOOK_FIELDS.filter((field) => field !== "messages" && !pageFields.has(field)) },
      app: { configured: Boolean(appPage), callback_matches: appCallbackMatches, messages_field_present: appHasMessages },
      instagram: { app_subscription_configured: Boolean(appInstagram), callback_matches: instagramCallbackMatches, messages_field_present: instagramFields.has("messages"), fields: [...instagramFields] },
      whatsapp: { app_subscription_configured: Boolean(appWhatsApp), callback_matches: Boolean(config.whatsappWebhookCallbackUrl && appWhatsApp?.callback_url === config.whatsappWebhookCallbackUrl), fields: (appWhatsApp?.fields || []).map((field) => typeof field === "string" ? field : field.name) },
      required_fields: ["messages"],
      repair_fields: repairFields,
      repair_needed: repairFields.some((field) => !pageFields.has(field)),
      repair_allowed: Boolean(appPage && appCallbackMatches && appHasMessages),
    };
  }

  async function repairPageWebhook() {
    const status = await webhookStatus();
    if (!status.app.configured || !status.app.callback_matches || !status.app.messages_field_present) throw new Error("meta_app_webhook_not_ready");
    if (!status.repair_needed) return status;
    await callGraph("POST", `${config.metaPageConnection.page.id}/subscribed_apps`, {
      params: { subscribed_fields: status.repair_fields.join(",") }, token: config.facebookPageAccessToken,
    });
    return webhookStatus();
  }

  return { begin, complete, listCandidates, selectPage, loadStoredConnection, webhookStatus, repairPageWebhook, getConnection: () => config.metaPageConnection || null };
}

function publicConnection(connection, config = {}) {
  if (connection?.mismatch) return {
    facebook: { status: "connection_mismatch", page_id: connection.page?.id || null, page_name: connection.page?.name || null, permissions: [] },
    instagram: { status: "not_verified", account_id: config.instagramBusinessAccountId || null, username: null },
  };
  if (!connection) return {
    facebook: { status: config.facebookPageId && config.facebookPageAccessToken ? "legacy_configured_unverified" : "not_connected", page_id: config.facebookPageId || null, page_name: null, permissions: [], webhook: "not_checked" },
    instagram: { status: config.instagramBusinessAccountId ? "configured_unverified" : "not_connected", account_id: config.instagramBusinessAccountId || null, username: null },
  };
  const page = connection.page;
  const instagram = page.instagram && page.instagram.id === String(config.instagramBusinessAccountId || "") ? page.instagram : null;
  return {
    facebook: { status: "oauth_saved", page_id: page.id, page_name: page.name, permissions: (connection.grantedPermissions || []).filter((permission) => REQUESTED_PERMISSIONS.includes(permission)), connected_at: connection.connectedAt || null, data_access_expires_at: connection.dataAccessExpiresAt || null, page_tasks: page.tasks },
    instagram: instagram ? { status: "linked_to_page", account_id: instagram.id, username: instagram.username } : {
      status: config.instagramBusinessAccountId ? "configured_link_not_verified" : "not_connected", account_id: config.instagramBusinessAccountId || null, username: null,
    },
  };
}

module.exports = {
  CONNECTION_KEY, PAGE_WEBHOOK_FIELDS, REQUIRED_PERMISSIONS, REQUESTED_PERMISSIONS, STATE_COOKIE,
  createMetaPageConnection, encryptToken, decryptToken, makeState, verifyState, parseCookie, publicConnection, clearStateCookie,
};
