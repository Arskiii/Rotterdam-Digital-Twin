export type ResultTone = "positive" | "negative" | "neutral";

/** Pick an actual observation on a time-scaled chart, including across missing history. */
export function nearestObservation(samples: ReadonlyArray<{ observedAt: string }>, fraction: number): number {
  if (!samples.length || !Number.isFinite(fraction)) return -1;
  const first = Date.parse(samples[0].observedAt);
  const last = Date.parse(samples[samples.length - 1].observedAt);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return -1;
  const target = first + (last - first) * Math.max(0, Math.min(1, fraction));
  let low = 0, high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Date.parse(samples[mid].observedAt) < target) low = mid + 1;
    else high = mid;
  }
  return low > 0 && target - Date.parse(samples[low - 1].observedAt) <= Date.parse(samples[low].observedAt) - target ? low - 1 : low;
}

export function mean(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

/** Colour only a visible, directional difference; speed and flow have no assumed objective. */
export function metricChange(baseline: number | null, candidate: number | null, digits: number, better?: "higher" | "lower") {
  if (baseline === null || candidate === null || !Number.isFinite(baseline) || !Number.isFinite(candidate)) {
    return { text: "—", tone: "neutral" as ResultTone };
  }
  const delta = Number((candidate - baseline).toFixed(digits));
  return {
    text: `${delta > 0 ? "+" : ""}${delta.toFixed(digits)}`,
    tone: !delta || !better ? "neutral" : (better === "lower" ? delta < 0 : delta > 0) ? "positive" : "negative",
  } satisfies { text: string; tone: ResultTone };
}
