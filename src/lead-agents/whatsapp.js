const axios = require("axios");
const crypto = require("crypto");
const { normalizePhone } = require("./normalize-lead");

// Writes every UTF-16 code unit above U+007F as a lower-case \uXXXX escape (surrogate pairs become two escapes), leaving ASCII untouched.
function escapeNonAscii(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code > 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : text[i];
  }
  return out;
}

class WhatsAppCloudAdapter {
  constructor(config) {
    this.config = config;
    this.client = axios.create({
      baseURL: `https://graph.facebook.com/${config.whatsappApiVersion || "v22.0"}`,
      timeout: config.requestTimeoutMs,
      headers: {
        Authorization: `Bearer ${config.whatsappAccessToken}`,
        "content-type": "application/json",
      },
    });
  }

  isConfigured() {
    return Boolean(
      this.config.whatsappAccessToken &&
        this.config.whatsappPhoneNumberId &&
        this.config.whatsappVerifyToken
    );
  }

  verifyWebhook(mode, token, challenge) {
    if (
      mode === "subscribe" &&
      token &&
      token === this.config.whatsappVerifyToken
    ) {
      return challenge;
    }
    return null;
  }

  // Real gap found on audit: META_APP_SECRET was already read into config
  // (and reported as "configured" by the readiness endpoint) but never
  // actually used to verify anything -- every POST to /webhooks/whatsapp
  // was processed as genuine Meta traffic purely because it arrived on
  // the right URL. Verifies the X-Hub-Signature-256 header (HMAC-SHA256
  // of the RAW request body, keyed by the Meta App Secret) using a
  // constant-time comparison. Must be called with the raw body bytes
  // BEFORE JSON.parse -- Meta signs the exact bytes it sent, not a
  // reserialized object.
  verifySignature(rawBody, signatureHeader) {
    // Fails CLOSED: without the app secret nothing can be authenticated.
    if (!this.config.metaAppSecret) return { ok: false, reason: "app_secret_not_configured" };
    const header = String(signatureHeader || "").trim();
    if (!header) return { ok: false, reason: "missing_signature" };
    const match = header.match(/^sha256=([0-9a-f]{64})$/i);
    if (!match) return { ok: false, reason: "malformed_signature" };
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
    const provided = Buffer.from(match[1].toLowerCase(), "hex");
    // Candidate 1: the exact bytes received. Candidate 2 (only when the body contains non-ASCII): the same payload with every character above U+007F written as a
    // lower-case \uXXXX escape -- the form Meta's platform documentation says its signature is computed over. Both are HMACs under the secret, so accepting either
    // cannot let anyone forge a request without the secret; it only prevents rejecting genuine messages that contain emoji or accented letters.
    const candidates = [["raw", bytes]];
    if (bytes.some((byte) => byte > 0x7f)) candidates.push(["escaped_unicode", Buffer.from(escapeNonAscii(bytes.toString("utf8")), "utf8")]);
    for (const [method, candidate] of candidates) {
      const expected = crypto.createHmac("sha256", this.config.metaAppSecret).update(candidate).digest();
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) return { ok: true, reason: null, method };
    }
    return { ok: false, reason: "signature_mismatch" };
  }

  extractEvents(body) {
    const events = [];
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const message of value.messages || []) {
          events.push({
            kind: "message",
            from: normalizePhone(message.from),
            message_id: message.id,
            message_type: message.type || "unknown",
            timestamp: message.timestamp,
            text:
              message.text?.body ||
              message.button?.text ||
              message.interactive?.button_reply?.title ||
              "",
            raw: message,
            metadata: value.metadata || {},
            contacts: value.contacts || [],
          });
        }
        for (const status of value.statuses || []) {
          events.push({
            kind: "status",
            message_id: status.id,
            recipient_id: normalizePhone(status.recipient_id),
            status: status.status,
            timestamp: status.timestamp,
            raw: status,
            metadata: value.metadata || {},
          });
        }
      }
    }
    return events;
  }

  async sendTextMessage({ to, body, contextMessageId }) {
    if (!this.isConfigured()) {
      return {
        delivered: false,
        response_code: null,
        skipped: true,
      };
    }

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        preview_url: false,
        body,
      },
    };

    if (contextMessageId) {
      payload.context = {
        message_id: contextMessageId,
      };
    }

    const response = await this.client.post(
      `/${this.config.whatsappPhoneNumberId}/messages`,
      payload
    );

    return {
      delivered: true,
      response_code: response.status,
      response: response.data,
      external_message_id: response.data.messages?.[0]?.id || "",
    };
  }

  // Phase 2 -- a recipient outside the 24h customer-service window can
  // only be reached via an approved message template (Meta policy; a
  // free-form send fails with error 131047/470). Never bypasses this --
  // this is the LEGITIMATE path Meta requires, not a workaround.
  async sendTemplateMessage({ to, templateName, languageCode, components }) {
    if (!this.isConfigured()) {
      return { delivered: false, response_code: null, skipped: true };
    }
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode || "en_US" },
        ...(Array.isArray(components) && components.length ? { components } : {}),
      },
    };
    const response = await this.client.post(`/${this.config.whatsappPhoneNumberId}/messages`, payload);
    return {
      delivered: true,
      response_code: response.status,
      response: response.data,
      external_message_id: response.data.messages?.[0]?.id || "",
    };
  }

  // Phase 2 -- Oyi needs to know what's actually approved before
  // offering a template retry, not assume a name exists. Queries Meta
  // directly rather than hard-coding any template name.
  async listApprovedTemplates() {
    if (!this.isConfigured() || !this.config.whatsappBusinessAccountId) return [];
    const response = await this.client.get(
      `/${this.config.whatsappBusinessAccountId}/message_templates`,
      { params: { fields: "name,status,category,language", status: "APPROVED", limit: 50 } }
    );
    return (response.data?.data || []).map((t) => ({ name: t.name, language: t.language, category: t.category }));
  }
}

module.exports = {
  WhatsAppCloudAdapter,
  escapeNonAscii,
};
