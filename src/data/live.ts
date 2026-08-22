// Live city state produced by scripts/fetch-live.mjs: NDW traffic flows, open
// bascule bridges, real transit positions and departure boards, Maas water
// level, weather and air quality. The snapshot is refreshed on a 60-second
// cadence by .github/workflows/deploy.yml onto the repo's `live` branch; a
// local copy ships as a fallback so the app works offline and in dev.

/** [x, y, kind, line, tripId, stopSeq, berthed, vehicleId, fixAgeSec] */
export type LiveVehicle = [number, number, number, string, string, number, number, string, number];

/** [line, kind, destination, secondsUntil, delaySec, isLive, tripId] */
export type Departure = [string, number, string, number, number, number, string];

export interface LiveSnapshot {
  v: number;
  t: string;
  traffic?: { t: string; todMin: number; s: [number, number, number][] }; // [stationIdx, veh/h, km/h]
  bridges?: { name: string; x: number; y: number; edges: number[]; until: string }[];
  incidents?: { x: number; y: number; kind: number; edge: number; name: string; until: string }[];
  vehicles?: {
    t: string;
    v: LiveVehicle[];
    /**
     * tripId → the trip's remaining calls as [x, y, secondsAfter `t`], already
     * shifted by the delay that trip is running. Lets the client keep a vehicle
     * moving between fixes on the timetable's own arithmetic.
     */
    plan?: Record<string, [number, number, number][]>;
  };
  departures?: {
    t: string;
    /** stationKey → [name, x, y] */
    stops: Record<string, [string, number, number]>;
    /** stationKey → next services */
    dep: Record<string, Departure[]>;
    liveTrips?: number;
  };
  water?: { station: string; cm: number; trend: number; t: string };
  weather?: { t: string; temp: number | null; wind: number | null; dir: number | null; gust: number | null; rain: number; desc: string };
  air?: { t: string; s: [number, number, number | null, number | null, string][] }; // [x, y, NO2, PM2.5, name]
}

const LIVE_BRANCH_URL = "https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/live/live.json";
// The live branch is served with cache-control max-age=300 and a cache-busting
// query string does not get past it, so five minutes is a hard floor on how
// fresh this data can be however often the workflow publishes. Polling faster
// than the source cadence just re-reads the same cached object.
const POLL_MS = 120_000;

/**
 * Thresholds are set against what the delivery path can actually achieve, not
 * against the publish cadence. The CDN caps freshness at five minutes, so a
 * perfectly healthy feed routinely reads as four or five minutes old; marking
 * that "lagging" would leave the chip amber almost permanently and teach the
 * operator to ignore it.
 *
 * Past the stale threshold the UI stops presenting old traffic as current,
 * which matters most for the departure boards: an hours-old "due in 2 min" is
 * worse than no board at all.
 */
export const LIVE_STALE_MIN = 20;
export const LIVE_LAGGING_MIN = 9;

export type LiveHealth = "live" | "lagging" | "stale" | "offline";

/**
 * Bring a v1 snapshot up to the v2 vehicle shape, in place.
 *
 * v1 published [x, y, kind, bearing, line]; v2 publishes
 * [x, y, kind, line, tripId, stopSeq, berthed, vehicleId, fixAge]. Read raw,
 * a v1 tuple puts the bearing where the line belongs and the line where the
 * trip id belongs — and since vehicles are keyed by trip, every bus on the
 * same route collapsed into one. A v1 feed rendered 76 vehicles instead of
 * 228 without erroring, which is the kind of wrong that goes unnoticed.
 *
 * Old snapshots carry no trip identity at all, so each vehicle is keyed by its
 * position instead. They cannot be followed across refreshes, which is honest:
 * v1 never knew which vehicle was which.
 */
export function upgradeV1(snap: LiveSnapshot) {
  const raw = snap.vehicles?.v as unknown as [number, number, number, number, string][] | undefined;
  if (!raw) return;
  snap.vehicles!.v = raw.map(([x, y, kind, , line], i) => [
    x, y, kind, line ?? "", `v1:${i}`, -1, 0, "", -1,
  ]);
}

/**
 * Whether a fetched snapshot may replace the one in hand, migrating it on the
 * way in.
 *
 *   invalid — not a snapshot, or a version this build cannot read. Try the
 *             next source; this one told us nothing.
 *   stale   — older than what we already have. Stop looking: a fallback copy
 *             must never overwrite a fresher published one.
 *   ok      — usable, and `raw` has been brought up to the current shape.
 *
 * Split out from the poll loop because this is the part with a history of
 * quiet failures — a v1 tuple read as v2 rendered 76 vehicles instead of 228
 * without erroring — and a network round trip is a poor place to keep logic
 * that can be checked directly.
 */
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Throw away anything in the snapshot that is not the shape it claims to be.
 *
 * This file is assembled by a scheduled job out of five third-party feeds —
 * NDW's XML situations, OVapi's protobuf, Rijkswaterstaat, Buienradar,
 * Luchtmeetnet — and reaches the browser as JSON with no schema between the
 * two. Until now every consumer trusted it completely, and one bad row was
 * enough to take the whole live path down: a `null` in `vehicles.v` threw a
 * TypeError out of the poll, and because the poll records the snapshot's
 * timestamp *before* handing it on, the retry saw the same `t` and skipped the
 * update entirely. The map kept moving on the layers that had already been
 * fed, while the boards, the brief and the transit panel sat frozen on old
 * data with nothing on screen saying so. The same row rendered through the
 * 1.5-second tick took the dock clock with it.
 *
 * So the boundary is the place to fix it, not each of the eight consumers.
 * A row that cannot be read is dropped and counted; the count is surfaced
 * rather than swallowed, because "the feed published 40 unreadable vehicles"
 * is exactly the kind of thing this product says out loud instead of hiding.
 *
 * Non-finite numbers are dropped as hard as missing ones. A NaN delay does not
 * fail anything on its way in — it silently turns a line's median, and then
 * the whole network median, into NaN.
 */
