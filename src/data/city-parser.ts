import { loadCity, parseBuildings, type CityData, type BuildingTile, type Meta, type ProgressFn } from "./loader";
import { fetchCityBuffer } from "./city-assets";

// One short-lived parser per map attempt. Transfer typed arrays rather than
// cloning a second copy of the city onto the browser's main thread.
export class CityParser {
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; progress: ProgressFn; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private unavailable = false;
  private cancelled = false;
  constructor(private createWorker = () => new Worker(new URL("./city-parser.worker.ts", import.meta.url), { type: "module" })) {}
  private ensureWorker() {
    if (this.worker) return;
    if (this.unavailable) throw new Error("Parser worker unavailable");
    this.worker = this.createWorker();
    this.worker.onmessage = ({ data }) => {
      const task = this.pending.get(data.id);
      if (!task) return;
      if (data.type === "progress") { task.progress(data.stage, data.fraction); return; }
      clearTimeout(task.timer); this.pending.delete(data.id);
      if (data.type === "result") task.resolve(data.value);
      else task.reject(new Error(data.message));
    };
    this.worker.onerror = (event) => { event.preventDefault(); this.unavailable = true; this.stop(new Error("Parser worker unavailable")); };
    this.worker.onmessageerror = () => { this.unavailable = true; this.stop(new Error("Parser worker unavailable")); };
  }
  private stop(error: Error) {
    this.worker?.terminate(); this.worker = null;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
  }
  dispose() { this.cancelled = true; this.stop(new Error("City loading cancelled")); }
  private async run<T>(kind: "base" | "buildings", base: string, meta: Meta, progress: ProgressFn, fallback: () => Promise<T>): Promise<T> {
    if (this.cancelled) throw new Error("City loading cancelled");
    try {
      this.ensureWorker();
      return await new Promise<T>((resolve, reject) => {
        const id = ++this.nextId;
        const timer = setTimeout(() => this.stop(new Error("City loading timed out. Retry map to try again.")), 135_000);
        this.pending.set(id, { resolve: (value) => resolve(value as T), reject, progress, timer });
        try { this.worker!.postMessage({ id, kind, base, meta }); }
        catch { this.unavailable = true; this.stop(new Error("Parser worker unavailable")); }
      });
    } catch (error) {
      // A network/data failure should stay visible. Only worker support failures
      // use the compatible main-thread parser; never retry corrupt data silently.
      if (this.cancelled || this.worker && !this.unavailable) throw error;
      if (error instanceof Error && error.message.includes("timed out")) throw error;
      this.unavailable = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return fallback();
    }
  }
  base(base: string, meta: Meta, progress: ProgressFn): Promise<CityData> {
    return this.run("base", base, meta, progress, () => loadCity(base, progress, undefined, meta, false));
  }
  buildings(base: string, meta: Meta): Promise<BuildingTile[]> {
    return this.run("buildings", base, meta, () => {}, async () => parseBuildings(await fetchCityBuffer(base, "buildings.bin")));
  }
}
