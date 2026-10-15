#!/usr/bin/env node
// Local, offline helper for verifying Meta webhook credentials WITHOUT ever printing or storing a secret. Prints only MATCH / MISMATCH.
//
//   compare:  META_SECRET_A=<value from Render> META_SECRET_B=<value from the Meta app dashboard> node scripts/verify-meta-webhook-signature.js compare
//             (values are read from the environment only; compared with a timing-safe hash comparison; nothing is echoed)
//   sample:   META_APP_SECRET=<secret> node scripts/verify-meta-webhook-signature.js sample --body-file body.json --signature "sha256=<hex>"
//             verifies a captured webhook delivery (exact body bytes + X-Hub-Signature-256 header) the same way the server does.
//
// Tip: set the variables for one command only, e.g. `read -s META_SECRET_A; export META_SECRET_A` so they never enter shell history.
const crypto = require("node:crypto");
const fs = require("node:fs");
const { WhatsAppCloudAdapter } = require("../src/lead-agents/whatsapp");

const [, , mode, ...args] = process.argv;
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
const digest = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest();

if (mode === "compare") {
  const a = process.env.META_SECRET_A || "", b = process.env.META_SECRET_B || "";
  if (!a || !b) { console.error("Set META_SECRET_A and META_SECRET_B in the environment."); process.exit(2); }
  const same = crypto.timingSafeEqual(digest(a), digest(b));
  const shapeNote = a.length === b.length ? "" : " (the two values have different lengths)";
  console.log(same ? "MATCH" : `MISMATCH${shapeNote}`);
  process.exit(same ? 0 : 1);
} else if (mode === "sample") {
  const secret = process.env.META_APP_SECRET || "";
  const file = arg("--body-file"), header = arg("--signature");
  if (!secret || !file || !header) { console.error("Need META_APP_SECRET (env), --body-file and --signature."); process.exit(2); }
  const result = new WhatsAppCloudAdapter({ metaAppSecret: secret }).verifySignature(fs.readFileSync(file), header);
  console.log(result.ok ? `MATCH (verified over: ${result.method})` : `MISMATCH (${result.reason})`);
  process.exit(result.ok ? 0 : 1);
} else {
  console.error("Usage: verify-meta-webhook-signature.js compare | sample --body-file <file> --signature <header>");
  process.exit(2);
}
