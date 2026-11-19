"use strict";

const crypto = require("crypto");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function validateSocialMedia(buffer, mimeType, { channels = ["facebook"] } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error("media_required"), { statusCode: 400 });
  const selectedChannels = Array.isArray(channels) ? channels : [];
  const instagramSelected = selectedChannels.includes("instagram");
  if (IMAGE_TYPES.has(mimeType)) {
    if (instagramSelected && mimeType !== "image/jpeg") throw Object.assign(new Error("instagram_image_must_be_jpeg"), { statusCode: 415 });
    const maxImageBytes = instagramSelected ? 8 * 1024 * 1024 : MAX_IMAGE_BYTES;
    if (buffer.length > maxImageBytes) throw Object.assign(new Error(instagramSelected ? "instagram_image_too_large" : "image_too_large"), { statusCode: 413 });
    const signatures = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };
    const sig = signatures[mimeType];
    if (!sig.every((value, index) => buffer[index] === value) || (mimeType === "image/webp" && buffer.toString("ascii", 8, 12) !== "WEBP")) throw Object.assign(new Error("media_type_mismatch"), { statusCode: 415 });
    return { mediaType: "image", mimeType, extension: mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/png" ? ".png" : ".webp" };
  }
  if (mimeType === "video/mp4") {
    if (buffer.length > MAX_VIDEO_BYTES) throw Object.assign(new Error("video_too_large"), { statusCode: 413 });
    if (buffer.length < 12 || buffer.toString("ascii", 4, 8) !== "ftyp") throw Object.assign(new Error("unsupported_video"), { statusCode: 415 });
    return { mediaType: "video", mimeType, extension: ".mp4" };
  }
  throw Object.assign(new Error("unsupported_media_type"), { statusCode: 415 });
}

function signature(filename, expires, secret) {
  return crypto.createHmac("sha256", secret).update(`${filename}\n${expires}`).digest("hex");
}

function createSocialMediaGrant(filename, secret, now = Date.now(), ttlMs = 12 * 60 * 60 * 1000) {
  if (!/^content_social_media_[0-9a-z]+_[0-9a-f]{12}\.(jpg|png|webp|mp4)$/.test(filename || "") || !secret) throw new Error("social_media_grant_unavailable");
  const expires = Math.floor((now + ttlMs) / 1000);
  return { expires, signature: signature(filename, expires, secret) };
}

function verifySocialMediaGrant(filename, expires, supplied, secret, now = Date.now()) {
  if (!/^content_social_media_[0-9a-z]+_[0-9a-f]{12}\.(jpg|png|webp|mp4)$/.test(filename || "") || !/^\d{10}$/.test(String(expires || "")) || !/^[a-f0-9]{64}$/.test(supplied || "") || !secret) return false;
  const expiry = Number(expires) * 1000;
  if (expiry <= now || expiry > now + 24 * 60 * 60 * 1000 + 60_000) return false;
  const expected = Buffer.from(signature(filename, Number(expires), secret), "hex");
  const actual = Buffer.from(supplied, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function publicGrantUrl(baseUrl, filename, secret, now = Date.now()) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("social_media_public_base_invalid");
  const grant = createSocialMediaGrant(filename, secret, now);
  return `${base.origin}/api/office/content/social-media/${encodeURIComponent(filename)}?expires=${grant.expires}&sig=${grant.signature}`;
}

module.exports = { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, validateSocialMedia, createSocialMediaGrant, verifySocialMediaGrant, publicGrantUrl };
