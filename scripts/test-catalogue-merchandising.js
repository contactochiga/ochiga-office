"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  net = require("node:net");
const { spawn } = require("node:child_process");
const M = require("../src/lead-agents/catalogue-merchandising");
const { hashPassword } = require("../src/lead-agents/auth");
let checks = 0;
const ok = (name, fn) => {
  fn();
  checks++;
  console.log("PASS " + name);
};
const content = {
  slides: [
    {
      key: "security",
      product: "test-only",
      image: `media/${"a".repeat(64)}.webp`,
      eyebrow: "TEST ONLY",
      title: "Test story",
      description: "Isolated test fixture",
      ctaLabel: "Explore",
      ctaHref: "/hardware/test-only",
      durationMs: 3000,
      startsAt: null,
      endsAt: null,
    },
  ],
  featured: ["test-only"],
  new_arrivals: ["test-only"],
  collections: [
    {
      key: "test",
      title: "Test collection",
      description: "",
      products: ["test-only"],
    },
  ],
};
const products = [
  {
    slug: "test-only",
    availability: "in_stock",
    images: [{ src: content.slides[0].image, alt: "Test asset" }],
  },
];
const fail = (fn, code) => assert.throws(fn, (e) => e.code === code);
ok("normalization copies only approved fields", () =>
  assert.equal(M.normalize({ ...content, cost: 999 }).cost, undefined),
);
for (const [field, value, code] of [
  ["durationMs", 2999, "invalid_campaign_duration"],
  ["durationMs", 20001, "invalid_campaign_duration"],
  ["ctaHref", "javascript:alert(1)", "invalid_campaign_cta"],
  ["ctaHref", "//other.test", "invalid_campaign_cta"],
  ["image", "https://other.test/a.webp", "invalid_campaign_reference"],
  ["endsAt", "garbage", "invalid_campaign_schedule"],
])
  ok("reject " + field + " " + value, () =>
    fail(
      () =>
        M.normalize({
          ...content,
          slides: [{ ...content.slides[0], [field]: value }],
        }),
      code,
    ),
  );
ok("schedule end before start rejected", () =>
  fail(
    () =>
      M.normalize({
        ...content,
        slides: [
          {
            ...content.slides[0],
            startsAt: "2026-10-26T00:00:00Z",
            endsAt: "2026-10-25T00:00:00Z",
          },
        ],
      }),
    "invalid_campaign_schedule",
  ),
);
ok("unreleased products rejected on publish", () =>
  fail(() => M.assertEligible(content, []), "campaign_product_not_public"),
);
ok("private images rejected on publish", () =>
  fail(
    () => M.assertEligible(content, [{ ...products[0], images: [] }]),
    "campaign_image_not_public",
  ),
);
ok("published references project correctly", () =>
  assert.equal(M.project(content, products).slides.length, 1),
);
ok("withdrawn product removes all campaign placements", () =>
  assert.deepEqual(M.project(content, []), M.EMPTY),
);
ok("unavailable product removes campaign placements", () =>
  assert.deepEqual(
    M.project(content, [{ ...products[0], availability: "unavailable" }]),
    M.EMPTY,
  ),
);
ok("schedule start inclusive", () =>
  assert.equal(
    M.project(
      {
        ...content,
        slides: [{ ...content.slides[0], startsAt: "2026-10-25T12:00:00Z" }],
      },
      products,
      Date.parse("2026-10-25T12:00:00Z"),
    ).slides.length,
    1,
  ),
);
ok("schedule start future hidden", () =>
  assert.equal(
    M.project(
      {
        ...content,
        slides: [{ ...content.slides[0], startsAt: "2026-10-26T12:00:00Z" }],
      },
      products,
      Date.parse("2026-10-25T12:00:00Z"),
    ).slides.length,
    0,
  ),
);
ok("schedule expiry exclusive", () =>
  assert.equal(
    M.project(
      {
        ...content,
        slides: [{ ...content.slides[0], endsAt: "2026-10-25T12:00:00Z" }],
      },
      products,
      Date.parse("2026-10-25T12:00:00Z"),
    ).slides.length,
    0,
  ),
);
let s = M.initial();
const go = (action, actor = "writer", c = content) =>
  (s = M.transition(s, { action, expected: s.row_version, content: c, actor }));
