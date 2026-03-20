'use strict';

/**
 * HeartBeat DJ — Service Worker
 *
 * Caching strategie:
 * - App shell: cache-first (HTML, CSS, JS)
 * - Spotify API: network-only (geen caching van API responses)
 * - Afbeeldingen (Unsplash): stale-while-revalidate
 *
 * De service worker maakt de app installeerbaar als PWA
 * en zorgt voor offline basisfunctionaliteit (UI laadt).
 */

const CACHE_NAME = 'heartbeat-dj-v5';

// Relatieve paden — werkt op elk domein en subpad
const APP_SHELL_RELATIVE = [
  'index.html',
  'auth-redirect.html',
  'css/styles.css',
  'js/app.js',
  'js/config.js',
  'js/spotify-auth.js',
  'js/spotify-api.js',
  'js/spotify-player.js',
  'js/playlist-manager.js',
  'js/zone-engine.js',
  'js/heart-rate-simulator.js',
  'js/workout-planner.js',
  'manifest.json',
];

// ── Install ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Converteer relatieve paden naar absolute URLs op basis van SW scope
      const base = self.registration.scope;
      const urls = APP_SHELL_RELATIVE.map((path) => new URL(path, base).href);
      return cache.addAll(urls);
    })
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Spotify API: altijd netwerk
  if (url.hostname.includes('spotify.com') || url.hostname.includes('scdn.co')) {
    event.respondWith(fetch(request));
    return;
  }

  // Unsplash: stale-while-revalidate
  if (url.hostname.includes('unsplash.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const fetched = fetch(request).then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          });
          return cached || fetched;
        })
      )
    );
    return;
  }

  // Navigatie (HTML): network-first — zodat updates direct zichtbaar zijn
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Sla verse versie op in cache voor offline gebruik
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('index.html')))
    );
    return;
  }

  // Overige app shell (CSS, JS, afbeeldingen): stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
