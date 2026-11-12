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
const { classifyCoverImageUrl } = require("./content-images");

let clientFactory = createClient;
// Tests only: replaces the Sanity client constructor (null restores the real one). Never used by the server.
function setSanityClientFactoryForTests(factory) {
  clientFactory = factory || createClient;
  cachedClient = null;
}

function sanityConfigured() {
  return Boolean(process.env.SANITY_PROJECT_ID && process.env.SANITY_DATASET && process.env.SANITY_API_WRITE_TOKEN);
}

let cachedClient = null;
function sanityClient() {
  if (!sanityConfigured()) return null;
  if (cachedClient) return cachedClient;
  cachedClient = clientFactory({
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

// The cover already on the Sanity document (draft first, then published), so an image that cannot be sent never removes what the site shows.
// A read error is thrown (the save then fails and nothing is published), never taken as "no cover".
async function existingCoverImage(client, documentIds) {
  for (const id of documentIds) {
    const doc = await client.getDocument(id);
    if (doc && doc.coverImage && doc.coverImage.asset) return doc.coverImage;
  }
  return null;
}

const COVER_PROBLEMS = Object.freeze({
  image_not_found: "the uploaded file is no longer in Office storage",
  image_too_large: "the file is larger than 10 MB",
  unsupported_image_type: "the file is not a JPEG, PNG or WebP image",
  image_unreadable: "the file is not a readable JPEG, PNG or WebP image",
});

// The server never requests a cover URL (content-images.js): an Office upload is read from Office storage, a Sanity image is referenced by asset id,
// and anything else keeps the document's current cover with a warning. Returns { image, warning }; image undefined means "leave the cover as it is".
async function resolveCoverImage(client, imageUrl, kind, { readStoredImage, documentIds, label }) {
  const source = classifyCoverImageUrl(imageUrl, kind, { sanityProjectId: process.env.SANITY_PROJECT_ID, sanityDataset: process.env.SANITY_DATASET });
  if (source.kind === "none") return { image: null };
  if (source.kind === "sanity_asset") return { image: { _type: "image", asset: { _type: "reference", _ref: source.assetId } } };
  let problem;
  if (source.kind === "office") {
    if (typeof readStoredImage !== "function") {
      problem = "Office storage is not available to this sync";
    } else {
      let file = null;
      try {
        file = await readStoredImage(source.filename);
      } catch (err) {
        problem = COVER_PROBLEMS[err && err.code] || "Office storage could not be read";
      }
      if (file) {
        try {
          const asset = await client.assets.upload("image", file.buffer, { filename: file.filename, contentType: file.mime_type });
          return { image: { _type: "image", asset: { _type: "reference", _ref: asset._id } } };
        } catch {
          problem = "Sanity did not accept the upload";
        }
      }
    }
  } else {
    problem = source.detail === "external_url"
      ? `it is a link to ${source.host}, and Office does not download images from links`
      : "it is not an image uploaded in Office";
  }
  const kept = await existingCoverImage(client, documentIds);
  const next = kept ? `The ${label} already in Sanity was kept.` : `Sanity has no ${label} for it.`;
  return { image: kept || null, warning: `${label[0].toUpperCase()}${label.slice(1)} not sent: ${problem}. ${next} Upload the image in Office to replace it.` };
}

// Creates or updates the DRAFT Sanity document for a content item.
// Never touches the published version — that only happens in
// publishToSanity(). Returns { ok, document_id, warnings }.
// readStoredImage(filename) reads an Office-uploaded cover (content-images.js readStoredCoverImage bound to the storage service).
async function saveDraftToSanity(item, { readStoredImage } = {}) {
  const client = sanityClient();
  if (!client) return { ok: false, skipped: true, reason: "sanity_not_configured" };

  const warnings = [];
  const id = item.sanity_document_id || `post-${item.id}`;
  const draftId = `drafts.${id}`;

  const [authorRef, categoryRef, cover] = await Promise.all([
    findReference(client, "author", "name", item.author),
    findReference(client, "category", "title", item.category),
    resolveCoverImage(client, item.featured_image_url, "content", { readStoredImage, documentIds: [draftId, id], label: "featured image" }),
  ]);
  const coverImage = cover.image;
  if (item.author && !authorRef) warnings.push(`No matching Sanity author named "${item.author}" — publish without one, or create it in Sanity Studio first.`);
  if (item.category && !categoryRef) warnings.push(`No matching Sanity category named "${item.category}" — publish without one, or create it in Sanity Studio first.`);
  if (cover.warning) warnings.push(cover.warning);

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

  const saved = await client.createOrReplace(doc);
  return { ok: true, document_id: id, warnings, draft_rev: (saved && saved._rev) || null };
}

// Read-only snapshot of what Sanity holds for a content item right now -- the live and draft documents (cover, author, category) and whether the
// item's author and category exist in Sanity -- so Office can tell current issues from warnings recorded at an earlier sync. Never writes; a
// Sanity read error is thrown (the caller reports it) rather than reported as "missing".
async function inspectSanityPost(item) {
  const client = sanityClient();
  if (!client) return { configured: false };
  const id = item.sanity_document_id || `post-${item.id}`;
  const [published, draft, authorId, categoryId] = await Promise.all([
    client.getDocument(id),
    client.getDocument(`drafts.${id}`),
    item.author ? client.fetch(`*[_type == "author" && name == $value][0]._id`, { value: item.author }) : null,
    item.category ? client.fetch(`*[_type == "category" && title == $value][0]._id`, { value: item.category }) : null,
  ]);
  const summary = (doc) => (doc ? { exists: true, has_cover: Boolean(doc.coverImage && doc.coverImage.asset), has_author: Boolean(doc.author), has_category: Boolean(doc.category), updated_at: doc._updatedAt || null } : { exists: false });
  return {
    configured: true,
    checked_at: new Date().toISOString(),
    document_id: id,
    published: summary(published),
    draft: summary(draft),
    author: item.author ? { name: item.author, found: Boolean(authorId) } : null,
    category: item.category ? { name: item.category, found: Boolean(categoryId) } : null,
  };
}

// Publishes: copy the draft's current field values onto the bare
// (published) id, then remove the draft — the same effect as clicking
// Publish in Sanity Studio. With expectedDraftRev (the revision
// saveDraftToSanity just wrote), a draft that changed in between — e.g.
// a concurrent edit — is refused instead of published.
async function publishToSanity(documentId, { publishedAt, expectedDraftRev } = {}) {
  const client = sanityClient();
  if (!client) return { ok: false, skipped: true, reason: "sanity_not_configured" };
  const draftId = `drafts.${documentId}`;
  const draft = await client.getDocument(draftId).catch(() => null);
  if (expectedDraftRev && (!draft || draft._rev !== expectedDraftRev)) return { ok: false, reason: "draft_changed_before_publish" };
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

// Development Management (Programme 11) — deliberately simpler than the
// post workflow: no author/category references, no draft/publish
// distinction. A synced project is always "live" (these 3 projects are
// already on the public site today; this only takes over managing
// their status/progress fields, not introducing a new unpublished
// state for content that already exists publicly). One direct
// createOrReplace per save.
async function syncDevelopmentProjectToSanity(project, { readStoredImage } = {}) {
  const client = sanityClient();
  if (!client) return { ok: false, skipped: true, reason: "sanity_not_configured" };
  const id = project.sanity_document_id || `development-project-${project.slug || project.id}`;

  const warnings = [];
  const cover = await resolveCoverImage(client, project.cover_image_url, "development", { readStoredImage, documentIds: [id], label: "cover image" });
  if (cover.warning) warnings.push(cover.warning);
  const coverImage = cover.image ? { ...cover.image } : null;
  if (coverImage && project.cover_image_alt) coverImage.alt = project.cover_image_alt;

  const doc = {
    _id: id,
    _type: "developmentProject",
    name: project.name,
    slug: { _type: "slug", current: project.slug || slugify(project.name) },
    typeLine: project.type_line || undefined,
    location: project.location || undefined,
    status: project.status || undefined,
    oneLiner: project.one_liner || undefined,
    statusStages: project.status_stages || [],
    statusActiveIndex: project.status_active_index ?? 0,
    order: Number.isFinite(project.display_order) ? project.display_order : 0,
    updatedAt: new Date().toISOString(),
  };
  if (coverImage) doc.coverImage = coverImage;
  await client.createOrReplace(doc);
  return { ok: true, document_id: id, warnings };
}

module.exports = {
  sanityConfigured,
  saveDraftToSanity,
  publishToSanity,
  unpublishFromSanity,
  inspectSanityPost,
  syncDevelopmentProjectToSanity,
  slugify,
  textToPortableText,
  setSanityClientFactoryForTests,
};
