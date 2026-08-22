// Offline, and a second visit that does not re-download the city.
//
// The city is 27 MB of binaries — graph, roads, buildings, water — and GitHub
// Pages serves them with `cache-control: max-age=600`. Ten minutes later the
// browser's own cache has given up and the whole city comes down the wire
// again. Pages does not let you set that header, so the only place to hold
// these files for longer is here.
//
// What this deliberately does NOT hold:
//
//   live/live.json   a measurement of now. A cached one is a lie with a
//                    timestamp on it, and the freshness chip would report the
//                    age of the original capture while serving a copy.
//   meta.json        the version signal. If this were served from cache the
//                    page could never notice that the data underneath it had
//                    been rebuilt, and the purge below would never fire.
//   index.html       network-first, so a new deploy is picked up on the next
//                    load rather than whenever the cache happens to expire.
//   anything cross-origin, and anything the page asked for with `no-store` or
//   `no-cache` — which is exactly how the live feed and the stale-build
//   watcher fetch, so both keep working unchanged.
//
// The data cache is keyed on a hash of meta.json, which the page sends after
// it has loaded. A rebuilt city changes that hash and the old binaries are
// dropped in one go, rather than a half-new city being assembled from two
// builds — which would be far worse than a slow load.

const APP_CACHE = "rtm-app-v1";
const DATA_CACHE = "rtm-data-v1";
const VERSION_KEY = "https://rtm.local/__data-version";
const KEEP = new Set([APP_CACHE, DATA_CACHE]);

self.addEventListener("install", (e) => {
  // Nothing is precached: the app shell is small and the data is enormous, so
  // there is no set of files worth downloading before anyone has asked.
  e.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (!KEEP.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

/**
 * Drop the whole data cache when the city underneath it has been rebuilt.
 *
 * All or nothing on purpose. The binaries are one artifact split across five
 * files — graph.bin indexes into the same node ids roads.bin draws — so a
 * cache holding yesterday's graph beside today's roads would render a city
 * that never existed. Serving the old one until every file can be replaced is
 * the safe half of that trade; the page will fetch the new set on this load.
 */
async function syncDataVersion(version) {
  const cache = await caches.open(DATA_CACHE);
  const held = await cache.match(VERSION_KEY);
  const seen = held ? await held.text() : null;
  if (seen === version) return;
  if (seen !== null) {
    // A version is on record and it is not this one, so the cache holds a city
    // that no longer exists. Drop it whole.
    await caches.delete(DATA_CACHE);
    const fresh = await caches.open(DATA_CACHE);
    await fresh.put(VERSION_KEY, new Response(version)).catch(() => {});
    return;
  }
  // Nothing on record: this is the first load that has ever reported a
  // version, so there is nothing stale to remove — and deleting here would
  // throw away exactly what this load has just finished caching. The page
  // sends the version at the end of boot, by which point the 27 MB is already
  // going in, so the old unconditional delete cost the first visit its cache
  // and made the warm-up take two loads instead of one.
  await cache.put(VERSION_KEY, new Response(version)).catch(() => {});
}

self.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg && msg.type === "data-version" && typeof msg.version === "string") {
    e.waitUntil(syncDataVersion(msg.version));
  }
});

/** Serve from cache, and only reach the network for something never seen. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // A 206 cannot be replayed as a whole response, and an error is not worth
  // holding onto — the next load should be free to try again.
  //
  // The put is deliberately not awaited and deliberately caught: storing the
  // city is 27 MB, and on a device near its storage limit every one of these
  // rejects with QuotaExceededError. The response is already in hand, so a
  // full disk should cost the visitor nothing but the cache — not an
  // unhandled rejection per file, and not a failed load.
  if (res.ok && res.status === 200) cache.put(request, res.clone()).catch(() => {});
  return res;
}

/** Prefer the network; fall back to cache only when it cannot be reached. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok && res.status === 200) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // the live and archive branches, jsDelivr

  // Navigations come first, before the cache-mode bypass below.
  //
  // A reload — the browser's button, or Ctrl+R — arrives with cache mode
  // "reload", and bypassing it meant the document was the one thing this
  // worker never answered. Offline, that is the difference between a map that
  // opens and ERR_INTERNET_DISCONNECTED: every binary was in the cache and
  // nothing could get to the page that would have read them. Still
  // network-first, so a new deploy is picked up whenever there is a network.
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, APP_CACHE));
    return;
  }

  // The page has already said it does not want a cached copy. The stale-build
  // watcher (no-store) and the live feed (no-cache) both depend on this.
  if (req.cache === "no-store" || req.cache === "no-cache" || req.cache === "reload") return;

  const path = url.pathname;
  const scope = new URL(self.registration.scope).pathname;
  const rel = path.startsWith(scope) ? path.slice(scope.length) : path.replace(/^\//, "");

  // A measurement of now, and the version signal: never served from a cache.
  if (rel.startsWith("data/live/") || rel === "data/meta.json") {
    e.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }
  // The city. Content-stable within a build, and the reason this file exists.
  if (rel.startsWith("data/")) {
    e.respondWith(cacheFirst(req, DATA_CACHE));
    return;
  }
  // Vite fingerprints these, so a cached one can never be the wrong version.
  if (rel.startsWith("assets/")) {
    e.respondWith(cacheFirst(req, APP_CACHE));
    return;
  }
  // Fonts are fingerprinted alongside the bundle; everything else in scope
  // (including index.html fetched as a subresource by the build watcher, which
  // has already been let through above) takes the network first.
  e.respondWith(networkFirst(req, APP_CACHE));
});
