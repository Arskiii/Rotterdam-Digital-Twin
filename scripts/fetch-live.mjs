#!/usr/bin/env node
// Live city state, one compact snapshot: real traffic flows (NDW), open
// bascule bridges (NDW situation feed), public-transport vehicle positions
// (OVapi GTFS-RT), Maas water level (Rijkswaterstaat), weather (Buienradar)
// and air quality (Luchtmeetnet).
//
//   node scripts/fetch-live.mjs [--out path]     (npm run fetch-live)
//
// Writes public/data/live/live.json by default. Designed to run every few
// minutes from .github/workflows/deploy.yml (which publishes to the `live`
// branch for the deployed app) and on demand locally. Each feed fails soft:
// a broken source drops its section, everything else still updates.
//
// Behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1 (the npm script sets it).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : join(ROOT, "public", "data", "live", "live.json");

const BBOX = { s: 51.84, w: 4.34, n: 52.0, e: 4.62 };
const ORIGIN = { lat: 51.92, lon: 4.48 };
const M_PER_LAT = 110574;
const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const px = (lon) => +(((lon - ORIGIN.lon) * M_PER_LON).toFixed(1));
const py = (lat) => +(((lat - ORIGIN.lat) * M_PER_LAT).toFixed(1));
const inBbox = (lat, lon) => lat > BBOX.s && lat < BBOX.n && lon > BBOX.w && lon < BBOX.e;

const UA = { "User-Agent": "rotterdam-intelligence-platform/1.0 (research; contact via github)" };
const getBuf = async (url) => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const getJson = async (url) => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};
const rx = (s, re) => s.match(re)?.[1] ?? null;

/** Iterate <tag …>…</tag> blocks in an XML string. */
function* blocks(xml, tag) {
  const close = `</${tag}>`;
  let from = 0;
  for (;;) {
    const start = xml.indexOf(`<${tag}`, from);
    if (start === -1) return;
    const end = xml.indexOf(close, start);
    if (end === -1) return;
    yield xml.slice(start, end + close.length);
    from = end + close.length;
  }
}

// ---------------- NL time-of-day minutes for a Date ----------------
function todMinNL(date) {
  const parts = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  return +parts.find((p) => p.type === "hour").value * 60 + +parts.find((p) => p.type === "minute").value;
}

// ---------------- 1. live traffic flows (NDW trafficspeed) ----------------
async function fetchTraffic() {
  const ndw = JSON.parse(readFileSync(join(ROOT, "public", "data", "ndw.json"), "utf8"));
  const siteToStation = new Map();
  ndw.stations.forEach((st, i) => {
    for (const id of st.ids ?? []) siteToStation.set(id, i);
  });
  if (!siteToStation.size) throw new Error("ndw.json has no station ids — rerun: npm run fetch-ndw");

  const xml = gunzipSync(await getBuf("https://opendata.ndw.nu/trafficspeed.xml.gz")).toString("utf8");
  const pubTime = rx(xml, /<publicationTime>([^<]+)</);
  const flow = new Float64Array(ndw.stations.length);
  const speedSum = new Float64Array(ndw.stations.length);
  const speedN = new Float64Array(ndw.stations.length);
  for (const rec of blocks(xml, "siteMeasurements")) {
    const id = rx(rec, /measurementSiteReference id="([^"]+)"/);
    const si = id ? siteToStation.get(id) : undefined;
    if (si === undefined) continue;
    for (const m of rec.matchAll(/<vehicleFlowRate>([\d.\-]+)<\/vehicleFlowRate>/g)) {
      const v = parseFloat(m[1]);
      if (v >= 0) flow[si] += v;
    }
    for (const m of rec.matchAll(/<speed>([\d.\-]+)<\/speed>/g)) {
      const v = parseFloat(m[1]);
      if (v > 0 && v < 200) { speedSum[si] += v; speedN[si]++; }
    }
  }
  const s = [];
  for (let i = 0; i < ndw.stations.length; i++) {
    if (flow[i] > 0) s.push([i, Math.round(flow[i]), speedN[i] ? +(speedSum[i] / speedN[i]).toFixed(1) : 0]);
  }
  const t = pubTime ?? new Date().toISOString();
  return { t, todMin: todMinNL(new Date(t)), s };
}

