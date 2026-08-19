#!/usr/bin/env node
// Ingest NDW (Nationale Databank Wegverkeersgegevens) open data:
//   - measurement_current.xml.gz  → measurement-site locations (DATEX II)
//   - trafficspeed.xml.gz         → live vehicle flow (veh/h) + speeds per site
//
//   node scripts/fetch-ndw.mjs [--cached]
//
// Filters sites to our coverage bbox, groups directional sites into stations,
// matches each station to the nearest routable edge in graph.bin, and writes
// public/data/ndw.json for the in-app calibration loop.
// Data: NDW open data (opendata.ndw.nu), public domain.

import { createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
mkdirSync(RAW, { recursive: true });

const BBOX = { s: 51.84, w: 4.34, n: 52.0, e: 4.62 };
const ORIGIN = { lat: 51.92, lon: 4.48 };
const M_PER_LAT = 110574;
const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const px = (lon) => (lon - ORIGIN.lon) * M_PER_LON;
const py = (lat) => (lat - ORIGIN.lat) * M_PER_LAT;

async function download(url, file) {
  if (process.argv.includes("--cached") && existsSync(file)) {
    console.log(`= cached ${file}`);
    return;
  }
  console.log(`downloading ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const ws = (await import("node:fs")).createWriteStream(file);
  await new Promise((resolve, reject) => {
    Readable.fromWeb(res.body).pipe(ws).on("finish", resolve).on("error", reject);
  });
}

/** Stream a .xml.gz and invoke onRecord(recordString) for each <tag>…</tag> block. */
async function streamRecords(file, tag, onRecord) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let buf = "";
  const stream = createReadStream(file).pipe(createGunzip());
  for await (const chunk of stream) {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf(close)) !== -1) {
      const start = buf.indexOf(open);
      if (start === -1 || start > idx) {
        buf = buf.slice(idx + close.length);
        continue;
      }
      onRecord(buf.slice(start, idx + close.length));
      buf = buf.slice(idx + close.length);
    }
    // keep the tail (may hold a partial record)
    if (buf.length > 8_000_000) buf = buf.slice(-4_000_000);
  }
}

const rx = (s, re) => {
  const m = s.match(re);
  return m ? m[1] : null;
};

async function main() {
  const sitesGz = join(RAW, "ndw-sites.xml.gz");
  const speedGz = join(RAW, "ndw-speed.xml.gz");
  await download("https://opendata.ndw.nu/measurement_current.xml.gz", sitesGz);
  await download("https://opendata.ndw.nu/trafficspeed.xml.gz", speedGz);

  // ---- 1. measurement sites inside the bbox ----
  const sites = new Map(); // id -> {lat, lon, x, y, name, lanes}
  let scanned = 0;
  await streamRecords(sitesGz, "measurementSiteRecord", (rec) => {
    scanned++;
    const lat = parseFloat(rx(rec, /<latitude>([\d.\-]+)<\/latitude>/) ?? "NaN");
    const lon = parseFloat(rx(rec, /<longitude>([\d.\-]+)<\/longitude>/) ?? "NaN");
    if (!(lat > BBOX.s && lat < BBOX.n && lon > BBOX.w && lon < BBOX.e)) return;
    const id = rx(rec, /measurementSiteRecord id="([^"]+)"/);
    if (!id) return;
    sites.set(id, {
      lat,
      lon,
      x: px(lon),
      y: py(lat),
      name: rx(rec, /<measurementSiteName>.*?<value[^>]*>([^<]+)<\/value>/s) ?? "",
      lanes: parseInt(rx(rec, /<measurementSiteNumberOfLanes>(\d+)</) ?? "1", 10),
    });
  });
  console.log(`site table: ${scanned} records scanned, ${sites.size} inside bbox`);

  // ---- 2. live flows/speeds for those sites ----
  let publicationTime = null;
  const speedHead = await new Promise((resolve) => {
    let head = "";
    const s = createReadStream(speedGz).pipe(createGunzip());
    s.on("data", (c) => {
      head += c.toString("utf8");
      if (head.length > 4000) {
        s.destroy();
        resolve(head);
      }
    });
    s.on("end", () => resolve(head));
  });
  publicationTime = rx(speedHead, /<publicationTime>([^<]+)</);
  console.log(`trafficspeed publication: ${publicationTime}`);

  let measured = 0;
  await streamRecords(speedGz, "siteMeasurements", (rec) => {
    const id = rx(rec, /measurementSiteReference id="([^"]+)"/);
    const site = id ? sites.get(id) : null;
    if (!site) return;
    // sum vehicle flows across lanes; flow-weighted mean speed
    let flow = 0;
    let speedW = 0;
    let speedWSum = 0;
    const flowRe = /<vehicleFlowRate>([\d.\-]+)<\/vehicleFlowRate>/g;
    for (const m of rec.matchAll(flowRe)) {
      const v = parseFloat(m[1]);
      if (v >= 0) flow += v;
    }
    const spdRe = /<speed>([\d.\-]+)<\/speed>/g;
    for (const m of rec.matchAll(spdRe)) {
      const v = parseFloat(m[1]);
      if (v > 0 && v < 200) {
        speedW += v;
        speedWSum++;
      }
    }
    site.flow = (site.flow ?? 0) + flow;
    if (speedWSum) site.speed = speedW / speedWSum;
    measured++;
  });
  console.log(`flow records matched to bbox sites: ${measured}`);

  const live = [...sites.values()].filter((s) => (s.flow ?? 0) > 0);
  console.log(`sites with live flow: ${live.length}`);

  // ---- 3. group directional twins into stations (30 m) ----
  const stations = [];
  const used = new Set();
  const arr = live;
  for (let i = 0; i < arr.length; i++) {
    if (used.has(i)) continue;
    const st = { x: arr[i].x, y: arr[i].y, flow: arr[i].flow, speed: arr[i].speed ?? 0, n: 1, lanes: arr[i].lanes, name: arr[i].name };
    used.add(i);
    for (let j = i + 1; j < arr.length; j++) {
      if (used.has(j)) continue;
      if (Math.hypot(arr[j].x - st.x / st.n, arr[j].y - st.y / st.n) < 30) {
        st.x += arr[j].x;
        st.y += arr[j].y;
        st.flow += arr[j].flow;
        st.speed += arr[j].speed ?? 0;
        st.lanes += arr[j].lanes;
        st.n++;
        used.add(j);
      }
    }
    st.x /= st.n;
    st.y /= st.n;
    st.speed /= st.n;
    stations.push(st);
  }
  console.log(`stations after directional grouping: ${stations.length}`);

  // ---- 4. match stations to routable edges (graph.bin v4) ----
  const buf = readFileSync(join(ROOT, "public", "data", "graph.bin"));
  let pos = 0;
  const u8 = () => buf.readUInt8(pos++);
  const u16 = () => { const v = buf.readUInt16LE(pos); pos += 2; return v; };
  const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
  const f32 = () => { const v = buf.readFloatLE(pos); pos += 4; return v; };
  if (u32() !== 0x474d5452 || u32() !== 4) throw new Error("graph.bin v4 expected");
  const nodeCount = u32();
  pos += nodeCount * 9;
  const sigCount = u32();
  pos += sigCount * 8;
  const auxCount = u32();
  pos += auxCount * 12;
  const clCount = u32();
  pos += clCount * 12;
  const eCount = u32();
  const eCls = new Uint8Array(eCount);
  const eGeoOff = new Uint32Array(eCount);
  const eGeoCount = new Uint16Array(eCount);
  const eMode = new Uint8Array(eCount);
  for (let i = 0; i < eCount; i++) {
    pos += 8; // a, b
    eCls[i] = u8();
    pos += 1 + 2 + 4; // flags, speed, len
    eGeoOff[i] = u32();
    eGeoCount[i] = u16();
    pos += 1; // district
    eMode[i] = u8();
    pos += 2; // nameIdx
  }
  const nameCount = u16();
  for (let i = 0; i < nameCount; i++) {
    const len = u8();
    pos += len;
  }
  const geoCount = u32();
  const geo = new Float32Array(eCount ? geoCount * 2 : 0);
  for (let i = 0; i < geoCount * 2; i++) geo[i] = f32();

  // sample grid over car-capable edges
  const CELL = 80;
  const cellMap = new Map();
  const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (let e = 0; e < eCount; e++) {
    if (!(eMode[e] & 1)) continue;
    for (let k = 0; k < eGeoCount[e]; k += 2) {
      const x = geo[(eGeoOff[e] + k) * 2];
      const y = geo[(eGeoOff[e] + k) * 2 + 1];
      const kk = key(x, y);
      if (!cellMap.has(kk)) cellMap.set(kk, []);
      cellMap.get(kk).push([x, y, e]);
    }
  }
  const matchEdge = (x, y) => {
    let best = -1;
    let bestScore = Infinity;
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const lst = cellMap.get(`${cx + dx},${cy + dy}`);
        if (!lst) continue;
        for (const [sx, sy, e] of lst) {
          const d = Math.hypot(sx - x, sy - y);
          if (d > 55) continue;
          const score = d + eCls[e] * 4; // prefer bigger roads on ties
          if (score < bestScore) {
            bestScore = score;
            best = e;
          }
        }
      }
    }
    return best;
  };

  const out = [];
  const perEdge = new Map(); // dedupe: strongest station per edge
  for (const st of stations) {
    const e = matchEdge(st.x, st.y);
    if (e < 0) continue;
    const rec = {
      x: +st.x.toFixed(1),
      y: +st.y.toFixed(1),
      edge: e,
      cls: eCls[e],
      flow: Math.round(st.flow),
      speed: +st.speed.toFixed(1),
      lanes: st.lanes,
      name: String(st.name).slice(0, 48),
    };
    const prev = perEdge.get(e);
    if (!prev || rec.flow > prev.flow) perEdge.set(e, rec);
  }
  out.push(...perEdge.values());

  const capture = new Date(publicationTime ?? Date.now());
  // time of day in Europe/Amsterdam minutes
  const nlParts = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(capture);
  const hh = +nlParts.find((p) => p.type === "hour").value;
  const mm = +nlParts.find((p) => p.type === "minute").value;

  const result = {
    source: "NDW open data (opendata.ndw.nu)",
    capturedAt: capture.toISOString(),
    todMin: hh * 60 + mm,
    stations: out.sort((a, b) => b.flow - a.flow),
  };
  writeFileSync(join(ROOT, "public", "data", "ndw.json"), JSON.stringify(result));
  const totalFlow = out.reduce((a, s) => a + s.flow, 0);
  console.log(
    `ndw.json: ${out.length} matched stations, ${totalFlow.toLocaleString()} veh/h combined, capture ${capture.toISOString()} (${hh}:${String(mm).padStart(2, "0")} NL)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
