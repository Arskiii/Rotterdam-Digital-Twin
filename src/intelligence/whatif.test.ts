import { describe, expect, it } from "vitest";
import type { ExperimentResultMsg, MetricsMsg } from "../sim/protocol";
import { beyondNoise, compareWhatIf } from "./whatif";

const run = (speed: number, wait: number, districts: number[], flows: [number, number][]): ExperimentResultMsg => ({
  type: "experimentResult", seed: 1, program: "actuated", warmupSec: 60, measureSec: 120,
  metrics: { avgSpeedKmh: speed, avgWaitSec: wait, throughputMin: 100, queued: 10,
    districts: districts.map((speedKmh) => ({ vehicles: 1, speedKmh, congestion: 0, queued: 0 })) } as unknown as MetricsMsg,
  stationFlows: flows.map(([edge, simulated]) => ({ edge, observed: 0, simulated, simulatedKmh: null })),
});

describe("what-if comparison", () => {
  const baseline = [run(30, 20, [40, 30], [[1, 400], [2, 100], [3, 10]]), run(31, 22, [40, 30], [[1, 420], [2, 120], [3, 12]])];
  const closure = [run(26, 35, [38, 22], [[1, 900], [2, 100], [3, 30]]), run(27, 33, [38, 22], [[1, 880], [2, 120], [3, 28]])];
  const result = compareWhatIf(baseline, closure, ["North", "South"], new Map([[1, { label: "A16", measuredVehH: 5000 }]]));

  it("reports seed-averaged network changes with the baseline spread as noise", () => {
    expect(result.speedKmh).toEqual({ baseline: 30.5, closure: 26.5, change: -4, noise: 1 });
    expect(beyondNoise(result.speedKmh)).toBe(true);
    expect(beyondNoise({ baseline: 1, closure: 1.5, change: 0.5, noise: 2 })).toBe(false);
  });

  it("lists the hardest-hit district first", () => {
    expect(result.districts[0]).toMatchObject({ district: "South", changeKmh: -8 });
  });

  it("ranks sensors by absolute flow shift and skips near-empty ones", () => {
    expect(result.shifts[0]).toMatchObject({ edge: 1, label: "A16", measuredVehH: 5000, baselineVehH: 410, closureVehH: 890, changePct: 117 });
    expect(result.shifts.some((shift) => shift.edge === 3)).toBe(false);
  });

  it("leaves out sensors on the closed roads themselves", () => {
    const withClosure = compareWhatIf(baseline, closure, ["North", "South"], new Map(), { closed: new Set([1]) });
    expect(withClosure.shifts.map((shift) => shift.edge)).toEqual([2]);
  });
});