// ---------------- 2. open bascule bridges (NDW actueel_beeld) ----------------
function loadGraphForBridges() {
  const buf = readFileSync(join(ROOT, "public", "data", "graph.bin"));
  let pos = 0;
  const u8 = () => buf.readUInt8(pos++);
  const u16 = () => { const v = buf.readUInt16LE(pos); pos += 2; return v; };
  const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
  const f32 = () => { const v = buf.readFloatLE(pos); pos += 4; return v; };
  if (u32() !== 0x474d5452 || u32() !== 4) throw new Error("graph.bin v4 expected");
  const nodeCount = u32();
  pos += nodeCount * 9;
  // note: u32() advances pos, so read counts BEFORE compounding into pos
  const sigCount = u32();
  pos += sigCount * 8;
  const auxCount = u32();
  pos += auxCount * 12;
  const clCount = u32();
  pos += clCount * 12;
  const eCount = u32();
  const edges = [];
  for (let i = 0; i < eCount; i++) {
    pos += 8;
    const cls = u8();
    const flags = u8();
    pos += 2 + 4;
    const geoOff = u32();
    const geoN = u16();
    pos += 1; // district
    const modeMask = u8();
    const nameIdx = u16();
    edges.push({ cls, flags, geoOff, geoN, modeMask, nameIdx });
  }
  const nameCount = u16();
  const names = [];
  for (let i = 0; i < nameCount; i++) {
    const len = u8();
    names.push(buf.toString("utf8", pos, pos + len));
    pos += len;
  }
  const geoCount = u32();
  const geo = new Float32Array(geoCount * 2);
  for (let i = 0; i < geoCount * 2; i++) geo[i] = f32();
  return { edges, names, geo };
}

/** Car edges near a projected point: [{e, d, bridge, nameIdx}] sorted by distance. */
function edgesNear(g, x, y, radius) {
  const hits = [];
  for (let e = 0; e < g.edges.length; e++) {
    const ed = g.edges[e];
    if (!(ed.modeMask & 1)) continue; // car edges only
    let best = Infinity;
    for (let k = 0; k < ed.geoN; k++) {
      const d = Math.hypot(g.geo[(ed.geoOff + k) * 2] - x, g.geo[(ed.geoOff + k) * 2 + 1] - y);
      if (d < best) best = d;
    }
    if (best > radius) continue;
    hits.push({ e, d: best, bridge: (ed.flags & 4) !== 0, nameIdx: ed.nameIdx });
  }
  return hits.sort((a, b) => a.d - b.d);
}

// situationRecord type → incident kind:
// 0 accident, 1 obstruction, 2 jam, 3 road closure, 4 roadworks / lane closure
function recordKind(rec) {
  if (rec.includes('xsi:type="sit:Accident"')) return 0;
  if (rec.includes('xsi:type="sit:VehicleObstruction"') || rec.includes('xsi:type="sit:GeneralObstruction"')) return 1;
  if (rec.includes('xsi:type="sit:AbnormalTraffic"')) return 2;
  if (rec.includes("<sit:roadOrCarriagewayOrLaneManagementType>roadClosed<")) return 3;
  if (
    rec.includes('xsi:type="sit:MaintenanceWorks"') ||
    rec.includes('xsi:type="sit:ConstructionWorks"') ||
    rec.includes("<sit:roadOrCarriagewayOrLaneManagementType>laneClosures<") ||
    rec.includes("<sit:roadOrCarriagewayOrLaneManagementType>carriagewayClosures<") ||
    rec.includes("<sit:roadOrCarriagewayOrLaneManagementType>narrowLanes<")
  ) {
    return 4;
  }
  return -1;
}

