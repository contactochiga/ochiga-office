const axios = require("axios");

class WebhookDispatcher {
  constructor({ config }) {
    this.config = config;
  }

  async post(url, secret, payload) {
    if (!url) {
      return {
        delivered: false,
        response_code: null,
      };
    }

    const response = await axios.post(url, payload, {
      timeout: this.config.requestTimeoutMs,
      headers: secret
        ? {
            "x-webhook-secret": secret,
          }
        : undefined,
    });

    return {
      delivered: true,
      response_code: response.status,
    };
  }

  async notifyFounder(payload) {
    return this.post(
      this.config.founderWebhookUrl,
      this.config.founderWebhookSecret,
      payload
    );
  }

  async notifyDemo(payload) {
    return this.post(
      this.config.demoWebhookUrl,
      this.config.demoWebhookSecret,
      payload
    );
  }

  async notifySales(payload) {
    return this.post(
      this.config.salesWebhookUrl,
      this.config.salesWebhookSecret,
      payload
    );
  }
}

module.exports = {
  WebhookDispatcher,
};
