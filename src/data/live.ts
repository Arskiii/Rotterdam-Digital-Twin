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
function upgradeV1(snap: LiveSnapshot) {
  const raw = snap.vehicles?.v as unknown as [number, number, number, number, string][] | undefined;
  if (!raw) return;
  snap.vehicles!.v = raw.map(([x, y, kind, , line], i) => [
    x, y, kind, line ?? "", `v1:${i}`, -1, 0, "", -1,
  ]);
}

export class LiveFeed {
  snapshot: LiveSnapshot | null = null;
  source: "branch" | "local" | null = null;
  private localUrl: string;
  private onUpdate: (snap: LiveSnapshot) => void;
  private lastT = "";

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
      if (!snap?.t || !(snap.v >= 1)) continue;
      if (snap.v < 2) upgradeV1(snap);
      // never replace a fresher snapshot with a staler one
      if (this.snapshot && Date.parse(snap.t) < Date.parse(this.snapshot.t)) return;
      this.source = source;
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
