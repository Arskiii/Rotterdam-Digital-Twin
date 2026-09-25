import { describe, expect, it } from "vitest";
import { parseResilienceIndex, resilienceGeometry } from "./resilience";

const index = {
  schemaVersion: 1, retrievedAt: "2026-09-25T12:00:00Z",
  source: "https://diensten.rotterdam.nl/arcgis/rest/services/SO_IBURO/DGO_data/MapServer",
  modelledNotLive: true,
  image: { cornersLocal: [[-10, -20], [10, -20], [10, 20], [-10, 20]] },
};

describe("modelled resilience surfaces", () => {
  it("maps the GIS image's north edge to negative Three.js Z", () => {
    const parsed = parseResilienceIndex(index);
    const geometry = resilienceGeometry(parsed.image.cornersLocal);
    const positions = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    expect([positions.getX(0), positions.getZ(0), uv.getY(0)]).toEqual([-10, 20, 0]);
    expect([positions.getX(2), positions.getZ(2), uv.getY(2)]).toEqual([10, -20, 1]);
    geometry.dispose();
  });

  it("rejects invalid coordinates and mislabelled live imagery", () => {
    expect(() => parseResilienceIndex({ ...index, modelledNotLive: false })).toThrow();
    expect(() => parseResilienceIndex({ ...index, image: { cornersLocal: [[Infinity, 0]] } })).toThrow();
  });
});