export function sanitizeSnapshot(snap: LiveSnapshot): { dropped: number; fields: string[] } {
  let dropped = 0;
  const fields: string[] = [];
  /** Keep the rows a predicate accepts; drop the field entirely if it is not a list. */
  const sift = <T>(list: unknown, ok: (row: unknown) => boolean, label: string): T[] | undefined => {
    if (list === undefined || list === null) return undefined;
    if (!Array.isArray(list)) {
      dropped++;
      fields.push(label);
      return undefined;
    }
    const kept = (list as unknown[]).filter(ok);
    if (kept.length !== list.length) {
      dropped += list.length - kept.length;
      fields.push(label);
    }
    return kept as T[];
  };

  if (snap.traffic) {
    // [stationIdx, veh/h, km/h]
    const s = sift<[number, number, number]>(
      snap.traffic.s,
      (r) => Array.isArray(r) && r.length >= 3 && num(r[0]) && r[0] >= 0 && num(r[1]) && num(r[2]),
      "traffic"
    );
    if (s) snap.traffic.s = s;
    else delete (snap as { traffic?: unknown }).traffic;
  }

  if (snap.vehicles) {
    // [x, y, kind, line, tripId, stopSeq, berthed, vehicleId, fixAge]
    const v = sift<LiveVehicle>(
      snap.vehicles.v,
      (r) => Array.isArray(r) && r.length >= 9 && num(r[0]) && num(r[1]) && num(r[2]),
      "vehicles"
    );
    snap.vehicles.v = v ?? [];
    // A plan keyed by trip id, each call [x, y, secondsAfter t]. A malformed
    // leg parks a vehicle at NaN, which is worse than not animating it.
    const plan = snap.vehicles.plan;
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
      for (const trip of Object.keys(plan)) {
        const legs = plan[trip];
        if (!Array.isArray(legs) || !legs.every((l) => Array.isArray(l) && l.length >= 3 && num(l[0]) && num(l[1]) && num(l[2]))) {
          delete plan[trip];
          dropped++;
          fields.push("paths");
        }
      }
    } else if (plan !== undefined) {
      delete snap.vehicles.plan;
      dropped++;
      fields.push("paths");
    }
  }

  if (snap.departures) {
    const dep = snap.departures.dep;
    if (!dep || typeof dep !== "object" || Array.isArray(dep)) {
      snap.departures.dep = {};
      if (dep !== undefined) {
        dropped++;
        fields.push("boards");
      }
    } else {
      for (const stop of Object.keys(dep)) {
        // [line, kind, destination, secondsUntil, delaySec, isLive, tripId]
        const rows = sift<Departure>(
          dep[stop],
          (r) => Array.isArray(r) && r.length >= 6 && num(r[3]) && num(r[4]) && num(r[1]),
          "boards"
        );
        if (rows) dep[stop] = rows;
        else delete dep[stop];
      }
    }
    const stops = snap.departures.stops;
    if (!stops || typeof stops !== "object" || Array.isArray(stops)) {
      snap.departures.stops = {};
      if (stops !== undefined) {
        dropped++;
        fields.push("stops");
      }
    } else {
      for (const k of Object.keys(stops)) {
        const s = stops[k];
        if (!Array.isArray(s) || s.length < 3 || typeof s[0] !== "string" || !num(s[1]) || !num(s[2])) {
          delete stops[k];
          dropped++;
          fields.push("stops");
        }
      }
    }
  }

  const inc = sift<NonNullable<LiveSnapshot["incidents"]>[number]>(
    snap.incidents,
    (r) => !!r && typeof r === "object" && num((r as { x: unknown }).x) && num((r as { y: unknown }).y) && num((r as { kind: unknown }).kind),
    "incidents"
  );
  if (snap.incidents !== undefined) snap.incidents = inc ?? [];

  const br = sift<NonNullable<LiveSnapshot["bridges"]>[number]>(
    snap.bridges,
    (r) => !!r && typeof r === "object" && num((r as { x: unknown }).x) && num((r as { y: unknown }).y) && Array.isArray((r as { edges: unknown }).edges),
    "bridges"
  );
  if (snap.bridges !== undefined) snap.bridges = br ?? [];

  if (snap.air) {
    const s = sift<[number, number, number | null, number | null, string]>(
      snap.air.s,
      (r) => Array.isArray(r) && r.length >= 2 && num(r[0]) && num(r[1]),
      "air"
    );
    if (s) snap.air.s = s;
    else delete (snap as { air?: unknown }).air;
  }

  // Scalars: a non-finite tide reading drives the river mesh to NaN and the
  // whole water plane disappears.
  if (snap.water && !num(snap.water.cm)) {
    delete (snap as { water?: unknown }).water;
    dropped++;
    fields.push("tide");
  }
  if (snap.weather && !num(snap.weather.rain)) {
    if (snap.weather && typeof snap.weather === "object") snap.weather.rain = 0;
    fields.push("weather");
  }

  return { dropped, fields: [...new Set(fields)] };
}

