/* Production Time Tracker — service worker
   Caches the app shell so the page opens instantly and works offline.
   Network calls to the Apps Script API are NEVER cached (always live);
   offline event queuing is handled in the page via localStorage. */

const CACHE = "tt-shell-v3";

// Core files — install fails loudly if these are missing.
const CORE = ["./", "./index.html", "./supervisor.html", "./manifest.json"];
// Nice-to-have files — cached best-effort so a missing icon can't break install.
const OPTIONAL = ["./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(CORE);
      await Promise.allSettled(OPTIONAL.map((u) => c.add(u)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never cache the API — always go to the network (the app queues offline itself).
  if (url.hostname.includes("script.google.com")) return;

  // App shell: cache-first, fall back to network, update cache in the background.
  if (e.request.method === "GET" && url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const fresh = fetch(e.request).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || fresh;
      })
    );
  }
});
