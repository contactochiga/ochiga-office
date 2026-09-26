// Wave 9 Slice 4 -- product-positioning convergence guard for the Office
// knowledge pack (knowledge/*.md, served to Backend Core through
// /api/lead-agents/admin/knowledge-pack).
//
// Backend `backend:corporate-company` / `backend:corporate-oyi` are the
// canonical institutional identity: Ochiga develops and powers intelligent
// places (three engines); Oyi is Ochiga's building operating technology.
// This guard keeps the Office pack from re-asserting the retired
// "infrastructure technology company / Infrastructure Operating System"
// identity, keeps "operating system" language subordinate (commercial
// shorthand), pins the current website structure, and proves the useful
// package/sales material is preserved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "knowledge");
const files = Object.fromEntries(
  fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")])
);

// Internal-only files not yet reconciled (Osa/staff/executive audience; out
// of this slice's scope). Listed so the deferral is explicit and the guard
// fails if any OTHER file regresses.
const DEFERRED = new Set(["pitch-deck-positioning.md", "business-model-and-current-maturity.md"]);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const RETIRED_IDENTITY = [
  /\bOchiga (is an?|builds) infrastructure technology\b/i,
  /\binfrastructure technology company\b/i,
  /\bOyi is (Ochiga's |its |an? |the )?infrastructure operating system\b/i,
  /\bOchiga is building infrastructure operating systems\b/i,
  /\bOyi is (an? |the )?operating system\b/i,
  /\bInfrastructure OS\b/,
];
const RETIRED_MARKER = /\b(retired|do not use|no longer)\b/i;

test("no knowledge file asserts the retired institutional identity (except explicit 'retired' notes)", () => {
  const violations = [];
  for (const [file, text] of Object.entries(files)) {
    if (DEFERRED.has(file)) continue;
    text.split("\n").forEach((line, i) => {
      if (RETIRED_IDENTITY.some((re) => re.test(line)) && !RETIRED_MARKER.test(line)) violations.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(violations, []);
});

test("every file that defines Oyi uses the canonical definition: Ochiga's building operating technology", () => {
  for (const file of ["ochiga-overview.md", "oyi-solution-map.md", "website-messaging.md", "approved-system-description.md", "company-explainer-patterns.md", "system-overview-and-surfaces.md", "objection-and-reply-guide.md", "product-boundaries-and-safe-claims.md", "commercial-proposal-logic.md", "osa-sales-narrative.md"]) {
    assert.match(files[file], /Ochiga's building operating technology/, file);
  }
});

test("'building operating system' language appears only as subordinate commercial/product shorthand", () => {
  const OS_PHRASE = /(operating system for (modern )?buildings|building operating system|one operating system)/i;
  for (const [file, text] of Object.entries(files)) {
    if (DEFERRED.has(file) || !OS_PHRASE.test(text)) continue;
    assert.match(text, /shorthand/i, `${file} uses operating-system language without marking it as shorthand`);
    assert.match(text, /Ochiga's building operating technology/, `${file} uses operating-system language without the canonical definition`);
  }
});

test("Ochiga the company is described by the canonical three-engine identity where the pack explains the company", () => {
  for (const file of ["ochiga-overview.md", "website-messaging.md", "approved-system-description.md", "company-explainer-patterns.md", "system-overview-and-surfaces.md", "objection-and-reply-guide.md", "product-boundaries-and-safe-claims.md", "websites-positioning-and-deployments.md"]) {
    assert.match(files[file], /develops and powers intelligent places/, file);
  }
});

test("website structure is current: Development, Technology, Private, Partnerships, About (ochiga.com.ng); retired sections only listed as retired", () => {
  const text = files["websites-positioning-and-deployments.md"];
  const nav = text.slice(text.indexOf("Main navigation:"), text.indexOf("getoyi.com —"));
  for (const section of ["Development", "Technology", "Private", "Partnerships", "About"]) assert.match(nav, new RegExp(`^- ${section}:`, "m"), section);
  for (const retired of ["Solutions", "Architecture", "Governance", "Command Center", "Engage", "Console", "Papers"]) {
    assert.doesNotMatch(nav, new RegExp(`^- ${retired}\\b`, "m"), `${retired} listed as a current ochiga.com.ng section`);
  }
  assert.match(text, /Retired structure/);
  assert.match(text, /getoyi\.com[^\n]*Main navigation: Oyi, Solutions, Technology, Hardware, Partners, Developers/);
  assert.doesNotMatch(files["website-messaging.md"], /Current strong public phrases/);
});

test("useful package and sales material is preserved", () => {
  const packages = ["Oyi Core", "Oyi Operations", "Oyi Infrastructure", "Oyi Command Center"];
  for (const file of ["commercial-proposal-logic.md", "osa-sales-narrative.md", "ochiga-overview.md"]) {
    for (const pkg of packages) assert.ok(files[file].includes(pkg), `${file}: ${pkg}`);
  }
  const proposal = files["commercial-proposal-logic.md"];
  for (const step of ["1. Client Overview", "3. Recommended Oyi Package", "10. Commercial Estimate", "11. Next Steps"]) assert.ok(proposal.includes(step), step);
  assert.match(proposal, /Hardware is always separate/);
  assert.match(proposal, /Oyi by Ochiga — The Operating System For Modern Buildings\./, "proposal headline kept as shorthand");
  const osa = files["osa-sales-narrative.md"];
  for (const step of ["1. Discovery", "2. Building Review / Site Visit", "3. Proposal", "7. Customer onboarding"]) assert.ok(osa.includes(step), step);
  assert.match(osa, /WhatsApp is communication; Oyi is operations\./);
});

test("the product structure matches the canonical four working parts (no 'Infrastructure OS' product)", () => {
  const overview = files["ochiga-overview.md"];
  for (const part of ["Facility OS", "Consumer OS", "Oyi Edge", "Oyi Intelligence"]) assert.match(overview, new RegExp(`- ${part}:`), part);
  assert.doesNotMatch(overview, /Infrastructure OS/);
});

console.log(`\n=== test-knowledge-positioning: ${passed} checks passed ===`);
