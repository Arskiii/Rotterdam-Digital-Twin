// Immutable city URLs carry content versions from the build. Mutable datasets
// revalidate online; live observations and APIs never use this offline cache.
const APP_CACHE = "rtm-app-v1";
const DATA_CACHE = "rtm-data-v2";
const KEEP = new Set([APP_CACHE, DATA_CACHE]);

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      for (const name of await caches.keys()) {
        if (/^rtm-(app|data)-v\d+$/.test(name) && !KEEP.has(name)) await caches.delete(name);
      }
    } catch { /* Storage can be denied; the network still works. */ }
    await self.clients.claim();
  })());
});

async function cached(request, name) {
  try { return await (await caches.open(name)).match(request); }
  catch { return undefined; }
}

function remember(request, response, name, writes) {
  // Never persist errors, partial bodies, or a response explicitly marked private.
  if (response.status !== 200 || /\b(no-store|private)\b/i.test(response.headers.get("Cache-Control") ?? "")) return;
  const copy = response.clone();
  writes.push((async () => {
    try { await (await caches.open(name)).put(request, copy); }
    catch { /* Quota/permission failures must not discard a successful download. */ }
  })());
}

async function cacheFirst(request, name, writes) {
  const hit = await cached(request, name);
  if (hit) return hit;
  const response = await fetch(request);
  remember(request, response, name, writes);
  return response;
}

async function networkFirst(request, name, writes) {
  try {
    // Revalidate the browser's HTTP cache too (Pages otherwise keeps it 10 min).
    const response = await fetch(request, { cache: "no-cache" });
    if (response.status >= 500) {
      const hit = await cached(request, name);
      if (hit) return hit;
    }
    remember(request, response, name, writes);
    return response;
  } catch (error) {
    const hit = await cached(request, name);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);
  if (path.startsWith("api/") || path.startsWith("data/live/")) return;

  // Reload navigations still need their offline document fallback. Explicit
  // fresh-data/build-watcher requests otherwise bypass this cache completely.
  if (request.mode !== "navigate" && ["no-store", "no-cache", "reload"].includes(request.cache)) return;
  const name = path.startsWith("data/") ? DATA_CACHE : APP_CACHE;
  const immutableCity = /^data\/(?:[\w-]+\.bin|meta\.json|roofs\/(?:index\.json|[\w-]+\.bin))$/.test(path)
    && /^[a-f0-9]{64}$/.test(url.searchParams.get("v") ?? "");
  const immutable = request.mode !== "navigate" && (path.startsWith("assets/") || immutableCity);
  const writes = [];
  const response = (immutable ? cacheFirst : networkFirst)(request, name, writes);
  event.respondWith(response);
  // Register synchronously; keep the worker alive through all asynchronous
  // cache writes without holding up the response on disk I/O.
  event.waitUntil(response.then(() => Promise.all(writes)).catch(() => {}));
});
