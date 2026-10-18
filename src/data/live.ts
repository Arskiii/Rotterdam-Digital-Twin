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
const OBSERVATION_URL = import.meta.env.VITE_OBSERVATION_API_URL?.trim() || "";
// The GitHub raw fallback has cache-control max-age=300 and its cache-busting
// query string does not help. A configured observation service can deliver
// faster, so poll that path once a minute; the GitHub-only path needs less.
const POLL_MS = OBSERVATION_URL ? 60_000 : 120_000;
const MAX_SNAPSHOT_CHARS = 2_000_000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validTime = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));
const finiteOrNull = (value: unknown) => value === null || Number.isFinite(value);

/** Cap the decoded response before parsing; content-length is often absent on CDN responses. */
export async function readSnapshotJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_SNAPSHOT_CHARS) throw new Error("Live snapshot too large");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SNAPSHOT_CHARS) { await reader.cancel(); throw new Error("Live snapshot too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

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
export function admitSnapshot(raw: unknown, current: LiveSnapshot | null, now = Date.now()): "invalid" | "stale" | "ok" {
  const snap = raw as LiveSnapshot | null;
  if (!record(snap) ||
      !Number.isInteger(snap.v) || snap.v < 1 || snap.v > 3 || typeof snap.t !== "string") return "invalid";
  const snapshotTime = Date.parse(snap.t);
  if (!Number.isFinite(snapshotTime) || snapshotTime > now + 60_000 ||
      !["traffic", "bridges", "incidents", "vehicles", "departures", "water", "weather", "air"].some((key) => Object.hasOwn(snap, key))) return "invalid";
  // The mirror and optional observation receiver are external JSON. Reject
  // malformed sections before the renderer can assume array/object methods.
  if (snap.traffic !== undefined && (!record(snap.traffic) || !validTime(snap.traffic.t) ||
      !Array.isArray(snap.traffic.s) || snap.traffic.s.length > 5000 ||
      !snap.traffic.s.every((row) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite)))) return "invalid";
  if (snap.bridges !== undefined && (!Array.isArray(snap.bridges) || snap.bridges.length > 500 ||
      !snap.bridges.every((bridge) => record(bridge) && typeof bridge.name === "string" &&
        Number.isFinite(bridge.x) && Number.isFinite(bridge.y) && Array.isArray(bridge.edges) &&
        bridge.edges.every(Number.isInteger)))) return "invalid";
  if (snap.incidents !== undefined && (!Array.isArray(snap.incidents) || snap.incidents.length > 500 ||
      !snap.incidents.every((incident) => record(incident) && Number.isFinite(incident.x) && Number.isFinite(incident.y) &&
        typeof incident.name === "string" && Number.isFinite(incident.kind)))) return "invalid";
  if (snap.vehicles !== undefined && (!record(snap.vehicles) || !validTime(snap.vehicles.t) ||
      !Array.isArray(snap.vehicles.v) || snap.vehicles.v.length > 10_000 ||
      !snap.vehicles.v.every((row) => Array.isArray(row) && row.length === (snap.v < 2 ? 5 : 9) &&
        row.slice(0, 3).every(Number.isFinite) && typeof (snap.v < 2 ? row[4] : row[3]) === "string") ||
      (snap.vehicles.plan !== undefined && (!record(snap.vehicles.plan) ||
        !Object.values(snap.vehicles.plan).every((points) => Array.isArray(points) && points.length <= 100 &&
          points.every((point) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite))))))) return "invalid";
  if (snap.departures !== undefined && (!record(snap.departures) || !validTime(snap.departures.t) ||
      !record(snap.departures.stops) || !record(snap.departures.dep) ||
      !Object.values(snap.departures.stops).every((stop) => Array.isArray(stop) && stop.length === 3 &&
        typeof stop[0] === "string" && Number.isFinite(stop[1]) && Number.isFinite(stop[2])) ||
      !Object.values(snap.departures.dep).every((rows) => Array.isArray(rows) && rows.length <= 100 &&
        rows.every((row) => Array.isArray(row) && row.length === 7 && typeof row[0] === "string" &&
          Number.isFinite(row[1]) && typeof row[2] === "string" && row.slice(3, 6).every(Number.isFinite) &&
          typeof row[6] === "string")))) return "invalid";
  if (snap.air !== undefined && (!record(snap.air) || !validTime(snap.air.t) || !Array.isArray(snap.air.s) ||
      !snap.air.s.every((row) => Array.isArray(row) && row.length === 5 && Number.isFinite(row[0]) && Number.isFinite(row[1]) &&
        finiteOrNull(row[2]) && finiteOrNull(row[3]) && typeof row[4] === "string"))) return "invalid";
  if (snap.water !== undefined && (!record(snap.water) || !validTime(snap.water.t) || !Number.isFinite(snap.water.cm))) return "invalid";
  if (snap.weather !== undefined && (!record(snap.weather) || !validTime(snap.weather.t) || !Number.isFinite(snap.weather.rain))) return "invalid";
  if (current && Date.parse(snap.t) < Date.parse(current.t)) return "stale";
  // v1 published [x, y, kind, bearing, line] where v2 publishes the line and
  // the trip id; read raw, every bus on a route collapsed into one vehicle.
  if (snap.v < 2) upgradeV1(snap);
  // v2 vehicle paths listed only the calls still ahead; v3 starts each one at
  // the call already made. Read as v3, a v2 path parks every vehicle on the
  // platform it is heading for. The missing call is not in the file, so the
  // paths are dropped and those vehicles sit at their last fix, as under v2.
  if (snap.v < 3 && snap.vehicles) delete snap.vehicles.plan;
  return "ok";
}

export class LiveFeed {
  snapshot: LiveSnapshot | null = null;
  source: "service" | "branch" | "local" | null = null;
  private localUrl: string;
  private onUpdate: (snap: LiveSnapshot) => void;
  private lastT = "";
  private polling = false;

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
    if (this.polling) return;
    this.polling = true;
    try {
      // Prefer a configured observation service; retain GitHub and the bundled
      // copy as fallbacks when it is unavailable or older than a known snapshot.
      const sources: ["service" | "branch" | "local", string][] = [
        ...(OBSERVATION_URL ? [["service", OBSERVATION_URL] as ["service", string]] : []),
        ["branch", LIVE_BRANCH_URL], ["local", this.localUrl],
      ];
      for (const [source, url] of sources) {
        let snap: LiveSnapshot;
        try {
          const res = await fetch(url, { cache: "no-cache", credentials: "omit", signal: AbortSignal.timeout(8_000) });
          if (!res.ok) continue;
          snap = (await readSnapshotJson(res)) as LiveSnapshot;
        } catch {
          continue; // this source is unreachable — try the next one
        }
        // v1 snapshots predate the departure boards but still carry traffic,
        // weather and tide, so they are accepted and simply offer less
        const verdict = admitSnapshot(snap, this.snapshot);
        if (verdict === "invalid") continue;
        if (verdict === "stale") continue; // try other paths, but never undo a fresher publish
        if (snap.t !== this.lastT) {
          this.lastT = snap.t;
          this.source = source;
          this.snapshot = snap;
          // Deliberately outside the fetch try/catch. Folding the handler into
          // it meant a bug anywhere downstream looked exactly like an offline
          // feed: the snapshot was dropped, the next source was tried, and the
          // app sat there with no data and nothing in the console.
          this.onUpdate(snap);
        }
        // A service can be reachable yet lag its publisher. When it is already
        // several minutes old, check the mirror before declaring this poll done.
        if (source === "service" && this.ageMin() > 3) continue;
        return;
      }
    } finally { this.polling = false; }
  }
}
