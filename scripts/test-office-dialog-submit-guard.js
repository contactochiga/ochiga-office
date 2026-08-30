const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Fixes the double-submit bug found during production E2E verification of
// the Office->Facility provisioning lifecycle (two rapid clicks on New
// Facility created two Portfolio records, "james Hotel" twice, 3ms
// apart). openDialog's submit handler is shared by every dialog in
// Office (New Facility included), so the fix lives there once rather
// than being duplicated per-dialog. No DOM-testing infrastructure exists
// in this repo (confirmed: no jsdom/puppeteer/playwright dependency), so
// this is a static-source assertion against the actual shipped file,
// matching every other Office frontend check's convention.

const officeJsPath = path.join(__dirname, "..", "public", "office", "office.js");
const src = fs.readFileSync(officeJsPath, "utf8");

const submitHandlerMatch = src.match(/card\.addEventListener\("submit", async \(event\) => \{[\s\S]*?\n  \}\);/);
assert.ok(submitHandlerMatch, "openDialog's submit handler must exist");
const handler = submitHandlerMatch[0];

// The guard must be checked and set BEFORE the first await (data
// creation / onSubmit call), so a second submit event firing while the
// first is still in flight is rejected synchronously, not racily.
const guardCheckIndex = handler.indexOf('dataset.submitting === "true") return;');
const disableIndex = handler.indexOf("submitButton.disabled = true;");
const firstAwaitIndex = handler.indexOf("await onSubmit(data)");
assert.ok(guardCheckIndex !== -1, "the submit handler must check a single-flight guard flag");
assert.ok(disableIndex !== -1, "the submit button must be disabled");
assert.ok(firstAwaitIndex !== -1, "the handler must still call onSubmit");
assert.ok(guardCheckIndex < firstAwaitIndex, "the guard check must happen before onSubmit is ever awaited");
assert.ok(disableIndex < firstAwaitIndex, "the submit button must be disabled before onSubmit is awaited, not after");

// A loading/progress state must be shown, not just a disabled button with
// no feedback.
assert.match(handler, /submitButton\.textContent = "Saving\.\.\."/, "the button must show a loading label while the request is in flight");

// On failure, the guard and button must reset so a legitimate retry is
// still possible -- this is not a permanent lockout.
assert.match(handler, /catch \(err\) \{[\s\S]*submitButton\.disabled = false;[\s\S]*submitButton\.dataset\.submitting = "false";/, "the guard must reset on failure so the user can retry");

// New Facility's own submit path must still go through this same shared
// handler, not a bespoke duplicate that could drift out of sync.
assert.match(src, /function openNewFacilityDialog\(prefill = \{\}\) \{\s*\n\s*openDialog\(/, "New Facility must still be built on the shared openDialog primitive");

console.log("office dialog submit guard smoke passed");
