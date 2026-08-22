import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraph, CityDataError } from "./loader";

const graph = (() => {
  const b = readFileSync(new URL("../../public/data/graph.bin", import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
})();

const damaged = (fn: (dv: DataView) => void): ArrayBuffer => {
  const copy = graph.slice(0);
  fn(new DataView(copy));
  return copy;
};

describe("parseGraph", () => {
  it("reads the committed city", () => {
    const g = parseGraph(graph);
    expect(g.nodeCount).toBeGreaterThan(100_000);
    expect(g.edges.count).toBeGreaterThan(100_000);
    // every edge's geometry is actually present
    const last = g.edges.count - 1;
    expect((g.edges.geoOff[last] + g.edges.geoCount[last]) * 2).toBeLessThanOrEqual(g.geo.length);
  });

  it("refuses every truncation instead of silently returning short geometry", () => {
    // The bug this test exists for: `buf.slice` clamps, so about a quarter of
    // truncations used to parse cleanly with a geometry array shorter than the
    // edges indexing into it — every read past the end came back undefined and
    // the city drew at NaN, with nothing raised anywhere.
    let silent = 0;
    for (let drop = 1; drop <= 40; drop++) {
      try {
        const g = parseGraph(graph.slice(0, graph.byteLength - drop));
        const last = g.edges.count - 1;
        if ((g.edges.geoOff[last] + g.edges.geoCount[last]) * 2 > g.geo.length) silent++;
      } catch {
        /* expected */
      }
    }
    expect(silent).toBe(0);
  });

  it("names the file and the reason when a section runs past the end", () => {
    let err: Error | undefined;
    try {
      parseGraph(graph.slice(0, graph.byteLength - 4));
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(CityDataError);
    expect(err!.message).toContain("graph.bin");
    expect(err!.message).toMatch(/geometry points|bytes remain/);
    expect(err!.message).toContain("reload");
  });

  it("rejects an inflated count instead of trying to allocate it", () => {
    // Flipping the node count's top bits asked for a 32 GB typed array, which
    // on a phone is an out-of-memory kill of the tab rather than an error.
    const t0 = performance.now();
    expect(() => parseGraph(damaged((dv) => dv.setUint32(8, 4_000_000_000, true)))).toThrow(CityDataError);
    expect(performance.now() - t0).toBeLessThan(50); // rejected on arithmetic, not on allocation
  });

  it("rejects a count that overruns without being absurd", () => {
    expect(() => parseGraph(damaged((dv) => dv.setUint32(8, 10_000_000, true)))).toThrow(CityDataError);
  });

  it("still refuses a foreign file and a future format", () => {
    expect(() => parseGraph(damaged((dv) => dv.setUint32(0, 0xdeadbeef, true)))).toThrow(CityDataError);
    expect(() => parseGraph(damaged((dv) => dv.setUint32(4, 99, true)))).toThrow(/version mismatch/);
  });

  it("refuses an empty or stub file", () => {
    expect(() => parseGraph(new ArrayBuffer(0))).toThrow();
    expect(() => parseGraph(graph.slice(0, 8))).toThrow();
  });
});
