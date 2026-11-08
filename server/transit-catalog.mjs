import { gunzipSync } from "node:zlib";
import { parseTimetable, serviceDateNum } from "../scripts/fetch-live.mjs";
import collection from '../collection.config.json' with { type: 'json' };

const URL = "https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/transit-data/transit.json.gz";

export function decodeTransitCatalog(bytes, now = Date.now()) {
  if (bytes.length > 12_000_000) throw new Error("Transit catalog too large");
  const data = JSON.parse(gunzipSync(bytes, { maxOutputLength: 40_000_000 }).toString());
  if (data.v !== 1 || !data.routes || !data.stops || typeof data.timetable !== "string") throw new Error("Invalid transit catalog");
  const timetable = parseTimetable(Buffer.from(data.timetable, "base64"));
  const day = serviceDateNum(new Date(now));
  if (!timetable.trips.some(trip => timetable.dateSets[trip.dates]?.has(day))) throw new Error("Transit timetable does not cover today");
  return { routes: data.routes, stops: data.stops, timetable };
}

export function createTransitCatalog({ fetcher = fetch, now = Date.now, urls = [`${collection.origin}/data/transit.json.gz`, URL] } = {}) {
  let cached = null, loadedAt = 0, inflight = null, retryAt = 0;
  const usable = (value) => {
    const day = serviceDateNum(new Date(now()));
    return value?.timetable.trips.some((trip) => value.timetable.dateSets[trip.dates]?.has(day));
  };
  return async (signal) => {
    if (usable(cached) && (now() - loadedAt < 15 * 60_000 || now() < retryAt)) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        let value, lastError;
        for (const url of urls) {
          try {
            const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500) });
            if (!response.ok) throw new Error(`Transit catalog: HTTP ${response.status}`);
            value = decodeTransitCatalog(Buffer.from(await response.arrayBuffer()), now());
            break;
          } catch (error) { lastError = error; }
        }
        if (!value) throw lastError;
        if (!usable(value)) throw new Error("Transit timetable does not cover today");
        cached = value;
        loadedAt = now();
        return value;
      } catch (error) {
        retryAt = now() + 60_000;
        // Keep usable identities through a brief mirror outage, but never carry
        // an expired service calendar into a new day.
        if (usable(cached)) return cached;
        throw error;
      } finally { inflight = null; }
    })();
    return inflight;
  };
}

export const loadTransitCatalog = createTransitCatalog();
