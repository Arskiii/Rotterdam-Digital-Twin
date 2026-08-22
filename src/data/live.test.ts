import { describe, it, expect } from "vitest";
import { admitSnapshot, upgradeV1, type LiveSnapshot } from "./live";

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
    expect(admitSnapshot(snap, null)).toBe("ok");
    expect(snap.vehicles!.plan).toBeDefined();
  });

  it("rejects anything that is not a snapshot", () => {
    expect(admitSnapshot(null, null)).toBe("invalid");
    expect(admitSnapshot({}, null)).toBe("invalid");
    expect(admitSnapshot({ v: 3 }, null)).toBe("invalid");
    expect(admitSnapshot({ t: T }, null)).toBe("invalid");
    expect(admitSnapshot({ v: 0, t: T }, null)).toBe("invalid");
    expect(admitSnapshot("<!doctype html>", null)).toBe("invalid");
  });

  it("rejects a snapshot whose timestamp will not parse", () => {
    // A 404 page or a truncated write can still be valid JSON.
    expect(admitSnapshot({ v: 3, t: "not a date" }, null)).toBe("invalid");
  });

  it("refuses to replace a fresher snapshot with a staler one", () => {
    // The committed fallback is always older than the published branch; letting
    // it win would walk the map backwards on every poll.
    expect(admitSnapshot(base({ t: OLDER }), base({ t: T }))).toBe("stale");
    expect(admitSnapshot(base({ t: NEWER }), base({ t: T }))).toBe("ok");
  });

  it("takes an equally-timed snapshot rather than calling it stale", () => {
    expect(admitSnapshot(base({ t: T }), base({ t: T }))).toBe("ok");
  });

  it("migrates a v1 snapshot on the way in", () => {
    const snap = base({ v: 1, vehicles: { t: T, v: [[1, 2, 1, 270, "B"] as never] } });
    expect(admitSnapshot(snap, null)).toBe("ok");
    expect(snap.vehicles!.v[0][3]).toBe("B");
  });

  it("drops v2 vehicle paths, which mean something else under v3", () => {
    // A v2 path listed only the calls still ahead; read as v3 it parks every
    // vehicle on the platform it is heading for.
    const snap = base({ v: 2, vehicles: { t: T, v: [], plan: { trip: [[1, 2, 3]] } } });
    expect(admitSnapshot(snap, null)).toBe("ok");
    expect(snap.vehicles!.plan).toBeUndefined();
  });

  it("keeps a v1 snapshot's slower-moving readings", () => {
    const snap = base({
      v: 1,
      weather: { t: T, temp: 17, wind: 4, dir: 90, gust: 7, rain: 0, desc: "clear" },
      water: { station: "Boompjes", cm: -20, trend: 1, t: T },
    });
    expect(admitSnapshot(snap, null)).toBe("ok");
    expect(snap.weather?.temp).toBe(17);
    expect(snap.water?.cm).toBe(-20);
  });
});
