"use strict";
const { spawn } = require("node:child_process"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async ({ app, RUN }) => {
  const root = path.resolve(__dirname, process.env.TEST_RESERVATIONS === "true" ? "../../oyi-phase4c" : "../../oyi-phase4b");
  if (!fs.existsSync(path.join(root, "tests/phase4/checkout-http.cjs")))
    throw Error("GetOyi isolated checkout worktree missing");
  const route = path.join(root, "src/app/checkout-rehearsal"),
    stop = "/tmp/getoyi-checkout-rehearsal.stop";
  if (fs.existsSync(route))
    throw Error("Refuse overwrite existing rehearsal route");
  const rehearsal = process.env.CHECKOUT_REHEARSAL === "true";
  if (rehearsal) {
  fs.mkdirSync(route);
  fs.writeFileSync(
    path.join(route, "page.tsx"),
    `import {ProductShowcase} from '@/components/hardware/ProductShowcase'; export default function Page(){return <main style={{padding:40}}><p>LOCAL TEST DATA ONLY</p><ProductShowcase name="LOCAL TEST Smart lock" productSlug="test-order" checkoutEnabled images={[]} variants={[{sku:'TEST-ORDER-1',name:'Standard',options:{},price:'₦1,275.00',availability:'In stock — synthetic fixture',availabilityTone:'ok',leadTime:''}]}><h1>LOCAL TEST Smart lock</h1></ProductShowcase></main>}`,
  );
  }
  fs.rmSync(stop, { force: true });
  const log = fs.openSync("/tmp/getoyi-checkout-web.log", "w");
  const base = "http://127.0.0.1:4324";
  const p = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4324",
    ],
    {
      cwd: root,
      stdio: ["ignore", log, log],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        HARDWARE_CATALOGUE_ENABLED: "true",
        HARDWARE_CHECKOUT_ENABLED: "true",
        CHECKOUT_LOCAL_REHEARSAL: "true",
        HARDWARE_CHECKOUT_SESSION_SECRET: crypto
          .randomBytes(32)
          .toString("hex"),
        GETOYI_CHECKOUT_ORIGIN: base,
        OCHIGA_OFFICE_CHECKOUT_URL: app.url,
        OCHIGA_OFFICE_CHECKOUT_KEY: "isolated-checkout-" + RUN,
        OCHIGA_OFFICE_BASE_URL: app.url,
        OCHIGA_OFFICE_CATALOGUE_KEY: "intentionally-unconfigured-local-reader",
      },
    },
  );
  try {
    for (let i = 0; i < 120; i++) {
      if (p.exitCode !== null) throw Error("Local Next server failed");
      if (
        await fetch(base + "/api/hardware/checkout/session")
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      await sleep(500);
    }
    await new Promise((resolve, reject) => {
      const t = spawn(
        process.execPath,
        ["tests/phase4/checkout-http.cjs", base],
        { cwd: root, stdio: "inherit" },
      );
      t.on("exit", (code) =>
        code ? reject(Error("Web HTTP suite failed")) : resolve(),
      );
    });
    if (process.env.CHECKOUT_REHEARSAL === "true") {
      console.log(
        "LOCAL REHEARSAL READY http://127.0.0.1:4324/checkout-rehearsal",
      );
      for (let i = 0; i < 1800 && !fs.existsSync(stop); i++) await sleep(1000);
    }
  } finally {
    p.kill("SIGTERM");
    await new Promise((r) => (p.exitCode !== null ? r() : p.once("exit", r)));
    fs.closeSync(log);
    if (rehearsal) fs.rmSync(route, { recursive: true, force: true });
    // Disposable Next dev type metadata can still mention the removed rehearsal page.
    const types = path.join(root, ".next/dev/types");
    if (rehearsal && fs.existsSync(types)) fs.renameSync(types, path.join(require("node:os").tmpdir(), "checkout-dev-types-" + RUN));
  }
};
