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

## 4. Result (after)
- `axios` 1.19.0 → **1.20.0** (`package.json` `^1.13.4` → `^1.20.0`). The lockfile diff is exactly the `axios` entry (version, resolved URL, integrity) and the root declaration; no other package changed; `npm ci` on a fresh checkout installs it cleanly (`npm ls axios`: one copy, 1.20.0).
- `npm audit`: **found 0 vulnerabilities** (full tree, 174 listed packages) and `npm audit --omit=dev`: 0. All 12 advisories of §1 are resolved. This statement is bounded by what `npm audit` knows (advisories published to the npm registry advisory database at the time of the run); it is not a claim that no undiscovered issue exists.
- Remaining vulnerabilities in the dependency tree: **none reported**.
- Verification on a fresh clean checkout of `9ebbd313e0d4ec936e5242f080d0c3e5d64c0509` after `npm ci` (complete run, 900 s per suite): gates 5/5; frozen S7.5.9 certification suites unchanged, 681/681 (auth-session 153, MFA lifecycle 213, database 239, browser 76); Office regression **80/80** (S7.0–S7.5.8, R1, Team permissions, WhatsApp autonomy, Settings S1–S6, Supabase store and every outbound-client suite); Postgres/PostgREST **10/10**.
- Other open items are unchanged by R2: F-5 logout denylist, F-6 mixed-version rollout, F-7 browser-harness flake (did not recur), the per-process limiter and `X-Forwarded-For` observations from R1, and the production-owner actions in the S7.5.9 report.
