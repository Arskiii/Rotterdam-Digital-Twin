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
import { inflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "gtfs-stops.json");
const URL_ZIP = "https://gtfs.ovapi.nl/nl/gtfs-nl.zip";

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

const UA = { "User-Agent": "rotterdam-intelligence-platform/1.0 (research; contact via github)" };

/** Fetch bytes [from, to] inclusive. */
async function range(from, to) {
  const res = await fetch(URL_ZIP, {
    headers: { ...UA, Range: `bytes=${from}-${to}` },
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status !== 206) throw new Error(`range ${from}-${to}: HTTP ${res.status} (server must support byte ranges)`);
  return Buffer.from(await res.arrayBuffer());
}

async function totalSize() {
  const res = await fetch(URL_ZIP, { method: "HEAD", headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HEAD: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length"));
  if (!Number.isFinite(len) || len <= 0) throw new Error("no content-length on the zip");
  return len;
}

/** Locate the central directory, following the ZIP64 records when present. */
async function centralDirectory(size) {
  const tailLen = Math.min(size, 66_000); // EOCD + max comment
  const tail = await range(size - tailLen, size - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error("no end-of-central-directory record found");
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  let count = tail.readUInt16LE(eocd + 10);

  // ZIP64: the 32-bit fields saturate and the real values live in EOCD64
  if (cdOff === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
    if (loc === -1) throw new Error("zip64 expected but no locator found");
    const eocd64Off = Number(tail.readBigUInt64LE(loc + 8));
    const e64 = await range(eocd64Off, eocd64Off + 55);
    if (e64.readUInt32LE(0) !== 0x06064b50) throw new Error("bad zip64 end-of-central-directory signature");
    count = Number(e64.readBigUInt64LE(32));
    cdSize = Number(e64.readBigUInt64LE(40));
    cdOff = Number(e64.readBigUInt64LE(48));
  }
  const cd = await range(cdOff, cdOff + cdSize - 1);
  return { cd, count };
}

/** Find one entry by name in a parsed central directory. */
function findEntry(cd, count, want) {
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory entry at ${p}`);
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOff = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);

    // ZIP64 extended information overrides the saturated 32-bit fields, in a
    // fixed order but only for the fields that actually saturated
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const tag = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (tag === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOff === 0xffffffff) { localOff = Number(cd.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }
    if (name === want || name.endsWith(`/${want}`)) return { name, method, compSize, uncompSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Range-read one entry's bytes and inflate. */
async function readEntry(entry) {
  // the local header repeats name/extra with its own lengths, so read it first
  const head = await range(entry.localOff, entry.localOff + 29);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local file header signature");
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const dataOff = entry.localOff + 30 + nameLen + extraLen;
  const raw = await range(dataOff, dataOff + entry.compSize - 1);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method}`);
  return inflateRawSync(raw, { maxOutputLength: 512 * 1024 * 1024 });
}

/** Minimal RFC4180 CSV row splitter (GTFS quotes names containing commas). */
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

async function main() {
  console.log("reading the national GTFS zip index over range requests…");
  const size = await totalSize();
  console.log(`  zip is ${(size / 1e6).toFixed(0)} MB`);
  const { cd, count } = await centralDirectory(size);
  console.log(`  central directory: ${count} entries`);
  const entry = findEntry(cd, count, "stops.txt");
  if (!entry) throw new Error("stops.txt not present in the zip");
  console.log(`  stops.txt: ${(entry.compSize / 1e6).toFixed(1)} MB compressed → ${(entry.uncompSize / 1e6).toFixed(1)} MB`);
  const csv = (await readEntry(entry)).toString("utf8");

  const lines = csv.split("\n");
  const header = splitCsv(lines[0].replace(/^﻿/, "").trim());
  const col = (n) => header.indexOf(n);
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
