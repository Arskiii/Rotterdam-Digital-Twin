#!/usr/bin/env node
// Cross-validate our OSM-derived signal network against the official UDAP
// iVRI registry (map.udap.nl — open data, attribution UDAP).
//
//   node scripts/validate-signals.mjs <udap-export.geojson> [authority]
//
// For every official installation of the given road authority inside our
// coverage area, finds the nearest signal cluster in graph.bin and reports
// match rates. An iVRI ↔ one signalized installation ↔ one cluster.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = { lat: 51.92, lon: 4.48 };
const M_PER_LAT = 110574;
const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const px = (lon) => (lon - ORIGIN.lon) * M_PER_LON;
const py = (lat) => (lat - ORIGIN.lat) * M_PER_LAT;

// ---- parse clusters out of graph.bin (v4) ----
const buf = readFileSync(join(ROOT, "public", "data", "graph.bin"));
let pos = 0;
const u8 = () => buf.readUInt8(pos++);
const u16 = () => { const v = buf.readUInt16LE(pos); pos += 2; return v; };
const i16 = () => { const v = buf.readInt16LE(pos); pos += 2; return v; };
const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
const f32 = () => { const v = buf.readFloatLE(pos); pos += 4; return v; };

if (u32() !== 0x474d5452) throw new Error("bad magic");
if (u32() !== 4) throw new Error("expected graph v4");
const nodeCount = u32();
pos += nodeCount * 9;
const sigCount = u32();
pos += sigCount * 8;
const auxCount = u32();
pos += auxCount * 12;
const clusterCount = u32();
const clusters = [];
for (let i = 0; i < clusterCount; i++) {
  const x = f32();
  const y = f32();
  const crossing = u8();
  u8();
  u16();
  clusters.push({ x, y, crossing });
}
console.log(`graph.bin: ${clusterCount} signal clusters (${clusters.filter((c) => !c.crossing).length} junctions)`);

// ---- load official registry ----
const file = process.argv[2];
const authority = process.argv[3] ?? "Rotterdam";
const gj = JSON.parse(readFileSync(file, "utf8"));
const official = gj.features
  .filter((f) => f.properties?.roadRegulatorName === authority)
  .map((f) => ({
    name: f.properties.name,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    x: px(f.geometry.coordinates[0]),
    y: py(f.geometry.coordinates[1]),
  }));

// keep only installations inside the fetched bbox (lat 51.84–52.00, lon
// 4.34–4.62) with a 250 m inset so boundary cabinets don't skew the numbers
const inArea = official.filter(
  (o) => o.lon > 4.3436 && o.lon < 4.6164 && o.lat > 51.8423 && o.lat < 51.9977
);
console.log(`UDAP registry: ${official.length} iVRIs under authority "${authority}", ${inArea.length} inside coverage`);

// ---- nearest-cluster match ----
const bands = [40, 75, 150];
const counts = bands.map(() => 0);
const misses = [];
for (const o of inArea) {
  let best = Infinity;
  for (const c of clusters) {
    const d = Math.hypot(c.x - o.x, c.y - o.y);
    if (d < best) best = d;
  }
  o.dist = best;
  bands.forEach((b, i) => {
    if (best <= b) counts[i]++;
  });
  if (best > bands[bands.length - 1]) misses.push(o);
}
if (!inArea.length) {
  console.log("no installations inside the coverage area for this authority");
  process.exit(0);
}
for (let i = 0; i < bands.length; i++) {
  console.log(`matched within ${String(bands[i]).padStart(3)} m: ${counts[i]}/${inArea.length} (${((counts[i] / inArea.length) * 100).toFixed(1)}%)`);
}
const dists = inArea.map((o) => o.dist).sort((a, b) => a - b);
console.log(`median offset: ${dists[Math.floor(dists.length / 2)].toFixed(1)} m`);
if (misses.length) {
  console.log(`unmatched (> ${bands[bands.length - 1]} m):`);
  for (const m of misses) console.log(`  ${m.name} @ ${m.lat.toFixed(5)},${m.lon.toFixed(5)} → nearest cluster ${m.dist.toFixed(0)} m`);
}
