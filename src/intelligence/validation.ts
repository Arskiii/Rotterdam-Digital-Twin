// How far the simulation is from what NDW's road sensors measured.
//
// scripts/validate-model.mjs runs the engine headless at fixed times of day
// and scores it with these functions; the Intelligence page renders the
// resulting public/data/model-validation.json. Keeping the scoring here means
// the published numbers and the tests check the same code.

/** One sensor station at one time slot: measured median vs simulated mean. */
export interface StationRow {
  edge: number;
  corridor: string;
  motorway: boolean;
  heldOut: boolean;
  obsFlow: number; // veh/h, median of archived readings
  simFlow: number; // veh/h, mean over seeds, before scaling
  obsKmh: number | null;
  simKmh: number | null;
}

export interface Score {
  stations: number;
  flowWmapePct: number | null;
  gehUnder5Pct: number | null;
  rankCorrelation: number | null;
  speedStations: number;
  speedMaeKmh: number | null;
  speedBiasKmh: number | null;
}

export interface CorridorScore extends Score { corridor: string; motorway: boolean }

export interface SlotReport {
  label: string;
  clockMin: number;
  observedDays: number;
  observedReadings: number;
  flowScale: number;
  heldOut: Score;
  /** The 80% of stations the flow scale was fitted on; older reports lack it. */
  calibration?: Score;
  motorway: Score;
  urban: Score;
  corridors: CorridorScore[];
}

export interface ValidationReport {
  generatedAt: string;
  window: { from: string; to: string; weekdays: number };
  runs: { seeds: number[]; density: number; warmupSec: number; measureSec: number; program: string; externalShare?: number | string };
  slots: SlotReport[];
  method: string;
  limitations: string[];
  references: { label: string; url: string }[];
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** GEH statistic for hourly flows (UK DMRB / TAG M3.1). */
export function geh(model: number, observed: number): number {
  const sum = model + observed;
  return sum > 0 ? Math.sqrt((2 * (model - observed) ** 2) / sum) : 0;
}

function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    for (let k = i; k <= j; k++) out[order[k].index] = (i + j) / 2 + 1; // ties share the mean rank
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation; null when either side has no spread. */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 3 || xs.length !== ys.length) return null;
  const rx = ranks(xs), ry = ranks(ys);
  const mean = (rx.length + 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mean) * (ry[i] - mean);
    dx += (rx[i] - mean) ** 2;
    dy += (ry[i] - mean) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/**
 * Scale from simulated to measured flow, fitted on calibration stations only.
 *
 * The simulation drives a sample of the city's traffic, so its counts are
 * proportional to real flow at best. One city-wide ratio is the least a
 * comparison can fit; held-out stations never contribute to it.
 */
export function fitFlowScale(rows: StationRow[]): number {
  const train = rows.filter((row) => !row.heldOut && row.simFlow > 0);
  const obs = train.reduce((sum, row) => sum + row.obsFlow, 0);
  const sim = train.reduce((sum, row) => sum + row.simFlow, 0);
  return sim > 0 ? obs / sim : 0;
}

export function score(rows: StationRow[], scale: number): Score {
  const flows = rows.filter((row) => row.obsFlow > 0);
  const observed = flows.reduce((sum, row) => sum + row.obsFlow, 0);
  const absError = flows.reduce((sum, row) => sum + Math.abs(scale * row.simFlow - row.obsFlow), 0);
  const speeds = rows.filter((row) => row.obsKmh !== null && row.simKmh !== null);
  const speedError = speeds.map((row) => row.simKmh! - row.obsKmh!);
  return {
    stations: flows.length,
    flowWmapePct: observed ? round((100 * absError) / observed) : null,
    gehUnder5Pct: flows.length ? round((100 * flows.filter((row) => geh(scale * row.simFlow, row.obsFlow) < 5).length) / flows.length) : null,
    rankCorrelation: (() => { const r = spearman(flows.map((row) => row.simFlow), flows.map((row) => row.obsFlow)); return r === null ? null : round(r, 2); })(),
    speedStations: speeds.length,
    speedMaeKmh: speeds.length ? round(speedError.reduce((sum, e) => sum + Math.abs(e), 0) / speeds.length) : null,
    speedBiasKmh: speeds.length ? round(speedError.reduce((sum, e) => sum + e, 0) / speeds.length) : null,
  };
}

/**
 * Which road a station measures.
 *
 * Rijkswaterstaat site names carry the road number (`0160vwa0107ra` is on the
 * A16, `020vwv0236` on the A20); graph edges on motorways are unnamed. City
 * roads use the street name of the matched edge.
 */
export function corridorOf(siteName: string, streetName: string, motorway: boolean): string {
  if (motorway) {
    const match = /^(\d{3,4})(?:hr|vw)[a-z]/i.exec(siteName);
    if (match) return `A${match[1].length === 4 ? Math.floor(Number(match[1]) / 10) : Number(match[1])}`;
    return streetName && streetName !== "MOTORWAY SEGMENT" ? streetName : "Motorway, unlabelled site";
  }
  return streetName || siteName || "Unnamed road";
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** TAG M3.1 asks for GEH < 5 on more than 85% of counted links. */
export const GEH_TARGET_PCT = 85;

/** One plain sentence on what a held-out score supports. */
export function verdict(score: Score): string {
  if (score.gehUnder5Pct === null) return "Not enough measured stations to judge.";
  const flow = score.gehUnder5Pct >= GEH_TARGET_PCT
    ? `Flows meet the usual calibration bar (GEH < 5 on ${score.gehUnder5Pct}% of held-out stations, target ${GEH_TARGET_PCT}%).`
    : `Flows do not meet the usual calibration bar: GEH < 5 on ${score.gehUnder5Pct}% of held-out stations against an ${GEH_TARGET_PCT}% target.`;
  const rank = score.rankCorrelation === null ? "" : score.rankCorrelation < 0.3
    ? " The model does not yet reproduce which roads are busiest."
    : score.rankCorrelation < 0.7 ? " It partly reproduces which roads are busiest." : " It reproduces which roads are busiest.";
  const speed = score.speedMaeKmh === null ? "" : ` Speeds are off by ${score.speedMaeKmh} km/h on average${score.speedBiasKmh ? `, ${score.speedBiasKmh < 0 ? "slower" : "faster"} than measured by ${Math.abs(score.speedBiasKmh)} km/h overall` : ""}.`;
  return flow + rank + speed;
}
