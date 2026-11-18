"use strict";

const MEDIA_FILE = /^content_social_media_[0-9a-z]+_[0-9a-f]{12}\.(jpg|png|webp|mp4)$/;
const CHANNELS = ["facebook", "instagram"];

function normalizeSocialContent(input) {
  if (input === undefined) return { ok: true, value: undefined };
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !CHANNELS.includes(key))) return { ok: false, error: "invalid_social_content" };
  const value = {};
  for (const channel of CHANNELS) {
    const source = input[channel];
    if (source === undefined) continue;
    if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).some((key) => !["enabled", "caption", "media_filename", "media_type"].includes(key))) return { ok: false, error: "invalid_social_content" };
    const caption = typeof source.caption === "string" ? source.caption.trim() : "";
    const mediaFilename = source.media_filename == null || source.media_filename === "" ? null : String(source.media_filename);
    const mediaType = source.media_type || "none";
    if (source.enabled && channel === "instagram" && mediaType === "image" && mediaFilename && !mediaFilename.endsWith(".jpg")) {
      return { ok: false, error: "instagram_image_must_be_jpeg" };
    }
    if (typeof source.enabled !== "boolean" || caption.length > 2200 || !["none", "image", "video"].includes(mediaType) ||
      (mediaFilename && !MEDIA_FILE.test(mediaFilename)) || ((mediaType === "none") !== !mediaFilename) ||
      (mediaType === "video" && !mediaFilename?.endsWith(".mp4")) || (mediaType === "image" && mediaFilename?.endsWith(".mp4")) ||
      (source.enabled && channel === "instagram" && !mediaFilename) ||
      (source.enabled && channel === "instagram" && mediaType === "image" && !mediaFilename?.endsWith(".jpg")) ||
      (source.enabled && channel === "facebook" && !caption && !mediaFilename)) return { ok: false, error: "invalid_social_content" };
    value[channel] = { enabled: source.enabled, caption, media_filename: mediaFilename, media_type: mediaType };
  }
  return { ok: true, value };
}

module.exports = { normalizeSocialContent, MEDIA_FILE, CHANNELS };
