#!/usr/bin/env node
// Fold one live snapshot into the historical archive.
//
//   node scripts/archive-live.mjs --snapshot live.json --dir <archive work tree>
//                                 [--prune-days 45]
//
// The archive is what lets the platform answer "what was this city doing last
// Tuesday at 08:20" — congestion, weather, incidents, the lot. It is written
// as plain binary files on the `archive` branch, in two tiers:
//
//   f/YYYY/MM/DD/HH.bin   fine   — every NDW station, one record per 5 min
//   c/YYYY/MM/DD/HH.bin   coarse — per district + city scalars, per 5 min
//   e/YYYY-MM.json        events — incidents and bridge openings, deduped
//
// The fine tier is ~22 KB an hour and carries the detail you want when
// looking back days; the coarse tier is under a kilobyte an hour and is what
// you scrub across months. Both are append-only within an hour and are
// rewritten in place until that hour closes, so a run that dies mid-hour costs
// at most one extra blob rather than the hour's data.
//
// Appends are idempotent: a record whose 5-minute slot is already present is
// skipped, so re-running over the same snapshot changes nothing.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const SNAPSHOT = arg("--snapshot");
const DIR = arg("--dir");
const PRUNE_DAYS = +(arg("--prune-days", "45"));
if (!SNAPSHOT || !DIR) {
  console.error("usage: archive-live.mjs --snapshot <live.json> --dir <archive dir> [--prune-days N]");
  process.exit(2);
}

const SLOT_MIN = 5; // archive resolution
const ORIGIN = { lat: 51.92, lon: 4.48 };
const M_PER_LAT = 110574;
const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

// ---------------- district attribution ----------------
// Districts are Voronoi seeds over the projected plane (see src/config.ts), so
// a station belongs to whichever seed is nearest — the same rule the sim uses.

const DISTRICTS = [
  ["centrum", 51.9204, 4.4794], ["noord", 51.9345, 4.4705], ["delfshaven", 51.9092, 4.4363],
  ["overschie", 51.9411, 4.4269], ["hillegersberg", 51.9565, 4.4779], ["kralingen", 51.9257, 4.5155],
  ["alexander", 51.9553, 4.5477], ["feijenoord", 51.8988, 4.5052], ["ijsselmonde", 51.8853, 4.5433],
  ["charlois", 51.8797, 4.4699], ["waalhaven", 51.8898, 4.4179], ["pernis", 51.8865, 4.3885],
  ["hoogvliet", 51.8632, 4.3623], ["schiedam", 51.9186, 4.3991], ["capelle", 51.9297, 4.5776],
].map(([key, lat, lon]) => ({
  key,
  x: (lon - ORIGIN.lon) * M_PER_LON,
  y: (lat - ORIGIN.lat) * M_PER_LAT,
}));

function districtOf(x, y) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const d = (DISTRICTS[i].x - x) ** 2 + (DISTRICTS[i].y - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------------- binary helpers ----------------

class Writer {
  constructor() { this.parts = []; }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(clamp(v, 0, 255)); this.parts.push(b); return this; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(clamp(v, 0, 65535)); this.parts.push(b); return this; }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16LE(clamp(v, -32768, 32767)); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(clamp(v, 0, 4294967295)); this.parts.push(b); return this; }
  raw(b) { this.parts.push(b); return this; }
  done() { return Buffer.concat(this.parts); }
}
const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : 0);

// ---------------- fine tier: every station ----------------

const FINE_MAGIC = "RTAF";
const FINE_HEAD = 4 + 2 + 4 + 2 + 2; // magic, version, hourEpoch, stationCount, recordCount

function fineRecordSize(stationCount) {
  return 1 + stationCount * 3; // slot byte + (u16 flow, u8 speed) per station
}

function readFine(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  if (buf.length < FINE_HEAD || buf.toString("ascii", 0, 4) !== FINE_MAGIC) return null;
  return {
    version: buf.readUInt16LE(4),
    hourEpoch: buf.readUInt32LE(6),
    stationCount: buf.readUInt16LE(10),
    recordCount: buf.readUInt16LE(12),
    body: buf.subarray(FINE_HEAD),
  };
}

/** Slots already written, so an append is idempotent. */
function fineSlots(prev) {
  const seen = new Set();
  if (!prev) return seen;
  const size = fineRecordSize(prev.stationCount);
  for (let i = 0; i < prev.recordCount; i++) seen.add(prev.body.readUInt8(i * size));
  return seen;
}

function writeFine(path, hourEpoch, stationCount, prev, slot, flows, speeds) {
  const rec = new Writer().u8(slot);
  for (let i = 0; i < stationCount; i++) {
    rec.u16(flows[i] ?? 0);
    rec.u8(speeds[i] ?? 0);
  }
  const head = new Writer()
    .raw(Buffer.from(FINE_MAGIC, "ascii"))
    .u16(1)
    .u32(hourEpoch)
    .u16(stationCount)
    .u16((prev?.recordCount ?? 0) + 1)
    .done();
  const body = prev ? Buffer.concat([prev.body, rec.done()]) : rec.done();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([head, body]));
}

