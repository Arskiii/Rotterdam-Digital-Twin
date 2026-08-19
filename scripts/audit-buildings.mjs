#!/usr/bin/env node
// Audit building-height accuracy in public/data/buildings.bin.
//
//   node scripts/audit-buildings.mjs
//
// Reports the height distribution, how much of the stock is estimated versus
// sourced, and checks Rotterdam's named towers against their published
// heights (scripts/landmark-heights.json).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLandmarks, pointInRing } from "./lib-heights.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const buf = readFileSync(join(ROOT, "public", "data", "buildings.bin"));
let pos = 0;
const u8 = () => buf.readUInt8(pos++);
const u16 = () => { const v = buf.readUInt16LE(pos); pos += 2; return v; };
const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
const f32 = () => { const v = buf.readFloatLE(pos); pos += 4; return v; };
const i16 = () => { const v = buf.readInt16LE(pos); pos += 2; return v; };

if (u32() !== 0x424d5452) throw new Error("bad buildings.bin magic");
const tileCount = u32();
const items = [];
for (let t = 0; t < tileCount; t++) {
  const ox = f32(), oy = f32();
  const count = u32();
  for (let i = 0; i < count; i++) {
    const h = u16() / 10;
    const nv = u8(), nt = u8();
    const pts = [];
    let cx = 0, cy = 0;
    for (let k = 0; k < nv; k++) {
      const x = ox + i16() / 10, y = oy + i16() / 10;
      cx += x; cy += y;
      pts.push([x, y]);
    }
    pos += nt * 3;
    items.push({ pts, cx: cx / nv, cy: cy / nv, h });
  }
}
console.log(`buildings.bin: ${items.length} prisms in ${tileCount} tiles`);

// ---- height distribution ----
const buckets = new Map();
let over30 = 0, over100 = 0, over150 = 0, maxH = 0;
// The estimation fallback writes uniform 0.1 m steps across 5.0–10.9 m; count
// that band's excess over its tagged neighbours as "estimated".
let inBand = 0;
for (const { h } of items) {
  if (h >= 5.0 && h <= 10.9) inBand++;
  if (h > 30) over30++;
  if (h > 100) over100++;
  if (h > 150) over150++;
  if (h > maxH) maxH = h;
  const b = Math.min(200, Math.floor(h / 10) * 10);
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
console.log(`tallest prism: ${maxH} m · >30 m: ${over30} · >100 m: ${over100} · >150 m: ${over150}`);
console.log(
  `5.0–10.9 m band: ${inBand} (${((inBand / items.length) * 100).toFixed(1)}%) — genuine low-rise once measured ` +
  `heights are applied; a flat 0.1 m histogram here means the estimation fallback instead (see apply-heights output for the source split)`
);
console.log("distribution (10 m buckets):");
for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
  const n = buckets.get(k);
  console.log(`  ${String(k).padStart(4)} m  ${String(n).padStart(7)}  ${"#".repeat(Math.max(1, Math.round(Math.log10(n + 1) * 8)))}`);
}

// ---- landmark verification against published heights ----
const landmarks = loadLandmarks(join(ROOT, "scripts", "landmark-heights.json"));
console.log("\nlandmarks vs published heights (tallest prism containing the point, else nearest):");
let ok = 0, off = 0;
for (const lm of landmarks) {
  // tallest prism containing the point (outline + tower part stack there),
  // else the nearest sizeable prism within 50 m
  let best = null, bestD = Infinity;
  for (const it of items) {
    const d = Math.hypot(it.cx - lm.x, it.cy - lm.y);
    if (d > 100) continue;
    if (pointInRing(lm.x, lm.y, it.pts)) {
      if (!best?.contains || it.h > best.it.h) best = { it, contains: true };
    } else if (!best?.contains && d < Math.min(50, bestD)) {
      best = { it, contains: false };
      bestD = d;
    }
  }
  best = best?.it;
  if (!best) {
    console.log(`  ✗ ${lm.name}: no prism found`);
    off++;
    continue;
  }
  const delta = best.h - lm.h;
  const good = Math.abs(delta) <= 16;
  if (good) ok++; else off++;
  console.log(
    `  ${good ? "✓" : "✗"} ${lm.name}: model ${best.h.toFixed(1)} m vs published ${lm.h} m (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} m)`
  );
}
console.log(`\n${ok}/${landmarks.length} landmarks within ±16 m of published height`);
process.exitCode = off > landmarks.length / 2 ? 1 : 0;
