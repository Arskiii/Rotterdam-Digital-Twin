// Baseline vs closure, run through the traffic simulation.
//
// The free-flow access check answers "is there still a route, and how much
// longer is it". This answers what the free-flow check cannot: where the
// displaced traffic goes and how much slower the network gets. Both arms run
// the same seeds, so a difference is the closure, not the dice; the gap
// between the baseline seeds is reported as the noise floor.

import type { ExperimentResultMsg } from "../sim/protocol";

export interface Change { baseline: number; closure: number; change: number; noise: number }
export interface DistrictChange { district: string; baselineKmh: number; closureKmh: number; changeKmh: number }
export interface StationShift { edge: number; label: string; measuredVehH: number | null; baselineVehH: number; closureVehH: number; changePct: number }
export interface WhatIfResult {
  speedKmh: Change;
  waitSec: Change;
  throughputMin: Change;
  queued: Change;
  districts: DistrictChange[];
  shifts: StationShift[];
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function change(baseline: number[], closure: number[]): Change {
  const b = mean(baseline), c = mean(closure);
  const noise = baseline.length > 1 ? Math.max(...baseline) - Math.min(...baseline) : 0;
  return { baseline: round(b), closure: round(c), change: round(c - b), noise: round(noise) };
}

/** True when a change is bigger than the spread between baseline seeds. */
export const beyondNoise = (value: Change) => Math.abs(value.change) > value.noise;

export function compareWhatIf(
  baseline: ExperimentResultMsg[],
  closure: ExperimentResultMsg[],
  districtNames: string[],
  stationInfo: Map<number, { label: string; measuredVehH: number | null }>,
  { minFlow = 60, top = 8, closed = new Set<number>() } = {},
): WhatIfResult {
  const metric = (runs: ExperimentResultMsg[], pick: (r: ExperimentResultMsg) => number) => runs.map(pick);
  const districts = districtNames.map((district, i) => {
    const b = mean(baseline.map((r) => r.metrics.districts[i]?.speedKmh ?? 0));
    const c = mean(closure.map((r) => r.metrics.districts[i]?.speedKmh ?? 0));
    return { district, baselineKmh: round(b), closureKmh: round(c), changeKmh: round(c - b) };
  }).sort((a, b) => a.changeKmh - b.changeKmh);

  // per-station simulated flow, averaged over seeds, matched by edge
  const flows = (runs: ExperimentResultMsg[]) => {
    const out = new Map<number, number>();
    for (const run of runs) for (const row of run.stationFlows) out.set(row.edge, (out.get(row.edge) ?? 0) + row.simulated / runs.length);
    return out;
  };
  const before = flows(baseline), after = flows(closure);
  const shifts: StationShift[] = [];
  for (const [edge, b] of before) {
    if (closed.has(edge)) continue; // a closed road losing its traffic says nothing new
    const a = after.get(edge) ?? 0;
    if (Math.max(a, b) < minFlow) continue; // too few simulated passes to call a shift
    const info = stationInfo.get(edge);
    shifts.push({ edge, label: info?.label ?? `Sensor on edge ${edge}`, measuredVehH: info?.measuredVehH ?? null,
      baselineVehH: Math.round(b), closureVehH: Math.round(a), changePct: round(b ? (100 * (a - b)) / b : 100, 0) });
  }
  shifts.sort((x, y) => Math.abs(y.closureVehH - y.baselineVehH) - Math.abs(x.closureVehH - x.baselineVehH));

  return {
    speedKmh: change(metric(baseline, (r) => r.metrics.avgSpeedKmh), metric(closure, (r) => r.metrics.avgSpeedKmh)),
    waitSec: change(metric(baseline, (r) => r.metrics.avgWaitSec), metric(closure, (r) => r.metrics.avgWaitSec)),
    throughputMin: change(metric(baseline, (r) => r.metrics.throughputMin), metric(closure, (r) => r.metrics.throughputMin)),
    queued: change(metric(baseline, (r) => r.metrics.queued), metric(closure, (r) => r.metrics.queued)),
    districts,
    shifts: shifts.slice(0, top),
  };
}
