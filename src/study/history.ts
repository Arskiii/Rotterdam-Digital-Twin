import { safeReading } from "../lab/imports";
import type { TrafficReading } from "../v03/scenario";
import { siteUrl } from "../ui/siteUrl";
import collection from "../../collection.config.json";

export const CORRIDOR_HISTORY_URL = `${collection.origin}/data/traffic-history.json`;
const REFRESH_MS = 60_000;
export interface CorridorHistory {
  readings: TrafficReading[];
  generatedAt: string;
  latestObservedAt: string | null;
  source: "published" | "bundled";
}

/** Validate the observation times themselves; a new envelope cannot freshen old data. */
export function parseHistory(value: unknown, source: CorridorHistory["source"], now = Date.now()): CorridorHistory {
  const data = value as Record<string, unknown> | null;
  const generated = typeof data?.generatedAt === "string" ? Date.parse(data.generatedAt) : NaN;
  if (data?.schemaVersion !== 1 || !Number.isFinite(generated) || generated > now + 120_000 ||
      !Array.isArray(data.readings) || data.readings.length > 10_000) throw new Error("Invalid corridor history");
  const readings = data.readings.map(safeReading);
  if (readings.some((row) => !row || Date.parse(row.observedAt) > now + 120_000)) throw new Error("Invalid corridor observations");
  const valid = (readings as TrafficReading[]).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  return { readings: valid, generatedAt: data.generatedAt as string, latestObservedAt: valid.at(-1)?.observedAt ?? null, source };
}

/** One bounded, refreshable observation cache shared by the retained workspaces. */
export class CorridorHistoryFeed {
  snapshot: CorridorHistory | null = null;
  error: string | null = null;
  private pending: Promise<CorridorHistory | null> | null = null;
  private checkedAt = -Infinity;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<() => void>();
  constructor(private published: () => string | URL = () => CORRIDOR_HISTORY_URL,
    private bundled: () => string | URL = () => siteUrl("data/traffic-history.json")) {}

  get refreshing() { return this.pending !== null; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.error("Corridor history subscriber:", error); }
    }
  }
  private resume = () => { if (!document.hidden) void this.refresh(); };
  private online = () => { if (!document.hidden) void this.refresh(true); };
  start() {
    if (this.timer !== undefined || typeof document === "undefined") return;
    this.timer = setInterval(this.resume, REFRESH_MS);
    document.addEventListener("visibilitychange", this.resume);
    window.addEventListener("online", this.online);
  }
  dispose() {
    clearInterval(this.timer); this.timer = undefined;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.resume);
      window.removeEventListener("online", this.online);
    }
  }
  load() { this.start(); return this.snapshot ? Promise.resolve(this.snapshot) : this.refresh(); }

  refresh(force = false): Promise<CorridorHistory | null> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.checkedAt < REFRESH_MS) return Promise.resolve(this.snapshot);
    this.checkedAt = Date.now();
    const read = async (url: string | URL, source: CorridorHistory["source"]) => {
      const target = new URL(url, typeof location === "undefined" ? "https://localhost" : location.href);
      // Raw GitHub is otherwise cached independently of the browser for several minutes.
      if (source === "published") target.searchParams.set("t", String(Math.floor(Date.now() / REFRESH_MS)));
      const response = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > 4_000_000) throw new Error("Corridor history is too large");
      return parseHistory(JSON.parse(body), source);
    };
    // Defer work until pending is assigned, so subscribers can safely call load().
    this.pending = Promise.resolve().then(async () => {
      this.error = null;
      try {
        const next = await read(this.published(), "published");
        if (this.snapshot?.latestObservedAt && (!next.latestObservedAt || next.latestObservedAt < this.snapshot.latestObservedAt)) {
          throw new Error("Published observations are older than the loaded history");
        }
        // Keep the array identity when only the collection timestamp changes.
        if (this.snapshot && JSON.stringify(next.readings) === JSON.stringify(this.snapshot.readings)) next.readings = this.snapshot.readings;
        this.snapshot = next;
      } catch {
        this.error = "Corridor update unavailable. Showing the last available observations.";
        if (!this.snapshot) {
          try { this.snapshot = await read(this.bundled(), "bundled"); }
          catch { this.error = "Corridor observations are unavailable. Try refreshing again."; }
        }
      }
      return this.snapshot;
    }).finally(() => { this.pending = null; this.emit(); });
    this.emit();
    return this.pending;
  }
}

export const corridorHistory = new CorridorHistoryFeed();
