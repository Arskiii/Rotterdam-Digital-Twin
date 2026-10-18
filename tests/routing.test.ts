import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { calculateHospitalAccess } from "../src/intelligence/routing";

const DATA = new URL("../public/data/", import.meta.url);

describe("hospital access screen", () => {
  it("uses the real directed road graph and never improves access after closing edges", () => {
    const raw = readFileSync(new URL("graph.bin", DATA));
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const meta = JSON.parse(readFileSync(new URL("meta.json", DATA), "utf8"));
    const exposure = JSON.parse(readFileSync(new URL("exposure.json", DATA), "utf8"));
    const rows = calculateHospitalAccess(buffer, meta.districts, new Set(exposure.exposedEdges), 0.9);
    expect(rows).toHaveLength(meta.districts.length);
    expect(rows.filter((row) => row.baseMin !== null).length).toBeGreaterThan(10);
    for (const row of rows) if (row.baseMin !== null && row.stressMin !== null) expect(row.stressMin).toBeGreaterThanOrEqual(row.baseMin);
    expect(rows.some((row) => (row.changeMin ?? 0) > 1)).toBe(true);
  });
});
