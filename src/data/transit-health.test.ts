import { describe, it, expect } from "vitest";
import { transitHealth } from "./transit-health";
import type { LiveSnapshot, Departure, LiveVehicle } from "./live";

const T = "2026-08-22T07:40:00.000Z";

/** [line, kind, destination, secondsUntil, delaySec, isLive, tripId] */
const d = (line: string, kind: number, delay: number, live: 0 | 1, trip: string): Departure =>
  [line, kind, "Somewhere", 300, delay, live, trip];

/** [x, y, kind, line, tripId, stopSeq, berthed, vehicleId, fixAge] */
const v = (kind: number, line: string, trip = "t"): LiveVehicle => [0, 0, kind, line, trip, 1, 0, "", 30];

const snap = (over: Partial<LiveSnapshot> = {}): LiveSnapshot =>
  ({ v: 3, t: T, ...over }) as LiveSnapshot;

const line = (h: ReturnType<typeof transitHealth>, kind: number, name: string) =>
  h.lines.find((l) => l.kind === kind && l.line === name)!;

describe("transitHealth", () => {
  it("returns an empty rollup for no snapshot", () => {
    const h = transitHealth(null);
    expect(h).toMatchObject({ lines: [], vehicles: 0, linesRunning: 0, linesMeasured: 0, medianDelaySec: null, at: null });
  });

  it("returns an empty rollup for a snapshot with no transit at all", () => {
    expect(transitHealth(snap()).lines).toEqual([]);
  });

  describe("the night case", () => {
    // 05:30 in Rotterdam: the metros have not started, so every board row is
    // the published timetable with a zero delay attached, and the only things
    // moving are two night buses. Read carelessly this is a perfect network.
    const night = snap({
      vehicles: { t: T, v: [v(2, "8", "b1"), v(2, "8", "b2"), v(2, "7", "b3")] },
      departures: {
        t: T,
        stops: {},
        dep: {
          slinge: [d("D", 1, 0, 0, "m1"), d("E", 1, 0, 0, "m2")],
          zuidplein: [d("D", 1, 0, 0, "m1"), d("E", 1, 0, 0, "m2")],
        },
      },
    });
    const h = transitHealth(night);

    it("calls a line with nothing reporting 'not-reporting', never on time", () => {
      expect(line(h, 1, "D").state).toBe("not-reporting");
      expect(line(h, 1, "D").medianDelaySec).toBeNull();
      expect(line(h, 1, "D").vehicles).toBe(0);
      expect(line(h, 1, "D").scheduled).toBe(1);
    });

    it("does not claim a network median it has no measurement for", () => {
      expect(h.medianDelaySec).toBeNull();
      expect(h.linesMeasured).toBe(0);
    });

    it("still reports the lines that are genuinely out", () => {
      expect(h.vehicles).toBe(3);
      expect(h.linesRunning).toBe(2);
      expect(line(h, 2, "8")).toMatchObject({ vehicles: 2, state: "running", trips: 0 });
    });
  });

  it("calls a line measured when its trips report, even with no position for it", () => {
    // The two feeds do not always agree: a trip can be live on a board while
    // its vehicle is missing from the position list. Keying the state on the
    // vehicle count alone produced a row that contradicted itself — a median
    // over two trips labelled NOT REPORTING.
    const h = transitHealth(
      snap({
        vehicles: { t: T, v: [] },
        departures: { t: T, stops: {}, dep: { a: [d("19", 0, 30, 1, "t1"), d("19", 0, 90, 1, "t2")] } },
      })
    );
    expect(line(h, 0, "19")).toMatchObject({ vehicles: 0, trips: 2, state: "measured", medianDelaySec: 60 });
  });

  it("counts a trip once however many boards it appears on", () => {
    // A metro run calls at fifteen stations; counting it per stop would turn
    // one late service into fifteen and make the median a median over stops.
    const dep: Record<string, Departure[]> = {};
    for (let i = 0; i < 15; i++) dep[`stop${i}`] = [d("D", 1, 600, 1, "trip-1")];
    const h = transitHealth(snap({ departures: { t: T, stops: {}, dep }, vehicles: { t: T, v: [v(1, "D")] } }));
    expect(line(h, 1, "D").trips).toBe(1);
    expect(line(h, 1, "D").medianDelaySec).toBe(600);
  });

  it("prefers a live sighting of a trip over a scheduled one", () => {
    // The same trip is live on the board it is approaching and scheduled
    // further down the line.
    const h = transitHealth(
      snap({
        vehicles: { t: T, v: [v(1, "D")] },
        departures: {
          t: T,
          stops: {},
          dep: { far: [d("D", 1, 0, 0, "trip-1")], near: [d("D", 1, 420, 1, "trip-1")] },
        },
      })
    );
    expect(line(h, 1, "D")).toMatchObject({ trips: 1, scheduled: 0, medianDelaySec: 420 });
  });

  it("takes the median, so one stuck vehicle does not define the line", () => {
    const dep: Record<string, Departure[]> = {
      a: [d("A", 0, 60, 1, "t1"), d("A", 0, 60, 1, "t2"), d("A", 0, 120, 1, "t3"), d("A", 0, 3600, 1, "t4")],
    };
    const h = transitHealth(snap({ departures: { t: T, stops: {}, dep }, vehicles: { t: T, v: [v(0, "A")] } }));
    expect(line(h, 0, "A").medianDelaySec).toBe(90); // not 960, the mean
    expect(line(h, 0, "A").worstDelaySec).toBe(3600);
    expect(line(h, 0, "A").trips).toBe(4);
  });

  it("carries an early running time through as negative", () => {
    const h = transitHealth(
      snap({
        vehicles: { t: T, v: [v(0, "A")] },
        departures: { t: T, stops: {}, dep: { a: [d("A", 0, -90, 1, "t1")] } },
      })
    );
    expect(line(h, 0, "A").medianDelaySec).toBe(-90);
  });

  it("ranks the worst line first, and a bigger sample ahead of a smaller tie", () => {
    const dep: Record<string, Departure[]> = {
      a: [
        d("A", 0, 600, 1, "a1"), d("A", 0, 600, 1, "a2"),
        d("B", 0, 60, 1, "b1"),
        d("C", 0, 600, 1, "c1"),
      ],
    };
    const h = transitHealth(
      snap({ departures: { t: T, stops: {}, dep }, vehicles: { t: T, v: [v(0, "A"), v(0, "B"), v(0, "C")] } })
    );
    // A and C tie on median; A has two trips behind it
    expect(h.lines.map((l) => l.line)).toEqual(["A", "C", "B"]);
  });

  it("sorts unmeasured lines last, however they are named", () => {
    const h = transitHealth(
      snap({
        vehicles: { t: T, v: [v(0, "Z")] },
        departures: { t: T, stops: {}, dep: { a: [d("A", 0, 60, 1, "a1")] } },
      })
    );
    expect(h.lines[h.lines.length - 1].line).toBe("Z");
    expect(h.lines[h.lines.length - 1].medianDelaySec).toBeNull();
  });

  it("keeps the same line number apart across modes", () => {
    // Tram 4 and bus 4 are different services with the same name.
    const h = transitHealth(
      snap({
        vehicles: { t: T, v: [v(0, "4"), v(2, "4"), v(2, "4")] },
        departures: { t: T, stops: {}, dep: { a: [d("4", 0, 300, 1, "t1"), d("4", 2, 60, 1, "b1")] } },
      })
    );
    expect(line(h, 0, "4")).toMatchObject({ vehicles: 1, medianDelaySec: 300 });
    expect(line(h, 2, "4")).toMatchObject({ vehicles: 2, medianDelaySec: 60 });
  });

  it("ignores board rows with no trip id rather than counting them per stop", () => {
    const h = transitHealth(
      snap({
        vehicles: { t: T, v: [v(1, "D")] },
        departures: {
          t: T,
          stops: {},
          dep: { a: [d("D", 1, 600, 1, "")], b: [d("D", 1, 600, 1, "")] },
        },
      })
    );
    expect(line(h, 1, "D")).toMatchObject({ trips: 0, state: "running", medianDelaySec: null });
  });

  it("ignores a vehicle with no line, since it cannot be attributed to one", () => {
    const h = transitHealth(snap({ vehicles: { t: T, v: [v(2, ""), v(2, "8")] } }));
    expect(h.vehicles).toBe(1);
    expect(h.lines).toHaveLength(1);
  });

  it("takes the network median over trips, not over the lines' medians", () => {
    // Line A has three trips near zero, line B one at an hour. A median of the
    // two medians would read 30 minutes; the median over services is a minute.
    const dep: Record<string, Departure[]> = {
      a: [d("A", 0, 60, 1, "a1"), d("A", 0, 60, 1, "a2"), d("A", 0, 60, 1, "a3"), d("B", 0, 3600, 1, "b1")],
    };
    const h = transitHealth(snap({ departures: { t: T, stops: {}, dep }, vehicles: { t: T, v: [v(0, "A"), v(0, "B")] } }));
    expect(h.medianDelaySec).toBe(60);
    expect(h.linesMeasured).toBe(2);
  });

  it("timestamps the rollup from the fleet capture, falling back to the snapshot", () => {
    expect(transitHealth(snap({ vehicles: { t: "2026-08-22T07:39:00.000Z", v: [] } })).at)
      .toBe("2026-08-22T07:39:00.000Z");
    expect(transitHealth(snap()).at).toBe(T);
  });
});
