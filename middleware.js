// Vercel Routing Middleware. Office API paths: production -> production Render; any other deployment -> an explicit
// non-production origin or a fail-closed 503 (see config/office-api-routing.mjs). Static files are untouched.
import officeApiRouting from "./config/office-api-routing.mjs";

export const config = {
  matcher: ["/api/lead-agents/:path*", "/api/digital-twin/:path*", "/api/plan-studio/:path*", "/webhooks/:path*", "/healthz"],
};

export default function middleware(request) {
  return officeApiRouting(request);
}
