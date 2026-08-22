const axios = require("axios");
const { normalizePhone } = require("./normalize-lead");

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
};
