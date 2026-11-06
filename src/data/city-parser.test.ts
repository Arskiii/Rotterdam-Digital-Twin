import { afterEach, describe, expect, it, vi } from "vitest";
import { CityParser } from "./city-parser";
import type { Meta } from "./loader";
import { transferableBuffers } from "./transfer";
import { fetchCityBuffer } from "./city-assets";
import { loadCity, parseBuildings } from "./loader";

vi.mock("./loader", () => ({ loadCity: vi.fn(), parseBuildings: vi.fn() }));
vi.mock("./city-assets", () => ({ fetchCityBuffer: vi.fn() }));
const meta = {} as Meta;
class ParserWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  send(data: unknown) { this.onmessage?.({ data }); }
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("city parsing off the UI thread", () => {
  it("makes base data available without waiting for optional buildings", async () => {
    const worker = new ParserWorker(), parser = new CityParser(() => worker as unknown as Worker), progress = vi.fn();
    const base = parser.base("/data/", meta, progress);
    const buildings = parser.buildings("/data/", meta);
    worker.send({ type: "progress", id: 1, stage: "grid", fraction: .5 });
    worker.send({ type: "result", id: 1, value: { buildings: [], graph: "ready" } });
    await expect(base).resolves.toEqual({ buildings: [], graph: "ready" });
    expect(progress).toHaveBeenCalledWith("grid", .5);
    const cancelled = expect(buildings).rejects.toThrow("cancelled"); parser.dispose(); await cancelled;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("does not silently fall back after data corruption", async () => {
    const worker = new ParserWorker(), parser = new CityParser(() => worker as unknown as Worker);
    const result = parser.base("/data/", meta, () => {});
    worker.send({ type: "error", id: 1, message: "City data version mismatch" });
    await expect(result).rejects.toThrow("version mismatch");
    expect(loadCity).not.toHaveBeenCalled(); parser.dispose();
  });
  it("uses the compatible parser when workers are blocked", async () => {
    vi.mocked(loadCity).mockResolvedValue({ buildings: [] } as never);
    const parser = new CityParser(() => { throw new Error("Blocked worker"); });
    await expect(parser.base("/data/", meta, () => {})).resolves.toEqual({ buildings: [] });
    expect(loadCity).toHaveBeenCalledWith("/data/", expect.any(Function), undefined, meta, false);
    vi.mocked(fetchCityBuffer).mockResolvedValue(new ArrayBuffer(8)); vi.mocked(parseBuildings).mockReturnValue([]);
    await expect(parser.buildings("/data/", meta)).resolves.toEqual([]); parser.dispose();
  });
  it("rejects a silent worker on deadline and can start a fresh retry", async () => {
    vi.useFakeTimers();
    const worker = new ParserWorker(), create = vi.fn(() => worker as unknown as Worker), parser = new CityParser(create);
    const rejected = expect(parser.base("/data/", meta, () => {})).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(135_000); await rejected;
    expect(vi.getTimerCount()).toBe(0); expect(loadCity).not.toHaveBeenCalled();
    const next = parser.base("/data/", meta, () => {}); worker.send({ type: "result", id: 2, value: { buildings: [] } });
    await expect(next).resolves.toEqual({ buildings: [] }); expect(create).toHaveBeenCalledTimes(2); parser.dispose();
  });
  it("transfers shared typed-array backing stores exactly once", () => {
    const buffer = new ArrayBuffer(32), extra = new Uint8Array([1, 2, 3]);
    const value = { raw: buffer, positions: new Float32Array(buffer), flags: new Uint8Array(buffer), tiles: [extra] };
    const transfers = transferableBuffers(value); expect(transfers).toEqual([buffer, extra.buffer]);
    const copy = structuredClone(value, { transfer: transfers });
    expect(buffer.byteLength).toBe(0); expect(copy.positions.buffer).toBe(copy.flags.buffer);
    expect([...copy.tiles[0]]).toEqual([1, 2, 3]);
  });
});
