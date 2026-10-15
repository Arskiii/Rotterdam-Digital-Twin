// The one place a build script learns which city it is building.
//
// Everything that used to be pasted at the top of each script — the coverage
// bbox, the projection origin, the district seeds — comes from
// city.config.json at the repository root. A second city is a second config
// file, selected with CITY_CONFIG=path/to/other.json.

import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = process.env.CITY_CONFIG ? resolve(process.env.CITY_CONFIG) : join(ROOT, "city.config.json");

export const CITY = JSON.parse(readFileSync(file, "utf8"));
export const ORIGIN = CITY.origin;
export const BBOX = CITY.bbox;
export const M_PER_LAT = 110574;
export const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
export const px = (lon) => (lon - ORIGIN.lon) * M_PER_LON;
export const py = (lat) => (lat - ORIGIN.lat) * M_PER_LAT;
export const DISTRICTS = CITY.districts.map((d) => ({ ...d, x: px(d.lon), y: py(d.lat) }));
