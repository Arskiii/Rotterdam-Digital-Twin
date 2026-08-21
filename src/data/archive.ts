// The historical archive: what the city was actually doing, hours or months
// ago. Written by scripts/archive-live.mjs from every live snapshot and
// published on the repo's `archive` branch.
//
// Two tiers, because the useful questions have different shapes:
//
//   c/YYYY/MM/DD/HH.bin   coarse — per district plus city scalars, one record
//                         per 5 minutes, kept forever (~1 KB an hour)
//   f/YYYY/MM/DD/HH.bin   fine   — every NDW station, same cadence, kept for a
//                         rolling window (~22 KB an hour)
//   e/YYYY-MM.json        events — incidents and bridge openings, deduped
//
// This module reads the coarse tier, which is what a months-long scrub needs.
// Hours are fetched independently and cached, so dragging the timeline costs
// one small request per hour it has not seen.

// The published archive first, then a locally committed copy — the same
// two-source shape the live feed uses, so the scrubber still works offline,
// in dev, and on a deployment that ships its own archive slice.
const ARCHIVE_SOURCES = [
  "https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/archive",
  `${import.meta.env.BASE_URL}data/archive`,
];

const COARSE_MAGIC = "RTAC";
const COARSE_HEAD = 13; // magic(4) + version(2) + hourEpoch(4) + districts(1) + records(2)

export interface DistrictSample {
  flow: number; // veh/h summed across the district's stations
  speed: number; // km/h, mean of reporting stations
  congestion: number; // 0 free-flowing … 1 stopped
}

export interface ArchiveRecord {
  /** unix ms at the sample */
  t: number;
  temp: number;
  rain: number;
  waterCm: number;
  incidents: number;
  bridges: number;
  transit: number;
  no2: number;
  pm25: number;
  districts: DistrictSample[];
}

export interface ArchiveEvent {
  t: string;
  type: string;
  name: string;
  x: number;
  y: number;
  until: string | null;
}

