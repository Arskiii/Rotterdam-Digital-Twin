#!/usr/bin/env node
// Publish the already validated daily Actions cache as one atomic reference
// bundle. No national GTFS download or timetable rebuild happens in a Function.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dir = process.env.TRANSIT_DATA_DIR || "data";
const bundle = {
  v: 1,
  routes: JSON.parse(readFileSync(join(dir, "gtfs-routes.json"), "utf8")),
  stops: JSON.parse(readFileSync(join(dir, "gtfs-stops.json"), "utf8")),
  timetable: readFileSync(join(dir, "ret-timetable.bin")).toString("base64"),
};
writeFileSync(process.argv[2], gzipSync(JSON.stringify(bundle)));
