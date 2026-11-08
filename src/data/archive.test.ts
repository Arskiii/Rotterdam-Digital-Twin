import { describe, it, expect, vi, afterEach } from "vitest";
import { archiveCoverage, archiveValue, ArchiveReader, parseCoarse, type DistrictSample } from "./archive";
import { congestionPatterns } from "../ui/patterns";
import { collectionSummary } from "./collection-health";

// A second implementation of the wire format, written from
// scripts/archive-live.mjs rather than from the parser. The point of writing it
// twice is that a change to either side has to be made twice to go unnoticed —
// this is the only contract in the repo whose two ends live in different
// languages and different processes.
class W {
  private bytes: number[] = [];
  raw(s: string) { for (const c of s) this.bytes.push(c.charCodeAt(0)); return this; }
  u8(v: number) { this.bytes.push(v & 0xff); return this; }
  u16(v: number) { const n = Math.round(v) & 0xffff; this.bytes.push(n & 0xff, n >> 8); return this; }
  i16(v: number) { return this.u16(Math.round(v) < 0 ? Math.round(v) + 0x10000 : Math.round(v)); }
  u32(v: number) { const n = v >>> 0; this.bytes.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff); return this; }
  done(): ArrayBuffer { return new Uint8Array(this.bytes).buffer; }
  get length() { return this.bytes.length; }
}

interface City {
  temp: number; rain: number; waterCm: number;
  incidents: number; bridges: number; transit: number; no2: number; pm25: number;
}

function writeCoarse(hourEpoch: number, records: { slot: number; city: City; districts: DistrictSample[] }[]): ArrayBuffer {
  const districtCount = records[0]?.districts.length ?? 0;
  const w = new W()
    .raw("RTAC")
    .u16(1)
    .u32(hourEpoch)
    .u8(districtCount)
    .u16(records.length);
  for (const r of records) {
    w.u8(r.slot)
      .i16(r.city.temp * 10)
      .u16(r.city.rain * 100)
      .i16(r.city.waterCm)
      .u8(r.city.incidents)
      .u8(r.city.bridges)
      .u16(r.city.transit)
      .u8(r.city.no2)
      .u8(r.city.pm25);
    for (const d of r.districts) w.u16(d.flow).u8(d.speed).u8(Math.round(d.congestion * 255));
  }
  return w.done();
}

const city: City = { temp: 17.4, rain: 0.6, waterCm: -23, incidents: 3, bridges: 1, transit: 214, no2: 28, pm25: 9 };
const HOUR = Date.UTC(2026, 7, 21, 9, 0, 0) / 1000;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("ArchiveReader freshness", () => {
  const start = new Date("2026-11-07T16:00:00Z"), end = new Date("2026-11-07T16:59:59Z");
  const binary = (slots: number[]) => writeCoarse(start.getTime() / 1000, slots.map((slot) => ({ slot, city, districts: [] })));
  it("rechecks missing hours and then sees newly appended samples", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    let slots: number[] = [];
    const fetcher = vi.fn(async () => slots.length ? new Response(binary(slots)) : new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const reader = new ArchiveReader();
    expect(await reader.range(start, end)).toEqual([]);
    const calls = fetcher.mock.calls.length;
    slots = [0]; expect(await reader.range(start, end)).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(calls);
    vi.setSystemTime(start.getTime() + 300001);
    expect(await reader.range(start, end)).toHaveLength(1);
    slots = [0, 5]; vi.setSystemTime(start.getTime() + 600002);
    expect(await reader.range(start, end)).toHaveLength(2);
  });
  it("does not cache server failures and preserves observations through malformed refreshes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    let mode = "error";
    vi.stubGlobal("fetch", vi.fn(async () => mode === "error" ? new Response(null, { status: 503 }) : new Response(mode === "valid" ? binary([0]) : new ArrayBuffer(0))));
    const reader = new ArchiveReader();
    expect(await reader.range(start, end)).toEqual([]);
    mode = "valid"; vi.setSystemTime(start.getTime() + 300001);
    const records = await reader.range(start, end); expect(records).toHaveLength(1);
    mode = "bad"; vi.setSystemTime(start.getTime() + 600002);
    expect(await reader.range(start, end)).toEqual(records);
  });
  it("refreshes this month's incidents and retains them during an outage", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const event = { t: start.toISOString(), type: "incident", name: "Road", x: 1, y: 2, until: null };
    let events = [event], fail = false;
    vi.stubGlobal("fetch", vi.fn(async () => fail ? new Response(null, { status: 503 }) : Response.json(events)));
    const reader = new ArchiveReader();
    expect(await reader.events(2026, 11)).toHaveLength(1);
    events = [event, { ...event, name: "New road" }];
    vi.setSystemTime(start.getTime() + 300001);
    expect(await reader.events(2026, 11)).toHaveLength(2);
    fail = true; vi.setSystemTime(start.getTime() + 600002);
    expect(await reader.events(2026, 11)).toHaveLength(2);
  });
});

