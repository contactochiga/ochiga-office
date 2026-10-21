"use strict";
// Test-harness preload for the SUT child process (the SUT itself is never modified): intercepts the one outbound e-mail call
// (https://api.resend.com/emails) and appends the message to the file named by MAIL_CAPTURE_FILE. Everything else is untouched.
const fs = require("fs");
const realFetch = globalThis.fetch;
globalThis.fetch = async function stubbedFetch(url, init) {
  const u = String(url && url.url ? url.url : url);
  if (u === "https://api.resend.com/emails") {
    try {
      const body = JSON.parse(init && init.body ? init.body : "{}");
      fs.appendFileSync(process.env.MAIL_CAPTURE_FILE, JSON.stringify({ at: Date.now(), to: body.to, subject: body.subject, text: body.text }) + "\n");
    } catch { /* capture only */ }
    if (process.env.MAIL_FAIL === "1") return new Response(JSON.stringify({ message: "stub failure" }), { status: 500, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "stub" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, init);
};
