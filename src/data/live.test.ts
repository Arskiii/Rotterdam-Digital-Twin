import { describe, it, expect } from "vitest";
import { admitSnapshot, sanitizeSnapshot, upgradeV1, type LiveSnapshot } from "./live";

const T = "2026-08-21T09:19:44.558Z";
const OLDER = "2026-08-21T08:00:00.000Z";
const NEWER = "2026-08-21T10:00:00.000Z";

const base = (over: Partial<LiveSnapshot> = {}): LiveSnapshot =>
  ({ v: 3, t: T, ...over }) as LiveSnapshot;

describe("upgradeV1", () => {
  it("moves the line out of the slot v2 gave the trip id", () => {
    // v1: [x, y, kind, bearing, line] — read as v2 the bearing became the line
    // and the line became the trip id, so every bus on a route keyed alike.
    const snap = base({
      v: 1,
      vehicles: { t: T, v: [[10, 20, 1, 270, "A"] as never, [30, 40, 1, 90, "A"] as never] },
    });
    upgradeV1(snap);
    const [a, b] = snap.vehicles!.v;
    expect(a[3]).toBe("A"); // line
    expect(b[3]).toBe("A");
    expect(a[4]).not.toBe(b[4]); // distinct synthetic trip keys
    expect(a.slice(0, 3)).toEqual([10, 20, 1]);
  });

  it("marks what v1 never knew as unknown rather than inventing it", () => {
    const snap = base({ v: 1, vehicles: { t: T, v: [[1, 2, 0, 180, "21"] as never] } });
    upgradeV1(snap);
    const [v] = snap.vehicles!.v;
    expect(v[5]).toBe(-1); // stop sequence
    expect(v[6]).toBe(0); // berthed
    expect(v[7]).toBe(""); // vehicle id
    expect(v[8]).toBe(-1); // fix age
  });

  it("is a no-op on a snapshot with no vehicles", () => {
    const snap = base({ v: 1 });
    expect(() => upgradeV1(snap)).not.toThrow();
  });
});

describe("admitSnapshot", () => {
  it("accepts a current snapshot untouched", () => {
    const snap = base({ vehicles: { t: T, v: [], plan: { trip: [[1, 2, 3]] } } });
    expect(admitSnapshot(snap, null).verdict).toBe("ok");
    expect(snap.vehicles!.plan).toBeDefined();
  });

  it("rejects anything that is not a snapshot", () => {
    expect(admitSnapshot(null, null).verdict).toBe("invalid");
    expect(admitSnapshot({}, null).verdict).toBe("invalid");
    expect(admitSnapshot({ v: 3 }, null).verdict).toBe("invalid");
    expect(admitSnapshot({ t: T }, null).verdict).toBe("invalid");
    expect(admitSnapshot({ v: 0, t: T }, null).verdict).toBe("invalid");
    expect(admitSnapshot("<!doctype html>", null).verdict).toBe("invalid");
  });

  it("rejects a snapshot whose timestamp will not parse", () => {
    // A 404 page or a truncated write can still be valid JSON.
    expect(admitSnapshot({ v: 3, t: "not a date" }, null).verdict).toBe("invalid");
  });

  it("refuses to replace a fresher snapshot with a staler one", () => {
    // The committed fallback is always older than the published branch; letting
    // it win would walk the map backwards on every poll.
    expect(admitSnapshot(base({ t: OLDER }), base({ t: T })).verdict).toBe("stale");
    expect(admitSnapshot(base({ t: NEWER }), base({ t: T })).verdict).toBe("ok");
  });

  it("takes an equally-timed snapshot rather than calling it stale", () => {
    expect(admitSnapshot(base({ t: T }), base({ t: T })).verdict).toBe("ok");
  });

  it("migrates a v1 snapshot on the way in", () => {
    const snap = base({ v: 1, vehicles: { t: T, v: [[1, 2, 1, 270, "B"] as never] } });
    expect(admitSnapshot(snap, null).verdict).toBe("ok");
    expect(snap.vehicles!.v[0][3]).toBe("B");
  });

  it("drops v2 vehicle paths, which mean something else under v3", () => {
    // A v2 path listed only the calls still ahead; read as v3 it parks every
    // vehicle on the platform it is heading for.
    const snap = base({ v: 2, vehicles: { t: T, v: [], plan: { trip: [[1, 2, 3]] } } });
    expect(admitSnapshot(snap, null).verdict).toBe("ok");
    expect(snap.vehicles!.plan).toBeUndefined();
  });

  it("keeps a v1 snapshot's slower-moving readings", () => {
    const snap = base({
      v: 1,
      weather: { t: T, temp: 17, wind: 4, dir: 90, gust: 7, rain: 0, desc: "clear" },
      water: { station: "Boompjes", cm: -20, trend: 1, t: T },
    });
    expect(admitSnapshot(snap, null).verdict).toBe("ok");
    expect(snap.weather?.temp).toBe(17);
    expect(snap.water?.cm).toBe(-20);
  });
});

