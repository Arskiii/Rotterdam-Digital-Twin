#!/usr/bin/env node
// Fetch measured building heights for the coverage area from the 3D BAG
// (https://3dbag.nl, TU Delft — BAG footprints × AHN LiDAR, CC BY 4.0).
//
//   node scripts/fetch-heights.mjs
//
// Tiled + resumable like fetch-osm.mjs: every WFS page is cached in
// data/raw3dbag/, rerunning skips finished pages. Output is a compact lookup
//
//   data/heights-3dbag.json   { source, fetchedAt, entries: [[x, y, h], ...] }
//
// with x/y in the project's local projected meters and h the roof height above
// ground (70th-percentile roof minus ground level — the right massing height
// for extrusion). Consumed by scripts/build-data.mjs (full rebuild) and
// scripts/apply-heights.mjs (in-place patch of public/data/buildings.bin).
//
// Requires network access to data.3dbag.nl. Runs fine on a normal connection;
// in restricted environments allowlist data.3dbag.nl first.

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { px, py, rdToWgs, wgsToRd } from "./lib-heights.mjs";

const BBOX = { s: 51.84, w: 4.34, n: 52.0, e: 4.62 }; // keep in sync with fetch-osm.mjs

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw3dbag");
mkdirSync(RAW, { recursive: true });

// WFS endpoints, newest 3D BAG release first. Layer lod12 carries the same
// per-pand height attributes as lod22 with far lighter 2D geometry.
const SERVICES = [
  { base: "https://data.3dbag.nl/api/BAG3D/wfs", typeName: "BAG3D:lod12", version: "2.0.0" },
  { base: "https://data.3dbag.nl/api/BAG3D_v2/wfs", typeName: "BAG3D_v2:lod12", version: "2.0.0" },
];
const PAGE = 5000;
const TILES = 6; // 6x6 like the OSM building fetch

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tileBoxesRd() {
  // Work in RD (EPSG:28992), the service's native CRS — no axis-order surprises.
  const sw = wgsToRd(BBOX.s, BBOX.w);
  const ne = wgsToRd(BBOX.n, BBOX.e);
  const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x);
  const minY = Math.min(sw.y, ne.y), maxY = Math.max(sw.y, ne.y);
  const boxes = [];
  const dw = (maxX - minX) / TILES;
  const dh = (maxY - minY) / TILES;
  for (let ty = 0; ty < TILES; ty++)
    for (let tx = 0; tx < TILES; tx++)
      boxes.push({
        id: `${tx}-${ty}`,
        minX: minX + tx * dw, maxX: minX + (tx + 1) * dw,
        minY: minY + ty * dh, maxY: minY + (ty + 1) * dh,
      });
  return boxes;
}