describe("parseCoarse", () => {
  it("reads v2 absence without treating it as zero and excludes it from patterns", () => {
    const buf = new W().raw("RTAC").u16(2).u32(HOUR).u8(2).u16(1)
      .u8(0).i16(-32768).u16(0).i16(-32768).u8(255).u8(0).u16(65535).u8(255).u8(255)
      .u16(65535).u8(255).u8(255).u16(0).u8(25).u8(127).done();
    const [r] = parseCoarse(buf);
    expect(r.temp).toBeNaN(); expect(r.rain).toBe(0); expect(r.bridges).toBe(0);
    expect(r.districts[0].flow).toBeNaN(); expect(r.districts[1].congestion).toBe(0.5);
    expect(archiveValue(r.temp, 1, "°C")).toBe("—");
    expect(congestionPatterns([r]).samples).toBe(1);
  });
  it("counts gaps between sparse records and never calls the entire span covered", () => {
    const from = HOUR * 1000;
    const records = parseCoarse(writeCoarse(HOUR, [0, 55].map(slot => ({ slot, city, districts: [] }))));
    expect(archiveCoverage(records, from, from + 3600_000)).toMatchObject({ expected: 12, captured: 2, fraction: 1 / 6, sampled: false });
    expect(archiveCoverage([...records, records[0]], from, from + 3600_000).captured).toBe(2);
  });
  it("does not call a cached heartbeat healthy after collection stops", () => {
    const status = { v: 1, healthy: true, startedAt: HOUR * 1000, lastSuccessAt: HOUR * 1000, coverage: { from: HOUR * 1000, to: HOUR * 1000, expected: 12, recorded: 10, missing: 2 }, maintenance: {} };
    expect(collectionSummary(status, HOUR * 1000 + 60_000).healthy).toBe(true);
    expect(collectionSummary(status, HOUR * 1000 + 600_000)).toMatchObject({ healthy: false });
    expect(collectionSummary(status, HOUR * 1000 + 600_000).text).toContain("2 missing");
  });
  it("round-trips a record the writer would produce", () => {
    const districts: DistrictSample[] = [
      { flow: 4200, speed: 48, congestion: 40 / 255 },
      { flow: 0, speed: 0, congestion: 0 },
    ];
    const [r] = parseCoarse(writeCoarse(HOUR, [{ slot: 25, city, districts }]));
    expect(r.t).toBe((HOUR + 25 * 60) * 1000);
    expect(r.temp).toBeCloseTo(17.4, 5);
    expect(r.rain).toBeCloseTo(0.6, 5);
    expect(r.waterCm).toBe(-23);
    expect(r.incidents).toBe(3);
    expect(r.bridges).toBe(1);
    expect(r.transit).toBe(214);
    expect(r.no2).toBe(28);
    expect(r.pm25).toBe(9);
    expect(r.districts).toHaveLength(2);
    expect(r.districts[0]).toMatchObject({ flow: 4200, speed: 48 });
    expect(r.districts[0].congestion).toBeCloseTo(40 / 255, 5);
  });

  it("keeps records in the order they were appended, one per slot", () => {
    const d: DistrictSample[] = [{ flow: 1, speed: 1, congestion: 0 }];
    const recs = parseCoarse(
      writeCoarse(HOUR, [0, 5, 10, 55].map((slot) => ({ slot, city, districts: d })))
    );
    expect(recs.map((r) => (r.t / 1000 - HOUR) / 60)).toEqual([0, 5, 10, 55]);
  });

  it("carries a negative temperature through as negative", () => {
    const [r] = parseCoarse(
      writeCoarse(HOUR, [{ slot: 0, city: { ...city, temp: -4.2, waterCm: -180 }, districts: [] }])
    );
    expect(r.temp).toBeCloseTo(-4.2, 5);
    expect(r.waterCm).toBe(-180);
  });

  it("reads a district count it was not compiled against", () => {
    // The archive stores its own district count; a build with a different
    // DISTRICTS list must not silently read the wrong stride.
    const eight: DistrictSample[] = Array.from({ length: 8 }, (_, i) => ({ flow: i * 100, speed: i, congestion: i / 255 }));
    const [r] = parseCoarse(writeCoarse(HOUR, [{ slot: 3, city, districts: eight }]));
    expect(r.districts).toHaveLength(8);
    expect(r.districts[7].flow).toBe(700);
  });

  it("returns nothing for a buffer that is not an archive hour", () => {
    expect(parseCoarse(new W().raw("NOPE").u16(1).u32(HOUR).u8(1).u16(0).done())).toEqual([]);
    expect(parseCoarse(new ArrayBuffer(0))).toEqual([]);
    expect(parseCoarse(new ArrayBuffer(4))).toEqual([]);
  });

  it("stops at the last whole record rather than reading past the end", () => {
    // A file cut short mid-append — the writer is not atomic across a crash.
    const full = writeCoarse(HOUR, [
      { slot: 0, city, districts: [{ flow: 1, speed: 1, congestion: 0 }] },
      { slot: 5, city, districts: [{ flow: 2, speed: 2, congestion: 0 }] },
    ]);
    const truncated = full.slice(0, full.byteLength - 3);
    const recs = parseCoarse(truncated);
    expect(recs).toHaveLength(1);
    expect(recs[0].districts[0].flow).toBe(1);
  });
});
