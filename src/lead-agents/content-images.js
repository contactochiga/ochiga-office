"use strict";

// Cover images for Sanity (articles and development projects), without the server ever fetching a URL.
//   - An image uploaded in Office (POST /admin/storage with the matching purpose) is read straight from Office storage by its file name.
//   - An image already in this Sanity project (cdn.sanity.io/images/<project>/<dataset>/...) is referenced by its asset id; nothing is downloaded.
//   - Any other URL -- external sites, internal addresses, other Office files -- is never requested. The caller keeps the cover the Sanity document
//     already has and reports it, so a legacy link never silently removes a published cover.
// Only files of the cover purpose qualify, so a private Office file (staff photo, document, attachment) can never be copied to the public site.

const sharp = require("sharp");
const { sniffImage } = require("./catalogue-media");

const COVER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const COVER_IMAGE_MAX_PIXELS = 40_000_000;
const COVER_IMAGE_PURPOSES = Object.freeze({ content: "content_featured_image", development: "development_cover_image" });
const MIME = Object.freeze({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });
const EXT = Object.freeze({ jpeg: ".jpg", png: ".png", webp: ".webp" });
const STORAGE_PATH = "/api/lead-agents/admin/storage/";

function coverError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// Validates image bytes from their content (never the declared type or name): JPEG, PNG or WebP, at most 10 MB, decodable as that same format.
async function validateCoverImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw coverError(400, "image_missing", "Choose an image file to upload.");
  if (buffer.length > COVER_IMAGE_MAX_BYTES) throw coverError(413, "image_too_large", "Images must be 10 MB or smaller.");
  const format = sniffImage(buffer);
  if (!format) throw coverError(415, "unsupported_image_type", "Use a JPEG, PNG or WebP image.");
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: COVER_IMAGE_MAX_PIXELS }).metadata();
  } catch {
    throw coverError(422, "image_unreadable", "This image could not be read. Export it again as JPEG, PNG or WebP.");
  }
  if (meta.format !== format || !meta.width || !meta.height) throw coverError(422, "image_unreadable", "This image could not be read. Export it again as JPEG, PNG or WebP.");
  return { format, mime_type: MIME[format], extension: EXT[format], width: meta.width, height: meta.height, size: buffer.length };
}

// What a stored cover URL points at. kind: none | office | sanity_asset | unsupported.
function classifyCoverImageUrl(value, kind, { sanityProjectId, sanityDataset } = {}) {
  const url = String(value || "").trim();
  if (!url) return { kind: "none" };
  const purpose = COVER_IMAGE_PURPOSES[kind];
  if (url.startsWith(STORAGE_PATH)) {
    let filename = "";
    try {
      filename = decodeURIComponent(url.slice(STORAGE_PATH.length));
    } catch {
      filename = "";
    }
    const match = filename.match(/^([a-z_]+)_[0-9a-z]+_[0-9a-f]{12}\.(jpg|png|webp)$/);
    if (match && match[1] === purpose) return { kind: "office", filename };
    return { kind: "unsupported", detail: "office_file_not_a_cover" };
  }
  const sanity = url.match(/^https:\/\/cdn\.sanity\.io\/images\/([a-z0-9-]+)\/([a-z0-9_-]+)\/([a-f0-9]{40}-\d+x\d+)\.(jpg|png|webp|gif|svg)(\?.*)?$/i);
  if (sanity && sanityProjectId && sanity[1] === sanityProjectId && sanity[2] === sanityDataset) {
    return { kind: "sanity_asset", assetId: `image-${sanity[3]}-${sanity[4].toLowerCase()}` };
  }
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "";
  }
  return { kind: "unsupported", detail: host ? "external_url" : "not_a_url", host };
}

// Reads an Office-stored cover by file name and validates it. Throws coverError when it is missing or not an acceptable image.
async function readStoredCoverImage(storageService, filename) {
  const stored = await storageService.getObject(filename);
  if (!stored) throw coverError(404, "image_not_found", "The uploaded image is no longer in Office storage. Upload it again.");
  const info = await validateCoverImage(stored.buffer);
  return { buffer: stored.buffer, filename, ...info };
}

module.exports = {
  COVER_IMAGE_MAX_BYTES,
  COVER_IMAGE_PURPOSES,
  classifyCoverImageUrl,
  readStoredCoverImage,
  validateCoverImage,
};
