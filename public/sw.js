// ====================================================================
// Nexus Gate — Service Worker
//
// Strategy:
//   - App shell (HTML, CSS, JS, fonts): cache-first (instant load offline)
//   - API requests: network-first (always try fresh data, fall back to cache)
//   - Images/icons: stale-while-revalidate
//
// The scanner page + offline queue handle offline scanning. The service
// worker ensures the app SHELL loads instantly even on bad WiFi.
// ====================================================================

const CACHE_VERSION = "nexus-gate-v1";
const APP_SHELL = ["/", "/manifest.json", "/icon-192.svg", "/icon-512.svg"];

// ---- Install: pre-cache the app shell ----
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {
        // If any resource fails, continue — we'll cache on-demand
      });
    }),
  );
  self.skipWaiting();
});

// ---- Activate: clean up old caches ----
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key)),
      );
    }),
  );
  self.clients.claim();
});

// ---- Fetch: route requests by type ----
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET requests (POST, PATCH, DELETE — always hit network)
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Skip cross-origin requests (Google Fonts, etc — they have their own caching)
  if (url.origin !== self.location.origin) return;

  // Skip Next.js HMR in development
  if (url.pathname.startsWith("/_next/webpack-hmr")) return;

  // ---- API requests: network-first ----
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful GET responses for offline fallback
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline — try cache
          return caches.match(request).then((cached) => {
            return (
              cached ||
              new Response(
                JSON.stringify({ error: "You're offline. Please reconnect." }),
                {
                  status: 503,
                  headers: { "Content-Type": "application/json" },
                },
              )
            );
          });
        }),
    );
    return;
  }

  // ---- App shell + static assets: stale-while-revalidate ----
  event.respondWith(
    caches.match(request).then((cached) => {
      // If we have a cached version, return it immediately and update in
      // background. If the background fetch fails (offline), we already
      // returned the cached version — the rejection is swallowed silently.
      if (cached) {
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_VERSION).then((cache) => {
                cache.put(request, clone);
              });
            }
          })
          .catch(() => {
            // Background revalidation failed — cached version still served.
          });
        return cached;
      }

      // No cached version — must fetch. If fetch fails, fall back to "/".
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match("/");
        });
    }),
  );
});

// ---- Message handler: allow pages to trigger skipWaiting ----
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
