const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const STORAGE_PURPOSES = Object.freeze([
  "staff_photo",
  "resident_photo",
  "document",
  "message_attachment",
  "generated_pdf",
  "plan_upload",
  "estate_image",
  "device_snapshot",
  "camera_snapshot",
  "digital_twin_file",
]);

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const body = match[3] || "";
  return {
    mimeType,
    buffer: isBase64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8"),
  };
}

function extensionForMime(mimeType) {
  const clean = String(mimeType || "").toLowerCase();
  if (clean.includes("jpeg") || clean.includes("jpg")) return ".jpg";
  if (clean.includes("png")) return ".png";
  if (clean.includes("webp")) return ".webp";
  if (clean.includes("svg")) return ".svg";
  if (clean.includes("pdf")) return ".pdf";
  if (clean.includes("html")) return ".html";
  if (clean.includes("json")) return ".json";
  if (clean.includes("gltf")) return ".gltf";
  if (clean.includes("glb")) return ".glb";
  return ".bin";
}

function sanitizePurpose(value) {
  const purpose = String(value || "document").toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return purpose || "document";
}

function createStorageService(config) {
  const driver = String(config.officeStorageDriver || config.storageDriver || "local").toLowerCase();
  const fallbackRootDir = path.join(process.cwd(), "data", "office-storage");
  let rootDir = config.officeStorageDir || fallbackRootDir;

  async function ensureRootDir() {
    try {
      await fs.mkdir(rootDir, { recursive: true });
      return rootDir;
    } catch (error) {
      const canFallback =
        rootDir !== fallbackRootDir &&
        ["EACCES", "EPERM", "EROFS", "ENOENT"].includes(String(error && error.code));
      if (!canFallback) {
        throw error;
      }
      rootDir = fallbackRootDir;
      await fs.mkdir(rootDir, { recursive: true });
      return rootDir;
    }
  }

  async function putBuffer(input) {
    if (driver !== "local") {
      const error = new Error(`Unsupported storage driver: ${driver}`);
      error.statusCode = 500;
      throw error;
    }
    const purpose = sanitizePurpose(input.purpose);
    const id = `${purpose}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    const mimeType = input.mime_type || input.mimeType || "application/octet-stream";
    const ext = input.extension || extensionForMime(mimeType);
    const activeRootDir = await ensureRootDir();
    const filename = `${id}${ext}`;
    const filePath = path.join(activeRootDir, filename);
    await fs.writeFile(filePath, input.buffer);
    return {
      id,
      filename,
      storage_driver: driver,
      storage_key: filename,
      mime_type: mimeType,
      size: input.buffer.length,
      purpose,
      resource_type: input.resource_type || input.resourceType || "office_file",
      resource_id: input.resource_id || input.resourceId || "",
      url: `/api/lead-agents/admin/storage/${encodeURIComponent(filename)}`,
      created_at: new Date().toISOString(),
      metadata: input.metadata || {},
    };
  }

  async function putDataUrl(input) {
    const parsed = parseDataUrl(input.data_url || input.dataUrl || "");
    if (!parsed) {
      const error = new Error("data_url is required");
      error.statusCode = 400;
      throw error;
    }
    return putBuffer({
      ...input,
      buffer: parsed.buffer,
      mime_type: input.mime_type || input.mimeType || parsed.mimeType,
    });
  }

  async function putText(input) {
    const content = String(input.content || "");
    return putBuffer({
      ...input,
      buffer: Buffer.from(content, "utf8"),
      mime_type: input.mime_type || input.mimeType || "text/plain; charset=utf-8",
      extension: input.extension || ".txt",
    });
  }

  return {
    driver,
    get rootDir() {
      return rootDir;
    },
    purposes: STORAGE_PURPOSES,
    putBuffer,
    putDataUrl,
    putText,
    filePathFor(filename) {
      return path.join(rootDir, path.basename(String(filename || "")));
    },
    health() {
      return { driver, configured: Boolean(rootDir), root_dir: rootDir || "" };
    },
  };
}

module.exports = {
  STORAGE_PURPOSES,
  createStorageService,
  extensionForMime,
  parseDataUrl,
};
