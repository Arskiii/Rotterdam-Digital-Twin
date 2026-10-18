#!/usr/bin/env node
// Is the committed timetable still good enough to run the city on?
//
//   node scripts/check-timetable.mjs [--days N]   (npm run check-timetable)
//
// The timetable is the thing that makes vehicles move: without a schedule for
// its trip, a tram is drawn at a position fix that is already two minutes old
// and then stands still. That failure is silent — the map still renders, it
// just quietly stops being alive — so it needs a check that fails loudly.
//
// Exits non-zero if the file is missing, unreadable, or its service calendar
// does not cover the next N days (default 7). Used to gate the scheduled
// rebuild: a rebuild that produces something worse than what we have must not
// be kept, and one that produces nothing must not go unnoticed.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTimetable, serviceDateNum } from "./fetch-live.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "data", "ret-timetable.bin");
const i = process.argv.indexOf("--days");
const DAYS = i >= 0 ? Math.max(1, +process.argv[i + 1] || 7) : 7;
const MIN_TRIPS = 20000; // Rotterdam runs ~11k-13k trips on a weekday

function fail(msg) {
  console.error(`timetable check FAILED: ${msg}`);
  process.exit(1);
}

if (!existsSync(BIN)) fail(`${BIN} does not exist`);

let tt;
try {
  tt = loadTimetable();
} catch (e) {
  fail(`could not parse it — ${e.message}`);
}

if (tt.trips.length < MIN_TRIPS) fail(`only ${tt.trips.length} trips, expected at least ${MIN_TRIPS}`);

// Every service date the file knows about, and how many trips run on each of
// the days we are about to need.
const perDay = new Map();
for (const t of tt.trips) for (const d of tt.dateSets[t.dates]) perDay.set(d, (perDay.get(d) || 0) + 1);

const missing = [];
const thin = [];
for (let k = 0; k < DAYS; k++) {
  const date = serviceDateNum(new Date(Date.now() + k * 86_400_000));
  const n = perDay.get(date) ?? 0;
  if (!n) missing.push(date);
  // a Sunday is genuinely lighter than a Tuesday, so this only catches a day
  // that is nearly empty rather than one that is merely quiet
  else if (n < 1000) thin.push(`${date} (${n})`);
}

const dates = [...perDay.keys()].sort();
console.log(`${tt.trips.length} trips, ${tt.stops.length} stops, ${dates.length} service dates`);
console.log(`covers ${dates[0]} → ${dates[dates.length - 1]}`);
if (missing.length) fail(`no service on ${missing.join(", ")} — the calendar has run out`);
if (thin.length) fail(`suspiciously few trips on ${thin.join(", ")}`);

const today = serviceDateNum(new Date());
const left = dates.filter((d) => d >= today).length;
console.log(`next ${DAYS} days all covered; ${left} service dates remain`);
if (left < 21) console.log(`  NOTE: only ${left} days of calendar left — a refresh is due`);