function parseCoarse(buf: ArrayBuffer): ArchiveRecord[] {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (buf.byteLength < COARSE_HEAD) return [];
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== COARSE_MAGIC) return [];
  const hourEpoch = dv.getUint32(6, true); // unix seconds at the hour start
  const districtCount = dv.getUint8(10);
  const recordCount = dv.getUint16(11, true);
  const recSize = 13 + districtCount * 4;
  const out: ArchiveRecord[] = [];
  for (let i = 0; i < recordCount; i++) {
    let p = COARSE_HEAD + i * recSize;
    if (p + recSize > buf.byteLength) break;
    const slot = dv.getUint8(p); p += 1;
    const temp = dv.getInt16(p, true) / 10; p += 2;
    const rain = dv.getUint16(p, true) / 100; p += 2;
    const waterCm = dv.getInt16(p, true); p += 2;
    const incidents = dv.getUint8(p); p += 1;
    const bridges = dv.getUint8(p); p += 1;
    const transit = dv.getUint16(p, true); p += 2;
    const no2 = dv.getUint8(p); p += 1;
    const pm25 = dv.getUint8(p); p += 1;
    const districts: DistrictSample[] = [];
    for (let d = 0; d < districtCount; d++) {
      const flow = dv.getUint16(p, true); p += 2;
      const speed = dv.getUint8(p); p += 1;
      const congestion = dv.getUint8(p) / 255; p += 1;
      districts.push({ flow, speed, congestion });
    }
    out.push({
      t: (hourEpoch + slot * 60) * 1000,
      temp, rain, waterCm, incidents, bridges, transit, no2, pm25, districts,
    });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Path for one archived hour, in UTC (the archive is written in UTC). */
function hourPath(tier: "c" | "f", at: Date): string {
  return `${tier}/${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())}/${pad(at.getUTCHours())}.bin`;
}

export class ArchiveReader {
  /** hour key → records, or null when that hour was never archived */
  private hours = new Map<string, ArchiveRecord[] | null>();
  private inflight = new Map<string, Promise<ArchiveRecord[] | null>>();
  private basePromise: Promise<string | null> | null = null;
  /** month key → its events, so a re-render costs nothing */
  private eventsByMonth = new Map<string, ArchiveEvent[]>();

  /**
   * Pick the archive source once, not per hour.
   *
   * Racing both sources on every hour meant an unreachable CDN cost two
   * timed-out requests per hour, and the browser's six-connections-per-host
   * limit turned a one-day window into half a minute of dead air. A 404 still
   * counts as reachable: it means the host answered and that hour simply was
   * not archived, which is the normal case.
   */
  private resolveBase(probe: string): Promise<string | null> {
    if (this.basePromise) return this.basePromise;
    this.basePromise = (async () => {
      for (const base of ARCHIVE_SOURCES) {
        try {
          // short: a healthy CDN answers well inside this, and the point is
          // to fall through quickly when it cannot be reached at all
          await fetch(`${base}/${probe}`, { cache: "default", signal: AbortSignal.timeout(3500) });
          return base; // answered at all — this host is serving the archive
        } catch {
          /* unreachable — try the next source */
        }
      }
      return null;
    })();
    return this.basePromise;
  }

  private async loadHour(hourStart: Date): Promise<ArchiveRecord[] | null> {
    const path = hourPath("c", hourStart);
    if (this.hours.has(path)) return this.hours.get(path)!;
    const pending = this.inflight.get(path);
    if (pending) return pending;
    const p = (async () => {
      try {
        const base = await this.resolveBase(path);
        if (!base) return null; // no reachable archive at all
        let buf: ArrayBuffer;
        try {
          const res = await fetch(`${base}/${path}`, { cache: "default", signal: AbortSignal.timeout(8000) });
          if (!res.ok) {
            // a missing hour is normal — the pipeline was not running then
            this.hours.set(path, null);
            return null;
          }
          buf = await res.arrayBuffer();
        } catch {
          return null; // transient: do not cache, a later scrub can retry
        }
        const recs = parseCoarse(buf);
        this.hours.set(path, recs.length ? recs : null);
        return recs.length ? recs : null;
      } finally {
        this.inflight.delete(path);
      }
    })();
    this.inflight.set(path, p);
    return p;
  }

  /**
   * Every archived sample in [from, to], oldest first.
   *
   * Hours are requested in parallel and missing ones simply contribute
   * nothing, so a window that straddles a pipeline outage returns the data
   * that does exist rather than failing.
   */
  async range(from: Date, to: Date): Promise<ArchiveRecord[]> {
    const end = to.getTime();
    const spanHours = Math.max(1, (end - from.getTime()) / 3_600_000);
    // One file per hour means a month is 720 requests, which is not a timeline
    // — it is a stampede. Wide windows sample hours instead: a 30-day scrub
    // reads every sixth hour, which is still far finer than its pixel width.
    const stride = spanHours > 336 ? 6 : spanHours > 120 ? 3 : spanHours > 48 ? 2 : 1;
    const hours: Date[] = [];
    const cursor = new Date(Date.UTC(
      from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours()
    ));
    while (cursor.getTime() <= end && hours.length < 200) {
      hours.push(new Date(cursor.getTime()));
      cursor.setUTCHours(cursor.getUTCHours() + stride);
    }
    const loaded = await Promise.all(hours.map((h) => this.loadHour(h)));
    const out: ArchiveRecord[] = [];
    for (const recs of loaded) {
      if (!recs) continue;
      for (const r of recs) if (r.t >= from.getTime() && r.t <= end) out.push(r);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** Recorded incidents and bridge openings for a month (YYYY-MM). */
  async events(year: number, month: number): Promise<ArchiveEvent[]> {
    const key = `${year}-${pad(month)}`;
    const cached = this.eventsByMonth.get(key);
    if (cached) return cached;
    const path = `e/${key}.json`;
    // Through resolveBase, not its own walk of the source list: the hours have
    // already settled which host is serving this archive, and re-deciding here
    // meant every call paid the full timeout of a source known to be dead.
    // Measured against an unreachable branch, one month of events took 22
    // seconds to arrive that way and sometimes timed out entirely.
    const base = await this.resolveBase(path);
    if (!base) return [];
    try {
      const res = await fetch(`${base}/${path}`, { cache: "default", signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const raw = (await res.json()) as ArchiveEvent[];
      if (!Array.isArray(raw)) return [];
      this.eventsByMonth.set(key, raw);
      return raw;
    } catch {
      return [];
    }
  }
}