async function fetchSituations() {
  const xml = gunzipSync(await getBuf("https://opendata.ndw.nu/actueel_beeld.xml.gz")).toString("utf8");
  const now = Date.now();
  const openBridges = [];
  const rawIncidents = [];
  for (const rec of blocks(xml, "sit:situationRecord")) {
    const isBridge = rec.includes("<sit:generalNetworkManagementType>bridgeSwingInOperation<");
    const kind = recordKind(rec);
    if (!isBridge && kind < 0) continue;
    const lat = parseFloat(rx(rec, /<loc:latitude>([\d.\-]+)</) ?? "NaN");
    const lon = parseFloat(rx(rec, /<loc:longitude>([\d.\-]+)</) ?? "NaN");
    if (!inBbox(lat, lon)) continue;
    if (rec.includes("<sit:probabilityOfOccurrence>riskOf<")) continue; // planned, not happening
    const start = Date.parse(rx(rec, /<com:overallStartTime>([^<]+)</) ?? "");
    const endRaw = rx(rec, /<com:overallEndTime>([^<]+)</);
    const end = endRaw ? Date.parse(endRaw) : now + 10 * 60_000;
    if (!(start <= now + 60_000 && end >= now - 60_000)) continue; // active window only
    if (isBridge) openBridges.push({ lat, lon, until: new Date(end).toISOString() });
    else rawIncidents.push({ lat, lon, kind, until: new Date(end).toISOString() });
  }
  if (!openBridges.length && !rawIncidents.length) return { bridges: [], incidents: [] };

  const g = loadGraphForBridges();
  const bridges = [];
  for (const b of openBridges) {
    const x = px(b.lon), y = py(b.lat);
    // bascule spans are bridge-flagged; fall back to nearest edges when tagging is missing
    let use = edgesNear(g, x, y, 130).filter((h) => h.bridge);
    if (!use.length) use = edgesNear(g, x, y, 60);
    if (!use.length) continue;
    use = use.slice(0, 10);
    const nameVotes = new Map();
    for (const h of use) nameVotes.set(h.nameIdx, (nameVotes.get(h.nameIdx) ?? 0) + 1);
    const topName = [...nameVotes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    bridges.push({
      name: g.names[topName] ?? "BASCULE BRIDGE",
      x, y,
      edges: use.map((h) => h.e),
      until: b.until,
    });
  }
  const incidents = [];
  for (const inc of rawIncidents.slice(0, 90)) {
    const x = px(inc.lon), y = py(inc.lat);
    const near = edgesNear(g, x, y, 60);
    incidents.push({
      x, y,
      kind: inc.kind,
      edge: near.length ? near[0].e : -1,
      name: near.length ? g.names[near[0].nameIdx] ?? "" : "",
      until: inc.until,
    });
  }
  return { bridges, incidents };
}

// ---------------- 3. transit vehicle positions (OVapi GTFS-RT) ----------------
function* pbFields(b, start = 0, end = b.length) {
  let p = start;
  while (p < end) {
    let shift = 0n, key = 0n;
    for (;;) { const byte = b[p++]; key |= BigInt(byte & 0x7f) << shift; if (!(byte & 0x80)) break; shift += 7n; }
    const field = Number(key >> 3n), wt = Number(key & 7n);
    if (wt === 0) { let v = 0n; shift = 0n; for (;;) { const byte = b[p++]; v |= BigInt(byte & 0x7f) << shift; if (!(byte & 0x80)) break; shift += 7n; } yield { field, wt, varint: v }; }
    else if (wt === 1) { yield { field, wt, off: p }; p += 8; }
    else if (wt === 2) { let len = 0n; shift = 0n; for (;;) { const byte = b[p++]; len |= BigInt(byte & 0x7f) << shift; if (!(byte & 0x80)) break; shift += 7n; } yield { field, wt, off: p, len: Number(len) }; p += Number(len); }
    else if (wt === 5) { yield { field, wt, off: p }; p += 4; }
    else throw new Error(`protobuf wire type ${wt}`);
  }
}

// GTFS route_type → our kind: 0 tram, 1 metro, 2 bus, 3 train, 4 ferry.
// Ferries matter here in a way they would not in most cities: route_type 4 in
// this bbox is the Waterbus, genuine vessel traffic on the Maas. It is the
// only live shipping the open feeds carry — Dutch AIS is not published openly,
// so cargo movements in the port remain out of reach.
const KIND = { 0: 0, 1: 1, 3: 2, 2: 3, 4: 4 };

// GTFS-RT VehiclePosition.current_status
const STOPPED_AT = 1;

// How fast each kind can physically travel, m/s, indexed by our kind. Not a
// realism target — a sanity bound, used only to catch a projected leg that no
// vehicle of that type could run. RET metro lines B and E do 100 km/h on the
// open sections out to Hoek van Holland and Den Haag, so the metro ceiling is
// genuinely high.
const TOP_SPEED = [22, 28, 25, 45, 20];

/** VehicleDescriptor → its id (the RET fleet number for metros and trams). */
function vehicleId(buf, off, len) {
  for (const d of pbFields(buf, off, off + len)) {
    if (d.field === 1 && d.wt === 2) return buf.toString("utf8", d.off, d.off + d.len);
  }
  return "";
}

/** StopTimeEvent → { delay, time } (both optional in the spec). */
function stopTimeEvent(buf, off, len) {
  let delay = null;
  let time = null;
  for (const a of pbFields(buf, off, off + len)) {
    if (a.field === 1 && a.wt === 0) delay = Number(BigInt.asIntN(64, a.varint));
    if (a.field === 2 && a.wt === 0) time = Number(BigInt.asIntN(64, a.varint));
  }
  return { delay, time };
}

/**
 * Where every tram, metro, bus and train in the coverage area actually is,
 * carrying the identity that makes a vehicle answerable: which line, which
 * trip, which stop it is working toward, and whether it is berthed or moving.
 *
 * OVapi does not populate bearing or speed for rail vehicles (verified: 0 of
 * 24 metros carry either), so neither is read — a synthesised heading would be
 * a fabricated measurement. Direction of travel comes from the stop sequence
 * instead, which is real.
 */
async function fetchVehicles(routes) {
  const buf = await getBuf("https://gtfs.ovapi.nl/nl/vehiclePositions.pb");
  const nowSec = Date.now() / 1000;
  const v = [];
  for (const ent of pbFields(buf)) {
    if (ent.field !== 2 || ent.wt !== 2) continue;
    for (const e of pbFields(buf, ent.off, ent.off + ent.len)) {
      if (e.field !== 4 || e.wt !== 2) continue; // VehiclePosition
      let lat = null, lon = null, routeId = "", tripId = "", ts = 0;
      let seq = -1, status = -1, stopId = "", vid = "";
      for (const f of pbFields(buf, e.off, e.off + e.len)) {
        if (f.field === 1 && f.wt === 2) {
          for (const t of pbFields(buf, f.off, f.off + f.len)) {
            if (t.field === 1 && t.wt === 2) tripId = buf.toString("utf8", t.off, t.off + t.len);
            if (t.field === 5 && t.wt === 2) routeId = buf.toString("utf8", t.off, t.off + t.len);
          }
        }
        if (f.field === 2 && f.wt === 2) {
          for (const p of pbFields(buf, f.off, f.off + f.len)) {
            if (p.field === 1 && p.wt === 5) lat = buf.readFloatLE(p.off);
            if (p.field === 2 && p.wt === 5) lon = buf.readFloatLE(p.off);
          }
        }
        if (f.field === 3 && f.wt === 0) seq = Number(f.varint);
        if (f.field === 4 && f.wt === 0) status = Number(f.varint);
        if (f.field === 5 && f.wt === 0) ts = Number(f.varint);
        if (f.field === 7 && f.wt === 2) stopId = buf.toString("utf8", f.off, f.off + f.len);
        if (f.field === 8 && f.wt === 2) vid = vehicleId(buf, f.off, f.len);
      }
      if (lat === null || !inBbox(lat, lon)) continue;
      if (ts && nowSec - ts > 240) continue; // stale fix
      const r = routes[routeId];
      const kind = r ? KIND[r[2]] : undefined;
      if (kind === undefined) continue;
      // [x, y, kind, line, tripId, stopSeq, berthed, vehicleId, fixAgeSec]
      v.push([
        px(lon), py(lat), kind, r[1] ?? "", tripId, seq,
        status === STOPPED_AT ? 1 : 0, vid,
        ts ? Math.round(nowSec - ts) : -1,
      ]);
    }
  }
  return { t: new Date().toISOString(), v };
}

// ---------------- the RET timetable (data/ret-timetable.bin) ----------------

let timetableCache = null;

/** Parse the packed timetable once per process. */
function loadTimetable() {
  if (timetableCache) return timetableCache;
  const buf = readFileSync(join(ROOT, "data", "ret-timetable.bin"));
  let pos = 0;
  const u8 = () => buf.readUInt8(pos++);
  const u16 = () => { const v = buf.readUInt16LE(pos); pos += 2; return v; };
  const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
  const str = () => { const n = u16(); const s = buf.toString("utf8", pos, pos + n); pos += n; return s; };
  const strList = () => { const n = u32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = str(); return a; };

  if (buf.toString("ascii", 0, 4) !== "RTTT") throw new Error("ret-timetable.bin: bad magic");
  pos = 4;
  if (u16() !== 1) throw new Error("ret-timetable.bin: unsupported version");
  const lines = strList();
  const stops = strList();
  const headsigns = strList();
  const dateSetCount = u32();
  const dateSets = new Array(dateSetCount);
  for (let i = 0; i < dateSetCount; i++) {
    const n = u32();
    const s = new Set();
    for (let k = 0; k < n; k++) s.add(u32());
    dateSets[i] = s;
  }
  const tripCount = u32();
  const trips = new Array(tripCount);
  for (let i = 0; i < tripCount; i++) {
    const id = str();
    const line = u16();
    const kind = u8();
    const head = u16();
    const dates = u16();
    const n = u16();
    const callStop = new Uint16Array(n);
    const callSec = new Uint16Array(n);
    for (let k = 0; k < n; k++) { callStop[k] = u16(); callSec[k] = u16(); }
    trips[i] = { id, line, kind, head, dates, callStop, callSec };
  }
  timetableCache = { lines, stops, headsigns, dateSets, trips };
  return timetableCache;
}

/** Offset of a timezone from UTC, in ms, at a given instant. */
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime();
}

