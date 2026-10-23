// S7 R10: trusted-proxy boundary, deployment topologies, the owner's client-address diagnostic, bounded password work, and the opt-in address ceiling. No external services.
"use strict";
const L = require("./cert/cert-lib");
const { resolveClientAddress } = require("../src/lead-agents/client-address");
const { A, boot, seed, recorder } = L;
const R = recorder("proxy-boundary-r10"); const { check, eq } = R;
const req = (xff, peer = "203.0.113.9") => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: peer } });
const login = (sys, email, password, headers) => sys.call("POST", `${A}/session/login`, { body: { email, password }, headers });

async function main() {
  // ===== P1 table-driven derivation: spoofed, malformed, absent, multi-hop
  const cases = [
    // [name, header, hops, expected]
    ["absent header, 0 hops", undefined, 0, "203.0.113.9"], ["absent header, 1 hop", undefined, 1, "203.0.113.9"], ["empty header", "", 1, "203.0.113.9"],
    ["commas only", ", , ,", 1, "203.0.113.9"], ["whitespace only", "   ", 2, "203.0.113.9"],
    ["spoofed single entry, untrusted", "9.9.9.9", 0, "203.0.113.9"], ["spoofed prefix, 1 trusted hop", "9.9.9.9, 198.51.100.4", 1, "198.51.100.4"],
    ["3-entry chain, 1 hop", "1.1.1.1, 2.2.2.2, 198.51.100.4", 1, "198.51.100.4"], ["3-entry chain, 2 hops", "1.1.1.1, 192.0.2.8, 198.51.100.4", 2, "192.0.2.8"], ["3-entry chain, 3 hops", "192.0.2.8, 2.2.2.2, 198.51.100.4", 3, "192.0.2.8"],
    ["chain shorter than hops", "198.51.100.4", 3, "203.0.113.9"], ["exactly hops", "192.0.2.8, 198.51.100.4", 2, "192.0.2.8"],
    ["non-IP in the trusted slot never reaches left entries", "9.9.9.9, not-an-ip", 1, "203.0.113.9"], ["unknown token", "9.9.9.9, unknown", 1, "203.0.113.9"],
    ["IPv6 trusted slot", "9.9.9.9, 2001:db8::7", 1, "2001:db8::7"], ["IPv6 with port", "9.9.9.9, [2001:db8::7]:4430", 1, "2001:db8::7"], ["IPv4 with port", "9.9.9.9, 198.51.100.4:51234", 1, "198.51.100.4"],
    ["IPv4-mapped IPv6", "9.9.9.9, ::ffff:198.51.100.4", 1, "198.51.100.4"], ["script injection in the slot", "9.9.9.9, <script>alert(1)</script>", 1, "203.0.113.9"],
    ["SQL-ish text in the slot", "9.9.9.9, 1.1.1.1' OR '1'='1", 1, "203.0.113.9"], ["overlong entry", "9.9.9.9, " + "1".repeat(200), 1, "203.0.113.9"], ["CRLF smuggling attempt", "9.9.9.9, 198.51.100.4\r\nx-evil: 1", 1, "203.0.113.9"],
    ["200 forged entries then a real one", Array.from({ length: 200 }, (_, i) => `10.0.${i % 250}.1`).join(", ") + ", 198.51.100.4", 1, "198.51.100.4"],
    ["10 KB header", "9.9.9.9, " + "a".repeat(10000), 1, "203.0.113.9"], ["negative hops", "9.9.9.9", -1, "203.0.113.9"], ["fractional hops", "9.9.9.9, 198.51.100.4", 1.5, "203.0.113.9"], ["string hops", "9.9.9.9, 198.51.100.4", "1", "203.0.113.9"],
    ["peer is IPv4-mapped", undefined, 0, "198.51.100.4", "::ffff:198.51.100.4"], ["no peer at all", undefined, 0, "unknown", ""],
  ];
  for (const [name, header, hops, expected, peer] of cases) eq(resolveClientAddress(req(header, peer === undefined ? "203.0.113.9" : peer), hops), expected, `P1 ${name}`);
  const arrayHeader = { headers: { "x-forwarded-for": ["9.9.9.9", "198.51.100.4"] }, socket: { remoteAddress: "203.0.113.9" } };
  eq(resolveClientAddress(arrayHeader, 1), "198.51.100.4", "P1 repeated header lines (array) are treated as one chain");

  // ===== P2 deployment topologies, modelled. A "chain" is what the application receives: client-supplied prefix + entries appended by proxies we operate.
  const vercelToRender = (clientClaims, clientReal) => `${clientReal}, 76.76.21.9`;        // Vercel overwrites the claim with the real client; Render's edge appends Vercel's egress address
  const directToRender = (clientClaims, clientReal) => `${clientClaims}, ${clientReal}`;   // no Vercel: the claim stays in front, Render's edge appends the real peer
  const attacker = "198.51.100.66", forged = "192.0.2.200";
  eq(resolveClientAddress(req(vercelToRender(forged, "203.0.113.50")), 2), "203.0.113.50", "P2 via the front end with 2 hops: the real client is identified");
  eq(resolveClientAddress(req(directToRender(forged, attacker)), 2), forged, "P2 HAZARD (documented): hops=2 on an origin that is ALSO reachable directly lets a direct caller choose its identity (the forged entry is trusted)");
  eq(resolveClientAddress(req(directToRender(forged, attacker)), 1), attacker, "P2 hops=1 is spoof-proof on BOTH paths for the direct request (the entry the origin's own edge appended)");
  eq(resolveClientAddress(req(vercelToRender(forged, "203.0.113.50")), 1), "76.76.21.9", "P2 …but via the front end hops=1 identifies the front end's egress address, not the client (coarse by design)");
  eq(resolveClientAddress(req(directToRender(forged, attacker)), 0), "203.0.113.9", "P2 hops=0 ignores the header on every path (the safe default)");

  // ===== P3 diagnostic route for the owner
  { const sys = await boot({ trustedProxyHops: 1 }, {}); const admin = await seed(sys, "diag", "super_admin"); const staff = await seed(sys, "diagstaff", "ochiga_staff");
    const sa = await login(sys, admin.email, admin.password, { "x-forwarded-for": "198.51.100.7" }); const ss = await login(sys, staff.email, staff.password, { "x-forwarded-for": "198.51.100.8" });
    const path = `${A}/diagnostics/client-address`;
    const r = await sys.call("GET", path, { cookie: sa.cookie, headers: { "x-forwarded-for": "9.9.9.9, 198.51.100.7" } });
    check(r.status === 200 && r.json.configured_trusted_proxy_hops === 1 && r.json.resolved_client_address === "198.51.100.7" && r.json.x_forwarded_for_entry_count === 2 && Array.isArray(r.json.x_forwarded_for_entries), "P3 an administrator sees what the application derived for THIS request");
    check(!/session_secret|password|token|api_key/i.test(JSON.stringify(r.json)), "P3 the diagnostic carries no secret");
    check((await sys.call("GET", path, { cookie: ss.cookie })).status === 403, "P3 a user without settings.manage is refused");
    check((await sys.call("GET", path, { apiKey: sys.config.apiKeys[0] })).status === 403, "P3 an API key is refused (human administrators only)");
    check((await sys.call("GET", path, { edge: sys.config.edgeAgentTokens[0] })).status === 403, "P3 an edge token is refused");
    check([401, 403].includes((await sys.call("GET", path, {})).status), "P3 anonymous is refused");
    eq((await sys.call("POST", path, { cookie: sa.cookie, body: {} })).status, 405, "P3 read-only: other methods are refused");
    const many = await sys.call("GET", path, { cookie: sa.cookie, headers: { "x-forwarded-for": Array.from({ length: 30 }, (_, i) => `10.1.1.${i}`).join(", ") } });
    check(many.json.x_forwarded_for_entries.length <= 8 && many.json.x_forwarded_for_entry_count === 30, "P3 at most 8 entries are echoed, the true count is reported");
    await sys.close(); }

  // ===== P4 bounded password work (A01-121): an absurd password is a wrong password without being hashed
  { const sys = await boot({}, { loginMax: 100000 }); const u = await seed(sys, "big", "ochiga_staff");
    for (const size of [1025, 5000, 500_000]) { const t0 = process.hrtime.bigint(); const r = await login(sys, u.email, "A".repeat(size)); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      check(r.status === 401 && !r.cookie && !/Cannot|undefined|at \S+ \(/.test(r.text), `P4 a ${size}-character password is refused (401) (${r.status}, ${ms.toFixed(0)} ms)`); check(ms < 1500, `P4 …quickly (${ms.toFixed(0)} ms)`); }
    eq((await login(sys, u.email, u.password)).status, 200, "P4 the genuine password still signs in afterwards (the account is not locked by oversize attempts)");
    const sixTen = await seed(sys, "limit", "ochiga_staff"); await sys.store.updateAdminUser(sixTen.id, { password_hash: require("../src/lead-agents/auth").hashPassword("x".repeat(1024)) });
    eq((await login(sys, sixTen.email, "x".repeat(1024))).status, 200, "P4 a password of exactly 1024 characters still works"); await sys.close(); }

  // ===== P5 the address-wide ceiling is OFF by default (shared egress addresses must not become a lock-out lever) and opt-in
  { const sys = await boot({ trustedProxyHops: 1 }, { loginMax: 100000 }); const out = [];
    for (let i = 0; i < 70; i++) out.push((await login(sys, `ghost${i}@egress.test`, "x", { "x-forwarded-for": "76.76.21.9" })).status);
    check(out.every((x) => x === 401), "P5 default: 70 failures from ONE shared (egress) address across 70 accounts never lock out that address"); 
    const legit = await seed(sys, "legit", "ochiga_staff"); eq((await login(sys, legit.email, legit.password, { "x-forwarded-for": "76.76.21.9" })).status, 200, "P5 …so a legitimate user behind the same address still signs in"); await sys.close(); }
  { const sys = await boot({ trustedProxyHops: 1, loginAddressFailureMax: 20 }, { loginMax: 100000 }); const out = [];
    for (let i = 0; i < 30; i++) out.push((await login(sys, `ghost${i}@egress.test`, "x", { "x-forwarded-for": "198.51.100.90" })).status);
    check(out.slice(0, 20).every((x) => x === 401) && out.slice(20).every((x) => x === 429), "P5 opt-in: the ceiling applies once the owner sets it"); await sys.close(); }

  // ===== P6 per-account throttling is preserved whatever the proxy configuration
  for (const hops of [0, 1]) { const sys = await boot({ trustedProxyHops: hops }, { loginMax: 5 }); const u = await seed(sys, "acct" + hops, "ochiga_staff"); const out = [];
    for (let i = 0; i < 60; i++) out.push((await login(sys, u.email, "wrong-passphrase-" + i, { "x-forwarded-for": `10.77.${i}.1` })).status);
    const processed = out.filter((x) => x === 401).length;
    check(processed <= 50 && out.slice(55).every((x) => x === 429), `P6 hops=${hops}: rotating forwarded addresses cannot exceed the per-account failure ceiling (${processed} processed of 60)`);
    eq((await login(sys, u.email, u.password, { "x-forwarded-for": "10.77.250.1" })).status, 429, `P6 hops=${hops}: and even the correct password is refused while the account ceiling holds`); await sys.close(); }

  const failed = R.done(); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
