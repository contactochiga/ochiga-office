"use strict";
// Preloaded into the SUT process with NODE_OPTIONS=--require. It redirects ONLY outbound calls to the e-mail provider (https://api.resend.com/emails)
// to a loopback capture endpoint (MAIL_CAPTURE_URL) owned by the test. The SUT source is not modified. All other fetches are untouched.
const realFetch = globalThis.fetch;
const target = process.env.MAIL_CAPTURE_URL;
if (target && realFetch) {
  globalThis.fetch = function patchedFetch(url, init) {
    const u = typeof url === "string" ? url : url && url.url;
    if (typeof u === "string" && u.startsWith("https://api.resend.com/")) return realFetch(target, init);
    return realFetch(url, init);
  };
}
