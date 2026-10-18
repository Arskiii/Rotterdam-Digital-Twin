#!/usr/bin/env node
// Patch building heights in public/data/buildings.bin in place — no raw OSM
// data or full rebuild needed. Height sources, best first:
//
//   1. data/heights-3dbag.json     measured 3D BAG roof heights (run
//                                  scripts/fetch-heights.mjs to produce it)
//   2. scripts/landmark-heights.json  published heights for named towers,
//                                  applied only where the stored height is
//                                  off by > 15 m and no measured height exists
//
//   node scripts/apply-heights.mjs [--dry-run] [--diag]
//
// --dry-run reports without writing; --diag prints candidate footprints per
// landmark (for tuning landmark coordinates).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clampH, loadMeasuredGrid, loadLandmarks, applyLandmarks,
  heightForFootprint, PointGrid, ringAreaXY, centroidOf,
} from "./lib-heights.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "public", "data", "buildings.bin");
const DRY = process.argv.includes("--dry-run");
const DIAG = process.argv.includes("--diag");

// ---- parse buildings.bin, remembering where each height u16 lives ----
const buf = readFileSync(BIN);
let pos = 0;
const u8 = () => buf.readUInt8(pos++);
const u16 = () => { const v = buf.readUInt16LE(pos); pos += 2; return v; };
const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
const f32 = () => { const v = buf.readFloatLE(pos); pos += 4; return v; };
const i16 = () => { const v = buf.readInt16LE(pos); pos += 2; return v; };

if (u32() !== 0x424d5452) throw new Error("bad buildings.bin magic");
const tileCount = u32();
const items = []; // {pts, cx, cy, area, h, hPos, measured, landmark}
for (let t = 0; t < tileCount; t++) {
  const ox = f32(), oy = f32();
  const count = u32();
  for (let i = 0; i < count; i++) {
    const hPos = pos;
    const h = u16() / 10;
    const nv = u8();
    const nt = u8();
    const pts = [];
    for (let k = 0; k < nv; k++) {
      const x = i16() / 10, y = i16() / 10;
      pts.push([ox + x, oy + y]);
    }
    pos += nt * 3;
    const [cx, cy] = centroidOf(pts);
    items.push({ pts, cx, cy, area: Math.abs(ringAreaXY(pts)), h, hPos, measured: false, landmark: false });
  }
}
console.log(`buildings.bin: ${items.length} footprints in ${tileCount} tiles`);

// ---- 1. measured heights (3D BAG), when fetched ----
const measuredPath = join(ROOT, "data", "heights-3dbag.json");
const measured = loadMeasuredGrid(measuredPath);
let nMeasured = 0;
if (measured) {
  console.log(`measured heights: ${measured.meta.count} from ${measured.meta.source}`);
  for (const it of items) {
    const h = heightForFootprint(measured.grid, it.pts, it.cx, it.cy);
    if (h != null) { it.h = h; it.measured = true; nMeasured++; }
  }
  console.log(`  matched ${nMeasured} / ${items.length} footprints (${((nMeasured / items.length) * 100).toFixed(1)}%)`);
} else {
  console.log("measured heights: data/heights-3dbag.json not present — run: node scripts/fetch-heights.mjs");
}

// ---- 2. published landmark heights ----
const landmarks = loadLandmarks(join(ROOT, "scripts", "landmark-heights.json"));
// PointGrid stores [x,y,h]; reuse the h slot as item index and expose a
// query() that returns item indices, which is what applyLandmarks expects.
const cGrid = new PointGrid(120);
items.forEach((it, i) => { cGrid.add(it.cx, it.cy, i); });
const lookupGrid = {
  query(minX, minY, maxX, maxY) {
    return cGrid.query(minX, minY, maxX, maxY).map((i) => cGrid.pts[i][2]);
  },
};

if (DIAG) {
  for (const lm of landmarks) {
    const cand = [];
    for (const i of lookupGrid.query(lm.x - 150, lm.y - 150, lm.x + 150, lm.y + 150)) {
      const it = items[i];
      const d = Math.hypot(it.cx - lm.x, it.cy - lm.y);
      if (d < 150) cand.push({ d, area: Math.round(it.area), h: it.h });
    }
    cand.sort((a, b) => a.d - b.d);
    console.log(`? ${lm.name}: ` + cand.slice(0, 4).map((c) => `${c.d.toFixed(0)}m/${c.area}m²/h${c.h}`).join("  "));
  }
}
const report = applyLandmarks(items, landmarks, lookupGrid);
console.log("landmarks:");
for (const r of report) {
  if (!r.matched) console.log(`  ✗ ${r.name}: no footprint matched — check coordinates`);
  else
    console.log(
      `  ${r.changed ? "→" : "="} ${r.name}: footprint ${r.dist.toFixed(0)} m away, ${r.area} m², ` +
      (r.changed ? `${r.before.toFixed(1)} m → ${r.after} m` : `kept ${r.before.toFixed(1)} m`)
    );
}

// ---- write heights back ----
let changed = 0;
for (const it of items) {
  const dm = Math.round(clampH(it.h) * 10);
  if (dm !== buf.readUInt16LE(it.hPos)) {
    changed++;
    if (!DRY) buf.writeUInt16LE(dm, it.hPos);
  }
}
if (DRY) {
  console.log(`dry run: ${changed} heights would change`);
} else {
  writeFileSync(BIN, buf);
  console.log(`wrote ${BIN}: ${changed} heights updated (${nMeasured} measured, ${report.filter((r) => r.changed).length} landmarks)`);
}
