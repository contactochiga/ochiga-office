"use strict";

// Real loopback redirects only. Synthetic headers; no external endpoints or secrets.
const assert = require("node:assert/strict");
const http = require("node:http");
const vm = require("node:vm");
const redirects = require("follow-redirects");
const axios = require("axios");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const request = (url, options) => new Promise((resolve, reject) => {
  redirects.http.get(url, options, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve(JSON.parse(body)));
  }).on("error", reject).setTimeout(3000, function () { this.destroy(new Error("loopback request timeout")); });
});

(async () => {
  let count = 0;
  const check = (ok, label) => { assert.ok(ok, label); count += 1; console.log(`PASS ${label}`); };
  const destination = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
  const target = await listen(destination);
  const source = http.createServer((req, res) => {
    if (req.url === "/final") return res.end(JSON.stringify(req.headers));
    res.writeHead(302, { location: req.url === "/same" ? "/final" : target.replace("127.0.0.1", "localhost") }); res.end();
  });
  const origin = await listen(source);
  try {
    check(require("follow-redirects/package.json").version === "1.16.2", "exact patched version");
    for (const crossRealm of [false, true]) {
      const sensitiveHeaders = crossRealm ? vm.runInNewContext('["X-Test-Secret"]') : ["X-Test-Secret"];
      const headers = { "X-Test-Secret": "synthetic", Authorization: "Bearer synthetic", Cookie: "synthetic=1", "X-Harmless": "kept" };
      const response = await request(origin + "/cross", { headers: { ...headers }, sensitiveHeaders, family: 4 });
      check(!response["x-test-secret"], `custom credential removed (${crossRealm ? "cross" : "same"} realm)`);
      check(!response.authorization && !response.cookie, "built-in credentials removed on cross-host redirect");
      check(response["x-harmless"] === "kept", "non-sensitive header preserved");
      const same = await request(origin + "/same", { headers: { ...headers }, sensitiveHeaders });
      check(same.authorization === headers.Authorization && same["x-test-secret"] === "synthetic", "same-origin authenticated redirect preserved");
    }
    const result = await axios.get(origin + "/cross", { proxy: false, family: 4, timeout: 3000, headers: { Authorization: "Bearer synthetic", Cookie: "synthetic=1", "X-Harmless": "kept" } });
    check(!result.data.authorization && !result.data.cookie && result.data["x-harmless"] === "kept", "Axios authenticated redirect boundary");
    console.log(`${count}/${count} passed`);
  } finally { await close(source); await close(destination); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
