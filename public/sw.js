// StreamVault Service Worker v26
// ─────────────────────────────────────────────────────────────
// Strategy:
//   Install:               PRE-CACHE app shell (/) + all /_next/static/ assets from HTML
//   Navigation (HTML):     STALE-WHILE-REVALIDATE → offline.html fallback → inline fallback
//   /_next/static/:        CACHE-FIRST (content-hashed, immutable) → empty on miss
//   /_next/:               NETWORK-FIRST → cache fallback → empty on miss
//   /api/stream/*:         STALE-WHILE-REVALIDATE (content APIs cached for offline browsing)
//   /api/auth/* /users /watchlist: PASS-THROUGH (never cache)
//   Static assets:         CACHE-FIRST with background update → empty on miss
//   WARM_CACHE message:    Cache any URLs sent from the app (runtime cache warming)
//
// Critical: The SW MUST be registered from an inline <script> in <head>
// (see layout.tsx), not from a React component. This ensures the SW
// intercepts navigation even when the app JS bundles fail to load offline.

const CACHE_NAME = 'streamvault-pwa-v1';
const OFFLINE_URL = '/offline.html';

// Static assets to always pre-cache (icons, manifest, offline page)
const PRECACHE_ASSETS = [
  '/offline.html',
  '/manifest.json',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/apple-touch-icon.png',
  '/favicon.png',
];

// Inline offline HTML — last resort if offline.html isn't cached
const INLINE_OFFLINE_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=contain"><meta name="theme-color" content="#080808"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><title>StreamVault — Offline</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#080808;color:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100dvh;padding:24px;text-align:center}.logo{font-size:28px;font-weight:800;letter-spacing:-0.5px;margin-bottom:32px}.logo span{color:#E50914}.icon-circle{width:80px;height:80px;border-radius:50%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;margin-bottom:24px}h2{font-size:20px;font-weight:600;margin-bottom:8px}p{font-size:14px;color:#A0A0A0;max-width:280px;line-height:1.5;margin-bottom:32px}.btn{background:#E50914;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent}.btn:active{opacity:0.8}</style></head><body><div class="logo">Stream<span>Vault</span></div><div class="icon-circle"><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#A0A0A0" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg></div><h2>You\'re Offline</h2><p>Check your internet connection and try again to continue streaming.</p><button class="btn" onclick="window.location.reload()">Try Again</button></body></html>';

// ── Extract /_next/ asset URLs from HTML ──
function extractAssetUrls(html) {
  const urls = new Set();
  // Match script[src], link[href] with relative URLs starting with /_next/
  const regex = /(?:src|href)="(\/_next\/[^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    urls.add(match[1]);
  }
  // Also match inline style URLs for CSS (e.g., /_next/static/css/...)
  const styleRegex = /url\(["']?(\/_next\/[^"')]+)["']?\)/g;
  while ((match = styleRegex.exec(html)) !== null) {
    urls.add(match[1]);
  }
  return Array.from(urls);
}

// ── Install: pre-cache app shell + all static assets from main page ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // 1. Pre-cache static assets (icons, manifest, offline page)
      await Promise.allSettled(PRECACHE_ASSETS.map((url) => cache.add(url)));

      // 2. Fetch main page, cache it, and extract + cache all /_next/ assets
      try {
        const response = await fetch('/');
        if (response && response.ok) {
          // Cache the main page HTML
          const html = await response.clone().text();
          await cache.put('/', response.clone());

          // Extract and cache all /_next/ static assets from the HTML
          const assetUrls = extractAssetUrls(html);
          if (assetUrls.length > 0) {
            await Promise.allSettled(
              assetUrls.map((url) =>
                cache.add(url).catch(() => {
                  // Individual asset fetch might fail — not blocking
                })
              )
            );
          }
        }
      } catch {
        // Offline during install — can't pre-cache app shell.
        // offline.html and icons are still cached from step 1.
      }
    })()
  );
  self.skipWaiting();
});

