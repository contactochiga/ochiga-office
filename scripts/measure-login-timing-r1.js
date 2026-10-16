// R1: login response-time distributions for the four cases an observer can try without a password, measured interleaved in one process under identical conditions.
// Not a proof of constant time: it reports min / median / p90 / max so the remaining difference is visible. Usage: node scripts/measure-login-timing-r1.js [samples]
"use strict";
const { boot, seed, A } = require("./cert/cert-lib");
const N = Number(process.argv[2]) || 60;
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, min: +s[0].toFixed(2), median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
(async () => {
  const sys = await boot({}); const real = await seed(sys, "real", "ochiga_staff"); const dormant = await seed(sys, "dormant", "ochiga_staff"); await sys.store.updateAdminUser(dormant.id, { status: "inactive" });
  const wrong = "definitely wrong password 123";
  const cases = { unknown: (i) => ({ email: `ghost${i}@cert.test`, password: wrong }), existing: () => ({ email: real.email, password: wrong }), inactive: () => ({ email: dormant.email, password: wrong }) };
  const samples = Object.fromEntries(Object.keys(cases).map((k) => [k, []]));
  for (let i = 0; i < 6; i += 1) for (const k of Object.keys(cases)) await sys.call("POST", `${A}/session/login`, { body: cases[k](i) }); // warm-up, discarded
  for (let i = 0; i < N; i += 1) for (const k of Object.keys(cases)) { const t = process.hrtime.bigint(); await sys.call("POST", `${A}/session/login`, { body: cases[k](i + 100) }); samples[k].push(Number(process.hrtime.bigint() - t) / 1e6); }
  const out = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stats(v)])); out.ratio_existing_to_unknown_median = +(out.existing.median / out.unknown.median).toFixed(2); out.ratio_inactive_to_existing_median = +(out.inactive.median / out.existing.median).toFixed(2);
  console.log(JSON.stringify(out, null, 2)); await sys.close();
})();
