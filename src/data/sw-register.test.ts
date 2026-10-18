import { describe, it, expect } from "vitest";
import { dataVersion } from "./sw-register";
import type { Meta } from "./loader";

const meta = (over: Partial<Meta> = {}): Meta =>
  ({
    version: 4,
    origin: { lat: 51.92, lon: 4.48 },
    extent: { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 },
    counts: { roadKm: 5093, graphEdges: 210000, buildings: 264000 },
    districts: [{ key: "centrum", name: "Centrum", x: 0, y: 0 }],
    ...over,
  }) as Meta;

describe("dataVersion", () => {
  it("is stable for the same city", () => {
    expect(dataVersion(meta())).toBe(dataVersion(meta()));
  });

  it("changes when the city is rebuilt differently", () => {
    const a = dataVersion(meta());
    expect(dataVersion(meta({ counts: { ...meta().counts, buildings: 264001 } }))).not.toBe(a);
    expect(dataVersion(meta({ extent: { minX: -1001, minY: -1000, maxX: 1000, maxY: 1000 } }))).not.toBe(a);
    expect(dataVersion(meta({ districts: [] }))).not.toBe(a);
  });

  it("leads with the format version, so a format change is legible in the key", () => {
    expect(dataVersion(meta())).toMatch(/^4-[0-9a-z]+$/);
    expect(dataVersion(meta({ version: 5 }))).toMatch(/^5-/);
  });

  it("produces a key safe to use in a cache name", () => {
    expect(dataVersion(meta())).not.toMatch(/[^0-9a-z-]/);
  });
});
