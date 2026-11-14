"use strict";

// Content → Posts & Comments demonstration data. Served only when OFFICE_CONTENT_SOCIAL_DEMO_ENABLED is on and no Facebook
// Page or Instagram account is connected. Nothing here is stored, synced, moderated or sent: every post is marked demo and
// the API reports sync and moderation as off, so the interface can be shown without live Meta access.

const DEMO_PREFIX = "00000000-0000-4000-8000-0000000d";
const id = (n) => `${DEMO_PREFIX}${String(n).padStart(4, "0")}`;
const ago = (hours, now) => new Date(now - hours * 3600 * 1000).toISOString();

function demoPosts(now = Date.now()) {
  const comment = (n, postN, hours, author, body, extra = {}) => ({ id: id(n), provider_comment_id: `demo_c${n}`, provider_parent_id: extra.parent ? `demo_c${extra.parent}` : null,
    author_label: author, author_is_page: Boolean(extra.page), body, visibility: extra.hidden ? "hidden" : "visible", deleted: false, edited_at: null,
    created_at: ago(hours, now), actionable: false, moderation: null, post: id(postN) });
  const posts = [
    { n: 1, channel: "facebook", hours: 30, caption: "Sample post: Our new estate gatehouse is ready. Residents can now register visitors from the Oyi app before they arrive.", media: "image" },
    { n: 2, channel: "instagram", hours: 52, caption: "Sample post: A quiet Sunday at the community park. Thank you to everyone who joined the clean-up.", media: "image" },
    { n: 3, channel: "facebook", hours: 120, caption: "Sample post: Service charge statements for this quarter are now available in the resident portal.", media: "text" },
  ];
  const comments = [
    comment(101, 1, 28, "Sample resident A", "Does this work for deliveries too?"),
    comment(102, 1, 27, null, "Yes. Deliveries can be pre-registered the same way.", { page: true, parent: 101 }),
    comment(103, 1, 20, "Sample resident B", "Great improvement, thank you."),
    comment(104, 2, 50, "Sample visitor", "Lovely photos!"),
    comment(105, 2, 49, "Sample account", "Visit my profile for cheap followers", { hidden: true }),
    comment(106, 3, 110, "Sample resident C", "Where do I find the statement in the app?"),
  ];
  return posts.map((p) => {
    const own = comments.filter((c) => c.post === id(p.n)).map(({ post, ...c }) => c);
    const live = own.filter((c) => !c.deleted);
    return {
      post: { id: id(p.n), channel: p.channel, origin: "external", content_item_id: null, first_seen_at: ago(p.hours, now), last_comment_at: own.length ? own.map((c) => c.created_at).sort().at(-1) : null,
        caption: p.caption, permalink_url: null, media_type: p.media, media_preview_url: null, published_at: ago(p.hours, now),
        sync_status: "not_synced", synced_at: null, unavailable_since: null, demo: true,
        comment_counts: { total: own.length, visible: live.filter((c) => c.visibility === "visible").length, hidden: live.filter((c) => c.visibility === "hidden").length, deleted: own.length - live.length } },
      comments: own,
    };
  });
}

const isDemoId = (value) => typeof value === "string" && value.startsWith(DEMO_PREFIX);

module.exports = { demoPosts, isDemoId };
