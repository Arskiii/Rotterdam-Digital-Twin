import { describe, expect, it } from "vitest";
import { corridorOf, fitFlowScale, geh, median, score, spearman, verdict, type StationRow } from "./validation";

const row = (over: Partial<StationRow>): StationRow => ({
  edge: 1, corridor: "A15", motorway: true, heldOut: false, obsFlow: 1000, simFlow: 100, obsKmh: 90, simKmh: 80, ...over,
});

describe("model validation scoring", () => {
  it("computes GEH as defined in TAG M3.1", () => {
    expect(geh(100, 100)).toBe(0);
    expect(geh(1200, 1000)).toBeCloseTo(Math.sqrt((2 * 200 ** 2) / 2200), 6);
  });

  it("ranks with ties and rejects series without spread", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it("fits the flow scale on calibration stations only", () => {
    const rows = [row({ obsFlow: 1000, simFlow: 100 }), row({ obsFlow: 99999, simFlow: 1, heldOut: true })];
    expect(fitFlowScale(rows)).toBe(10);
  });

  it("scores flow error after scaling and speed error without it", () => {
    const rows = [row({ obsFlow: 1000, simFlow: 100 }), row({ obsFlow: 2000, simFlow: 100, obsKmh: 50, simKmh: 60 })];
    expect(score(rows, 10)).toMatchObject({ stations: 2, flowWmapePct: 33.3, speedStations: 2, speedMaeKmh: 10, speedBiasKmh: 0 });
  });

  it("reads the motorway number from Rijkswaterstaat site names", () => {
    expect(corridorOf("0160vwa0107ra", "MOTORWAY SEGMENT", true)).toBe("A16");
    expect(corridorOf("020vwv0236", "", true)).toBe("A20");
    expect(corridorOf("0041hrl0710ra", "", true)).toBe("A4");
    expect(corridorOf("10D014041C", "MOTORWAY SEGMENT", true)).toBe("Motorway, unlabelled site");
    expect(corridorOf("Kralingseplein", "Kralingseplein", false)).toBe("Kralingseplein");
  });

  it("takes the middle value, or the mean of the middle two", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("says plainly when flows miss the calibration bar", () => {
    const text = verdict({ stations: 10, flowWmapePct: 80, gehUnder5Pct: 6, rankCorrelation: 0.1, speedStations: 10, speedMaeKmh: 14, speedBiasKmh: -7 });
    expect(text).toContain("do not meet");
    expect(text).toContain("busiest");
    expect(text).toContain("slower than measured by 7 km/h");
  });
});
