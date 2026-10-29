// Office API routing for the Vercel-hosted static Office (used by middleware.js).
// Production deployments proxy the Office API paths to the production Render service, exactly as the former
// vercel.json rewrites did. Every other deployment (preview, development, unknown) proxies ONLY to an explicitly
// configured non-production origin (OFFICE_PREVIEW_API_ORIGIN, https, never the production host) and otherwise
// FAILS CLOSED with 503 — it never falls back to production.
import { rewrite } from "@vercel/functions";

export const PRODUCTION_API_ORIGIN = "https://ochiga-lead-agents.onrender.com";
export const PRODUCTION_HOSTS = Object.freeze(["ochiga-lead-agents.onrender.com", "office.ochiga.com.ng", "www.office.ochiga.com.ng"]);
// The same five path families the former vercel.json rewrites proxied.
export const API_PATHS = Object.freeze([/^\/api\/lead-agents(\/|$)/, /^\/api\/digital-twin(\/|$)/, /^\/api\/plan-studio(\/|$)/, /^\/webhooks(\/|$)/, /^\/healthz$/]);

export function isApiPath(pathname) {
  return API_PATHS.some((re) => re.test(pathname));
}

// Returns the origin to proxy to, or null when the request must be refused.
export function apiOriginFor(env) {
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv === "production") return PRODUCTION_API_ORIGIN;
  const raw = String(env.OFFICE_PREVIEW_API_ORIGIN || "").trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  if (PRODUCTION_HOSTS.includes(url.hostname.toLowerCase())) return null;
  return url.origin;
}

export function refusal() {
  return new Response(JSON.stringify({ error: "preview_api_not_configured", message: "This preview has no staging Office API configured. It does not connect to production." }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-office-api-route": "refused" },
  });
}

export default function officeApiRouting(request, env = process.env) {
  const url = new URL(request.url);
  if (!isApiPath(url.pathname)) return undefined; // static Office files continue normally
  const origin = apiOriginFor(env);
  if (!origin) return refusal();
  return rewrite(new URL(url.pathname + url.search, origin));
}
