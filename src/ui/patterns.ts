// What the archive knows once you stop looking at one moment at a time.
//
// The scrubber answers "what was the city doing at 08:40 last Tuesday". These
// functions answer the questions that need the whole window at once: where
// congestion keeps coming back, at what hour, and what actually happened around
// an incident. Pure over ArchiveRecord[] so they can be checked without a DOM.
//
// Everything here distinguishes "free flowing" from "nobody measured". A
// district with no reporting station archives a congestion of zero, which is
// the same number as an empty motorway — so the sample count travels with every
// average, and a cell backed by nothing is never drawn as calm.

import type { ArchiveRecord, ArchiveEvent } from "../data/archive";

/** A district's congestion profile across the archived window. */
export interface DistrictPattern {
  index: number;
  /** mean congestion 0..1 over every measured sample */
  mean: number;
  /** highest single sample seen */
  peak: number;
  samples: number;
  /** per local hour 0..23 */
  byHour: { mean: number; samples: number }[];
  /** the hour this district is worst in, over hours with enough samples */
  worstHour: { hour: number; mean: number; samples: number } | null;
}

export interface PatternSummary {
  districts: DistrictPattern[];
  /** local hours that carry at least one measured sample */
  coveredHours: number[];
  /** measured district-samples behind the whole summary */
  samples: number;
  records: number;
  span: { from: number; to: number } | null;
}

/** An hour needs this many samples before its average is worth ranking on. */
const MIN_HOUR_SAMPLES = 2;

/**
 * Local hour in Rotterdam for each record.
 *
 * Done once per record rather than per district: Intl formatting is the
 * expensive part of this whole pass, and a record has one clock.
 */
function localHours(recs: ArchiveRecord[]): number[] {
  const fmt = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    hour12: false,
  });
  return recs.map((r) => {
    const h = +fmt.format(new Date(r.t));
    return h === 24 ? 0 : h;
  });
}

export function congestionPatterns(recs: ArchiveRecord[]): PatternSummary {
  const n = recs[0]?.districts.length ?? 0;
  const districts: DistrictPattern[] = Array.from({ length: n }, (_, index) => ({
    index,
    mean: 0,
    peak: 0,
    samples: 0,
    byHour: Array.from({ length: 24 }, () => ({ mean: 0, samples: 0 })),
    worstHour: null,
  }));
  if (!recs.length) {
    return { districts, coveredHours: [], samples: 0, records: 0, span: null };
  }

  const hours = localHours(recs);
  const sums = districts.map(() => 0);
  const hourSums = districts.map(() => new Float64Array(24));
  const covered = new Set<number>();
  let samples = 0;

  recs.forEach((r, i) => {
    const hour = hours[i];
    for (let d = 0; d < n; d++) {
      const s = r.districts[d];
      // speed 0 means no station in this district reported — not a jam
      if (!s || s.speed <= 0) continue;
      const c = s.congestion;
      const dist = districts[d];
      sums[d] += c;
      dist.samples++;
      if (c > dist.peak) dist.peak = c;
      hourSums[d][hour] += c;
      dist.byHour[hour].samples++;
      covered.add(hour);
      samples++;
    }
  });

  for (let d = 0; d < n; d++) {
    const dist = districts[d];
    dist.mean = dist.samples ? sums[d] / dist.samples : 0;
    for (let h = 0; h < 24; h++) {
      const cell = dist.byHour[h];
      cell.mean = cell.samples ? hourSums[d][h] / cell.samples : 0;
    }
    let worst: DistrictPattern["worstHour"] = null;
    for (let h = 0; h < 24; h++) {
      const cell = dist.byHour[h];
      if (cell.samples < MIN_HOUR_SAMPLES) continue;
      if (!worst || cell.mean > worst.mean) worst = { hour: h, mean: cell.mean, samples: cell.samples };
    }
    dist.worstHour = worst;
  }

  return {
    districts,
    coveredHours: [...covered].sort((a, b) => a - b),
    samples,
    records: recs.length,
    span: { from: recs[0].t, to: recs[recs.length - 1].t },
  };
}

