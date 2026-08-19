#!/usr/bin/env node
// Live city state, one compact snapshot: real traffic flows (NDW), open
// bascule bridges (NDW situation feed), public-transport vehicle positions
// (OVapi GTFS-RT), Maas water level (Rijkswaterstaat), weather (Buienradar)
// and air quality (Luchtmeetnet).
//
//   node scripts/fetch-live.mjs [--out path]     (npm run fetch-live)
//
// Writes public/data/live/live.json by default. Designed to run every few
// minutes from .github/workflows/live-data.yml (which publishes to the `live`
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

// GTFS route_type → our kind: 0 tram, 1 metro, 2 bus, 3 train
const KIND = { 0: 0, 1: 1, 3: 2, 2: 3 };

async function fetchVehicles() {
  const routes = JSON.parse(readFileSync(join(ROOT, "data", "gtfs-routes.json"), "utf8"));
  const buf = await getBuf("https://gtfs.ovapi.nl/nl/vehiclePositions.pb");
  const nowSec = Date.now() / 1000;
  const v = [];
  for (const ent of pbFields(buf)) {
    if (ent.field !== 2 || ent.wt !== 2) continue;
    for (const e of pbFields(buf, ent.off, ent.off + ent.len)) {
      if (e.field !== 4 || e.wt !== 2) continue; // VehiclePosition
      let lat = null, lon = null, bearing = 0, routeId = "", ts = 0;
      for (const f of pbFields(buf, e.off, e.off + e.len)) {
        if (f.field === 2 && f.wt === 2) {
          for (const p of pbFields(buf, f.off, f.off + f.len)) {
            if (p.field === 1 && p.wt === 5) lat = buf.readFloatLE(p.off);
            if (p.field === 2 && p.wt === 5) lon = buf.readFloatLE(p.off);
            if (p.field === 3 && p.wt === 5) bearing = buf.readFloatLE(p.off);
          }
        }
        if (f.field === 1 && f.wt === 2) {
          for (const t of pbFields(buf, f.off, f.off + f.len)) {
            if (t.field === 5 && t.wt === 2) routeId = buf.toString("utf8", t.off, t.off + t.len);
          }
        }
        if (f.field === 5 && f.wt === 0) ts = Number(f.varint);
      }
      if (lat === null || !inBbox(lat, lon)) continue;
      if (ts && nowSec - ts > 240) continue; // stale fix
      const r = routes[routeId];
      const kind = r ? KIND[r[2]] : undefined;
      if (kind === undefined) continue;
      v.push([px(lon), py(lat), kind, Math.round(bearing), r[1] ?? ""]);
    }
  }
  return { t: new Date().toISOString(), v };
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
  const out = { v: 1, t: new Date().toISOString() };
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
    ["vehicles", fetchVehicles],
    ["water", fetchWater],
    ["weather", fetchWeather],
    ["air", fetchAir],
  ];
  let ok = 0;
  for (const [key, fn] of feeds) {
    try {
      const res = await fn();
      if (key !== "situations") out[key] = res;
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
