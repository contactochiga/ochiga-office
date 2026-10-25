"use strict";
// Merchandising contains references, never a second product/price/media database.
const { httpError } = require("./catalogue");
const EMPTY = Object.freeze({
  slides: [],
  featured: [],
  new_arrivals: [],
  collections: [],
});
const slug = (v) =>
  typeof v === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) && v.length <= 80;
function text(v, max, required = true) {
  if (typeof v !== "string" || v.length > max || (required && !v.trim()))
    throw httpError(400, "invalid_campaign_text");
  return v.trim();
}
function refs(v) {
  if (
    !Array.isArray(v) ||
    v.length > 24 ||
    v.some((s) => !slug(s)) ||
    new Set(v).size !== v.length
  )
    throw httpError(400, "invalid_campaign_products");
  return [...v];
}
function time(v) {
  if (v === null || v === "" || v === undefined) return null;
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d\d-\d\dT/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw httpError(400, "invalid_campaign_schedule");
  return new Date(v).toISOString();
}
function normalize(input) {
  if (
    !input ||
    !Array.isArray(input.slides) ||
    input.slides.length > 8 ||
    !Array.isArray(input.collections) ||
    input.collections.length > 8
  )
    throw httpError(400, "invalid_merchandising");
  const slides = input.slides.map((s) => {
    if (
      !slug(s.key) ||
      !slug(s.product) ||
      !/^media\/[0-9a-f]{64}\.webp$/.test(s.image || "")
    )
      throw httpError(400, "invalid_campaign_reference");
    if (
      !Number.isInteger(s.durationMs) ||
      s.durationMs < 3000 ||
      s.durationMs > 20000
    )
      throw httpError(400, "invalid_campaign_duration");
    const startsAt = time(s.startsAt),
      endsAt = time(s.endsAt);
    if (startsAt && endsAt && startsAt >= endsAt)
      throw httpError(400, "invalid_campaign_schedule");
    // Explicit safe internal destinations only; no open redirect, protocol or arbitrary purchase URL.
    if (
      ![
        "#browse",
        "#categories",
        "/contact?type=tech_oem",
        `/hardware/${s.product}`,
      ].includes(s.ctaHref)
    )
      throw httpError(400, "invalid_campaign_cta");
    return {
      key: s.key,
      product: s.product,
      image: s.image,
      eyebrow: text(s.eyebrow, 80),
      title: text(s.title, 100),
      description: text(s.description, 300),
      ctaLabel: text(s.ctaLabel, 60),
      ctaHref: s.ctaHref,
      durationMs: s.durationMs,
      startsAt,
      endsAt,
    };
  });
  const collections = input.collections.map((c) => {
    if (!slug(c.key)) throw httpError(400, "invalid_collection_key");
    return {
      key: c.key,
      title: text(c.title, 100),
      description: text(c.description, 300, false),
      products: refs(c.products),
    };
  });
  if (
    new Set(slides.map((s) => s.key)).size !== slides.length ||
    new Set(collections.map((s) => s.key)).size !== collections.length
  )
    throw httpError(400, "duplicate_campaign_key");
  return {
    slides,
    featured: refs(input.featured),
    new_arrivals: refs(input.new_arrivals),
    collections,
  };
}
function project(content, products, now = Date.now()) {
  try {
    content = normalize(content || EMPTY);
  } catch {
    return structuredClone(EMPTY);
  }
  const eligible = new Map(
    products
      .filter((p) => p.availability !== "unavailable")
      .map((p) => [p.slug, p]),
  );
  const pick = (xs) => (xs || []).filter((s) => eligible.has(s));
  return {
    slides: (content?.slides || []).flatMap((s) => {
      const p = eligible.get(s.product),
        image = p?.images.find((i) => i.src === s.image);
      if (
        !p ||
        !image ||
        (s.startsAt && Date.parse(s.startsAt) > now) ||
        (s.endsAt && Date.parse(s.endsAt) <= now)
      )
        return [];
      return [
        {
          key: s.key,
          eyebrow: s.eyebrow,
          title: s.title,
          description: s.description,
          ctaLabel: s.ctaLabel,
          ctaHref: s.ctaHref,
          durationMs: s.durationMs,
          image: { src: image.src, alt: image.alt },
        },
      ];
    }),
    featured: pick(content?.featured),
    new_arrivals: pick(content?.new_arrivals),
    collections: (content?.collections || [])
      .map((c) => ({
        key: c.key,
        title: c.title,
        description: c.description,
        products: pick(c.products),
      }))
      .filter((c) => c.products.length),
  };
}
function assertEligible(content, products) {
  const eligible = new Map(
    products
      .filter((p) => p.availability !== "unavailable")
      .map((p) => [p.slug, p]),
  );
  if (
    [
      ...content.featured,
      ...content.new_arrivals,
      ...content.collections.flatMap((c) => c.products),
      ...content.slides.map((s) => s.product),
    ].some((s) => !eligible.has(s))
  )
    throw httpError(409, "campaign_product_not_public");
  if (
    content.slides.some(
      (s) => !eligible.get(s.product)?.images.some((i) => i.src === s.image),
    )
  )
    throw httpError(409, "campaign_image_not_public");
}
const initial = () => ({
  id: 1,
  row_version: 0,
  current_version: 0,
  published_version: null,
  workflow: "draft",
  authors: [],
  versions: [],
  events: [],
});
function transition(state, { action, expected, content, actor, note = "" }) {
  if (
    !actor ||
    !Number.isSafeInteger(expected) ||
    expected !== state.row_version
  )
    throw httpError(409, "state_changed");
  const s = structuredClone(state),
    at = new Date().toISOString();
  if (action === "save") {
    s.current_version++;
    s.authors = [
      ...new Set([...(s.workflow === "published" ? [] : s.authors), actor]),
    ];
    s.workflow = "draft";
    s.versions.push({
      version: s.current_version,
      content: normalize(content),
      authors: [...s.authors],
      created_at: at,
    });
  } else if (action === "submit" && s.current_version && s.workflow === "draft")
    s.workflow = "in_review";
  else if (action === "approve" && s.workflow === "in_review") {
    if (s.authors.includes(actor))
      throw httpError(403, "self_review_forbidden");
    s.workflow = "approved";
  } else if (action === "reject" && s.workflow === "in_review") {
    if (s.authors.includes(actor))
      throw httpError(403, "self_review_forbidden");
    s.workflow = "draft";
  } else if (action === "publish" && s.workflow === "approved") {
    s.published_version = s.current_version;
    s.workflow = "published";
  } else if (action === "withdraw" && s.published_version !== null)
    s.published_version = null;
  else throw httpError(409, "invalid_campaign_transition");
  s.row_version++;
  s.events.push({
    action,
    version: s.current_version,
    actor,
    note,
    created_at: at,
  });
  return s;
}
async function read(cat) {
  if (cat.client) {
    try {
      const state = (await cat.client.get("/catalogue_merchandising?id=eq.1"))
        .data[0];
      const versions = (
        await cat.client.get(
          "/catalogue_merchandising_versions?order=version.asc",
        )
      ).data;
      const events = (
        await cat.client.get("/catalogue_merchandising_events?order=id.asc")
      ).data;
      return { ...(state || initial()), versions, events };
    } catch {
      throw httpError(503, "merchandising_unavailable");
    }
  }
  return structuredClone(cat.s.merchandising || initial());
}
async function mutate(cat, input) {
  if (cat.client) {
    try {
      return (
        await cat.client.post("/rpc/catalogue_merchandising_transition", {
          p_action: input.action,
          p_expected: input.expected,
          p_content: input.content || null,
          p_actor: input.actor,
          p_note: input.note || "",
        })
      ).data;
    } catch (error) {
      const data = error.response?.data;
      const code = String(data?.message || "");
      if (
        [
          "state_changed",
          "self_review_forbidden",
          "invalid_campaign_transition",
          "invalid_merchandising",
          "invalid_actor",
        ].includes(code)
      )
        throw httpError(
          code === "self_review_forbidden"
            ? 403
            : ["state_changed", "invalid_campaign_transition"].includes(code)
              ? 409
              : 400,
          code,
        );
      throw httpError(503, "merchandising_unavailable");
    }
  }

  // Synchronous CAS and mutation before persistence, following FileCatalogueStore's atomic convention.
  const next = transition(cat.s.merchandising || initial(), input);
  cat.s.merchandising = next;
  await cat.persist();
  return structuredClone(next);
}
module.exports = {
  EMPTY,
  normalize,
  project,
  assertEligible,
  transition,
  initial,
  read,
  mutate,
};
