import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cityAssetUrl, fetchCityBuffer, fetchCityJson } from "./city-assets";

const base = "https://example.test/twin/data/";
const content = "city bytes";
let hash: string;
beforeEach(async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  vi.stubGlobal("location", new URL("https://example.test/twin/?page=lab"));
  vi.stubGlobal("__CITY_ASSET_VERSIONS__", { "graph.bin": hash, "roofs/": "b".repeat(64) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("versioned city downloads", () => {
  it("shares exact cache keys between map and intelligence, with root and repository hosting", () => {
    expect(cityAssetUrl(base, "graph.bin")).toBe(`${base}graph.bin?v=${hash}`);
    expect(cityAssetUrl("/twin/data/", "graph.bin")).toBe(`${base}graph.bin?v=${hash}`);
    expect(cityAssetUrl("https://example.test/data/", "graph.bin")).toBe(`https://example.test/data/graph.bin?v=${hash}`);
    expect(cityAssetUrl(base, "roofs/-1_0.bin")).toContain(`v=${"b".repeat(64)}`);
  });

  it("leaves mutable JSON and the commit-pinned mirror unversioned", () => {
    expect(cityAssetUrl(base, "ndw.json")).toBe(`${base}ndw.json`);
    expect(cityAssetUrl("https://mirror.test/commit/data/", "graph.bin")).toBe("https://mirror.test/commit/data/graph.bin");
  });

  it("accepts correct bytes and rejects an old cached graph or a deployment mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(content)).mockResolvedValueOnce(new Response("wrong city")));
    expect(new TextDecoder().decode(await fetchCityBuffer(base, "graph.bin"))).toBe(content);
    await expect(fetchCityBuffer(base, "graph.bin")).rejects.toThrow("City data changed");
  });

  it("checks HTTP errors and releases download timers after success or failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response('{"stations":[]}')).mockResolvedValueOnce(new Response("missing", { status: 404 })));
    await expect(fetchCityJson(base, "ndw.json")).resolves.toEqual({ stations: [] });
    await expect(fetchCityBuffer(base, "graph.bin")).rejects.toThrow("HTTP 404");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled response body, not just a stalled connection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Response(new ReadableStream({
      start(controller) { options.signal!.addEventListener("abort", () => controller.error(options.signal!.reason)); },
    }))));
    const download = fetchCityBuffer(base, "graph.bin", undefined, 100);
    const rejected = expect(download).rejects.toThrow("download timed out");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports progress while assembling a streamed binary", async () => {
    const bytes = new TextEncoder().encode(content);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.slice(0, 4)); controller.enqueue(bytes.slice(4)); controller.close(); },
    }), { headers: { "Content-Length": String(bytes.length) } })));
    const progress = vi.fn();
    expect(new Uint8Array(await fetchCityBuffer(base, "graph.bin", progress))).toEqual(bytes);
    expect(progress).toHaveBeenCalledWith(4 / bytes.length);
    expect(progress).toHaveBeenLastCalledWith(1);
  });
});
