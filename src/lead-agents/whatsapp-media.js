"use strict";

// WhatsApp inbound message description (Slice 3.1): what the customer actually sent, kept in three DISTINCT parts --
//   * text     : what the customer typed (a text body, or the title of a button / list reply they tapped);
//   * caption  : the caption they wrote on an image, video or document;
//   * attachments : metadata of the media they sent (Meta media id, MIME type, SHA-256, size, filename, voice-note flag).
// Nothing is downloaded and nothing is invented: a media message without a caption has empty text and empty caption, never a placeholder. Only
// provider metadata is copied (no URL -- Meta's webhook carries none, and any url-like field is dropped), each field type-checked and length-capped.
// Pure functions: no network, no storage, no AI.

const MEDIA_KINDS = Object.freeze(["image", "video", "audio", "document", "sticker"]);
const CAPTIONED_KINDS = Object.freeze(["image", "video", "document"]);

// The narrow STOP-family check the Backend's opt-out governance uses (Ochiga-backend replyClassifier.ts quickUnsubscribeCheck), so Office never sends an
// automatic reply to a message that is an opt-out request, whether it was typed as text or written as a caption.
const STOP_PATTERN = /^\s*(?:please\s+)?(stop|unsubscribe|opt\s*out|remove me|don'?t (contact|message|text|email|call) me( again)?|leave me alone|no more messages)\s*[.!]?\s*$/i;

function str(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return max ? trimmed.slice(0, max) : trimmed;
}

function mimeType(value) {
  const v = str(value, 127).toLowerCase();
  // type/subtype with optional parameters (e.g. "audio/ogg; codecs=opus")
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;\s*[a-z0-9_.-]+=[a-z0-9_.\-"]+)*$/.test(v) ? v : null;
}

function filename(value) {
  // a display name only (never a path): last path segment, no control characters
  const base = str(value, 512).split(/[\\/]/).pop() || "";
  const safe = base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
  return safe || null;
}

function sizeBytes(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// Text the customer typed or tapped. Same sources the CRM view already reads (whatsapp-inbound-visibility.js), captions excluded.
function typedText(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const body = p.text && typeof p.text === "object" ? p.text.body : typeof p.text === "string" ? p.text : "";
  return str(body, 4096) || str(p.button?.text, 1024) || str(p.interactive?.button_reply?.title, 1024) || str(p.interactive?.list_reply?.title, 1024);
}

function describeInboundMessage(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const messageType = str(p.type, 40).toLowerCase() || "unknown";
  const media = MEDIA_KINDS.includes(messageType) && p[messageType] && typeof p[messageType] === "object" ? p[messageType] : null;
  const caption = media && CAPTIONED_KINDS.includes(messageType) ? str(media.caption, 4096) : "";
  const attachments = [];
  if (media) {
    const providerMediaId = str(media.id, 128);
    if (providerMediaId) {
      attachments.push({
        kind: messageType,
        provider_media_id: providerMediaId,
        mime_type: mimeType(media.mime_type),
        size_bytes: sizeBytes(media.file_size),
        sha256: str(media.sha256, 128) || null,
        filename: messageType === "document" ? filename(media.filename) : null,
        voice: messageType === "audio" ? media.voice === true : false,
        animated: messageType === "sticker" ? media.animated === true : false,
      });
    }
  }
  return { message_type: messageType, text: typedText(p), caption, attachments };
}

// What a reader (Oyi, the classifier, a human) can treat as the customer's own words: typed text, else the caption. Never a placeholder.
function customerAuthoredText(described) {
  return described.text || described.caption || "";
}

function isOptOutRequest(text) {
  return STOP_PATTERN.test(String(text || "").trim());
}

// Payload fields added to the Office -> Backend webhook-event request (additive; `text` keeps meaning "typed text"). Metadata only: no bytes, no URL.
function backendMessageFields(described) {
  const fields = { message_type: described.message_type };
  if (described.caption) fields.caption = described.caption;
  if (described.attachments.length) fields.attachments = described.attachments.map((a) => ({ ...a }));
  return fields;
}

module.exports = { MEDIA_KINDS, CAPTIONED_KINDS, STOP_PATTERN, describeInboundMessage, customerAuthoredText, isOptOutRequest, backendMessageFields, typedText };
