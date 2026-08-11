const axios = require("axios");

class OpenAIResponsesClient {
  constructor(config) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.openaiBaseUrl,
      timeout: config.requestTimeoutMs,
      headers: {
        authorization: `Bearer ${config.openaiApiKey}`,
        "content-type": "application/json",
      },
    });
  }

  async createResponse(payload) {
    try {
      const response = await this.client.post("/responses", payload);
      return response.data;
    } catch (err) {
      if (err.response) {
        const detail = JSON.stringify(err.response.data);
        err.message = `${err.message} | OpenAI response: ${detail}`;
      }
      throw err;
    }
  }

  async createTranscription({ buffer, filename, mimeType, language, prompt }) {
    if (!buffer || !buffer.length) {
      const error = new Error("Audio buffer is required");
      error.statusCode = 400;
      throw error;
    }
    if (typeof FormData === "undefined" || typeof Blob === "undefined" || typeof fetch === "undefined") {
      throw new Error("This Node.js runtime does not support fetch/FormData audio uploads");
    }

    const form = new FormData();
    form.append("model", this.config.openaiTranscriptionModel || "whisper-1");
    form.append(
      "file",
      new Blob([buffer], { type: mimeType || "audio/webm" }),
      filename || "oyi-voice-note.webm"
    );
    form.append("response_format", "json");
    if (language) {
      form.append("language", language);
    }
    if (prompt) {
      form.append("prompt", prompt);
    }

    const response = await fetch(`${this.config.openaiBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: form,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { text };
    }
    if (!response.ok) {
      const error = new Error(`OpenAI transcription failed: ${text}`);
      error.statusCode = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }
}

module.exports = {
  OpenAIResponsesClient,
};
