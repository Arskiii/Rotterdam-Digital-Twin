#!/usr/bin/env node
// The Rotterdam timetable, extracted from the national GTFS.
//
//   node scripts/fetch-gtfs-timetable.mjs     (npm run fetch-timetable)
//
// Why this exists, twice over.
//
// The departure boards: OVapi's GTFS-RT tripUpdates feed reports stops a trip
// has ALREADY called at, not stops ahead of it — measured on the live feed, 29
// of 653 metro stop updates were in the future, and a trip that has not
// departed yet publishes a single row. That is a record of what happened, not
// a forecast, so it cannot answer "when is the next metro". A real departure
// board is scheduled time + live delay, which means we need the schedule.
//
// The map: a position fix is a minute or two old before it is even published.
// Without a schedule to drive them, every vehicle on screen stands still
// between fixes and then jumps. The schedule is what makes them move.
//
// stop_times.txt is 1 GB uncompressed, so it is never held in memory: the
// entry's compressed byte range is streamed straight through inflate and
// filtered to the operators below, line by line. Output is a compact binary
// committed to data/, refreshed when the timetable changes — a few times a
// year, not per refresh.
//
// Behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1 (the npm script sets it).

import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "ret-timetable.bin");
const URL_ZIP = "https://gtfs.ovapi.nl/nl/gtfs-nl.zip";
const UA = { "User-Agent": "rotterdam-intelligence-platform/1.0 (research; contact via github)" };

// ---------------- zip plumbing (range reads, no full download) ----------------

async function range(from, to, asStream = false) {
  const res = await fetch(URL_ZIP, {
    headers: { ...UA, Range: `bytes=${from}-${to}` },
    signal: AbortSignal.timeout(1_800_000),
  });
  if (res.status !== 206) throw new Error(`range ${from}-${to}: HTTP ${res.status}`);
  return asStream ? Readable.fromWeb(res.body) : Buffer.from(await res.arrayBuffer());
}