// ---------------- coarse tier: districts + city scalars ----------------

const COARSE_MAGIC = "RTAC";
const COARSE_HEAD = 4 + 2 + 4 + 1 + 2;
const COARSE_REC = 1 + 2 + 2 + 2 + 1 + 1 + 2 + 1 + 1 + DISTRICTS.length * 4;

function readCoarse(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  if (buf.length < COARSE_HEAD || buf.toString("ascii", 0, 4) !== COARSE_MAGIC) return null;
  return {
    hourEpoch: buf.readUInt32LE(6),
    districtCount: buf.readUInt8(10),
    recordCount: buf.readUInt16LE(11),
    body: buf.subarray(COARSE_HEAD),
  };
}

function coarseSlots(prev) {
  const seen = new Set();
  if (!prev) return seen;
  for (let i = 0; i < prev.recordCount; i++) seen.add(prev.body.readUInt8(i * COARSE_REC));
  return seen;
}

function writeCoarse(path, hourEpoch, prev, slot, city, districts) {
  const rec = new Writer()
    .u8(slot)
    .i16((city.temp ?? 0) * 10)
    .u16((city.rain ?? 0) * 100)
    .i16(city.waterCm ?? 0)
    .u8(city.incidents ?? 0)
    .u8(city.bridges ?? 0)
    .u16(city.transit ?? 0)
    .u8(city.no2 ?? 0)
    .u8(city.pm25 ?? 0);
  for (const d of districts) {
    rec.u16(d.flow).u8(d.speed).u8(d.congestion);
  }
  const head = new Writer()
    .raw(Buffer.from(COARSE_MAGIC, "ascii"))
    .u16(1)
    .u32(hourEpoch)
    .u8(DISTRICTS.length)
    .u16((prev?.recordCount ?? 0) + 1)
    .done();
  const body = prev ? Buffer.concat([prev.body, rec.done()]) : rec.done();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([head, body]));
}

// ---------------- events ----------------

const KIND_NAME = ["accident", "obstruction", "jam", "closure", "roadworks"];

/**
 * Append incidents and bridge openings, one entry per real-world occurrence.
 *
 * The identity of an occurrence is its kind and its position — deliberately
 * not its end time. NDW revises `until` as an incident develops, so keying on
 * it logged the same accident again every time the estimate moved, and a
 * morning of roadworks became dozens of rows. Instead an entry is extended:
 * `t` is when it was first seen, `until` tracks the latest estimate, and
 * `seen` is the last snapshot it appeared in.
 *
 * A gap longer than REOPEN_MS starts a new entry, so a bridge that opens twice
 * in a day is two openings rather than one very long one.
 */
const REOPEN_MS = 2 * 3_600_000;

function appendEvents(path, snap, stampIso) {
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const byKey = new Map();
  for (const e of existing) {
    const prev = byKey.get(e.k);
    // keep the most recent occurrence of each key as the extendable one
    if (!prev || Date.parse(e.seen ?? e.t) > Date.parse(prev.seen ?? prev.t)) byKey.set(e.k, e);
  }
  const now = Date.parse(stampIso);
  let added = 0;
  let extended = 0;
  const record = (key, row) => {
    const open = byKey.get(key);
    if (open && now - Date.parse(open.seen ?? open.t) <= REOPEN_MS) {
      open.seen = stampIso;
      if (row.until) open.until = row.until;
      extended++;
      return;
    }
    const entry = { k: key, seen: stampIso, ...row };
    existing.push(entry);
    byKey.set(key, entry);
    added++;
  };
  for (const inc of snap.incidents ?? []) {
    record(`i:${inc.kind}:${Math.round(inc.x)}:${Math.round(inc.y)}`, {
      t: stampIso, type: KIND_NAME[inc.kind] ?? String(inc.kind),
      name: inc.name ?? "", x: inc.x, y: inc.y, until: inc.until ?? null,
    });
  }
  for (const b of snap.bridges ?? []) {
    record(`b:${Math.round(b.x)}:${Math.round(b.y)}`, {
      t: stampIso, type: "bridge-open", name: b.name ?? "", x: b.x, y: b.y, until: b.until ?? null,
    });
  }
  if (added || extended) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(existing));
  }
  return { added, extended };
}

// ---------------- retention ----------------