go("save");
const first = JSON.stringify(s.versions[0]);
go("submit");
ok("self review rejected without override", () =>
  fail(() => go("approve"), "self_review_forbidden"),
);
go("approve", "reviewer");
go("publish", "publisher");
go("save");
ok("editing keeps approved live version", () =>
  assert.equal(s.published_version, 1),
);
ok("earlier history immutable", () =>
  assert.equal(JSON.stringify(s.versions[0]), first),
);
ok("draft cannot publish", () =>
  fail(() => go("publish", "publisher"), "invalid_campaign_transition"),
);
ok("stale save rejected", () =>
  fail(
    () =>
      M.transition(s, {
        action: "save",
        expected: 0,
        content,
        actor: "writer",
      }),
    "state_changed",
  ),
);
go("withdraw", "publisher");
ok("withdraw clears live pointer", () =>
  assert.equal(s.published_version, null),
);
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-merch-"));
  const secret = crypto.randomBytes(24).toString("hex"),
    key = crypto.randomBytes(24).toString("hex");
  const roles = {
    dual: ["catalogue.write", "catalogue.review"],
    writer: ["catalogue.write"],
    reviewer: ["catalogue.review"],
    publisher: ["catalogue.public.publish"],
    reader: [],
  };
  const password = "Local-Only-" + secret;
  fs.writeFileSync(
    path.join(dir, "store.json"),
    JSON.stringify({
      admin_users: Object.entries(roles).map(([name, scopes]) => ({
        id: crypto.randomUUID(),
        email: name + "@test.invalid",
        password_hash: hashPassword(password),
        role: "ochiga_staff",
        status: "active",
        permission_scopes: scopes,
      })),
    }),
  );
  const port = await new Promise((r) => {
    const n = net.createServer();
    n.listen(0, "127.0.0.1", () => {
      const p = n.address().port;
      n.close(() => r(p));
    });
  });
  const proc = spawn(process.execPath, ["lead-agents-server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      NODE_ENV: "test",
      LEAD_AGENTS_HOST: "127.0.0.1",
      LEAD_AGENTS_PORT: String(port),
      LEAD_AGENTS_STORE_PATH: path.join(dir, "store.json"),
      OFFICE_STORAGE_DIR: path.join(dir, "storage"),
      LEAD_AGENTS_AUTH_MODE: "required_api_key",
      LEAD_AGENTS_API_KEYS: "local-full-" + secret,
      OPENAI_API_KEY: "local-not-real",
      LEAD_AGENTS_SESSION_SECRET: secret,
      LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([
        {
          client: "test-catalogue",
          key_sha256: crypto.createHash("sha256").update(key).digest("hex"),
          scopes: ["catalogue.public.read"],
        },
      ]),
      OPENAI_BASE_URL: "http://127.0.0.1:9",
      LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "100",
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`,
    cookies = {};
  let state;
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(base + "/healthz").catch(() => null)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const role of Object.keys(roles)) {
      const r = await fetch(base + "/api/lead-agents/admin/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: role + "@test.invalid", password }),
      });
      assert.equal(r.status, 200);
      cookies[role] = r.headers
        .getSetCookie()
        .find((x) => x.startsWith("lead_agents_admin="))
        .split(";")[0];
    }
    const api = async (
      role,
      action,
      content = M.EMPTY,
      expected = state?.row_version || 0,
    ) => {
      const r = await fetch(
        base + "/api/lead-agents/admin/catalogue/merchandising",
        {
          method: action ? "POST" : "GET",
          headers: {
            cookie: cookies[role] || "",
            origin: base,
            "content-type": "application/json",
          },
          ...(action
            ? {
                body: JSON.stringify({
                  action,
                  content,
                  expected_row_version: expected,
                }),
              }
            : {}),
        },
      );
      const data = await r.json();
      return { status: r.status, data };
    };
    let r = await api("reader");
    ok("reader can inspect campaign state", () => assert.equal(r.status, 200));
    state = r.data.merchandising;
    r = await api("reader", "save");
    ok("reader cannot write", () => assert.equal(r.status, 403));
    r = await api("writer", "save");
    ok("writer creates immutable draft over HTTP", () =>
      assert.equal(r.status, 200),
    );
    state = r.data.merchandising;
    r = await api("writer", "approve");
    ok("writer lacks approval grant", () => assert.equal(r.status, 403));
    r = await api("writer", "submit");
    ok("writer submits saved version", () => assert.equal(r.status, 200));
    state = r.data.merchandising;
    r = await api("reviewer", "approve");
    ok("independent reviewer approves", () => assert.equal(r.status, 200));
    state = r.data.merchandising;
    r = await api("reviewer", "publish");
    ok("review grant cannot publish", () => assert.equal(r.status, 403));
    r = await api("publisher", "publish");
    ok("publisher releases approved merchandising", () =>
      assert.equal(r.status, 200),
    );
    state = r.data.merchandising;
    const pub = await fetch(base + "/api/public/catalogue/merchandising", {
      headers: { "x-api-key": key },
    });
    ok("scoped projection returns only public merchandising", () =>
      assert.equal(pub.status, 200),
    );
    const projection = await pub.json();
    ok("public projection omits authors and history", () =>
      assert.deepEqual(projection, M.EMPTY),
    );
    const bad = await fetch(base + "/api/public/catalogue/merchandising");
    ok("anonymous projection access refused", () =>
      assert.equal(bad.status, 401),
    );
    r = await api("publisher", "withdraw");
    ok("withdrawal succeeds", () => assert.equal(r.status, 200));
    state = r.data.merchandising;
    r = await api("writer", "save", M.EMPTY, 0);
    ok("stale HTTP mutation returns 409", () => assert.equal(r.status, 409));
    const outcomes = await Promise.all([
      api("writer", "save"),
      api("writer", "save"),
    ]);
    ok("concurrent saves allow one winner", () =>
      assert.deepEqual(outcomes.map((x) => x.status).sort(), [200, 409]),
    );
    const disk = JSON.parse(fs.readFileSync(path.join(dir, "store.json")));
    ok("workflow history persisted", () =>
      assert.equal(disk.catalogue.merchandising.events.length, 6),
    );
    state = (await api("reader")).data.merchandising;
    r = await api("dual", "save");
    state = r.data.merchandising;
    r = await api("dual", "submit");
    state = r.data.merchandising;
    r = await api("dual", "approve");
    ok(
      "combined writer/reviewer cannot approve own saved version over HTTP",
      () => assert.equal(r.status, 403),
    );
    const scoped = await fetch(
      base + "/api/lead-agents/admin/catalogue/merchandising",
      { headers: { "x-api-key": key } },
    );
    ok("catalogue integration key cannot enter staff merchandising", () =>
      assert.equal(scoped.status, 403),
    );
    ok("invalid stored destination fails closed in projection", () =>
      assert.deepEqual(
        M.project(
          {
            ...content,
            slides: [{ ...content.slides[0], ctaHref: "javascript:alert(1)" }],
          },
          products,
        ),
        M.EMPTY,
      ),
    );
    const isolated = {
      capability: true,
      client: {
        get: async () => {
          throw new Error("missing schema");
        },
      },
    };
    await assert.rejects(
      M.read(isolated),
      (e) => e.code === "merchandising_unavailable",
    );
    ok(
      "missing merchandising schema leaves core catalogue capability intact",
      () => assert.equal(isolated.capability, true),
    );
    console.log(`${checks} checks passed`);
  } finally {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
