import { describe, it, expect } from "vitest";
import { congestionPatterns, eventImpacts, impactByType } from "./patterns";
import type { ArchiveRecord, ArchiveEvent } from "../data/archive";

const city = { temp: 17, rain: 0, waterCm: 0, incidents: 0, bridges: 0, transit: 0, no2: 0, pm25: 0 };

/** One archived sample. `districts` is [speed, congestion] per district —
 *  speed 0 is the archive's way of saying nobody reported. */
function rec(iso: string, districts: [number, number][]): ArchiveRecord {
  return {
    t: Date.parse(iso),
    ...city,
    districts: districts.map(([speed, congestion]) => ({ flow: speed * 10, speed, congestion })),
  };
}

describe("congestionPatterns", () => {
  it("returns an empty summary for an empty window", () => {
    const p = congestionPatterns([]);
    expect(p.records).toBe(0);
    expect(p.samples).toBe(0);
    expect(p.span).toBeNull();
    expect(p.coveredHours).toEqual([]);
  });

  it("averages only the districts that actually reported", () => {
    // District 1 never reports. Counting its archived zero as free-flowing is
    // the exact mistake this whole module exists to avoid.
    const recs = [
      rec("2026-08-21T06:00:00Z", [[40, 0.2], [0, 0]]),
      rec("2026-08-21T06:05:00Z", [[40, 0.6], [0, 0]]),
    ];
    const p = congestionPatterns(recs);
    expect(p.districts[0].mean).toBeCloseTo(0.4, 6);
    expect(p.districts[0].samples).toBe(2);
    expect(p.districts[1].samples).toBe(0);
    expect(p.districts[1].mean).toBe(0);
    expect(p.samples).toBe(2); // not 4
  });

  it("records the highest single sample as the peak", () => {
    const p = congestionPatterns([
      rec("2026-08-21T06:00:00Z", [[40, 0.2]]),
      rec("2026-08-21T06:05:00Z", [[40, 0.9]]),
      rec("2026-08-21T06:10:00Z", [[40, 0.5]]),
    ]);
    expect(p.districts[0].peak).toBeCloseTo(0.9, 6);
  });

  it("buckets samples by Rotterdam's local hour, not UTC", () => {
    // August is CEST, UTC+2 — 06:00Z is the 08:00 bucket.
    const p = congestionPatterns([rec("2026-08-21T06:30:00Z", [[40, 0.5]])]);
    expect(p.coveredHours).toEqual([8]);
    expect(p.districts[0].byHour[8].samples).toBe(1);
  });

  it("will not name a worst hour it has too few samples for", () => {
    // One sample in an hour is not a pattern; MIN_HOUR_SAMPLES is 2.
    const one = congestionPatterns([rec("2026-08-21T06:00:00Z", [[40, 0.9]])]);
    expect(one.districts[0].worstHour).toBeNull();

    const two = congestionPatterns([
      rec("2026-08-21T06:00:00Z", [[40, 0.9]]),
      rec("2026-08-21T06:05:00Z", [[40, 0.7]]),
    ]);
    expect(two.districts[0].worstHour).toMatchObject({ hour: 8, samples: 2 });
    expect(two.districts[0].worstHour!.mean).toBeCloseTo(0.8, 6);
  });

  it("picks the worst hour by mean, not by any single spike", () => {
    const p = congestionPatterns([
      // 08:00 local — one spike, one calm
      rec("2026-08-21T06:00:00Z", [[40, 0.95]]),
      rec("2026-08-21T06:05:00Z", [[40, 0.05]]),
      // 09:00 local — consistently bad
      rec("2026-08-21T07:00:00Z", [[40, 0.7]]),
      rec("2026-08-21T07:05:00Z", [[40, 0.7]]),
    ]);
    expect(p.districts[0].worstHour!.hour).toBe(9);
  });

  it("reports the span it actually covered", () => {
    const recs = [rec("2026-08-21T06:00:00Z", [[40, 0.1]]), rec("2026-08-21T09:00:00Z", [[40, 0.1]])];
    const p = congestionPatterns(recs);
    expect(p.span).toEqual({ from: recs[0].t, to: recs[1].t });
    expect(p.records).toBe(2);
  });
});

