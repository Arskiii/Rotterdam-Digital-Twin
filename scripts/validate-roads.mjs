#!/usr/bin/env node
// Validate our OSM-derived road network against the official Dutch road
// register NWB (Nationaal Wegen Bestand) via PDOK's OGC API.
//
//   node scripts/validate-roads.mjs
//
// NWB is the authoritative register of motorized roads (maintained by
// Rijkswaterstaat; it's also what NDW references). BGT covers surveyed
// surface polygons — the right register for *network* validation is NWB.
// For every wegvak (official road segment) in the coverage bbox we check
// whether our routable graph has an edge nearby, and report coverage by
// road authority. Data: PDOK / RWS, public domain.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BBOX = { s: 51.84, w: 4.34, n: 52.0, e: 4.62 };
const ORIGIN = { lat: 51.92, lon: 4.48 };
const M_PER_LAT = 110574;
const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const px = (lon) => (lon - ORIGIN.lon) * M_PER_LON;
const py = (lat) => (lat - ORIGIN.lat) * M_PER_LAT;

// ---- parse routable edges from graph.bin (v4) into a sample grid ----
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
const eGeoOff = new Uint32Array(eCount);
const eGeoCount = new Uint16Array(eCount);
const eMode = new Uint8Array(eCount);
for (let i = 0; i < eCount; i++) {
  pos += 8;
  pos += 1; // cls
  pos += 1 + 2 + 4;
  eGeoOff[i] = u32();
  eGeoCount[i] = u16();
  pos += 1;
  eMode[i] = u8();
  pos += 2;
}
const nameCount = u16();
for (let i = 0; i < nameCount; i++) {
  const len = u8();
  pos += len;
}
const geoCount = u32();
const geo = new Float32Array(geoCount * 2);
for (let i = 0; i < geoCount * 2; i++) geo[i] = f32();

const CELL = 60;
const grid = new Map();
const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
for (let e = 0; e < eCount; e++) {
  if (!(eMode[e] & 1)) continue; // car-capable network only
  for (let k = 0; k < eGeoCount[e]; k++) {
    const x = geo[(eGeoOff[e] + k) * 2];
    const y = geo[(eGeoOff[e] + k) * 2 + 1];
    const kk = key(x, y);
    if (!grid.has(kk)) grid.set(kk, []);
    grid.get(kk).push([x, y]);
  }
}
const nearOurNetwork = (x, y, tol) => {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const lst = grid.get(`${cx + dx},${cy + dy}`);
      if (!lst) continue;
      for (const [sx, sy] of lst) {
        if (Math.hypot(sx - x, sy - y) <= tol) return true;
      }
    }
  }
  return false;
};
console.log(`our network: ${eCount} edges sampled into the match grid`);

// ---- page through NWB wegvakken in the bbox ----
const AUTH = { R: "Rijk (motorway)", P: "Provincie", G: "Gemeente", W: "Waterschap", T: "Anders" };
const stats = new Map(); // auth -> {segments, matched, km, kmMatched}
const missBig = [];
let url = `https://api.pdok.nl/rws/nationaal-wegenbestand-wegen/ogc/v1/collections/wegvakken/items?f=json&limit=1000&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}`;
let pages = 0;
let total = 0;
const TOL = 35;
while (url && pages < 120) {
  const res = await fetch(url, { headers: { Accept: "application/geo+json" } });
  if (!res.ok) throw new Error(`PDOK HTTP ${res.status}`);
  const data = await res.json();
  for (const f of data.features ?? []) {
    const bst = f.properties?.bst_code ?? "";
    if (bst === "VV" || bst.startsWith("VD")) continue; // ferry services aren't roads
    total++;
    const auth = f.properties?.wegbehsrt ?? "T";
    if (!stats.has(auth)) stats.set(auth, { segments: 0, matched: 0, km: 0, kmMatched: 0 });
    const st = stats.get(auth);
    const lines = f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates];
    // sample points + length
    let lenM = 0;
    let samples = 0;
    let hit = 0;
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const [lon, lat] = line[i];
        if (i > 0) {
          const [plon, plat] = line[i - 1];
          lenM += Math.hypot(px(lon) - px(plon), py(lat) - py(plat));
        }
        if (i % 2 === 0) {
          samples++;
          if (nearOurNetwork(px(lon), py(lat), TOL)) hit++;
        }
      }
    }
    const matched = samples > 0 && hit / samples >= 0.5;
    st.segments++;
    st.km += lenM / 1000;
    if (matched) {
      st.matched++;
      st.kmMatched += lenM / 1000;
    } else if (lenM > 250) {
      missBig.push({ name: f.properties?.stt_naam ?? "?", gem: f.properties?.gme_naam ?? "?", auth, lenM: Math.round(lenM) });
    }
  }
  const next = (data.links ?? []).find((l) => l.rel === "next");
  url = next?.href ?? null;
  pages++;
  if (pages % 10 === 0) console.log(`…${total} wegvakken processed`);
}
console.log(`NWB wegvakken in bbox: ${total} (${pages} pages)`);
console.log(`match tolerance: ${TOL} m, a segment counts as matched when ≥50% of its samples hit our network\n`);
let allSeg = 0, allMatch = 0, allKm = 0, allKmM = 0;
for (const [auth, st] of [...stats.entries()].sort((a, b) => b[1].km - a[1].km)) {
  allSeg += st.segments;
  allMatch += st.matched;
  allKm += st.km;
  allKmM += st.kmMatched;
  console.log(
    `${(AUTH[auth] ?? auth).padEnd(18)} ${String(st.matched).padStart(6)}/${String(st.segments).padEnd(6)} segments (${((st.matched / st.segments) * 100).toFixed(1)}%) · ${st.kmMatched.toFixed(0)}/${st.km.toFixed(0)} km (${((st.kmMatched / st.km) * 100).toFixed(1)}%)`
  );
}
console.log(
  `\nTOTAL              ${allMatch}/${allSeg} segments (${((allMatch / allSeg) * 100).toFixed(1)}%) · ${allKmM.toFixed(0)}/${allKm.toFixed(0)} km (${((allKmM / allKm) * 100).toFixed(1)}%)`
);
missBig.sort((a, b) => b.lenM - a.lenM);
if (missBig.length) {
  console.log(`\nlargest unmatched official segments (top 10):`);
  for (const m of missBig.slice(0, 10)) console.log(`  ${m.lenM} m · ${m.name} (${m.gem}, ${AUTH[m.auth] ?? m.auth})`);
}
