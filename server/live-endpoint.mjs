import { collectLiveSnapshot } from "../scripts/fetch-live.mjs";
import { loadTransitCatalog } from "./transit-catalog.mjs";

const CACHE_MS = 30_000;
const RETRY_MS = 15_000;

/** A shared promise coalesces concurrent cold requests in each warm instance. */
export function createLiveHandler({ collect = collectLiveSnapshot, catalog = loadTransitCatalog, now = Date.now } = {}) {
  let cached = null, inflight = null, retryAt = 0;
  const load = async () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.body;
    if (inflight) return inflight;
    if (now() < retryAt) throw new Error("Upstream unavailable");
    inflight = (async () => {
      try {
        const signal = AbortSignal.timeout(6_500);
        const transit = catalog(signal);
        // A provider may fail before another feed starts awaiting the catalog.
        transit.catch(() => {});
        const snap = await collect({ signal, transit });
        // A new envelope around old environmental readings is not a live map.
        const current = [snap.vehicles, snap.traffic].some((section) => {
          const age = now() - Date.parse(section?.t);
          return Number.isFinite(age) && age >= -60_000 && age < 5 * 60_000;
        });
        if (!current) throw new Error("No current traffic or transit observations");
        const body = JSON.stringify(snap);
        cached = { at: now(), body };
        return body;
      } catch (error) {
        retryAt = now() + RETRY_MS;
        throw error;
      } finally { inflight = null; }
    })();
    return inflight;
  };
  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD, OPTIONS");
      res.statusCode = 405;
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }
    try {
      const body = await load();
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      res.setHeader("Vercel-CDN-Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
      res.statusCode = 200;
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      console.warn("Live endpoint:", error.message);
      res.statusCode = 503;
      res.setHeader("Retry-After", "15");
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "Live sources temporarily unavailable" }));
    }
  };
}