describe("eventImpacts", () => {
  const seeds = [{ x: 0, y: 0 }, { x: 10000, y: 10000 }];
  const ev = (over: Partial<ArchiveEvent> = {}): ArchiveEvent => ({
    t: "2026-08-21T06:00:00Z",
    type: "accident",
    name: "A20",
    x: 0,
    y: 0,
    until: "2026-08-21T06:20:00Z",
    ...over,
  });

  it("returns nothing without records, events or seeds", () => {
    expect(eventImpacts([], [ev()], seeds)).toEqual([]);
    expect(eventImpacts([rec("2026-08-21T06:00:00Z", [[40, 0.1], [40, 0.1]])], [], seeds)).toEqual([]);
    expect(eventImpacts([rec("2026-08-21T06:00:00Z", [[40, 0.1]])], [ev()], [])).toEqual([]);
  });

  it("compares the district against its own quiet hours", () => {
    const recs = [
      rec("2026-08-21T05:00:00Z", [[40, 0.10], [40, 0.90]]), // quiet, d0
      rec("2026-08-21T05:30:00Z", [[40, 0.20], [40, 0.90]]), // quiet, d0
      rec("2026-08-21T06:05:00Z", [[40, 0.70], [40, 0.90]]), // during
      rec("2026-08-21T06:15:00Z", [[40, 0.90], [40, 0.90]]), // during
    ];
    const [impact] = eventImpacts(recs, [ev()], seeds);
    expect(impact.district).toBe(0);
    expect(impact.during).toBeCloseTo(0.8, 6);
    expect(impact.baseline).toBeCloseTo(0.15, 6);
    expect(impact.delta).toBeCloseTo(0.65, 6);
    expect(impact.duringSamples).toBe(2);
    expect(impact.baselineSamples).toBe(2);
  });

  it("attributes an event to the nearest district seed", () => {
    const recs = [rec("2026-08-21T06:05:00Z", [[40, 0.5], [40, 0.5]])];
    expect(eventImpacts(recs, [ev({ x: 9900, y: 9900 })], seeds)[0].district).toBe(1);
  });

  it("reports zero delta rather than a fake one when a side has no samples", () => {
    // Nothing archived inside the window: the honest answer is "not measured",
    // which is what duringSamples 0 says.
    const recs = [rec("2026-08-21T05:00:00Z", [[40, 0.1], [40, 0.1]])];
    const [impact] = eventImpacts(recs, [ev()], seeds);
    expect(impact.duringSamples).toBe(0);
    expect(impact.delta).toBe(0);
  });

  it("excludes samples under any other event from the baseline", () => {
    // An accident during roadworks must not be measured against the roadworks.
    const recs = [
      rec("2026-08-21T05:00:00Z", [[40, 0.1], [40, 0.1]]), // genuinely quiet
      rec("2026-08-21T07:05:00Z", [[40, 0.8], [40, 0.1]]), // inside the roadworks
      rec("2026-08-21T06:05:00Z", [[40, 0.6], [40, 0.1]]), // inside the accident
    ];
    const events = [
      ev(),
      ev({ type: "roadworks", t: "2026-08-21T07:00:00Z", until: "2026-08-21T07:30:00Z" }),
    ];
    const [accident] = eventImpacts(recs, events, seeds);
    expect(accident.baselineSamples).toBe(1);
    expect(accident.baseline).toBeCloseTo(0.1, 6);
  });

  it("gives an event with no end time a bounded window", () => {
    const recs = [
      rec("2026-08-21T06:05:00Z", [[40, 0.7], [40, 0.1]]), // inside the 10-min default
      rec("2026-08-21T06:40:00Z", [[40, 0.1], [40, 0.1]]), // outside it
    ];
    const [impact] = eventImpacts(recs, [ev({ until: null })], seeds);
    expect(impact.duringSamples).toBe(1);
    expect(impact.during).toBeCloseTo(0.7, 6);
  });
});

describe("impactByType", () => {
  const impact = (type: string, delta: number, measured = true) => ({
    type, name: "x", district: 0, from: 0, to: null,
    during: 0, duringSamples: measured ? 2 : 0,
    baseline: 0, baselineSamples: measured ? 2 : 0,
    delta,
  });

  it("averages over the measured events only, but counts them all", () => {
    const out = impactByType([
      impact("accident", 0.4),
      impact("accident", 0.2),
      impact("accident", 99, false), // unmeasured — counted, not averaged
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "accident", events: 3, measured: 2 });
    expect(out[0].meanDelta).toBeCloseTo(0.3, 6);
  });

  it("reports a zero mean for a kind nothing was measured for", () => {
    const [only] = impactByType([impact("closure", 5, false)]);
    expect(only).toMatchObject({ events: 1, measured: 0, meanDelta: 0 });
  });

  it("sorts the costliest kind first", () => {
    const out = impactByType([impact("jam", 0.1), impact("closure", 0.9), impact("roadworks", 0.5)]);
    expect(out.map((o) => o.type)).toEqual(["closure", "roadworks", "jam"]);
  });
});