async function fetchPage(svc, box, startIndex) {
  const params = new URLSearchParams({
    service: "WFS",
    version: svc.version,
    request: "GetFeature",
    typeNames: svc.typeName,
    outputFormat: "application/json",
    srsName: "EPSG:28992",
    count: String(PAGE),
    startIndex: String(startIndex),
    bbox: `${box.minX},${box.minY},${box.maxX},${box.maxY},EPSG:28992`,
  });
  const url = `${svc.base}?${params}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "rotterdam-intelligence-platform/1.0 (research; contact via github)" },
        signal: AbortSignal.timeout(180_000),
      });
      const text = await res.text();
      if (!res.ok || text.trimStart().startsWith("<")) {
        throw new Error(`HTTP ${res.status} ${text.slice(0, 140).replace(/\n/g, " ")}`);
      }
      return JSON.parse(text);
    } catch (err) {
      console.warn(`  ! tile ${box.id} @${startIndex} attempt ${attempt + 1}: ${err.message ?? err}`);
      await sleep(2500 * (attempt + 1));
    }
  }
  throw new Error(`tile ${box.id} @${startIndex}: all attempts failed`);
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? parseFloat(v) : NaN);

/** Roof-above-ground height from a 3D BAG feature's properties (v3 or v2 names). */
function heightOfProps(p) {
  if (!p) return NaN;
  const roof = [p.b3_h_dak_70p, p.b3_h_dak_50p, p.b3_h_dak_max, p.h_dak_70p, p.h_dak_50p, p.h_dak_max]
    .map(num).find((v) => Number.isFinite(v));
  const ground = [p.b3_h_maaiveld, p.h_maaiveld].map(num).find((v) => Number.isFinite(v));
  if (!Number.isFinite(roof)) return NaN;
  // Roof percentiles are NAP elevations; subtract ground level when known
  // (Rotterdam sits around NAP so a missing maaiveld stays close to truth).
  return roof - (Number.isFinite(ground) ? ground : 0);
}

/** Centroid (RD) of the first polygon ring in a GeoJSON geometry. */
function centroidRd(geom) {
  if (!geom) return null;
  let ring = null;
  if (geom.type === "Polygon") ring = geom.coordinates?.[0];
  else if (geom.type === "MultiPolygon") ring = geom.coordinates?.[0]?.[0];
  else if (geom.type === "Point") return { x: geom.coordinates[0], y: geom.coordinates[1] };
  if (!ring || ring.length < 3) return null;
  // GeoJSON rings repeat the first vertex at the end — don't double-count it
  const last = ring.length - 1;
  const n = ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1] ? last : ring.length;
  if (n < 3) return null;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return { x: x / n, y: y / n };
}

async function main() {
  const boxes = tileBoxesRd();
  let svcIdx = 0;

  for (const box of boxes) {
    for (let page = 0; ; page++) {
      const file = join(RAW, `tile-${box.id}-p${page}.json`);
      let json;
      if (existsSync(file) && statSync(file).size > 50) {
        json = JSON.parse(readFileSync(file, "utf8"));
        console.log(`  = tile ${box.id} page ${page} (cached, ${json.features?.length ?? 0} features)`);
      } else {
        let lastErr;
        json = null;
        for (let s = 0; s < SERVICES.length && !json; s++) {
          const svc = SERVICES[(svcIdx + s) % SERVICES.length];
          try {
            json = await fetchPage(svc, box, page * PAGE);
            svcIdx = (svcIdx + s) % SERVICES.length; // stick with what works
          } catch (err) {
            lastErr = err;
          }
        }
        if (!json) throw lastErr;
        if (!Array.isArray(json.features)) throw new Error(`tile ${box.id} page ${page}: no features array — service change? Response keys: ${Object.keys(json)}`);
        writeFileSync(file, JSON.stringify(json));
        console.log(`  + tile ${box.id} page ${page}: ${json.features.length} features`);
        await sleep(800);
      }
      if ((json.features?.length ?? 0) < PAGE) break; // last page of this tile
    }
  }

  // ---- reduce all cached pages to the compact lookup ----
  const entries = [];
  const seen = new Set();
  let noHeight = 0;
  for (const f of readdirSync(RAW).filter((f) => /^tile-\d+-\d+-p\d+\.json$/.test(f))) {
    const json = JSON.parse(readFileSync(join(RAW, f), "utf8"));
    for (const feat of json.features ?? []) {
      const id = feat.properties?.identificatie ?? feat.id;
      if (id && seen.has(id)) continue; // tile-edge duplicates
      if (id) seen.add(id);
      const h = heightOfProps(feat.properties);
      const c = centroidRd(feat.geometry);
      if (!c || !Number.isFinite(h) || h <= 0 || h > 300) { noHeight++; continue; }
      const wgs = rdToWgs(c.x, c.y);
      entries.push([+px(wgs.lon).toFixed(1), +py(wgs.lat).toFixed(1), +h.toFixed(1)]);
    }
  }
  if (entries.length < 50_000) {
    throw new Error(`only ${entries.length} measured heights extracted — that cannot cover greater Rotterdam; not writing output`);
  }
  const out = {
    source: "3D BAG (https://3dbag.nl, TU Delft), BAG × AHN, CC BY 4.0",
    fetchedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  writeFileSync(join(ROOT, "data", "heights-3dbag.json"), JSON.stringify(out));
  console.log(`heights-3dbag.json: ${entries.length} buildings with measured heights (${noHeight} skipped without usable height)`);
  console.log("Next: node scripts/apply-heights.mjs   (patches public/data/buildings.bin in place)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
