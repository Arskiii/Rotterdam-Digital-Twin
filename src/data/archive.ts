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
import collection from "../../collection.config.json";

const ARCHIVE_SOURCES = [
  `${collection.origin}/archive`,
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

/** Missing version-2 metrics are NaN; callers format them as an em dash. */
export function archiveValue(value: number, decimals = 0, suffix = ""): string {
  return Number.isFinite(value) ? `${value.toFixed(decimals)}${suffix}` : "—";
}

export function archiveStride(hours: number): number {
  return hours > 336 ? 6 : hours > 120 ? 3 : hours > 48 ? 2 : 1;
}

/** Count actual five-minute slots, not the span between two isolated readings. */
export function archiveCoverage(records: ArchiveRecord[], from: number, to: number) {
  const stride = archiveStride((to - from) / 3_600_000);
  const firstHour = Math.floor(from / 3_600_000) * 3_600_000;
  const wanted = new Set<number>();
  for (let hour = firstHour; hour <= to; hour += stride * 3_600_000) {
    for (let i = 0; i < 12; i++) {
      const t = hour + i * 300_000;
      if (t >= from && t + 300_000 <= to) wanted.add(t);
    }
  }
  const captured = new Set(records.filter(r => wanted.has(r.t)).map(r => r.t)).size;
  return { expected: wanted.size, captured, fraction: wanted.size ? captured / wanted.size : 0, sampled: stride > 1 };
}

export interface ArchiveEvent {
  t: string;
  type: string;
  name: string;
  x: number;
  y: number;
  until: string | null;
}

/** Exported for tests: the wire format is the contract between two repos-worth
 *  of code (scripts/archive-live.mjs writes it, this reads it) and nothing else
 *  would notice a silent drift in it. */
export function parseCoarse(buf: ArrayBuffer): ArchiveRecord[] {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (buf.byteLength < COARSE_HEAD) return [];
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== COARSE_MAGIC) return [];
  const version = dv.getUint16(4, true);
  if (version !== 1 && version !== 2) return [];
  const hourEpoch = dv.getUint32(6, true); // unix seconds at the hour start
  const districtCount = dv.getUint8(10);
  const recordCount = dv.getUint16(11, true);
  const recSize = 13 + districtCount * 4;
  const out: ArchiveRecord[] = [];
  for (let i = 0; i < recordCount; i++) {
    let p = COARSE_HEAD + i * recSize;
    if (p + recSize > buf.byteLength) break;
    const slot = dv.getUint8(p); p += 1;
    if (slot > 59 || (version === 2 && slot % 5)) continue;
    const metric = (value: number, sentinel: number, scale = 1) => version === 2 && value === sentinel ? NaN : value / scale;
    const temp = metric(dv.getInt16(p, true), -32768, 10); p += 2;
    const rain = metric(dv.getUint16(p, true), 65535, 100); p += 2;
    const waterCm = metric(dv.getInt16(p, true), -32768); p += 2;
    const incidents = metric(dv.getUint8(p), 255); p += 1;
    const bridges = metric(dv.getUint8(p), 255); p += 1;
    const transit = metric(dv.getUint16(p, true), 65535); p += 2;
    const no2 = metric(dv.getUint8(p), 255); p += 1;
    const pm25 = metric(dv.getUint8(p), 255); p += 1;
    const districts: DistrictSample[] = [];
    for (let d = 0; d < districtCount; d++) {
      const flow = metric(dv.getUint16(p, true), 65535); p += 2;
      const speed = metric(dv.getUint8(p), 255); p += 1;
      const congestion = metric(dv.getUint8(p), 255, version === 2 ? 254 : 255); p += 1;
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
  private hourLoadedAt = new Map<string, number>();
  private inflight = new Map<string, Promise<ArchiveRecord[] | null>>();
  private basePromise: Promise<string | null> | null = null;
  private baseLoadedAt = 0;
  /** month key → its events, so a re-render costs nothing */
  private eventsByMonth = new Map<string, ArchiveEvent[]>();
  private eventsLoadedAt = new Map<string, number>();

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
    if (this.basePromise && Date.now() - this.baseLoadedAt < 300_000) return this.basePromise;
    this.baseLoadedAt = Date.now();
    this.basePromise = (async () => {
      for (const base of ARCHIVE_SOURCES) {
        try {
          // short: a healthy CDN answers well inside this, and the point is
          // to fall through quickly when it cannot be reached at all
          const response = await fetch(`${base}/${probe}`, { cache: "no-cache", signal: AbortSignal.timeout(3500) });
          if (response.ok || response.status === 404) return base;
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
    const cached = this.hours.get(path);
    const mutable = !cached || Date.now() - hourStart.getTime() < 48 * 3_600_000;
    if (this.hours.has(path) && (!mutable || Date.now() - (this.hourLoadedAt.get(path) ?? 0) < 300_000)) return cached!;
    const pending = this.inflight.get(path);
    if (pending) return pending;
    const p = (async () => {
      try {
        const base = await this.resolveBase(path);
        if (!base) return cached ?? null; // no reachable archive at all
        let buf: ArrayBuffer;
        try {
          const res = await fetch(`${base}/${path}`, { cache: mutable ? "no-cache" : "default", signal: AbortSignal.timeout(8000) });
          if (!res.ok) {
            // A missing hour can still be published later; server failures
            // never poison that hour's cache for the rest of the session.
            if (res.status === 404 && !cached) { this.hours.set(path, null); this.hourLoadedAt.set(path, Date.now()); }
            return cached ?? null;
          }
          buf = await res.arrayBuffer();
        } catch {
          return cached ?? null;
        }
        const recs = parseCoarse(buf);
        if (!recs.length) return cached ?? null;
        this.hours.set(path, recs.length ? recs : null);
        this.hourLoadedAt.set(path, Date.now());
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
    const stride = archiveStride(spanHours);
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
    const now = new Date();
    const mutable = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
    if (cached && (!mutable || Date.now() - (this.eventsLoadedAt.get(key) ?? 0) < 300_000)) return cached;
    const path = `e/${key}.json`;
    // Through resolveBase, not its own walk of the source list: the hours have
    // already settled which host is serving this archive, and re-deciding here
    // meant every call paid the full timeout of a source known to be dead.
    // Measured against an unreachable branch, one month of events took 22
    // seconds to arrive that way and sometimes timed out entirely.
    const base = await this.resolveBase(path);
    if (!base) return cached ?? [];
    try {
      const res = await fetch(`${base}/${path}`, { cache: mutable ? "no-cache" : "default", signal: AbortSignal.timeout(8000) });
      if (!res.ok) return cached ?? [];
      const raw = (await res.json()) as ArchiveEvent[];
      if (!Array.isArray(raw)) return cached ?? [];
      this.eventsByMonth.set(key, raw);
      this.eventsLoadedAt.set(key, Date.now());
      return raw;
    } catch {
      return cached ?? [];
    }
  }
}
