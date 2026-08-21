// Reading one file out of the national GTFS zip without downloading it.
//
// gtfs-nl.zip is ~215 MB and stop_times.txt alone is 1 GB uncompressed, but a
// ZIP's central directory lives at the end of the file and every entry is
// independently deflated. Byte-range requests therefore let a caller take just
// the entry it wants — stops.txt, routes.txt, agency.txt — and stream the big
// one through inflate rather than holding it.
//
// Shared by fetch-gtfs-stops, fetch-gtfs-routes and fetch-gtfs-timetable. It
// exists because the ZIP64 handling below is fiddly enough that a third
// hand-copied version of it was going to drift from the other two.
//
// Behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1 (the npm scripts set it).

import { inflateRawSync, createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

export const URL_ZIP = "https://gtfs.ovapi.nl/nl/gtfs-nl.zip";
const UA = { "User-Agent": "rotterdam-intelligence-platform/1.0 (research; contact via github)" };

/** Fetch bytes [from, to] inclusive; as a stream when the entry is large. */
export async function range(from, to, asStream = false) {
  const res = await fetch(URL_ZIP, {
    headers: { ...UA, Range: `bytes=${from}-${to}` },
    signal: AbortSignal.timeout(1_800_000),
  });
  if (res.status !== 206) {
    throw new Error(`range ${from}-${to}: HTTP ${res.status} (server must support byte ranges)`);
  }
  return asStream ? Readable.fromWeb(res.body) : Buffer.from(await res.arrayBuffer());
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

/** Parse the central directory into name → entry. One HEAD and two ranges. */
export async function zipIndex() {
  const { cd, count } = await centralDirectory(await totalSize());
  const entries = new Map();
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
    entries.set(name, { name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry by name, tolerating a directory prefix. */
export function findEntry(entries, want) {
  const direct = entries.get(want);
  if (direct) return direct;
  for (const [name, e] of entries) if (name.endsWith(`/${want}`)) return e;
  return null;
}

/** Where an entry's deflated bytes actually start (past its local header). */
async function dataOffset(entry) {
  // the local header repeats name/extra with its own lengths, so read it first
  const head = await range(entry.localOff, entry.localOff + 29);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local file header signature");
  return entry.localOff + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

/** Range-read one entry and inflate it whole. For the small files only. */
export async function readEntry(entry) {
  const off = await dataOffset(entry);
  const raw = await range(off, off + entry.compSize - 1);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method}`);
  return inflateRawSync(raw, { maxOutputLength: 512 * 1024 * 1024 });
}

/** Yield each line of one entry without ever buffering the whole thing. */
export async function* entryLines(entry) {
  const off = await dataOffset(entry);
  const body = await range(off, off + entry.compSize - 1, true);
  const stream = entry.method === 8 ? body.pipe(createInflateRaw()) : body;
  yield* createInterface({ input: stream, crlfDelay: Infinity });
}

/** Minimal RFC4180 CSV row splitter (GTFS quotes names containing commas). */
export function splitCsv(line) {
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

/** Header row → column names, stripping the BOM the Dutch feed sometimes has. */
export const header = (line) => splitCsv(line.replace(/^﻿/, "").trim());
