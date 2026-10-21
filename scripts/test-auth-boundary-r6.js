// S7 R6 (H3, H4): the trusted-proxy boundary and the throttling of the authenticated password prompts. Positive and negative controls over HTTP; no external services.
"use strict";
const L = require("./cert/cert-lib");
const { resolveClientAddress, parseTrustedProxyHops } = require("../src/lead-agents/client-address");
const { A, boot, seed, recorder } = L;
const R = recorder("auth-boundary-r6"); const { check, eq } = R;
const WRONG = "definitely wrong passphrase 123";
const login = (sys, email, password, headers) => sys.call("POST", `${A}/session/login`, { body: { email, password }, headers });
const fakeReq = (xff, peer = "203.0.113.9") => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: peer } });

async function main() {
  // ===== unit: the one place that reads X-Forwarded-For
  eq(resolveClientAddress(fakeReq("1.2.3.4"), 0), "203.0.113.9", "H3 no trusted proxy: the header is ignored, the TCP peer is the identity");
  eq(resolveClientAddress(fakeReq("1.2.3.4, 5.6.7.8"), 0), "203.0.113.9", "H3 no trusted proxy: a chain is ignored too");
  eq(resolveClientAddress(fakeReq("6.6.6.6, 198.51.100.7"), 1), "198.51.100.7", "H3 one trusted proxy: the entry the proxy appended (rightmost) is used, not the client-supplied leftmost");
  eq(resolveClientAddress(fakeReq("6.6.6.6, 7.7.7.7, 198.51.100.7"), 1), "198.51.100.7", "H3 a long forged prefix does not matter");
  eq(resolveClientAddress(fakeReq("6.6.6.6, 192.0.2.1, 198.51.100.7"), 2), "192.0.2.1", "H3 two trusted proxies: the second from the right");
  eq(resolveClientAddress(fakeReq("198.51.100.7"), 2), "203.0.113.9", "H3 a chain shorter than the trusted hop count is not trusted: peer address");
  eq(resolveClientAddress(fakeReq(undefined), 1), "203.0.113.9", "H3 trusted hop configured but header absent: peer address");
  eq(resolveClientAddress(fakeReq("not-an-ip"), 1), "203.0.113.9", "H3 garbage in the trusted slot never becomes an identity");
  eq(resolveClientAddress(fakeReq("<script>x</script>, 'or 1=1"), 1), "203.0.113.9", "H3 free text is never used as a key");
  eq(resolveClientAddress(fakeReq("198.51.100.7:443"), 1), "198.51.100.7", "H3 address:port is normalised");
  eq(resolveClientAddress(fakeReq("[2001:db8::1]:443"), 1), "2001:db8::1", "H3 bracketed IPv6 with port is normalised");
  eq(resolveClientAddress(fakeReq("::ffff:198.51.100.7"), 1), "198.51.100.7", "H3 IPv4-mapped IPv6 is normalised to IPv4");
  eq(resolveClientAddress({ headers: {}, socket: {} }, 0), "unknown", "H3 no socket address: a constant, never undefined");
  eq(resolveClientAddress(fakeReq("1.1.1.1"), -3), "203.0.113.9", "H3 negative hop count is treated as 0");
  eq(JSON.stringify([parseTrustedProxyHops(undefined), parseTrustedProxyHops("1"), parseTrustedProxyHops("abc"), parseTrustedProxyHops("99"), parseTrustedProxyHops("-1")]),
    JSON.stringify([{ hops: 0, valid: true }, { hops: 1, valid: true }, { hops: 0, valid: false }, { hops: 0, valid: false }, { hops: 0, valid: false }]), "H3 configuration parsing: default 0, invalid values fall back to 0 (secure)");

  // ===== login: rotating X-Forwarded-For does not create new budgets (default: no trusted proxy)
  { const sys = await boot({}, { loginMax: 5 }); const u = await seed(sys, "spoof", "ochiga_staff"); const out = [];
    for (let i = 0; i < 14; i += 1) out.push((await login(sys, u.email, WRONG, { "x-forwarded-for": `10.20.${i}.1` })).status);
    eq(JSON.stringify(out.slice(0, 5)), JSON.stringify([401, 401, 401, 401, 401]), "H3 the first five wrong guesses are processed");
    check(out.slice(5).every((s) => s === 429), "H3 attempts 6..14 with fourteen different forged addresses are all refused (429)");
    const right = await login(sys, u.email, u.password, { "x-forwarded-for": "10.99.99.99" }); eq(right.status, 429, "H3 the correct password from a new forged address is refused while the budget holds"); check(!right.cookie, "H3 …and no session is created");
    const other = await seed(sys, "bystander", "ochiga_staff"); eq((await login(sys, other.email, other.password, { "x-forwarded-for": "10.20.0.1" })).status, 200, "H3 negative control: another account is unaffected"); await sys.close(); }

  // ===== login: behind ONE trusted proxy the proxy-appended address is the identity, a forged prefix is not
  { const sys = await boot({ trustedProxyHops: 1 }, { loginMax: 5 }); const u = await seed(sys, "proxied", "ochiga_staff"); const out = [];
    for (let i = 0; i < 8; i += 1) out.push((await login(sys, u.email, WRONG, { "x-forwarded-for": `10.77.${i}.1, 198.51.100.50` })).status);
    eq(JSON.stringify(out), JSON.stringify([401, 401, 401, 401, 401, 429, 429, 429]), "H3 trusted proxy: a rotating forged first entry does not change the identity (the proxy-appended entry does)");
    const real = await seed(sys, "otheruser", "ochiga_staff"); eq((await login(sys, real.email, real.password, { "x-forwarded-for": "10.0.0.1, 198.51.100.51" })).status, 200, "H3 a different real client address is a different identity"); await sys.close(); }

  // ===== H4: /session/password is bounded
  { const sys = await boot({}, { loginMax: 5 }); const u = await seed(sys, "pw", "ochiga_staff"); const other = await seed(sys, "pwother", "ochiga_staff");
    const s1 = await login(sys, u.email, u.password); const s2 = await login(sys, u.email, u.password); const so = await login(sys, other.email, other.password);
    const change = (cookie, current, headers) => sys.call("POST", `${A}/session/password`, { cookie, body: { current_password: current, new_password: "A brand new long passphrase 5821!" }, headers });
    const out = []; let bodies = [];
    for (let i = 0; i < 12; i += 1) { const r = await change(i % 2 ? s1.cookie : s2.cookie, WRONG + i, { "x-forwarded-for": `10.31.${i}.1` }); out.push(r.status); bodies.push(r.text); }
    eq(out.filter((s) => s === 401).length, 5, "H4 exactly the budget of wrong guesses (5 here) is answered 401, whatever the cookie or forged address");
    check(out.slice(5).every((s) => s === 429), "H4 every further attempt is refused with 429");
    const correct = await change(s1.cookie, u.password, { "x-forwarded-for": "10.31.77.1" }); eq(correct.status, 429, "H4 a tripped budget refuses even the correct password (no oracle from the throttle)");
    check(!bodies.concat([correct.text]).some((b) => b.includes(u.email) || b.includes("password_hash") || b.includes(u.password)), "H4 refusals disclose nothing about the account");
    eq((await change(so.cookie, WRONG, {})).status, 401, "H4 negative control: another account's prompt is unaffected and answers 401 like any wrong password");
    const stillSignsIn = await login(sys, u.email, u.password); eq(stillSignsIn.status, 200, "H4 password-prompt throttling does not lock the owner out of normal sign-in"); await sys.close(); }

  // ===== H4: below the budget a correct change works and clears the counter; wrong guesses before it are generic 401s
  { const sys = await boot({}, { loginMax: 5 }); const u = await seed(sys, "pwok", "ochiga_staff"); const s = await login(sys, u.email, u.password);
    for (let i = 0; i < 3; i += 1) eq((await sys.call("POST", `${A}/session/password`, { cookie: s.cookie, body: { current_password: WRONG, new_password: "A brand new long passphrase 5821!" } })).status, 401, `H4 wrong guess ${i + 1} is a plain 401`);
    const ok = await sys.call("POST", `${A}/session/password`, { cookie: s.cookie, body: { current_password: u.password, new_password: "A brand new long passphrase 5821!" } }); eq(ok.status, 200, "H4 the correct current password still changes the password below the budget");
    eq((await login(sys, u.email, "A brand new long passphrase 5821!")).status, 200, "H4 the new password signs in"); await sys.close(); }

  // ===== H4: step-up guessing with rotating forged addresses is bounded
  { const sys = await boot({}, { loginMax: 5 }); const u = await seed(sys, "stepup", "super_admin"); const s = await login(sys, u.email, u.password); const out = [];
    for (let i = 0; i < 12; i += 1) out.push((await sys.call("POST", `${A}/session/step-up`, { cookie: s.cookie, body: { password: WRONG + i, purpose: "security_policy_write" }, headers: { "x-forwarded-for": `10.41.${i}.1` } })).status);
    check(out.slice(0, 5).every((x) => x === 401) && out.slice(5).every((x) => x === 429), "H4 step-up: five 401s then 429s despite twelve forged addresses"); await sys.close(); }

  // ===== audit records carry the resolved address, not the forged one
  { const sys = await boot({}, { loginMax: 50 }); const u = await seed(sys, "audited", "ochiga_staff");
    await login(sys, u.email, u.password, { "x-forwarded-for": "6.6.6.6" });
    const ev = await sys.store.listAuditEvents(50); const ips = ev.map((e) => JSON.stringify(e)).join(" ");
    check(!ips.includes("6.6.6.6"), "H3 the audit trail never records the client-supplied forwarded address when no proxy is trusted"); await sys.close(); }

  // ===== operational visibility: /healthz states the limiter scope and the trusted-proxy boundary (file store => per-process, said plainly)
  { const sys = await boot({ trustedProxyHops: 2 }, {}); const h = await sys.call("GET", "/healthz", {});
    eq(h.json && h.json.rate_limit && h.json.rate_limit.scope, "process", "R6 /healthz: the file store reports per-process counting, never 'shared'");
    eq(h.json && h.json.rate_limit && h.json.rate_limit.trusted_proxy_hops, 2, "R6 /healthz: the configured trusted proxy hop count is visible"); await sys.close(); }
  { const sys = await boot({ trustedProxyHops: 0, trustedProxyHopsInvalid: true }, {}); const h = await sys.call("GET", "/healthz", {});
    eq(h.json && h.json.rate_limit && h.json.rate_limit.trusted_proxy_hops_config, "invalid_ignored", "R6 /healthz: an invalid LEAD_AGENTS_TRUSTED_PROXY_HOPS is reported and ignored (secure default)"); await sys.close(); }

  const failed = R.done(); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