export interface Admission {
  verdict: "invalid" | "stale" | "ok";
  /** rows the snapshot published that could not be read, and had to be dropped */
  dropped: number;
  /** which parts of the feed they came from */
  fields: string[];
}

export function admitSnapshot(raw: unknown, current: LiveSnapshot | null): Admission {
  const no = (verdict: Admission["verdict"]): Admission => ({ verdict, dropped: 0, fields: [] });
  const snap = raw as LiveSnapshot | null;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return no("invalid");
  if (typeof snap.t !== "string" || !snap.t || !(snap.v >= 1)) return no("invalid");
  if (!Number.isFinite(Date.parse(snap.t))) return no("invalid");
  if (current && Date.parse(snap.t) < Date.parse(current.t)) return no("stale");
  // v1 published [x, y, kind, bearing, line] where v2 publishes the line and
  // the trip id; read raw, every bus on a route collapsed into one vehicle.
  if (snap.v < 2) upgradeV1(snap);
  // v2 vehicle paths listed only the calls still ahead; v3 starts each one at
  // the call already made. Read as v3, a v2 path parks every vehicle on the
  // platform it is heading for. The missing call is not in the file, so the
  // paths are dropped and those vehicles sit at their last fix, as under v2.
  if (snap.v < 3 && snap.vehicles) delete snap.vehicles.plan;
  // Version first, shape second: the migrations above rewrite the very rows
  // the sift below has to judge.
  const { dropped, fields } = sanitizeSnapshot(snap);
  return { verdict: "ok", dropped, fields };
}

export class LiveFeed {
  snapshot: LiveSnapshot | null = null;
  source: "branch" | "local" | null = null;
  private localUrl: string;
  private onUpdate: (snap: LiveSnapshot) => void;
  private lastT = "";
  /** rows the last accepted snapshot published that could not be read */
  lastDropped = 0;
  lastDroppedFields: string[] = [];

  constructor(dataBase: string, onUpdate: (snap: LiveSnapshot) => void) {
    this.localUrl = `${dataBase}live/live.json`;
    this.onUpdate = onUpdate;
    void this.poll();
    setInterval(() => void this.poll(), POLL_MS);
  }

  /** Minutes since the snapshot was produced; Infinity before the first load. */
  ageMin(): number {
    if (!this.snapshot) return Infinity;
    return Math.max(0, (Date.now() - Date.parse(this.snapshot.t)) / 60_000);
  }

  health(): LiveHealth {
    const age = this.ageMin();
    if (!Number.isFinite(age)) return "offline";
    if (age > LIVE_STALE_MIN) return "stale";
    if (age > LIVE_LAGGING_MIN) return "lagging";
    return "live";
  }

  /**
   * Whether time-critical readings may be shown as current. Departure boards
   * and vehicle positions go through this; slower-moving values (weather, tide,
   * air quality) stay useful for far longer and do not.
   */
  get fresh(): boolean {
    return this.ageMin() <= LIVE_STALE_MIN;
  }

  private async poll() {
    // the refreshed branch first, the committed copy as fallback
    for (const [source, url] of [["branch", LIVE_BRANCH_URL], ["local", this.localUrl]] as const) {
      let snap: LiveSnapshot;
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) continue;
        snap = (await res.json()) as LiveSnapshot;
      } catch {
        continue; // this source is unreachable — try the next one
      }
      // v1 snapshots predate the departure boards but still carry traffic,
      // weather and tide, so they are accepted and simply offer less
      const { verdict, dropped, fields } = admitSnapshot(snap, this.snapshot);
      if (verdict === "invalid") continue;
      if (verdict === "stale") return; // a fallback must not undo a fresher publish
      this.source = source;
      this.lastDropped = dropped;
      this.lastDroppedFields = fields;
      if (snap.t !== this.lastT) {
        this.lastT = snap.t;
        this.snapshot = snap;
        // Deliberately outside the fetch try/catch. Folding the handler into
        // it meant a bug anywhere downstream looked exactly like an offline
        // feed: the snapshot was dropped, the next source was tried, and the
        // app sat there with no data and nothing in the console.
        this.onUpdate(snap);
      }
      return;
    }
  }
}
