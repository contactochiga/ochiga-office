// Server-side Sanity publishing adapter (Phase 8, Office v2).
//
// Sanity remains the canonical public content source of truth — the
// "post" document type (sanity/schemas/post.ts in Ochiga-website),
// project/dataset/schema confirmed by direct inspection before writing
// this file, not guessed. This module only ever writes to Sanity's
// existing "post" schema; it never introduces a parallel content store,
// and the write token never leaves this process (no route returns it,
// no frontend code references it).
//
// Draft/publish uses Sanity's own document-versioning convention: a
// document id "drafts.<id>" is a draft, the same id without that
// prefix is the published version. Publishing = copy draft content to
// the bare id, then delete the draft. Unpublishing = the reverse.
const { createClient } = require("@sanity/client");
const crypto = require("crypto");

function sanityConfigured() {
  return Boolean(process.env.SANITY_PROJECT_ID && process.env.SANITY_DATASET && process.env.SANITY_API_WRITE_TOKEN);
}

let cachedClient = null;
function sanityClient() {
  if (!sanityConfigured()) return null;
  if (cachedClient) return cachedClient;
  cachedClient = createClient({
    projectId: process.env.SANITY_PROJECT_ID,
    dataset: process.env.SANITY_DATASET,
    apiVersion: process.env.SANITY_API_VERSION || "2024-01-01",
    token: process.env.SANITY_API_WRITE_TOKEN,
    useCdn: false,
  });
  return cachedClient;
}

function portableKey() {
  return crypto.randomBytes(6).toString("hex");
}

