import { gunzipSync } from "node:zlib";
import { parseTimetable, serviceDateNum } from "../scripts/fetch-live.mjs";

const URL = "https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/transit-data/transit.json.gz";

export function createTransitCatalog({ fetcher = fetch, now = Date.now } = {}) {
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
        const response = await fetcher(URL, { signal });
        if (!response.ok) throw new Error(`Transit catalog: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 12_000_000) throw new Error("Transit catalog too large");
        const data = JSON.parse(gunzipSync(bytes, { maxOutputLength: 40_000_000 }).toString());
        if (data.v !== 1 || !data.routes || !data.stops || typeof data.timetable !== "string") throw new Error("Invalid transit catalog");
        const timetable = parseTimetable(Buffer.from(data.timetable, "base64"));
        if (!timetable.trips.length) throw new Error("Empty transit timetable");
        const value = { routes: data.routes, stops: data.stops, timetable };
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
