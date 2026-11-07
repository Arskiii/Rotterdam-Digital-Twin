import { describe, expect, it, vi } from "vitest";
import packed from "../../.generated/study-network.json";
import history from "../../public/data/traffic-history.json";
import { cityPoint, loadStudy, nearestSection, studySections } from "./data";
import { corridorHistory } from "./history";
import { StudySelection } from "./context";
import { unpackNetwork } from "../lab/networkSnapshot";
import { corridorReadings, selectedCorridor } from "../v03/corridors";
import { safeReading } from "../lab/imports";
import type { TrafficReading } from "../v03/scenario";

describe("shared corridor workflow", () => {
  it("reuses geometry while delivering refreshed history to newly opened workspaces", async () => {
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    const fresh = { ...history, generatedAt: new Date().toISOString(), readings: [{ ...history.readings[0], observedAt }] };
    let updated = false;
    const fetcher = vi.fn(async (url: string | URL) => Response.json(String(url).includes("study-network") ? packed : updated ? fresh : history));
    vi.stubGlobal("fetch", fetcher);
    try {
      const original = await loadStudy();
      updated = true; await corridorHistory.refresh(true);
      const latest = await loadStudy();
      expect(latest.network).toBe(original.network);
      expect(latest.readings[0].observedAt).toBe(observedAt);
      expect(original.readings[0].observedAt).not.toBe(observedAt);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes("study-network"))).toHaveLength(1);
    } finally { corridorHistory.dispose(); vi.unstubAllGlobals(); }
  });
  it("converts both origins and latitude scales without shifting selected roads", () => {
    const study = { lat: 51.916916, lon: 4.4867455 }, city = { lat: 51.92, lon: 4.48 };
    const lat = 51.917, lon = 4.487;
    const point = { x: (lon - study.lon) * 111320 * Math.cos(study.lat * Math.PI / 180), y: -(lat - study.lat) * 111320 };
    const world = cityPoint(point, study, city);
    expect(world.x).toBeCloseTo((lon - city.lon) * 111320 * Math.cos(city.lat * Math.PI / 180), 6);
    expect(world.z).toBeCloseTo(-(lat - city.lat) * 110574, 6);
  });
  it("only picks a nearby supported segment, with no inferred corridor outside the study", () => {
    const sections = [{ id: "a", a: { x: 0, z: 0 }, b: { x: 100, z: 0 } }, { id: "b", a: { x: 0, z: 20 }, b: { x: 100, z: 20 } }];
    expect(nearestSection({ x: 50, z: 12 }, sections)).toBe("b");
    expect(nearestSection({ x: 140, z: 0 }, sections)).toBeNull();
    expect(nearestSection({ x: -10, z: 0 }, sections)).toBe("a");
  });
  it("uses the exact bundled Lab IDs and flags only sections with matched history", () => {
    const study = { network: unpackNetwork(packed.network), origin: packed.origin,
      readings: history.readings.map(safeReading).filter((row: TrafficReading | null): row is TrafficReading => !!row) };
    const sections = studySections(study);
    expect(sections.length).toBeGreaterThan(100);
    const ids = new Set<string>();
    for (const { edge, measured } of sections) {
      const match = selectedCorridor(study.network, edge.id)!;
      expect(match).not.toBeNull(); expect(match.edgeIds.some((id) => ids.has(id))).toBe(false);
      match.edgeIds.forEach((id) => ids.add(id));
      expect(corridorReadings(study.network, study.readings, study.origin, match).length > 0).toBe(measured);
    }
  });
  it("shares identity across views and does not reset selection when switching tabs", () => {
    const pages: string[] = [], state = new StudySelection("a", (page) => pages.push(page)), seen: (string | null)[] = [];
    const unsubscribe = state.subscribe((id) => seen.push(id));
    state.open("intelligence"); state.open("lab"); state.open("map");
    expect(state.id).toBe("a"); expect(seen).toEqual(["a"]);
    state.select("b"); state.select("b"); expect(seen).toEqual(["a", "b"]);
    unsubscribe(); state.select(null); expect(seen).toEqual(["a", "b"]);
    expect(pages).toEqual(["intelligence", "lab", "map"]);
  });
});