export interface EventImpact {
  type: string;
  name: string;
  /** district the event sits in */
  district: number;
  from: number;
  to: number | null;
  /** mean congestion in that district while the event was open */
  during: number;
  duringSamples: number;
  /** the same district's mean outside every event of any kind */
  baseline: number;
  baselineSamples: number;
  /** during − baseline, in congestion points */
  delta: number;
}

/**
 * What the roads were doing while something was blocking them.
 *
 * The comparison is against the same district's own quiet hours, not against
 * the city — Charlois at rush hour is busier than Pernis at any hour, and a
 * city-wide baseline would read that as an incident effect. Quiet means no
 * archived event of any kind was open there, so an accident during roadworks
 * is not measured against the roadworks.
 *
 * An event with too few samples either side is reported with its counts rather
 * than dropped: five minutes of archive across a twelve-minute obstruction is a
 * real limit of the record, and hiding it would imply we simply had nothing.
 */
export function eventImpacts(
  recs: ArchiveRecord[],
  events: ArchiveEvent[],
  seeds: { x: number; y: number }[]
): EventImpact[] {
  if (!recs.length || !events.length || !seeds.length) return [];

  const districtOf = (x: number, y: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const d = (seeds[i].x - x) ** 2 + (seeds[i].y - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const windows = events.map((e) => {
    const from = Date.parse(e.t);
    const until = e.until ? Date.parse(e.until) : NaN;
    return {
      e,
      district: districtOf(e.x, e.y),
      from,
      to: Number.isFinite(until) ? until : from + 10 * 60_000,
    };
  }).filter((w) => Number.isFinite(w.from));

  // per district: the samples with nothing open, for the baseline
  const quiet = seeds.map(() => ({ sum: 0, n: 0 }));
  for (const r of recs) {
    for (let d = 0; d < seeds.length; d++) {
      const s = r.districts[d];
      if (!s || s.speed <= 0) continue;
      const busy = windows.some((w) => w.district === d && r.t >= w.from && r.t <= w.to);
      if (busy) continue;
      quiet[d].sum += s.congestion;
      quiet[d].n++;
    }
  }

  const out: EventImpact[] = [];
  for (const w of windows) {
    let sum = 0;
    let n = 0;
    for (const r of recs) {
      if (r.t < w.from || r.t > w.to) continue;
      const s = r.districts[w.district];
      if (!s || s.speed <= 0) continue;
      sum += s.congestion;
      n++;
    }
    const base = quiet[w.district];
    const during = n ? sum / n : 0;
    const baseline = base.n ? base.sum / base.n : 0;
    out.push({
      type: w.e.type,
      name: w.e.name,
      district: w.district,
      from: w.from,
      to: Number.isFinite(w.to) ? w.to : null,
      during,
      duringSamples: n,
      baseline,
      baselineSamples: base.n,
      delta: n && base.n ? during - baseline : 0,
    });
  }
  return out;
}

/** Roll the per-event impacts up by kind, weighting each event equally. */
export function impactByType(impacts: EventImpact[]): {
  type: string;
  events: number;
  measured: number;
  meanDelta: number;
}[] {
  const by = new Map<string, { events: number; measured: number; sum: number }>();
  for (const i of impacts) {
    const e = by.get(i.type) ?? { events: 0, measured: 0, sum: 0 };
    e.events++;
    if (i.duringSamples && i.baselineSamples) {
      e.measured++;
      e.sum += i.delta;
    }
    by.set(i.type, e);
  }
  return [...by.entries()]
    .map(([type, v]) => ({ type, events: v.events, measured: v.measured, meanDelta: v.measured ? v.sum / v.measured : 0 }))
    .sort((a, b) => b.meanDelta - a.meanDelta);
}
