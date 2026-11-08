import { afterEach, describe, expect, it, vi } from "vitest";
import { CorridorHistoryFeed, parseHistory } from "./history";

const NOW = "2026-11-07T14:30:00Z";
const OLD = "2026-09-27T09:50:00Z";
const CURRENT = "2026-11-07T14:25:00Z";
const row = (observedAt = CURRENT) => ({ id: "detector-1", name: "Schiedamsedijk", lat: 51.91461, lon: 4.481979,
  observedAt, speedKmh: 0, vehiclesPerHour: 0 });
const history = (observedAt = CURRENT) => ({ schemaVersion: 1, generatedAt: NOW, readings: [row(observedAt)] });
const create = () => new CorridorHistoryFeed(() => "https://example.com/published", () => "https://example.com/bundled");
const clock = () => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("published corridor history", () => {
  it("accepts a complete week of two five-minute detector feeds", () => {
    const readings = Array.from({ length: 4032 }, (_, i) => ({ ...row(new Date(Date.parse(NOW) - Math.floor(i / 2) * 300_000).toISOString()), id: `detector-${i % 2}` }));
    expect(parseHistory({ ...history(), readings }, "published", Date.parse(NOW)).readings).toHaveLength(4032);
  });
  it("uses measurement dates rather than the collector timestamp and preserves measured zeros", () => {
    const parsed = parseHistory(history(OLD), "published", Date.parse(NOW));
    expect(parsed.latestObservedAt).toBe("2026-09-27T09:50:00.000Z");
    expect(parsed.readings[0].speedKmh).toBe(0);
    expect(parsed.readings[0].vehiclesPerHour).toBe(0);
  });

  it("rejects invalid schema, partial corruption, oversized arrays and future observations", () => {
    for (const invalid of [null, {}, { ...history(), schemaVersion: 2 }, { ...history(), generatedAt: "bad" },
      { ...history(), readings: [row(), { ...row(), lat: 0 }] },
      { ...history(), readings: Array(10001).fill(row()) }, history("2026-11-08T14:25:00Z")]) {
      expect(() => parseHistory(invalid, "published", Date.parse(NOW))).toThrow();
    }
  });

  it("loads the published history and coalesces map, Intelligence and Lab requests", async () => {
    clock();
    const fetcher = vi.fn(async () => Response.json(history())); vi.stubGlobal("fetch", fetcher);
    const feed = create(), first = feed.load();
    expect(feed.refresh(true)).toBe(first);
    const loaded = await first;
    expect(loaded?.source).toBe("published"); expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([expect.any(URL), expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]);
    expect(await feed.load()).toBe(loaded);
  });

  it("recovers from the packaged fallback without freezing observations for the session", async () => {
    clock();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(Response.json(history(OLD)))
      .mockResolvedValueOnce(Response.json(history()));
    vi.stubGlobal("fetch", fetcher);
    const feed = create();
    const fallback = await feed.load();
    expect(fallback?.source).toBe("bundled"); expect(feed.error).toContain("unavailable");
    await feed.refresh(true);
    expect(feed.snapshot?.latestObservedAt).toBe("2026-11-07T14:25:00.000Z");
    expect(feed.snapshot?.source).toBe("published"); expect(feed.error).toBeNull();
    expect(fallback?.readings).toEqual([row("2026-09-27T09:50:00.000Z")]);
  });

  it("retains good observations across outages, older mirrors and malformed responses", async () => {
    clock();
    const fetcher = vi.fn(async () => Response.json(history())); vi.stubGlobal("fetch", fetcher);
    const feed = create(); await feed.load(); const first = feed.snapshot;
    for (const response of [new Response("offline", { status: 503 }), Response.json(history(OLD)), Response.json({ readings: [] }),
      Response.json({ ...history(), readings: [] })]) {
      fetcher.mockResolvedValueOnce(response); await feed.refresh(true);
      expect(feed.snapshot).toBe(first); expect(feed.error).toContain("unavailable");
    }
    expect(fetcher).toHaveBeenCalledTimes(5); // No stale bundled fetch after a good reading.
  });

  it("does not invent observations when both sources fail and can retry successfully", async () => {
    clock();
    const fetcher = vi.fn().mockRejectedValue(new Error("offline")); vi.stubGlobal("fetch", fetcher);
    const feed = create(); expect(await feed.load()).toBeNull();
    expect(feed.error).toContain("Try refreshing");
    fetcher.mockResolvedValue(Response.json(history()));
    await feed.refresh(true); expect(feed.snapshot?.readings.length).toBe(1);
  });

  it("keeps report inputs stable when the collection timestamp alone changes", async () => {
    clock();
    const fetcher = vi.fn(async () => Response.json(history())); vi.stubGlobal("fetch", fetcher);
    const feed = create(); await feed.load(); const readings = feed.snapshot!.readings;
    fetcher.mockResolvedValueOnce(Response.json({ ...history(), generatedAt: "2026-11-07T14:31:00Z" }));
    await feed.refresh(true); expect(feed.snapshot!.readings).toBe(readings);
    fetcher.mockResolvedValueOnce(Response.json(history("2026-11-07T14:29:00Z")));
    await feed.refresh(true); expect(feed.snapshot!.readings).not.toBe(readings);
    expect(readings[0].observedAt).toBe("2026-11-07T14:25:00.000Z");
  });

  it("pauses hidden polling, refreshes on return and reconnect, and removes listeners on disposal", async () => {
    clock();
    const doc = Object.assign(new EventTarget(), { hidden: false }), win = new EventTarget();
    vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
    const fetcher = vi.fn(async () => Response.json(history())); vi.stubGlobal("fetch", fetcher);
    const feed = create(); await feed.load(); feed.start();
    doc.hidden = true; await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange")); await feed.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    win.dispatchEvent(new Event("online")); await feed.refresh(); expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(4);
    feed.dispose(); await vi.advanceTimersByTimeAsync(60_000); win.dispatchEvent(new Event("online"));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("isolates subscriber failures and notifies other workspaces after recovery", async () => {
    clock(); vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(history())));
    const feed = create(), healthy = vi.fn();
    feed.subscribe(() => { throw new Error("bad view"); }); const unsubscribe = feed.subscribe(healthy);
    await feed.load(); expect(healthy).toHaveBeenCalledTimes(2);
    unsubscribe(); await feed.refresh(true); expect(healthy).toHaveBeenCalledTimes(2);
  });
});
