const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");

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
  "content_featured_image",
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

// Render's local filesystem is ephemeral — it does not survive a
// redeploy, and on some plans not even a restart. Any driver other than
// "supabase" here is local disk, which is fine for local dev (no
// external dependency needed) but must never be relied on in
// production. "supabase" persists into Supabase Storage (the same
// proven pattern Ochiga-backend already uses for Consumer profile
// avatars — supabaseAdmin.storage.from(bucket).upload/getPublicUrl in
// src/routes/me.routes.ts) via a private bucket dedicated to Office, so
// Office staff identity/media stays completely separate from Consumer's
// user table and bucket.
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

  const bucket = config.officeStorageBucket || "office-media";
  const supabaseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  const supabaseClient = driver === "supabase"
    ? axios.create({
        baseURL: `${supabaseUrl}/storage/v1`,
        timeout: config.requestTimeoutMs || 30000,
        headers: {
          apikey: config.supabaseServiceRoleKey,
          authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        },
        // Supabase returns raw bytes for object reads, not JSON.
        responseType: "arraybuffer",
        validateStatus: () => true,
      })
    : null;

  async function putBufferLocal(input, id, filename, mimeType) {
    const activeRootDir = await ensureRootDir();
    const filePath = path.join(activeRootDir, filename);
    await fs.writeFile(filePath, input.buffer);
  }

  async function putBufferSupabase(input, id, filename, mimeType) {
    const response = await supabaseClient.post(
      `/object/${encodeURIComponent(bucket)}/${encodeURIComponent(filename)}`,
      input.buffer,
      { headers: { "content-type": mimeType, "x-upsert": "true" }, responseType: "json" }
    );
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Supabase Storage upload failed (${response.status}): ${JSON.stringify(response.data)}`);
      error.statusCode = 502;
      throw error;
    }
  }

  async function putBuffer(input) {
    const purpose = sanitizePurpose(input.purpose);
    const id = `${purpose}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    const mimeType = input.mime_type || input.mimeType || "application/octet-stream";
    const ext = input.extension || extensionForMime(mimeType);
    const filename = `${id}${ext}`;
    if (driver === "supabase") {
      await putBufferSupabase(input, id, filename, mimeType);
    } else {
      await putBufferLocal(input, id, filename, mimeType);
    }
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

  // Replaces the old filePathFor()+fs-based serveFile() pairing so the
  // same authenticated route contract (GET /admin/storage/:filename,
  // and the document share-token route) keeps working unchanged for
  // callers — only where the bytes actually live has changed.
  async function getObject(filename) {
    const safeName = path.basename(String(filename || ""));
    if (driver === "supabase") {
      const response = await supabaseClient.get(`/object/${encodeURIComponent(bucket)}/${encodeURIComponent(safeName)}`);
      if (response.status === 404) return null;
      if (response.status >= 400 && response.status < 500) {
        // Supabase Storage's real "not found" wraps a 404 inside a 400
        // response body (statusCode/error/code all say not-found) rather
        // than using a plain HTTP 404 — verified directly against the
        // live API, not assumed. Anything else in the 4xx range is a
        // genuine error, not a miss.
        let parsed = null;
        try {
          parsed = JSON.parse(Buffer.from(response.data).toString("utf8"));
        } catch {
          parsed = null;
        }
        if (parsed && (parsed.statusCode === "404" || parsed.error === "not_found" || parsed.code === "NoSuchKey")) {
          return null;
        }
        const error = new Error(`Supabase Storage download failed (${response.status}): ${JSON.stringify(parsed)}`);
        error.statusCode = 502;
        throw error;
      }
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(`Supabase Storage download failed (${response.status})`);
        error.statusCode = 502;
        throw error;
      }
      return {
        buffer: Buffer.from(response.data),
        mimeType: response.headers["content-type"] || "application/octet-stream",
      };
    }
    try {
      const buffer = await fs.readFile(path.join(rootDir, safeName));
      return { buffer, mimeType: undefined };
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  // Documents Workspace permanent-delete needs a real way to remove the
  // underlying bytes, not just the office_files metadata row -- without
  // this, permanently deleting a document would silently orphan its
  // storage object on whichever driver is active.
  async function deleteObject(filename) {
    const safeName = path.basename(String(filename || ""));
    if (driver === "supabase") {
      const response = await supabaseClient.delete(`/object/${encodeURIComponent(bucket)}/${encodeURIComponent(safeName)}`);
      if (response.status >= 200 && response.status < 300) return true;
      if (response.status === 404) return false;
      const error = new Error(`Supabase Storage delete failed (${response.status})`);
      error.statusCode = 502;
      throw error;
    }
    try {
      await fs.unlink(path.join(rootDir, safeName));
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
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
    getObject,
    deleteObject,
    filePathFor(filename) {
      return path.join(rootDir, path.basename(String(filename || "")));
    },
    health() {
      return driver === "supabase"
        ? { driver, configured: Boolean(supabaseUrl && config.supabaseServiceRoleKey), bucket }
        : { driver, configured: Boolean(rootDir), root_dir: rootDir || "" };
    },
  };
}

module.exports = {
  STORAGE_PURPOSES,
  createStorageService,
  extensionForMime,
  parseDataUrl,
};
