// Live city state produced by scripts/fetch-live.mjs: NDW traffic flows,
// open bascule bridges, OVapi transit positions, Maas water level, weather
// and air quality. The snapshot is refreshed by .github/workflows/live-data.yml
// onto the repo's `live` branch; a local copy ships as a fallback so the app
// works offline and in dev.

export interface LiveSnapshot {
  v: number;
  t: string;
  traffic?: { t: string; todMin: number; s: [number, number, number][] }; // [stationIdx, veh/h, km/h]
  bridges?: { name: string; x: number; y: number; edges: number[]; until: string }[];
  incidents?: { x: number; y: number; kind: number; edge: number; name: string; until: string }[];
  vehicles?: { t: string; v: [number, number, number, number, string][] }; // [x, y, kind, bearing, line]
  water?: { station: string; cm: number; trend: number; t: string };
  weather?: { t: string; temp: number | null; wind: number | null; dir: number | null; gust: number | null; rain: number; desc: string };
  air?: { t: string; s: [number, number, number | null, number | null, string][] }; // [x, y, NO2, PM2.5, name]
}

const LIVE_BRANCH_URL = "https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/live/live.json";
const POLL_MS = 75_000;

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

  private async poll() {
    // the refreshed branch first, the committed copy as fallback
    for (const [source, url] of [["branch", LIVE_BRANCH_URL], ["local", this.localUrl]] as const) {
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) continue;
        const snap = (await res.json()) as LiveSnapshot;
        if (!snap?.t || snap.v !== 1) continue;
        // never replace a fresher snapshot with a staler one
        if (this.snapshot && Date.parse(snap.t) < Date.parse(this.snapshot.t)) return;
        this.source = source;
        if (snap.t !== this.lastT) {
          this.lastT = snap.t;
          this.snapshot = snap;
          this.onUpdate(snap);
        }
        return;
      } catch {
        /* try next source */
      }
    }
  }
}
