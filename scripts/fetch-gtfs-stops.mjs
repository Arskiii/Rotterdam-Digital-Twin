#!/usr/bin/env node
// Stop table for the live transit layer, pulled out of the national GTFS
// without downloading it.
//
//   node scripts/fetch-gtfs-stops.mjs        (npm run fetch-stops)
//
// gtfs-nl.zip is ~215 MB, but a ZIP's central directory lives at the end of
// the file and every entry is independently deflated, so HTTP range reads let
// us take just stops.txt (~8 MB compressed) and skip the other 200 MB. The
// result is filtered to the coverage bbox and written to data/gtfs-stops.json
// (~1 MB), which is committed — stop_ids and platform coordinates only churn
// when the operators republish, so this is a rerun-on-demand job, not a
// per-refresh one.
//
// Behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1 (the npm script sets it).

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zipIndex, findEntry, readEntry, splitCsv, header as headerOf } from "./lib/gtfs-zip.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "gtfs-stops.json");

// Wider than the sim bbox on purpose: a departure board names a trip's final
// stop, and RET metro runs well past the modelled area — line B to Hoek van
// Holland (lon 4.12), line E to Den Haag Centraal (lat 52.08), line D to De
// Akkers. Without those the board would show "due 4 min" with no destination.
const BBOX = { s: 51.79, w: 4.03, n: 52.12, e: 4.72 };
const ORIGIN = { lat: 51.92, lon: 4.48 };
const M_PER_LAT = 110574;
const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const px = (lon) => +(((lon - ORIGIN.lon) * M_PER_LON).toFixed(1));
const py = (lat) => +(((lat - ORIGIN.lat) * M_PER_LAT).toFixed(1));

async function main() {
  console.log("reading the national GTFS zip index over range requests…");
  const entries = await zipIndex();
  console.log(`  central directory: ${entries.size} entries`);
  const entry = findEntry(entries, "stops.txt");
  if (!entry) throw new Error("stops.txt not present in the zip");
  console.log(`  stops.txt: ${(entry.compSize / 1e6).toFixed(1)} MB compressed → ${(entry.uncompSize / 1e6).toFixed(1)} MB`);
  const csv = (await readEntry(entry)).toString("utf8");

  const lines = csv.split("\n");
  const cols = headerOf(lines[0]);
  const col = (n) => cols.indexOf(n);
  const cId = col("stop_id");
  const cName = col("stop_name");
  const cLat = col("stop_lat");
  const cLon = col("stop_lon");
  const cParent = col("parent_station");
  const cPlatform = col("platform_code");
  const cType = col("location_type");
  if (cId < 0 || cName < 0 || cLat < 0 || cLon < 0) throw new Error("stops.txt is missing required columns");

  const stops = {};
  let seen = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 5) continue;
    const f = splitCsv(line.trim());
    const lat = parseFloat(f[cLat]);
    const lon = parseFloat(f[cLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    seen++;
    if (lat < BBOX.s || lat > BBOX.n || lon < BBOX.w || lon > BBOX.e) continue;
    // location_type 1 is a parent station, 0/blank a boarding platform; both
    // are worth keeping — RT references platforms, humans read station names
    const id = f[cId];
    if (!id) continue;
    stops[id] = {
      n: f[cName] ?? "",
      x: px(lon),
      y: py(lat),
      ...(cParent >= 0 && f[cParent] ? { p: f[cParent] } : {}),
      ...(cPlatform >= 0 && f[cPlatform] ? { q: f[cPlatform] } : {}),
      ...(cType >= 0 && f[cType] === "1" ? { s: 1 } : {}),
    };
  }
  console.log(`  ${seen} stops nationally → ${Object.keys(stops).length} inside the coverage bbox`);
  if (!Object.keys(stops).length) throw new Error("no stops matched the bbox — check BBOX or the feed");
  writeFileSync(OUT, JSON.stringify(stops));
  console.log(`stop table → ${OUT} (${(JSON.stringify(stops).length / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