// Splits a line into spans with strong/em marks for **bold** and
// *italic* — the exact same markdown-lite rules Office's editor toolbar
// writes and its Preview panel renders (wireBodyToolbar/
// markdownLiteToHtml in office.js), so what a writer sees in Preview is
// what actually reaches the published article.
function inlineSpans(text) {
  const spans = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text))) {
    if (match.index > lastIndex) spans.push({ _type: "span", _key: portableKey(), text: text.slice(lastIndex, match.index), marks: [] });
    if (match[1] !== undefined) spans.push({ _type: "span", _key: portableKey(), text: match[1], marks: ["strong"] });
    else spans.push({ _type: "span", _key: portableKey(), text: match[2], marks: ["em"] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) spans.push({ _type: "span", _key: portableKey(), text: text.slice(lastIndex), marks: [] });
  if (!spans.length) spans.push({ _type: "span", _key: portableKey(), text: "", marks: [] });
  return spans;
}

// Markdown-lite -> Portable Text: paragraphs (blank-line separated)
// become normal blocks; "# "/"## "/"### " become h2/h3/h4; a group
// where every line starts with "- " becomes bullet listItem blocks.
// Intentionally a small fixed rule set, not a full markdown parser —
// matches exactly what the editor toolbar can produce.
function textToPortableText(body) {
  const groups = String(body || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const blocks = [];
  groups.forEach((group) => {
    const lines = group.split("\n");
    if (lines.length && lines.every((l) => l.trim().startsWith("- "))) {
      lines.forEach((l) => {
        blocks.push({ _type: "block", _key: portableKey(), style: "normal", listItem: "bullet", level: 1, markDefs: [], children: inlineSpans(l.trim().slice(2)) });
      });
      return;
    }
    if (/^###\s+/.test(group)) {
      blocks.push({ _type: "block", _key: portableKey(), style: "h4", markDefs: [], children: inlineSpans(group.replace(/^###\s+/, "")) });
      return;
    }
    if (/^##\s+/.test(group)) {
      blocks.push({ _type: "block", _key: portableKey(), style: "h3", markDefs: [], children: inlineSpans(group.replace(/^##\s+/, "")) });
      return;
    }
    if (/^#\s+/.test(group)) {
      blocks.push({ _type: "block", _key: portableKey(), style: "h2", markDefs: [], children: inlineSpans(group.replace(/^#\s+/, "")) });
      return;
    }
    blocks.push({ _type: "block", _key: portableKey(), style: "normal", markDefs: [], children: inlineSpans(lines.join(" ")) });
  });
  return blocks;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

// Best-effort reference lookup — never fabricates an author/category
// document, and never fails the publish if no match exists; the
// article just publishes without that reference, same as if an editor
// left the field blank in Sanity Studio.
async function findReference(client, type, fieldName, value) {
  if (!value) return null;
  try {
    const doc = await client.fetch(`*[_type == $type && ${fieldName} == $value][0]{_id}`, { type, value });
    return doc?._id || null;
  } catch {
    return null;
  }
}

async function uploadImageIfNeeded(client, imageUrl, baseUrl) {
  if (!imageUrl) return null;
  try {
    const absoluteUrl = /^https?:\/\//.test(imageUrl) ? imageUrl : `${baseUrl || ""}${imageUrl}`;
    const response = await fetch(absoluteUrl);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const asset = await client.assets.upload("image", buffer, { filename: imageUrl.split("/").pop() || "cover.jpg" });
    return { _type: "image", asset: { _type: "reference", _ref: asset._id } };
  } catch {
    return null;
  }
}

// Creates or updates the DRAFT Sanity document for a content item.
// Never touches the published version — that only happens in
// publishToSanity(). Returns { ok, document_id, warnings }.
async function saveDraftToSanity(item, { baseUrl } = {}) {
  const client = sanityClient();
  if (!client) return { ok: false, skipped: true, reason: "sanity_not_configured" };

  const warnings = [];
  const id = item.sanity_document_id || `post-${item.id}`;
  const draftId = `drafts.${id}`;

  const [authorRef, categoryRef, coverImage] = await Promise.all([
    findReference(client, "author", "name", item.author),
    findReference(client, "category", "title", item.category),
    uploadImageIfNeeded(client, item.featured_image_url, baseUrl),
  ]);
  if (item.author && !authorRef) warnings.push(`No matching Sanity author named "${item.author}" — publish without one, or create it in Sanity Studio first.`);
  if (item.category && !categoryRef) warnings.push(`No matching Sanity category named "${item.category}" — publish without one, or create it in Sanity Studio first.`);
  if (item.featured_image_url && !coverImage) warnings.push("Featured image could not be uploaded to Sanity — publishing without a cover image.");

  const doc = {
    _id: draftId,
    _type: "post",
    title: item.title,
    slug: { _type: "slug", current: item.slug || slugify(item.title) },
    excerpt: item.excerpt || "",
    tags: item.tags || [],
    body: textToPortableText(item.body),
    seoTitle: item.seo_title || undefined,
    seoDescription: item.seo_description || undefined,
    featured: false,
    updatedAt: new Date().toISOString(),
  };
  if (authorRef) doc.author = { _type: "reference", _ref: authorRef };
  if (categoryRef) doc.category = { _type: "reference", _ref: categoryRef };
  if (coverImage) doc.coverImage = coverImage;

  await client.createOrReplace(doc);
  return { ok: true, document_id: id, warnings };
}

// Publishes: copy the draft's current field values onto the bare
// (published) id, then remove the draft — the same effect as clicking
// Publish in Sanity Studio.
async function publishToSanity(documentId, { publishedAt } = {}) {
  const client = sanityClient();
  if (!client) return { ok: false, skipped: true, reason: "sanity_not_configured" };
  const draftId = `drafts.${documentId}`;
  const draft = await client.getDocument(draftId).catch(() => null);
  const source = draft || (await client.getDocument(documentId).catch(() => null));
  if (!source) return { ok: false, reason: "document_not_found" };

  const published = {
    ...source,
    _id: documentId,
    publishedAt: publishedAt || source.publishedAt || new Date().toISOString(),
  };
  await client.createOrReplace(published);
  if (draft) {
    await client.delete(draftId).catch(() => null);
  }
  return { ok: true, document_id: documentId };
}

// Unpublish: move the published document back to a draft (Sanity
// Studio's own "Unpublish" behavior), never a hard delete — the
// content stays recoverable.
async function unpublishFromSanity(documentId) {
  const client = sanityClient();
  if (!client) return { ok: false, skipped: true, reason: "sanity_not_configured" };
  const published = await client.getDocument(documentId).catch(() => null);
  if (!published) return { ok: false, reason: "document_not_found" };
  await client.createIfNotExists({ ...published, _id: `drafts.${documentId}` });
  await client.delete(documentId).catch(() => null);
  return { ok: true, document_id: documentId };
}

module.exports = {
  sanityConfigured,
  saveDraftToSanity,
  publishToSanity,
  unpublishFromSanity,
  slugify,
  textToPortableText,
};