/** Unix seconds at 00:00 Europe/Amsterdam on a YYYYMMDD service date. */
function serviceMidnight(yyyymmdd) {
  const y = Math.floor(yyyymmdd / 10000);
  const m = Math.floor(yyyymmdd / 100) % 100;
  const d = yyyymmdd % 100;
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // one correction pass settles it except exactly at a DST boundary, where
  // the timetable's own local clock is ambiguous anyway
  const off = tzOffsetMs(new Date(guess), "Europe/Amsterdam");
  return (guess - off) / 1000;
}

/** YYYYMMDD (as a number) for a date, in Amsterdam local terms. */
function serviceDateNum(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return +`${p.year}${p.month}${p.day}`;
}

/**
 * Live running delay per trip, from GTFS-RT tripUpdates.
 *
 * OVapi publishes stop updates for calls a trip has ALREADY made, so the last
 * row is the freshest read on how late the vehicle is running. That delay is
 * what gets carried forward onto its remaining scheduled calls — the same
 * arithmetic a platform display does.
 */
async function fetchTripDelays() {
  const buf = await getBuf("https://gtfs.ovapi.nl/nl/tripUpdates.pb");
  const delays = new Map(); // tripId → { delay, cancelled }
  for (const ent of pbFields(buf)) {
    if (ent.field !== 2 || ent.wt !== 2) continue;
    for (const e of pbFields(buf, ent.off, ent.off + ent.len)) {
      if (e.field !== 3 || e.wt !== 2) continue; // TripUpdate
      let tripId = "";
      let cancelled = false;
      let delay = null;
      for (const f of pbFields(buf, e.off, e.off + e.len)) {
        if (f.field === 1 && f.wt === 2) {
          for (const t of pbFields(buf, f.off, f.off + f.len)) {
            if (t.field === 1 && t.wt === 2) tripId = buf.toString("utf8", t.off, t.off + t.len);
            if (t.field === 6 && t.wt === 0) cancelled = Number(t.varint) === 3; // CANCELED
          }
        }
        if (f.field === 2 && f.wt === 2) {
          let arr = null, dep = null;
          for (const s of pbFields(buf, f.off, f.off + f.len)) {
            if (s.field === 2 && s.wt === 2) arr = stopTimeEvent(buf, s.off, s.len);
            if (s.field === 3 && s.wt === 2) dep = stopTimeEvent(buf, s.off, s.len);
          }
          const d = dep?.delay ?? arr?.delay;
          if (d !== null && d !== undefined) delay = d; // keep the last one seen
        }
      }
      if (tripId) delays.set(tripId, { delay: delay ?? 0, live: delay !== null, cancelled });
    }
  }
  return delays;
}

