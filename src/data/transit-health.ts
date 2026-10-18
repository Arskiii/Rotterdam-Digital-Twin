// How the transit network is actually running, line by line.
//
// The live map draws every tram, metro, bus and ferry individually, and the
// departure boards answer "what is coming here". Neither answers the question
// an operator actually has, which is "is anything wrong tonight, and where" —
// that needs the fleet rolled up per line.
//
// Everything here is measured. A line's delay is the median of the running
// delays its own trips reported, over the trips that reported one; a line's
// vehicle count is how many are publishing a position right now. Nothing is
// inferred from the timetable, and nothing is filled in.
//
// The distinction that matters, and the reason this is not four lines of
// groupBy: **a line with nothing reporting is not a line running on time.**
// At 05:30 Rotterdam's metros have not started and every board row is the
// published timetable with a zero delay attached. Read carelessly that is a
// perfect network. Read honestly it is a network that is not running yet, and
// the two have to look different.
//
// Pure over a snapshot so it can be checked at rush hour, at night, and in the
// half-lit state between them without waiting for any of them to happen.

import type { LiveSnapshot } from "./live";

/** 0 tram · 1 metro · 2 bus · 3 train — the feed's own ordering. */
export const KIND_LABEL = ["TRAM", "METRO", "BUS", "FERRY"];

export type LineState =
  /** vehicles are out and at least one trip reported a running delay */
  | "measured"
  /** vehicles are out, but no trip on this line has reported a delay yet */
  | "running"
  /** the timetable lists services and nothing is reporting a position */
  | "not-reporting";

export interface LineHealth {
  kind: number;
  line: string;
  /** vehicles publishing a position in this snapshot */
  vehicles: number;
  /** distinct trips that reported a running delay — the sample behind the median */
  trips: number;
  /** median of those trips' delays, seconds. null when nothing reported one. */
  medianDelaySec: number | null;
  /** the worst single trip, seconds. null when nothing reported one. */
  worstDelaySec: number | null;
  /** trips on the boards still running to the published timetable */
  scheduled: number;
  state: LineState;
}

export interface TransitHealth {
  lines: LineHealth[];
  /** vehicles publishing a position, across every line */
  vehicles: number;
  /** lines with at least one vehicle out */
  linesRunning: number;
  /** lines whose delay is actually measured */
  linesMeasured: number;
  /** median across every trip that reported, not the median of the medians */
  medianDelaySec: number | null;
  /** when the fleet positions were captured */
  at: string | null;
}

/** Middle value, or the mean of the middle two. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const key = (kind: number, line: string) => `${kind}:${line}`;

/**
 * Roll the snapshot up per line.
 *
 * A trip appears on the board of every stop it is going to call at, so trips
 * are collected by id before anything is averaged — otherwise a long metro run
 * counts fifteen times and a short bus route once, and the "median delay"
 * becomes a median over stops rather than over services.
 */
export function transitHealth(snap: LiveSnapshot | null): TransitHealth {
  const empty: TransitHealth = {
    lines: [], vehicles: 0, linesRunning: 0, linesMeasured: 0, medianDelaySec: null, at: null,
  };
  if (!snap) return empty;

  // ---- trips, deduped by id across every board they appear on ----
  const trips = new Map<string, { kind: number; line: string; delay: number; live: boolean }>();
  const dep = snap.departures?.dep ?? {};
  for (const stopKey of Object.keys(dep)) {
    for (const row of dep[stopKey] ?? []) {
      const [line, kind, , , delaySec, isLive, tripId] = row;
      // A row with no trip id cannot be deduped and would be counted once per
      // stop it calls at, so it is left out of the sample rather than
      // multiplying one late service into fifteen.
      if (!tripId) continue;
      const seen = trips.get(tripId);
      // Prefer a live sighting of a trip over a scheduled one: the same trip
      // can be live on the board of the stop it is approaching and scheduled
      // on one further down the line.
      if (seen && (seen.live || !isLive)) continue;
      trips.set(tripId, { kind, line: String(line), delay: delaySec, live: !!isLive });
    }
  }

  // ---- vehicles reporting a position ----
  const vehicles = new Map<string, number>();
  let vehicleTotal = 0;
  for (const v of snap.vehicles?.v ?? []) {
    const kind = v[2];
    const line = String(v[3] ?? "");
    if (!line) continue; // a vehicle with no line cannot be attributed to one
    vehicles.set(key(kind, line), (vehicles.get(key(kind, line)) ?? 0) + 1);
    vehicleTotal++;
  }

  // ---- merge: a line is anything the fleet or the boards know about ----
  const acc = new Map<string, { kind: number; line: string; delays: number[]; scheduled: number }>();
  const touch = (kind: number, line: string) => {
    const k = key(kind, line);
    let e = acc.get(k);
    if (!e) acc.set(k, (e = { kind, line, delays: [], scheduled: 0 }));
    return e;
  };
  for (const t of trips.values()) {
    const e = touch(t.kind, t.line);
    if (t.live) e.delays.push(t.delay);
    else e.scheduled++;
  }
  for (const k of vehicles.keys()) {
    const i = k.indexOf(":");
    touch(+k.slice(0, i), k.slice(i + 1));
  }

  const lines: LineHealth[] = [];
  const allDelays: number[] = [];
  for (const [k, e] of acc) {
    const n = vehicles.get(k) ?? 0;
    const measured = e.delays.length > 0;
    allDelays.push(...e.delays);
    lines.push({
      kind: e.kind,
      line: e.line,
      vehicles: n,
      trips: e.delays.length,
      medianDelaySec: measured ? median(e.delays) : null,
      worstDelaySec: measured ? Math.max(...e.delays) : null,
      scheduled: e.scheduled,
      // Both signals count, and a delay is the stronger of the two.
      //
      // Keying this on the vehicle count alone produced a row that contradicted
      // itself: tram 19 with no position reporting, a median over two trips,
      // and the label NOT REPORTING beside it. The two feeds do not always
      // agree — a trip can be live on a board while its vehicle is not in the
      // position list — and a line whose trips are reporting delays is being
      // measured whether or not anything carries a coordinate.
      //
      // Nothing at all is still "not reporting", never "on time": a line the
      // timetable says should be running and which nothing reports from is the
      // one state worth noticing, and it is exactly the state a naive
      // zero-delay rollup renders as perfect.
      state: measured ? "measured" : n > 0 ? "running" : "not-reporting",
    });
  }

  // Worst first, and within that the biggest sample — a +6' median over eleven
  // trips is a stronger claim than the same number over one.
  lines.sort(
    (a, b) =>
      (b.medianDelaySec ?? -Infinity) - (a.medianDelaySec ?? -Infinity) ||
      b.trips - a.trips ||
      a.kind - b.kind ||
      a.line.localeCompare(b.line, undefined, { numeric: true })
  );

  return {
    lines,
    vehicles: vehicleTotal,
    linesRunning: lines.filter((l) => l.vehicles > 0).length,
    linesMeasured: lines.filter((l) => l.trips > 0).length,
    medianDelaySec: allDelays.length ? median(allDelays) : null,
    at: snap.vehicles?.t ?? snap.departures?.t ?? snap.t ?? null,
  };
}