/** Drop fine-tier hours older than the window; the coarse tier is kept. */
function prune(dir, days) {
  const root = join(dir, "f");
  if (!existsSync(root) || !(days > 0)) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  const walk = (p, depth) => {
    if (!existsSync(p)) return;
    for (const name of readdirSync(p)) {
      const child = join(p, name);
      if (depth < 3) {
        if (statSync(child).isDirectory()) {
          walk(child, depth + 1);
          if (!readdirSync(child).length) rmSync(child, { recursive: true });
        }
      } else if (name.endsWith(".bin")) {
        const rel = child.slice(root.length + 1).replace(/\.bin$/, "").split(/[/\\]/);
        const [y, m, d, h] = rel.map(Number);
        if (Date.UTC(y, m - 1, d, h) < cutoff) { rmSync(child); removed++; }
      }
    }
  };
  walk(root, 1);
  return removed;
}

// ---------------- main ----------------

function main() {
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const ndw = JSON.parse(readFileSync(join(ROOT, "public", "data", "ndw.json"), "utf8"));
  const stationCount = ndw.stations.length;

  const at = new Date(snap.t ?? Date.now());
  if (!Number.isFinite(at.getTime())) throw new Error("snapshot has no usable timestamp");
  const hourEpoch = Math.floor(at.getTime() / 3_600_000) * 3600;
  const slot = Math.floor(at.getUTCMinutes() / SLOT_MIN) * SLOT_MIN;
  const y = at.getUTCFullYear();
  const mo = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  const h = String(at.getUTCHours()).padStart(2, "0");

  // ---- per-station series ----
  const flows = new Array(stationCount).fill(0);
  const speeds = new Array(stationCount).fill(0);
  for (const [i, flow, speed] of snap.traffic?.s ?? []) {
    if (i < stationCount) { flows[i] = flow; speeds[i] = speed; }
  }

  const finePath = join(DIR, "f", String(y), mo, d, `${h}.bin`);
  const prevFine = readFine(finePath);
  const fineSeen = fineSlots(prevFine);
  const wroteFine = !fineSeen.has(slot) && (snap.traffic?.s?.length ?? 0) > 0;
  if (wroteFine) {
    if (prevFine && prevFine.stationCount !== stationCount) {
      throw new Error(`station count changed mid-hour (${prevFine.stationCount} → ${stationCount}); rerun fetch-ndw and start a new hour`);
    }
    writeFine(finePath, hourEpoch, stationCount, prevFine, slot, flows, speeds);
  }

  // ---- district rollup ----
  const agg = DISTRICTS.map(() => ({ flow: 0, speedSum: 0, speedN: 0, ratioSum: 0, ratioN: 0 }));
  for (const [i, flow, speed] of snap.traffic?.s ?? []) {
    const st = ndw.stations[i];
    if (!st) continue;
    const di = districtOf(st.x, st.y);
    agg[di].flow += flow;
    if (speed > 0) {
      agg[di].speedSum += speed;
      agg[di].speedN++;
      // congestion is measured speed against the station's own free-flow read,
      // which is the only limit we have here without loading the graph
      const free = st.speed > 5 ? st.speed : 50;
      agg[di].ratioSum += Math.min(1, speed / free);
      agg[di].ratioN++;
    }
  }
  const districts = agg.map((a) => ({
    flow: a.flow,
    speed: a.speedN ? a.speedSum / a.speedN : 0,
    // 0 = free flowing, 255 = stopped
    congestion: a.ratioN ? (1 - a.ratioSum / a.ratioN) * 255 : 0,
  }));

  const air = snap.air?.s ?? [];
  const mean = (idx) => {
    const vals = air.map((s) => s[idx]).filter((v) => typeof v === "number");
    return vals.length ? vals.reduce((p, c) => p + c, 0) / vals.length : 0;
  };
  const city = {
    temp: snap.weather?.temp ?? 0,
    rain: snap.weather?.rain ?? 0,
    waterCm: snap.water?.cm ?? 0,
    incidents: (snap.incidents ?? []).length,
    bridges: (snap.bridges ?? []).length,
    transit: (snap.vehicles?.v ?? []).length,
    no2: mean(2),
    pm25: mean(3),
  };

  const coarsePath = join(DIR, "c", String(y), mo, d, `${h}.bin`);
  const prevCoarse = readCoarse(coarsePath);
  const wroteCoarse = !coarseSlots(prevCoarse).has(slot);
  if (wroteCoarse) writeCoarse(coarsePath, hourEpoch, prevCoarse, slot, city, districts);

  const ev = appendEvents(join(DIR, "e", `${y}-${mo}.json`), snap, at.toISOString());
  const pruned = prune(DIR, PRUNE_DAYS);

  console.log(
    `archive ${y}-${mo}-${d} ${h}:${String(slot).padStart(2, "0")}Z — ` +
      `fine ${wroteFine ? "+1" : "skip"}, coarse ${wroteCoarse ? "+1" : "skip"}, ` +
      `events +${ev.added}~${ev.extended}${pruned ? `, pruned ${pruned}` : ""}`
  );
}

main();