/**
 * The departure board: for every RET metro and tram station, the next few
 * services with a predicted time.
 *
 * scheduled call (timetable) + running delay (GTFS-RT) = when it actually
 * turns up. Trips with no RT row fall back to the schedule and are flagged so
 * the UI can say so rather than implying a measurement it does not have.
 *
 * Buses are left out on purpose: they would multiply the snapshot several
 * times over for a fleet the platform does not model.
 */
async function fetchDepartures() {
  const tt = loadTimetable();
  const stopTable = JSON.parse(readFileSync(join(ROOT, "data", "gtfs-stops.json"), "utf8"));
  const delays = await fetchTripDelays();
  const nowSec = Math.floor(Date.now() / 1000);
  const HORIZON = 45 * 60;
  const PER_STOP = 6;
  // Waypoints per vehicle for the client to move along between position fixes.
  // Six calls is a few minutes of runway — enough to keep a vehicle moving
  // until the next snapshot lands, without carrying a whole trip.
  const PLAN_STOPS = 6;
  const PLAN_HORIZON = 20 * 60;

  // A service day runs past midnight, so yesterday's late trips are still
  // arriving; both dates are scanned against their own local midnight.
  const now = new Date();
  const days = [
    serviceDateNum(new Date(now.getTime() - 86_400_000)),
    serviceDateNum(now),
  ].map((d) => ({ date: d, base: serviceMidnight(d) }));

  /** stationKey → { name, x, y, rows } */
  const stations = new Map();
  /** tripId → [[x, y, secondsFromSnapshot], …] — where this trip is due next */
  const plans = {};
  const stationOf = (gtfsStopId) => {
    const s = stopTable[gtfsStopId];
    if (!s) return null;
    const parent = s.p && stopTable[s.p] ? s.p : null;
    const key = parent ?? gtfsStopId;
    let st = stations.get(key);
    if (!st) {
      const src = parent ? stopTable[parent] : s;
      stations.set(key, (st = { name: src.n || s.n, x: src.x, y: src.y, rows: [] }));
    }
    return st;
  };

  let liveTrips = 0;
  for (const trip of tt.trips) {
    const rt = delays.get(trip.id);
    if (rt?.cancelled) continue;
    const set = tt.dateSets[trip.dates];
    const shift = rt?.delay ?? 0;
    for (const day of days) {
      if (!set.has(day.date)) continue;
      // whole-trip window check before touching individual calls
      const n = trip.callSec.length;
      if (!n) continue;
      const firstAt = day.base + trip.callSec[0] * 2 + shift;
      const lastAt = day.base + trip.callSec[n - 1] * 2 + shift;
      if (lastAt < nowSec - 60 || firstAt > nowSec + HORIZON) continue;
      if (rt?.live) liveTrips++;
      const dest = tt.headsigns[trip.head] || "";

      // The path this trip is scheduled to take from here, shifted by the delay
      // it is actually running. A vehicle's position between fixes is then a
      // projection of the published timetable onto measured lateness — the same
      // arithmetic as the departure board, not invented motion.
      const wp = [];
      for (let k = 0; k < n && wp.length < PLAN_STOPS; k++) {
        const at = day.base + trip.callSec[k] * 2 + shift;
        if (at < nowSec) continue; // already called there
        if (at > nowSec + PLAN_HORIZON) break;
        const stop = stopTable[tt.stops[trip.callStop[k]]];
        if (!stop) continue;
        wp.push([stop.x, stop.y, Math.round(at - nowSec)]);
      }
      if (wp.length) plans[trip.id] = wp;

      for (let k = 0; k < n; k++) {
        if (k === n - 1) continue; // nobody boards at the terminus
        const at = day.base + trip.callSec[k] * 2 + shift;
        if (at < nowSec - 60 || at > nowSec + HORIZON) continue;
        const st = stationOf(tt.stops[trip.callStop[k]]);
        if (!st) continue;
        // [line, kind, destination, secondsUntil, delaySec, isLive, tripId]
        st.rows.push([
          tt.lines[trip.line], trip.kind, dest,
          at - nowSec, shift, rt?.live ? 1 : 0, trip.id,
        ]);
      }
      break; // a trip only runs once across the two candidate days
    }
  }

  const stops = {};
  const dep = {};
  for (const [key, st] of stations) {
    if (!st.rows.length) continue;
    st.rows.sort((a, b) => a[3] - b[3]);
    stops[key] = [st.name, st.x, st.y];
    dep[key] = st.rows.slice(0, PER_STOP);
  }
  // planT, not t: the waypoint offsets are counted from the instant the
  // timetable was walked, and the walk itself takes a second or two
  return { t: new Date().toISOString(), planT: nowSec, stops, dep, liveTrips, plans };
}