describe("sanitizeSnapshot", () => {
  // Everything here passed the version and timestamp gate and then took the
  // live path down: the poll records the snapshot's `t` before handing it on,
  // so the retry saw the same timestamp and skipped the update entirely.
  const sane = (over: Partial<LiveSnapshot>) => {
    const s = base(over);
    const r = sanitizeSnapshot(s);
    return { s, ...r };
  };

  it("drops a null vehicle rather than throwing on it", () => {
    const { s, dropped, fields } = sane({
      vehicles: { t: T, v: [null as never, [1, 2, 1, "D", "t", 1, 0, "", 5] as never] },
    });
    expect(s.vehicles!.v).toHaveLength(1);
    expect(dropped).toBe(1);
    expect(fields).toContain("vehicles");
  });

  it("empties a vehicle list that is not a list at all", () => {
    const { s, dropped } = sane({ vehicles: { t: T, v: {} as never } });
    expect(s.vehicles!.v).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("drops a vehicle whose position is not a finite number", () => {
    const { s } = sane({
      vehicles: {
        t: T,
        v: [
          [NaN, 2, 1, "D", "a", 1, 0, "", 5] as never,
          [1, Infinity, 1, "D", "b", 1, 0, "", 5] as never,
          [1, 2, 1, "D", "c", 1, 0, "", 5] as never,
        ],
      },
    });
    expect(s.vehicles!.v.map((v) => v[4])).toEqual(["c"]);
  });

  it("drops a board row whose delay is NaN, which would poison every median", () => {
    const { s, fields } = sane({
      departures: {
        t: T,
        stops: {},
        dep: {
          a: [
            ["D", 1, "x", 300, NaN, 1, "t1"] as never,
            ["D", 1, "x", 300, 60, 1, "t2"] as never,
          ],
        },
      },
    });
    expect(s.departures!.dep.a).toHaveLength(1);
    expect(fields).toContain("boards");
  });

  it("drops a board entry that is not a list of rows", () => {
    const { s, dropped } = sane({ departures: { t: T, stops: {}, dep: { a: 5 as never } } });
    expect(s.departures!.dep.a).toBeUndefined();
    expect(dropped).toBe(1);
  });

  it("replaces a boards object that is not an object", () => {
    const { s } = sane({ departures: { t: T, stops: {}, dep: "no" as never } });
    expect(s.departures!.dep).toEqual({});
  });

  it("drops a stop with no usable coordinates", () => {
    const { s } = sane({
      departures: { t: T, stops: { good: ["Beurs", 1, 2], bad: 7 as never, alsoBad: ["x", NaN, 2] }, dep: {} },
    });
    expect(Object.keys(s.departures!.stops)).toEqual(["good"]);
  });

  it("drops a traffic row that is short or unreadable", () => {
    const { s } = sane({
      traffic: { t: T, todMin: 0, s: [[1] as never, [2, 3, "x"] as never, [4, 500, 80]] },
    });
    expect(s.traffic!.s).toEqual([[4, 500, 80]]);
  });

  it("drops the whole traffic block when it is not a list", () => {
    const { s, dropped } = sane({ traffic: { t: T, todMin: 0, s: "oops" as never } });
    expect(s.traffic).toBeUndefined();
    expect(dropped).toBe(1);
  });

  it("drops a vehicle path with an unreadable leg rather than parking it at NaN", () => {
    const { s, fields } = sane({
      vehicles: { t: T, v: [], plan: { good: [[1, 2, 3]], bad: [[1, NaN, 3]], alsoBad: "no" as never } },
    });
    expect(Object.keys(s.vehicles!.plan!)).toEqual(["good"]);
    expect(fields).toContain("paths");
  });

  it("drops incidents and bridges that carry no position", () => {
    const { s } = sane({
      incidents: [{ x: 1, y: 2, kind: 0, edge: 5, name: "A", until: T }, { kind: 0 } as never],
      bridges: [{ name: "B", x: 1, y: 2, edges: [1], until: T }, { name: "C", x: NaN, y: 2, edges: [], until: T }],
    });
    expect(s.incidents).toHaveLength(1);
    expect(s.bridges).toHaveLength(1);
  });

  it("drops a tide reading that would send the river mesh to NaN", () => {
    const { s, fields } = sane({ water: { station: "Boompjes", cm: NaN, trend: 0, t: T } });
    expect(s.water).toBeUndefined();
    expect(fields).toContain("tide");
  });

  it("treats an unreadable rainfall as no rain rather than dropping the weather", () => {
    const { s } = sane({ weather: { t: T, temp: 17, wind: 1, dir: 0, gust: 2, rain: NaN as never, desc: "clear" } });
    expect(s.weather!.rain).toBe(0);
    expect(s.weather!.temp).toBe(17);
  });

  it("leaves a well-formed snapshot completely alone", () => {
    const good = base({
      traffic: { t: T, todMin: 400, s: [[0, 900, 80]] },
      vehicles: { t: T, v: [[1, 2, 1, "D", "t1", 3, 0, "", 12]], plan: { t1: [[1, 2, 30]] } },
      departures: { t: T, stops: { a: ["Beurs", 1, 2] }, dep: { a: [["D", 1, "Slinge", 300, 60, 1, "t1"]] } },
      incidents: [{ x: 1, y: 2, kind: 1, edge: 3, name: "A20", until: T }],
      water: { station: "Boompjes", cm: -20, trend: 1, t: T },
    });
    const before = JSON.stringify(good);
    const r = sanitizeSnapshot(good);
    expect(r).toEqual({ dropped: 0, fields: [] });
    expect(JSON.stringify(good)).toBe(before);
  });

  it("reports the damage through admitSnapshot, so it can be said out loud", () => {
    const r = admitSnapshot(base({ vehicles: { t: T, v: [null as never, null as never] } }), null);
    expect(r).toMatchObject({ verdict: "ok", dropped: 2 });
    expect(r.fields).toEqual(["vehicles"]);
  });

  it("rejects a snapshot that is an array or a string outright", () => {
    expect(admitSnapshot([], null).verdict).toBe("invalid");
    expect(admitSnapshot("<!doctype html>", null).verdict).toBe("invalid");
  });
});
