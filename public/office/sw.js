// Ochiga Office service worker (Ecosystem Standardization Programme 14).
//
// Caches only the static app shell (HTML/JS/manifest/brand assets) —
// never API responses. Office's data is live, permission-gated, and
// per-user; caching it here would risk showing a staff member stale or
// wrong data offline, or leaking one person's cached response to
// another session on a shared machine. This exists purely so the shell
// itself loads instantly/offline; every /api/lead-agents/* request
// always goes to the network untouched.
const CACHE_NAME = "ochiga-office-shell-v1";
const SHELL_ASSETS = [
  "/office",
  "/office.js",
  "/office/manifest.json",
  "/office/brand/ochiga-logo-dark.png",
  "/office/brand/ochiga-logo-light.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (!SHELL_ASSETS.includes(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