async function zipIndex() {
  const head = await fetch(URL_ZIP, { method: "HEAD", headers: UA, signal: AbortSignal.timeout(60_000) });
  const size = Number(head.headers.get("content-length"));
  if (!Number.isFinite(size)) throw new Error("no content-length on the zip");
  const tail = await range(size - Math.min(size, 66_000), size - 1);
  const i = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (i === -1) throw new Error("no end-of-central-directory record");
  const cdSize = tail.readUInt32LE(i + 12);
  const cdOff = tail.readUInt32LE(i + 16);
  const count = tail.readUInt16LE(i + 10);
  const cd = await range(cdOff, cdOff + cdSize - 1);
  const entries = new Map();
  let p = 0;
  for (let k = 0; k < count; k++) {
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOff = cd.readUInt32LE(p + 42);
    entries.set(cd.toString("utf8", p + 46, p + 46 + nameLen), { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Yield each line of one zip entry without ever buffering the whole thing. */
async function* entryLines(entry) {
  const head = await range(entry.localOff, entry.localOff + 29);
  const dataOff = entry.localOff + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const body = await range(dataOff, dataOff + entry.compSize - 1, true);
  const stream = entry.method === 8 ? body.pipe(createInflateRaw()) : body;
  yield* createInterface({ input: stream, crlfDelay: Infinity });
}

function splitCsv(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const header = (line) => splitCsv(line.replace(/^﻿/, "").trim());

/**
 * The nth comma-separated field, without allocating an array for the rest.
 *
 * Only for stop_times.txt, whose values are ids, clock times and integers —
 * no quoting, so a comma scan is exact. Called ~40M times across the two
 * passes, where splitCsv would dominate the runtime.
 */
function field(line, idx) {
  let from = 0;
  for (let i = 0; i < idx; i++) {
    from = line.indexOf(",", from) + 1;
    if (from === 0) return "";
  }
  const to = line.indexOf(",", from);
  return to === -1 ? line.slice(from) : line.slice(from, to);
}

/** "25:14:00" → seconds after midnight (GTFS lets a service run past 24h). */
function gtfsSeconds(hms) {
  const p = hms.split(":");
  if (p.length !== 3) return -1;
  const h = +p[0], m = +p[1], s = +p[2];
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return -1;
  return h * 3600 + m * 60 + s;
}

// ---------------- main ----------------

async function main() {
  const routes = JSON.parse(readFileSync(join(ROOT, "data", "gtfs-routes.json"), "utf8"));
  // Which routes can matter, by geography rather than by operator.
  //
  // Filtering on a list of operator names left 43 of the 172 buses on screen
  // frozen: they run for EBS, Connexxion, Qbuzz and Arriva, and adding those
  // names would have pulled four national bus timetables — Groningen to
  // Zeeland — into the repo to reach a few dozen vehicles in Rotterdam. What
  // actually decides whether a trip can appear is whether it calls anywhere
  // near the area the map draws, so that is the test.
  //
  // route_type 2 (heavy rail) is left out on purpose: NS publishes no vehicle
  // positions to OVapi — zero trains in the live feed — so their timetables
  // would be weight nothing could ever draw.
  const KIND_OF = { 0: 0, 1: 1, 3: 2, 4: 4 }; // GTFS route_type → our kind
  const drawable = new Map(); // routeId → [line, kind]
  for (const [id, r] of Object.entries(routes)) {
    const kind = KIND_OF[r[2]];
    if (kind !== undefined) drawable.set(id, [r[1], kind]);
  }

  // The area the live fetcher draws vehicles in (its BBOX), plus 3 km so a
  // service that stops just outside but runs through is still kept. Stop
  // coordinates come from data/gtfs-stops.json, already in this projection.
  const ORIGIN = { lat: 51.92, lon: 4.48 };
  const M_PER_LAT = 110574;
  const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
  const DRAWN = { s: 51.84, w: 4.34, n: 52.0, e: 4.62 };
  const MARGIN = 3000;
  const bx0 = (DRAWN.w - ORIGIN.lon) * M_PER_LON - MARGIN;
  const bx1 = (DRAWN.e - ORIGIN.lon) * M_PER_LON + MARGIN;
  const by0 = (DRAWN.s - ORIGIN.lat) * M_PER_LAT - MARGIN;
  const by1 = (DRAWN.n - ORIGIN.lat) * M_PER_LAT + MARGIN;
  const stopTable = JSON.parse(readFileSync(join(ROOT, "data", "gtfs-stops.json"), "utf8"));
  const local = new Set();
  for (const [id, s] of Object.entries(stopTable)) {
    if (s.x >= bx0 && s.x <= bx1 && s.y >= by0 && s.y <= by1) local.add(id);
  }
  console.log(`${drawable.size} drawable routes nationally; ${local.size} stops inside the drawn area`);

  const entries = await zipIndex();
  const need = ["trips.txt", "stop_times.txt", "calendar_dates.txt"];
  for (const n of need) if (!entries.has(n)) throw new Error(`${n} missing from the zip`);

  // ---- 0. stop_times.txt, first pass → which trips call in the area ----
  // A whole extra stream of the 1 GB file. It buys the geographic filter: the
  // alternative is buffering every call of every candidate trip nationally and
  // discarding most of them, which does not fit in memory.
  console.log("streaming stop_times.txt, pass 1 of 2 (which trips come here)…");
  const localTrips = new Set();
  {
    let cols = null;
    let n = 0;
    for await (const line of entryLines(entries.get("stop_times.txt"))) {
      if (!cols) {
        const h = header(line);
        cols = { t: h.indexOf("trip_id"), s: h.indexOf("stop_id") };
        if (cols.t < 0 || cols.s < 0) throw new Error("stop_times.txt is missing required columns");
        continue;
      }
      if (!line) continue;
      if (++n % 5_000_000 === 0) console.log(`    ${(n / 1e6).toFixed(0)}M rows scanned, ${localTrips.size} trips so far`);
      // 19M rows: read the two fields by scanning commas rather than paying
      // for a full CSV split per row. stop_times carries no quoted values.
      const tripId = field(line, cols.t);
      if (!tripId || localTrips.has(tripId)) continue;
      if (local.has(field(line, cols.s))) localTrips.add(tripId);
    }
    console.log(`  ${(n / 1e6).toFixed(1)}M rows → ${localTrips.size} trips call inside the area`);
  }
  if (!localTrips.size) throw new Error("no trips call inside the drawn area — check data/gtfs-stops.json");

  // ---- 1. trips.txt → the in-scope trips and their service days ----
  console.log("streaming trips.txt…");
  const trips = new Map(); // tripId → { line, kind, service, headsign }
  const services = new Set();
  {
    let cols = null;
    let n = 0;
    for await (const line of entryLines(entries.get("trips.txt"))) {
      if (!cols) {
        const h = header(line);
        cols = { r: h.indexOf("route_id"), s: h.indexOf("service_id"), t: h.indexOf("trip_id"), hs: h.indexOf("trip_headsign") };
        if (cols.r < 0 || cols.s < 0 || cols.t < 0) throw new Error("trips.txt is missing required columns");
        continue;
      }
      if (!line) continue;
      n++;
      // cheap rejects before paying for a full CSV split: most trips never
      // come near Rotterdam, and most of those that do are not drawable
      if (!localTrips.has(field(line, cols.t))) continue;
      const f = splitCsv(line);
      const w = drawable.get(f[cols.r]);
      if (!w) continue;
      trips.set(f[cols.t], { line: w[0], kind: w[1], service: f[cols.s], headsign: cols.hs >= 0 ? f[cols.hs] : "" });
      services.add(f[cols.s]);
    }
    console.log(`  ${n} trips nationally → ${trips.size} in-scope trips, ${services.size} service ids`);
  }
  if (!trips.size) throw new Error("no drawable trips call in the area — check data/gtfs-routes.json");

  // ---- 2. calendar_dates.txt → which dates each service runs ----
  console.log("streaming calendar_dates.txt…");
  const serviceDates = new Map(); // service → Set(YYYYMMDD)
  {
    let cols = null;
    for await (const line of entryLines(entries.get("calendar_dates.txt"))) {
      if (!cols) {
        const h = header(line);
        cols = { s: h.indexOf("service_id"), d: h.indexOf("date"), e: h.indexOf("exception_type") };
        continue;
      }
      if (!line) continue;
      const f = splitCsv(line);
      if (!services.has(f[cols.s])) continue;
      if (cols.e >= 0 && f[cols.e] !== "1") continue; // 2 = removed
      let set = serviceDates.get(f[cols.s]);
      if (!set) serviceDates.set(f[cols.s], (set = new Set()));
      set.add(f[cols.d]);
    }
    const days = new Set();
    for (const s of serviceDates.values()) for (const d of s) days.add(d);
    console.log(`  ${serviceDates.size} services span ${days.size} calendar dates`);
  }

  // ---- 3. stop_times.txt, second pass → the calls themselves ----
  console.log("streaming stop_times.txt, pass 2 of 2 (the calls)…");
  const calls = new Map(); // tripId → [{ seq, stop, sec }]
  {
    let cols = null;
    let n = 0;
    let kept = 0;
    for await (const line of entryLines(entries.get("stop_times.txt"))) {
      if (!cols) {
        const h = header(line);
        cols = {
          t: h.indexOf("trip_id"), a: h.indexOf("arrival_time"), d: h.indexOf("departure_time"),
          s: h.indexOf("stop_id"), q: h.indexOf("stop_sequence"),
        };
        if (cols.t < 0 || cols.s < 0 || cols.q < 0) throw new Error("stop_times.txt is missing required columns");
        continue;
      }
      if (!line) continue;
      if (++n % 5_000_000 === 0) console.log(`    ${(n / 1e6).toFixed(0)}M rows scanned, ${kept} kept`);
      // test the trip before paying for a full CSV split of the row
      const tripId = field(line, cols.t);
      if (!trips.has(tripId)) continue;
      const f = splitCsv(line);
      const sec = gtfsSeconds(f[cols.d] || f[cols.a] || "");
      if (sec < 0) continue;
      let list = calls.get(tripId);
      if (!list) calls.set(tripId, (list = []));
      list.push({ seq: +f[cols.q], stop: f[cols.s], sec });
      kept++;
    }
    console.log(`  ${(n / 1e6).toFixed(1)}M stop_times scanned → ${kept} calls across ${calls.size} trips`);
  }
  if (!calls.size) throw new Error("no stop_times matched — trip_id column assumption may be wrong");

  // ---- 4. pack ----
  // Strings are interned; every trip stores its ordered calls as
  // (stopIdx u16, sec u32). Service dates become a per-trip date-set index.
  const lineNames = [];
  const lineIdx = new Map();
  const stopIds = [];
  const stopIdx = new Map();
  const headsigns = [];
  const headIdx = new Map();
  const dateSets = [];
  const dateSetIdx = new Map();
  const intern = (arr, map, v) => {
    let i = map.get(v);
    if (i === undefined) { i = arr.length; arr.push(v); map.set(v, i); }
    return i;
  };

  const packed = [];
  for (const [tripId, list] of calls) {
    const meta = trips.get(tripId);
    list.sort((a, b) => a.seq - b.seq);
    const dates = [...(serviceDates.get(meta.service) ?? [])].sort();
    if (!dates.length) continue; // a service that never runs is not a departure
    const key = dates.join(",");
    let dsi = dateSetIdx.get(key);
    if (dsi === undefined) { dsi = dateSets.length; dateSets.push(dates); dateSetIdx.set(key, dsi); }
    packed.push({
      tripId,
      line: intern(lineNames, lineIdx, meta.line ?? ""),
      kind: meta.kind,
      head: intern(headsigns, headIdx, meta.headsign ?? ""),
      dates: dsi,
      // seconds are stored in 2-second units so a call fits a u16 (max 36 h,
      // enough for GTFS's past-midnight times) — timetables are published to
      // the minute, so this loses nothing and saves ~1.4 MB
      calls: list.map((c) => [intern(stopIds, stopIdx, c.stop), Math.round(c.sec / 2)]),
    });
  }
  console.log(`  packing ${packed.length} trips, ${stopIds.length} stops, ${dateSets.length} date sets`);

  const chunks = [];
  const push = (b) => chunks.push(b);
  const u8 = (v) => { const b = Buffer.alloc(1); b.writeUInt8(v); push(b); };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); push(b); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); push(b); };
  const str = (s) => { const b = Buffer.from(s, "utf8"); u16(b.length); push(b); };
  const strList = (arr) => { u32(arr.length); for (const s of arr) str(s); };

  push(Buffer.from("RTTT", "ascii"));
  u16(1);
  strList(lineNames);
  strList(stopIds);
  strList(headsigns);
  u32(dateSets.length);
  for (const d of dateSets) { u32(d.length); for (const s of d) u32(+s); }
  u32(packed.length);
  for (const t of packed) {
    str(t.tripId);
    u16(t.line);
    u8(t.kind);
    u16(t.head);
    u16(t.dates);
    u16(t.calls.length);
    for (const [si, half] of t.calls) { u16(si); u16(half); }
  }
  const buf = Buffer.concat(chunks);
  writeFileSync(OUT, buf);
  console.log(`timetable → ${OUT} (${(buf.length / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