// ── Activate: claim clients immediately, clean old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// ── Message handlers ──
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // WARM_CACHE: app sends URLs to pre-cache after loading online
  // This catches dynamically imported chunks that weren't in the initial HTML
  if (event.data?.type === 'WARM_CACHE' && Array.isArray(event.data.urls)) {
    const urls = event.data.urls.filter(
      (u) => typeof u === 'string' && u.startsWith('/')
    );
    if (urls.length === 0) return;

    caches.open(CACHE_NAME).then((cache) => {
      urls.forEach((url) => {
        // Only cache if not already cached
        cache.match(url).then((cached) => {
          if (!cached) {
            fetch(url)
              .then((res) => {
                if (res && res.ok) cache.put(url, res);
              })
              .catch(() => {});
          }
        });
      });
    });
    return;
  }
});

// ── Fetch ──
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // API routes — selective caching
  if (url.pathname.startsWith('/api/')) {
    // Auth/user APIs — never cache (passthrough)
    if (url.pathname.startsWith('/api/auth/') ||
        url.pathname.startsWith('/api/users') ||
        url.pathname.startsWith('/api/watchlist')) {
      return;
    }

    // Content APIs (trending, popular, genres, detail, search, etc.)
    // → STALE-WHILE-REVALIDATE: serve cached instantly, update in background
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          // Background update
          fetch(request)
            .then((res) => {
              if (res && res.ok) {
                const clone = res.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
              }
            })
            .catch(() => {});
          return cached;
        }

        // No cache — try network
        return fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
              return response;
            }
            return response;
          })
          .catch(() => {
            // Offline + no cache — return empty JSON
            return new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          });
      })
    );
    return;
  }

  // ── Navigation requests (HTML pages): STALE-WHILE-REVALIDATE ──
  // Serve from cache instantly (critical for iOS PWA offline).
  // If nothing cached and offline → serve /offline.html → inline fallback.
  // On successful network response, update cache for next time.
  if (request.mode === 'navigate' || request.mode === 'same-origin') {
    event.respondWith(
      caches.match(request).then((cached) => {
        // If we have a cached version, serve it immediately
        if (cached) {
          // Update in background when online (don't block the response)
          fetch(request)
            .then((response) => {
              if (response && response.ok) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
              }
            })
            .catch(() => {}); // ignore offline
          return cached;
        }

        // No cache — try network
        return fetch(request)
          .then((response) => {
            if (response && response.ok) {
              // Cache this response for offline use
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
              return response;
            }
            // Non-OK network response → try offline.html → inline fallback
            return getOfflineResponse();
          })
          .catch(() => {
            // Network failed (offline) → serve offline.html → inline fallback
            return getOfflineResponse();
          });
      })
    );
    return;
  }

  // ── Next.js static bundles (/_next/static/): CACHE-FIRST ──
  // These URLs are content-hashed — immutable. Cache once, serve forever.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => {
            // Bundle not cached + offline → return empty response so app doesn't crash
            // The HTML will be served from cache; missing JS just means features won't work
            return new Response('', { status: 200 });
          });
      })
    );
    return;
  }

  // ── Other Next.js resources (/_next/image/, /_next/chunks/ etc.): NETWORK-FIRST, cache fallback ──
  if (url.pathname.startsWith('/_next/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => {
          if (cached) return cached;
          return new Response('', { status: 200 });
        }))
    );
    return;
  }

  // ── Static assets (icons, manifest, fonts, SVGs): CACHE-FIRST with background update ──
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request).then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
        }).catch(() => {});
        return cached;
      }

      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Static asset not cached + offline → return empty response
          // (NOT 503 — that causes visible errors in console and breaks the app)
          return new Response('', { status: 200 });
        });
    })
  );
});

// ── Offline response helper ──
// Tries /offline.html from cache, falls back to inline HTML.
// Never returns undefined — always returns a valid Response.
function getOfflineResponse() {
  return caches.match(OFFLINE_URL).then((cached) => {
    if (cached) return cached;
    // Last resort: inline HTML so the user never sees Safari's native error
    return new Response(INLINE_OFFLINE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });
}
