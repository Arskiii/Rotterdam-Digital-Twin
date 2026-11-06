# Cache and startup reliability — 6 November 2026

Opening Intelligence or Scenario Lab directly previously preloaded `graph.bin`,
`roads.bin` and `buildings.bin` from the root document even though those views did
not need the 3D map. Those three downloads total **25,300,064 bytes**. The shared
shell now starts them only when the map is opened, alongside its lazy JavaScript
module. Preload and loader URLs use identical content versions.

City files have SHA-256 versions computed from their bytes at build time. This
catches height-only rebuilds that do not change the counts in `meta.json`. Roof
tiles share a directory version that also includes their buildings file. Core
files and metadata are checked against their individual digests before use on
HTTPS/localhost; the commit-pinned external mirror retains its own versions.
An inconsistent core download asks the user to reload instead of mixing builds.
The existing late, metadata-only cache purge has been removed.

Only fingerprinted application assets and versioned city files use cache-first
loading. Other datasets revalidate online, including traffic history, CBS
neighborhoods, model validation and NDW. Live observations and APIs bypass the
offline cache. Network errors and temporary server errors can use the last
successful offline document/data response; freshness labels still describe the
original observation timestamps.

Cache reads and writes tolerate unavailable storage and quota failures. Writes
are covered by the fetch event lifetime without delaying the response on disk
I/O, following the service-worker
[waitUntil contract](https://developer.mozilla.org/en-US/docs/Web/API/ExtendableEvent/waitUntil).
Activation and the `?nosw=1` recovery path leave unrelated workers/caches alone.
Registration starts with the shell and no longer depends on successful map boot.

Map downloads have a two-minute limit covering the response body as well as the
connection. Small metadata and optional tile downloads have shorter limits.
Simulation initialization has a 20-second no-progress watchdog and a two-minute
overall limit. A blocked constructor, transfer error, decode error or stalled
worker uses the existing one-retry/live-map fallback. Startup listeners and timers
are removed when finished, and a failed city download terminates its worker.
The map reuses the metadata from its source probe rather than fetching it again.
Geometry-build MessageChannel ports are closed after each yield.

## Verification

- 161 Vitest tests, 83 Node tests, 15 Python tests; TypeScript and production build.
- Regression tests execute the actual service-worker script with cache/network
  failures, offline reload, HTTP 503, content changes, pending writes, private and
  partial responses, API bypass and migration from the old data cache.
- Worker tests cover readiness, progressing/idle startup, the total deadline,
  blocked construction, failed transfers, decode failures and cancellation.
- Local production-browser request logging: direct Intelligence load requested
  **zero map binaries**. Opening the map then downloaded each of its seven core
  binaries once. Reloading the warmed map made **zero core binary network
  requests**, reusing **28,330,159 bytes** while mutable datasets revalidated.
  The test server forced HTTP revalidation, so this was service-worker reuse.
- Shared navigation and Setup's Simulation-only controls verified in the browser.
- A browser run with `worker-src 'none'` recovered from Setup to Map/Live,
  disabled Simulation and showed labelled local activity plus live transit.
- Reloading the warmed map with the local HTTP server stopped recovered the
  cached city. This checks an unavailable site server, not offline live feeds.
- Shell: 60.7 kB JavaScript, within 100 kB budget. Lazy map: 760.8 kB, within
  800 kB budget. No new dependencies. These are transfer/cache improvements;
  no browser FPS or frame-time improvement is claimed.

The `rtm-data-v2` migration replaces the old unversioned cache once. A first visit
can begin downloads before the worker takes control; complete offline reuse is
guaranteed only for resources that have actually been cached, not every possible
route or unvisited roof tile.
