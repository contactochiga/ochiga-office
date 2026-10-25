"use strict";

// Product gallery image processing (Phase 2 stage 3). Pure validation + sharp; no storage, no database.
//   1. the bytes must START with a JPEG, PNG or WebP signature (the declared Content-Type and file name are ignored);
//   2. sharp must decode them as that same format (a polyglot or mislabelled file is refused), as a single still frame, within the size,
//      pixel and dimension limits, without decoder errors;
//   3. derivatives are re-encoded WebP, auto-rotated from EXIF and converted to sRGB, with ALL metadata stripped (EXIF/GPS, XMP, IPTC, ICC).
// The original stays private: it is stored as uploaded and never served.
// Memory: Render's instance is small, so libvips runs single-threaded without its operation cache, and at most one image is processed
// at a time (a short queue; beyond it the client is told to retry).

const crypto = require("crypto");
const sharp = require("sharp");
const { httpError } = require("./catalogue");

sharp.concurrency(1);
sharp.cache(false);

const MEDIA_LIMITS = Object.freeze({
  maxBytes: 15 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxSide: 8000,
  minSide: 200,
  gallery: 12,
  galleryVisible: 5,
  alt: 250,
  caption: 300,
  queue: 6,
  timeoutSeconds: 30,
});

const DERIVATIVES = Object.freeze([
  { kind: "thumb", box: 320, quality: 78 },
  { kind: "w480", box: 480, quality: 80 },
  { kind: "w960", box: 960, quality: 80 },
  { kind: "w1600", box: 1600, quality: 82 },
]);
const DERIVATIVE_KINDS = Object.freeze(DERIVATIVES.map((d) => d.kind));
const MIME = Object.freeze({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });
const EXT = Object.freeze({ jpeg: ".jpg", png: ".png", webp: ".webp" });

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Content signature, never the declared type.
function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

function rejected(statusCode, code, extra) {
  return httpError(statusCode, code, extra);
}

// One-at-a-time processing with a bounded queue.
let active = 0;
const waiting = [];
async function withSlot(task) {
  if (active >= 1) {
    if (waiting.length >= MEDIA_LIMITS.queue) throw rejected(503, "media_busy");
    await new Promise((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

const decoderOptions = { failOn: "error", limitInputPixels: MEDIA_LIMITS.maxPixels, sequentialRead: true, animated: false };

// Validates and processes one upload. Throws 413 / 415 / 422 with a specific code; returns the facts and the WebP renditions.
async function processProductImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw rejected(400, "image_empty");
  if (buffer.length > MEDIA_LIMITS.maxBytes) throw rejected(413, "image_too_large", { details: [`at most ${MEDIA_LIMITS.maxBytes} bytes`] });
  const sniffed = sniffImage(buffer);
  if (!sniffed) throw rejected(415, "unsupported_image_type", { details: ["JPEG, PNG or WebP only (checked from the file content)"] });
  return withSlot(async () => {
    let meta;
    try {
      meta = await sharp(buffer, { ...decoderOptions, animated: true }).metadata();
    } catch (error) {
      throw rejected(422, /pixel limit/i.test(String(error && error.message)) ? "image_too_many_pixels" : "image_unreadable");
    }
    if (meta.format !== sniffed) throw rejected(422, "image_format_mismatch");
    if ((meta.pages || 1) > 1) throw rejected(422, "image_animated");
    const swap = (meta.orientation || 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    if (!width || !height) throw rejected(422, "image_unreadable");
    if (width > MEDIA_LIMITS.maxSide || height > MEDIA_LIMITS.maxSide) throw rejected(422, "image_dimensions_too_large", { details: [`at most ${MEDIA_LIMITS.maxSide} px per side`] });
    if (width < MEDIA_LIMITS.minSide || height < MEDIA_LIMITS.minSide) throw rejected(422, "image_dimensions_too_small", { details: [`at least ${MEDIA_LIMITS.minSide} px per side`] });
    const derivatives = [];
    try {
      // one full decode; each rendition is a clone of the oriented pipeline. No withMetadata(): output carries no EXIF/XMP/IPTC/ICC.
      const base = sharp(buffer, decoderOptions).rotate().toColourspace("srgb").timeout({ seconds: MEDIA_LIMITS.timeoutSeconds });
      for (const spec of DERIVATIVES) {
        const { data, info } = await base.clone()
          .resize({ width: spec.box, height: spec.box, fit: "inside", withoutEnlargement: true })
          .webp({ quality: spec.quality, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        derivatives.push({ kind: spec.kind, buffer: data, width: info.width, height: info.height, bytes: data.length, sha256: sha256(data) });
      }
    } catch (error) {
      if (error && error.statusCode) throw error;
      throw rejected(422, "image_unreadable");
    }
    return { format: sniffed, mime_type: MIME[sniffed], extension: EXT[sniffed], width, height, bytes: buffer.length, sha256: sha256(buffer), derivatives };
  });
}

function safeOriginalName(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f<>"'`\\/]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

module.exports = { DERIVATIVES, DERIVATIVE_KINDS, MEDIA_LIMITS, processProductImage, safeOriginalName, sha256, sniffImage };
