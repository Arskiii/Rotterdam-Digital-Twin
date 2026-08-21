#!/usr/bin/env node
// The national route table: route_id → [operator, line, route_type].
//
//   node scripts/fetch-gtfs-routes.mjs        (npm run fetch-routes)
//
// This is the lookup that gives a live vehicle its identity. fetch-live reads
// a GTFS-RT position, takes its route_id, and finds the operator, the line
// number painted on the front, and whether it is a tram, metro, bus or ferry.
// A route_id missing from this table is a vehicle dropped from the snapshot
// entirely — so a stale table does not degrade the map, it silently empties
// parts of it. fetch-gtfs-timetable reads the same file to decide which routes
// are worth extracting a schedule for.
//
// The file was hand-made once and had no producer, which is why this exists.
//
// routes.txt and agency.txt are a few hundred KB between them, so this is
// seconds over range reads rather than a download of the 215 MB zip.
//
// Behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1 (the npm script sets it).

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zipIndex, findEntry, readEntry, splitCsv, header } from "./lib/gtfs-zip.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "gtfs-routes.json");

function rows(text) {
  const lines = text.split("\n");
  const cols = header(lines[0]);
  return { cols, lines: lines.slice(1) };
}

async function main() {
  console.log("reading the national GTFS zip index over range requests…");
  const entries = await zipIndex();

  // agency.txt first: routes.txt carries an agency_id, and what we want on
  // screen is the operator's name
  const agencyEntry = findEntry(entries, "agency.txt");
  if (!agencyEntry) throw new Error("agency.txt not present in the zip");
  const agencies = new Map();
  {
    const { cols, lines } = rows((await readEntry(agencyEntry)).toString("utf8"));
    const cId = cols.indexOf("agency_id");
    const cName = cols.indexOf("agency_name");
    if (cName < 0) throw new Error("agency.txt has no agency_name column");
    for (const line of lines) {
      if (!line.trim()) continue;
      const f = splitCsv(line);
      agencies.set(cId >= 0 ? f[cId] : "", f[cName]);
    }
    console.log(`  ${agencies.size} operators`);
  }

  const routesEntry = findEntry(entries, "routes.txt");
  if (!routesEntry) throw new Error("routes.txt not present in the zip");
  const out = {};
  const byType = {};
  {
    const { cols, lines } = rows((await readEntry(routesEntry)).toString("utf8"));
    const cId = cols.indexOf("route_id");
    const cAgency = cols.indexOf("agency_id");
    const cShort = cols.indexOf("route_short_name");
    const cLong = cols.indexOf("route_long_name");
    const cType = cols.indexOf("route_type");
    if (cId < 0 || cType < 0) throw new Error("routes.txt is missing route_id or route_type");
    for (const line of lines) {
      if (!line.trim()) continue;
      const f = splitCsv(line);
      const type = +f[cType];
      if (!Number.isFinite(type)) continue;
      // long name is the fallback for services that carry no number — NS
      // Intercity and Sprinter are the ones this actually catches
      const label = (cShort >= 0 ? f[cShort] : "") || (cLong >= 0 ? f[cLong] : "");
      out[f[cId]] = [agencies.get(cAgency >= 0 ? f[cAgency] : "") ?? "", label, type];
      byType[type] = (byType[type] || 0) + 1;
    }
  }

  const n = Object.keys(out).length;
  if (!n) throw new Error("no routes parsed — the columns in routes.txt may have moved");
  // A national feed that suddenly holds a fraction of what it did is a bad
  // feed, not a smaller country. Refuse to overwrite a good table with it.
  if (existsSync(OUT)) {
    const prev = Object.keys(JSON.parse(readFileSync(OUT, "utf8"))).length;
    if (n < prev * 0.5) {
      throw new Error(`refusing to write ${n} routes over the existing ${prev} — the feed looks truncated`);
    }
  }
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`  ${n} routes by type ${JSON.stringify(byType)}  (0 tram · 1 metro · 2 rail · 3 bus · 4 ferry)`);
  console.log(`routes → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