// ---------------- 4. Maas water level (Rijkswaterstaat, Boompjes gauge) ----------------
async function fetchWater() {
  const end = new Date();
  const begin = new Date(end.getTime() - 90 * 60_000);
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, ".000+00:00");
  const res = await fetch("https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen", {
    method: "POST",
    headers: { ...UA, "Content-Type": "application/json", "X-API-KEY": "rotterdam-digital-twin" },
    body: JSON.stringify({
      AquoPlusWaarnemingMetadata: { AquoMetadata: { Compartiment: { Code: "OW" }, Grootheid: { Code: "WATHTE" } } },
      Locatie: { Code: "rotterdam.nieuwemaas.boompjes" },
      Periode: { Begindatumtijd: iso(begin), Einddatumtijd: iso(end) },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 204) throw new Error("RWS: no data in window");
  if (!res.ok) throw new Error(`RWS: HTTP ${res.status}`);
  const j = await res.json();
  const m = (j.WaarnemingenLijst?.[0]?.MetingenLijst ?? [])
    .map((x) => ({ t: Date.parse(x.Tijdstip), cm: x.Meetwaarde?.Waarde_Numeriek }))
    .filter((x) => Number.isFinite(x.cm) && Math.abs(x.cm) < 600)
    .sort((a, b) => a.t - b.t);
  if (!m.length) throw new Error("RWS: empty series");
  const last = m[m.length - 1];
  const first = m[0];
  const hours = (last.t - first.t) / 3_600_000;
  return {
    station: "Boompjes",
    cm: Math.round(last.cm),
    trend: hours > 0.2 ? +((last.cm - first.cm) / hours).toFixed(1) : 0, // cm/h
    t: new Date(last.t).toISOString(),
  };
}

// ---------------- 5. weather (Buienradar, Meetstation Rotterdam) ----------------
async function fetchWeather() {
  const j = await getJson("https://data.buienradar.nl/2.0/feed/json");
  const st =
    j.actual?.stationmeasurements?.find((s) => s.stationid === 6344) ??
    j.actual?.stationmeasurements?.find((s) => /rotterdam/i.test(s.stationname ?? ""));
  if (!st) throw new Error("Buienradar: Rotterdam station missing");
  return {
    t: st.timestamp,
    temp: st.temperature ?? null,
    wind: st.windspeed ?? null, // m/s
    dir: st.winddirectiondegrees ?? null,
    gust: st.windgusts ?? null,
    rain: st.precipitation ?? 0, // mm/h
    desc: String(st.weatherdescription ?? "").slice(0, 40),
  };
}

// ---------------- 6. air quality (Luchtmeetnet) ----------------
async function airStations() {
  const cacheFile = join(ROOT, "data", "luchtmeetnet-stations.json");
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
  const list = [];
  for (let page = 1; page <= 8; page++) {
    const j = await getJson(`https://api.luchtmeetnet.nl/open_api/stations?page=${page}&order_by=number`);
    for (const s of j.data ?? []) list.push(s.number);
    if (page >= (j.pagination?.last_page ?? 1)) break;
  }
  const out = [];
  for (const number of list) {
    try {
      const d = (await getJson(`https://api.luchtmeetnet.nl/open_api/stations/${number}`)).data;
      const [lon, lat] = d?.geometry?.coordinates ?? [];
      if (inBbox(lat, lon)) out.push({ number, name: String(d.location ?? number).slice(0, 40), x: px(lon), y: py(lat) });
    } catch {
      /* skip broken station */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

async function fetchAir() {
  const stations = await airStations();
  const s = [];
  for (const st of stations) {
    try {
      const j = await getJson(`https://api.luchtmeetnet.nl/open_api/measurements?station_number=${st.number}&order_by=timestamp_measured&order_direction=desc&page=1`);
      const latest = {};
      for (const m of j.data ?? []) {
        if (latest[m.formula] === undefined && Date.now() - Date.parse(m.timestamp_measured) < 4 * 3_600_000) {
          latest[m.formula] = +(+m.value).toFixed(1);
        }
      }
      if (latest.NO2 !== undefined || latest.PM25 !== undefined) {
        s.push([st.x, st.y, latest.NO2 ?? null, latest.PM25 ?? null, st.name]);
      }
    } catch {
      /* station offline */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!s.length) throw new Error("Luchtmeetnet: no measurements");
  return { t: new Date().toISOString(), s };
}

// ---------------- main ----------------
async function main() {
  const out = { v: 2, t: new Date().toISOString() };
  const routes = JSON.parse(readFileSync(join(ROOT, "data", "gtfs-routes.json"), "utf8"));
  const feeds = [
    ["traffic", fetchTraffic],
    [
      "situations",
      async () => {
        const { bridges, incidents } = await fetchSituations();
        out.bridges = bridges;
        out.incidents = incidents;
        return `${bridges.length} bridges, ${incidents.length} incidents`;
      },
    ],
    ["vehicles", () => fetchVehicles(routes)],
    [
      "departures",
      async () => {
        const d = await fetchDepartures();
        const { plans, planT, ...rest } = d;
        out.departures = rest;
        // The plans belong with the vehicles they steer, and vehicles is
        // fetched first, so attach rather than nest — but rebase the offsets
        // onto the vehicle snapshot's clock first. The client then has one
        // timebase for both the fix age and the schedule, instead of two that
        // drift apart by however long the timetable walk took.
        if (out.vehicles) {
          const shift = planT - Math.round(Date.parse(out.vehicles.t) / 1000);
          if (shift) for (const id in plans) for (const w of plans[id]) w[2] += shift;
          // A first leg that would need an impossible speed is proof the trip
          // is running later than the operator's delay admits — the vehicle is
          // measurably still 3 km short of a call it is supposedly due at in a
          // minute. Believing the schedule there would fling it across the map
          // at 137 km/h, so the whole plan slides later instead: the route and
          // its relative timings are kept, the vehicle is simply later than
          // claimed. The next snapshot re-anchors it either way.
          const lagged = new Set();
          for (const v of out.vehicles.v) {
            const p = plans[v[4]];
            if (!p || lagged.has(v[4])) continue; // one shift per trip
            lagged.add(v[4]);
            const need = Math.hypot(p[0][0] - v[0], p[0][1] - v[1]) / (TOP_SPEED[v[2]] ?? 25);
            const lag = Math.ceil(need - (p[0][2] + (v[8] >= 0 ? v[8] : 0)));
            if (lag > 0) for (const w of p) w[2] += lag;
          }
          out.vehicles.plan = plans;
        }
        const planned = out.vehicles ? Object.keys(out.vehicles.v).filter((i) => plans[out.vehicles.v[i][4]]).length : 0;
        return `${Object.keys(d.stops).length} stations, ${d.liveTrips} live delays, ${planned} vehicles with a path`;
      },
    ],
    ["water", fetchWater],
    ["weather", fetchWeather],
    ["air", fetchAir],
  ];
  let ok = 0;
  for (const [key, fn] of feeds) {
    try {
      const res = await fn();
      if (key !== "situations" && key !== "departures") out[key] = res;
      ok++;
      const n = typeof res === "string" ? res : Array.isArray(res) ? res.length : (res.s?.length ?? res.v?.length ?? "");
      console.log(`  + ${key}${n !== "" ? `: ${n}` : ""}`);
    } catch (err) {
      console.warn(`  ! ${key}: ${err.message ?? err}`);
    }
  }
  if (!ok) throw new Error("every live feed failed — not writing snapshot");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`live snapshot → ${OUT} (${ok}/${feeds.length} feeds)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
