# S7 remediation R2 — dependency security (axios): audit recorded before any change

Starting HEAD `3178840108ed4554c14370c2364ca42b5e11b3d1` (local = remote, clean). Scope: the one high-severity advisory group reported by `npm audit` for `axios`. No broad upgrades, no other package touched, no merge/deployment/production action.

## 1. Findings (before)
| | |
|---|---|
| Installed | `axios@1.19.0` (`npm ls axios`: a single copy, no transitive copy) |
| Declared | `"axios": "^1.13.4"` in `package.json` `dependencies` (a **direct, production** dependency; not a dev dependency) |
| Ownership / paths | only `ochiga-office → axios`; no other package depends on it |
| Audit result | `npm audit`: 1 high (`axios`), 0 critical, 0 moderate, 0 low, total 1. Vulnerable range `1.0.0 – 1.19.0`; `fixAvailable: true` |
| Published advisories (12, all fixed in **1.20.0**; ranges `>=… <1.20.0`) | GHSA-vh66-26gq-q6x8 fetch-adapter prototype-pollution gadget (mod); GHSA-9fr6-4gfg-395g default-instance method override (mod); GHSA-c29m-xwm3-cm6r ReDoS in `fromDataURI` (high); GHSA-mghh-pgcx-3jjj ReDoS in `shouldBypassProxy` (high); GHSA-x97p-jq2g-jp4f `toFormData` options pollution (high); GHSA-3pq3-5fj3-cg6v HTTP/2 adapter bypasses DNS/proxy controls (high); GHSA-542g-h47m-68v8 HTTP/2 session unhandled error DoS (high); GHSA-j8rh-479h-cp32 header injection via inherited headers (mod); GHSA-4hqw-qxg8-jxx2 fetch-adapter FormData header injection (mod); GHSA-m8m8-qj5v-23w3 HTTP adapter socket hijack gadget (high); GHSA-44g4-m2mj-wpvx CIDR `NO_PROXY` ignored (mod); GHSA-r4gj-5m52-g5wh `maxRedirects: 0` not enforced by fetch adapter, redirect SSRF (high) |
| Patched versions | `1.20.0` is the first and only patched release; it is also `latest` on the registry (dist-tags: latest `1.20.0`). No backport to 1.19.x exists. |
| Dependency delta 1.19.0 → 1.20.0 | **none**: identical dependency ranges (`form-data ^4.0.6`, `proxy-from-env ^2.1.0`, `follow-redirects ^1.16.0`, `https-proxy-agent ^5.0.1`), MIT licence, same major (1.x) |

## 2. Exposure in this codebase (static review)
13 source files create or use axios (27 request call sites): Supabase store, WhatsApp, Backend/Facility/Consumer bridges, OpenAI, webhooks, outbox, sync. None sets `maxRedirects`, an HTTP/2 or custom adapter, interceptors, `NO_PROXY`/proxy options or a custom `transformRequest`, so the HTTP/2, `maxRedirects`, proxy-bypass and interceptor advisories have no direct trigger here; the prototype-pollution and header-injection gadgets and the `data:`/proxy-host ReDoS issues are **gadget/untrusted-input class** advisories whose reachability depends on attacker influence over request configuration or URLs, which a static review cannot rule out in a codebase with configurable outbound URLs (webhooks, bridges). Conservative rating therefore stays High as `npm audit` reports. The Supabase store client is the highest-value consumer (service-role credentials), which is why the full Postgres/PostgREST suite set is part of verification.

## 3. Plan
Upgrade exactly `axios` to `1.20.0` (`^1.20.0` in `package.json`), regenerate only its lockfile entry, re-run `npm audit` (full and `--omit=dev`), then the complete regression. If the lockfile or the suites show any other package change, stop and report.
