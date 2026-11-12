"use strict";

// Content approval integrity (Content / Publishing, Phase 8).
//
// An approval covers ONE exact version of an article. Approving records a fingerprint of every editorial field in metadata.approval; any later edit that changes
// that version withdraws the approval (the article returns to draft and must be reviewed again), and publishing -- by a publisher or by the scheduler -- refuses
// anything whose current content does not match the approved fingerprint. An approved/scheduled item with no recorded fingerprint (approved before this check
// existed) cannot be proven to be the approved version, so it is refused too. A refused item goes back to "in_review" (not draft: nothing needs rewriting, only a
// fresh approval). Pure functions only; callers do the writes and audit.

const crypto = require("crypto");

// Exactly the fields a writer can change (the PATCH allow-list) -- every one of them reaches the published Sanity document.
const CONTENT_FIELDS = Object.freeze(["title", "slug", "excerpt", "category", "author", "tags", "body", "featured_image_url", "seo_title", "seo_description"]);
const APPROVAL_BOUND_STATUSES = Object.freeze(["approved", "scheduled"]);
const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

// Stores differ in how an empty field comes back (file store "", Supabase null); both mean "empty" and must fingerprint identically.
function canonicalValue(field, value) {
  if (field === "tags") return Array.isArray(value) ? value.map((tag) => String(tag ?? "")) : [];
  return value === null || value === undefined ? "" : String(value);
}

function contentFingerprint(item) {
  const source = item && typeof item === "object" ? item : {};
  const canonical = CONTENT_FIELDS.map((field) => [field, canonicalValue(field, source[field])]);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function approvalRecord(item) {
  const approval = item && item.metadata && typeof item.metadata === "object" ? item.metadata.approval : null;
  return approval && typeof approval === "object" && typeof approval.fingerprint === "string" ? approval : null;
}

function buildApproval(item, approvedBy, now = new Date()) {
  return { fingerprint: contentFingerprint(item), approved_by: approvedBy || "", approved_at: now.toISOString() };
}

// metadata without the approval record (used whenever an approval stops applying)
function withoutApproval(metadata) {
  const next = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
  delete next.approval;
  return next;
}

// Can this item be published as it stands? { ok, reason } -- reason is "no_approval_record" or "content_changed_since_approval".
function verifyApprovedVersion(item) {
  const approval = approvalRecord(item);
  if (!approval) return { ok: false, reason: "no_approval_record" };
  if (approval.fingerprint !== contentFingerprint(item)) return { ok: false, reason: "content_changed_since_approval" };
  return { ok: true, reason: null };
}

// Does saving `next` (the item after a PATCH) withdraw the approval held by `before`? Only for approval-bound statuses, and only when the content really changed.
function editWithdrawsApproval(before, next) {
  if (!before || !APPROVAL_BOUND_STATUSES.includes(before.workflow_status)) return false;
  return contentFingerprint(before) !== contentFingerprint(next);
}

// Validates a requested publish time: a real, timezone-qualified instant, in the future, at most about a year ahead. Returns { ok, iso, error }.
function validateScheduledPublishAt(value, now = new Date()) {
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "scheduled_publish_at is required" };
  const raw = value.trim();
  // A time without a timezone would be read in the server's zone, not the publisher's -- refuse rather than guess.
  const parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/i);
  if (!parts) return { ok: false, error: "scheduled_publish_at must be an ISO 8601 date and time with a timezone, e.g. 2026-12-01T09:00:00Z" };
  // Date() silently rolls impossible calendar values over (2026-02-30 becomes 2 March), so the fields are checked first.
  const [, year, month, day, hour, minute, second = "0", offsetHour = "0", offsetMinute = "0"] = parts;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 14 || Number(offsetMinute) > 59) {
    return { ok: false, error: "scheduled_publish_at is not a valid date" };
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { ok: false, error: "scheduled_publish_at is not a valid date" };
  if (at.getTime() <= now.getTime()) return { ok: false, error: "scheduled_publish_at must be in the future" };
  if (at.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) return { ok: false, error: "scheduled_publish_at must be within one year" };
  return { ok: true, iso: at.toISOString(), error: null };
}

// A refused item is returned to review (callers do that), so the messages say what already happened.
const REFUSAL_MESSAGES = Object.freeze({
  no_approval_record: "This article has no recorded approval for its current version, so it was not published. It has been returned to review; a reviewer must approve it again.",
  content_changed_since_approval: "This article changed after it was approved, so it was not published. It has been returned to review; a reviewer must approve it again.",
});

// The patch that returns a refused item to review: no schedule, no approval.
function returnToReviewPatch(item) {
  return { workflow_status: "in_review", scheduled_publish_at: null, metadata: withoutApproval(item && item.metadata) };
}

module.exports = {
  CONTENT_FIELDS,
  APPROVAL_BOUND_STATUSES,
  MAX_SCHEDULE_AHEAD_MS,
  REFUSAL_MESSAGES,
  contentFingerprint,
  approvalRecord,
  buildApproval,
  withoutApproval,
  returnToReviewPatch,
  verifyApprovedVersion,
  editWithdrawsApproval,
  validateScheduledPublishAt,
};
