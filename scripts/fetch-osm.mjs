#!/usr/bin/env node
// Fetch raw OpenStreetMap data for greater Rotterdam via Overpass API.
// Tiled + resumable: every response is cached in data/raw/, rerunning skips
// finished tiles. Output feeds scripts/build-data.mjs.

import { mkdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
mkdirSync(RAW, { recursive: true });

// Greater Rotterdam: every city district (Hoogvliet → Nesselande, Overschie →
// IJsselmonde) plus the full A4/A15/A16/A20 motorway ring and the adjoining
// municipalities (Schiedam, Capelle) so the network doesn't dead-end at the
// city limits. The far-west port (Botlek/Europoort/Maasvlakte) and Hoek van
// Holland are excluded: 25 km of near-empty industrial terrain.
export const BBOX = { s: 51.84, w: 4.34, n: 52.0, e: 4.62 };

const ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const HIGHWAY_RE =
  "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian|busway)$";

let endpointIdx = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[endpointIdx % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "rotterdam-intelligence-platform/1.0 (research; contact via github)",
        },
        signal: AbortSignal.timeout(300_000),
      });
      const text = await res.text();
      if (!res.ok || text.trimStart().startsWith("<")) {
        throw new Error(`HTTP ${res.status} ${text.slice(0, 120).replace(/\n/g, " ")}`);
      }
      const json = JSON.parse(text);
      if (json.remark && /error/i.test(json.remark)) throw new Error(json.remark);
      return json;
    } catch (err) {
      console.warn(`  ! ${label} attempt ${attempt + 1} via ${new URL(url).host}: ${err.message ?? err}`);
      endpointIdx++; // rotate mirror
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(`${label}: all attempts failed`);
}

function tileBoxes(nx, ny, pad = 0) {
  const boxes = [];
  const dw = (BBOX.e - BBOX.w) / nx;
  const dh = (BBOX.n - BBOX.s) / ny;
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      boxes.push({
        id: `${x}-${y}`,
        s: BBOX.s + y * dh - pad,
        w: BBOX.w + x * dw - pad,
        n: BBOX.s + (y + 1) * dh + pad,
        e: BBOX.w + (x + 1) * dw + pad,
      });
  return boxes;
}

const bboxStr = (b) => `${b.s},${b.w},${b.n},${b.e}`;

async function fetchToFile(name, query, label) {
  const file = join(RAW, name);
  if (existsSync(file) && statSync(file).size > 100) {
    console.log(`  = ${label} (cached)`);
    return;
  }
  const t0 = Date.now();
  const json = await overpass(query, label);
  writeFileSync(file, JSON.stringify(json));
  const mb = (statSync(file).size / 1e6).toFixed(1);
  console.log(`  + ${label}: ${json.elements.length} elements, ${mb} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await sleep(1200); // be polite between requests
}

async function runQueue(jobs, concurrency) {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      await job();
    }
  });
  await Promise.all(workers);
}

async function main() {
  const only = process.argv[2]; // optional: roads|signals|buildings|water|rail

  // ---- traffic signals: single query, the full inventory --------------------
  if (!only || only === "signals") {
    console.log("Traffic signals…");
    await fetchToFile(
      "signals.json",
      `[out:json][timeout:180];(node["highway"="traffic_signals"](${bboxStr(BBOX)});node["crossing"="traffic_signals"](${bboxStr(BBOX)}););out body qt;`,
      "signals"
    );
  }

  // ---- roads: 4x4 tiles -----------------------------------------------------
  if (!only || only === "roads") {
    console.log("Road network (16 tiles)…");
    const jobs = tileBoxes(4, 4).map((b) => () =>
      fetchToFile(
        `roads-${b.id}.json`,
        `[out:json][timeout:240];way["highway"~"${HIGHWAY_RE}"](${bboxStr(b)});out geom qt;`,
        `roads ${b.id}`
      )
    );
    await runQueue(jobs, 2);
  }

  // ---- water ----------------------------------------------------------------
  if (!only || only === "water") {
    console.log("Water polygons…");
    await fetchToFile(
      "water-ways.json",
      `[out:json][timeout:240];(way["natural"="water"](${bboxStr(BBOX)});way["waterway"="riverbank"](${bboxStr(BBOX)}););out geom qt;`,
      "water ways"
    );
    await fetchToFile(
      "water-rels.json",
      `[out:json][timeout:300];(relation["natural"="water"](${bboxStr(BBOX)});relation["waterway"="riverbank"](${bboxStr(BBOX)}););out geom qt;`,
      "water relations"
    );
  }

  // ---- cycle & foot paths: 4x4 tiles (bike/pedestrian networks) -------------
  if (!only || only === "paths") {
    console.log("Cycle & foot paths (16 tiles)…");
    const jobs = tileBoxes(4, 4).map((b) => () =>
      fetchToFile(
        `paths-${b.id}.json`,
        `[out:json][timeout:240];way["highway"~"^(cycleway|footway|path)$"](${bboxStr(b)});out geom qt;`,
        `paths ${b.id}`
      )
    );
    await runQueue(jobs, 2);
  }

  // ---- rail (visual layer: rail / metro / tram) -----------------------------
  if (!only || only === "rail") {
    console.log("Rail…");
    await fetchToFile(
      "rail.json",
      `[out:json][timeout:240];way["railway"~"^(rail|light_rail|subway|tram)$"](${bboxStr(BBOX)});out geom qt;`,
      "rail"
    );
  }

  // ---- district boundaries (gebieden / wijken) ------------------------------
  if (!only || only === "districts") {
    console.log("District boundaries…");
    await fetchToFile(
      "districts.json",
      `[out:json][timeout:300];relation["boundary"="administrative"]["admin_level"~"^(9|10)$"](${bboxStr(BBOX)});out geom qt;`,
      "district boundaries"
    );
  }

  // ---- transit routes (RET tram + metro service patterns) -------------------
  if (!only || only === "transit") {
    console.log("Transit routes…");
    await fetchToFile(
      "transit.json",
      `[out:json][timeout:300];relation["type"="route"]["route"~"^(tram|subway|light_rail)$"](${bboxStr(BBOX)});out geom qt;`,
      "transit routes"
    );
  }

  // ---- buildings: 6x6 tiles, ways + multipolygon relations ------------------
  if (!only || only === "buildings") {
    console.log("Buildings (36 tiles + relations)…");
    await fetchToFile(
      "buildings-rels.json",
      `[out:json][timeout:300];relation["building"](${bboxStr(BBOX)});out geom qt;`,
      "building relations"
    );
    const jobs = tileBoxes(6, 6).map((b) => () =>
      fetchToFile(
        `buildings-${b.id}.json`,
        `[out:json][timeout:300];way["building"](${bboxStr(b)});out geom qt;`,
        `buildings ${b.id}`
      )
    );
    await runQueue(jobs, 2);
    // building:part carries the real tower massing (heights live on parts,
    // outlines often only describe the podium) — build-data extrudes both.
    console.log("Building parts (36 tiles)…");
    const partJobs = tileBoxes(6, 6).map((b) => () =>
      fetchToFile(
        `buildings-parts-${b.id}.json`,
        `[out:json][timeout:300];way["building:part"](${bboxStr(b)});out geom qt;`,
        `building parts ${b.id}`
      )
    );
    await runQueue(partJobs, 2);
  }

  console.log("Done. Raw data in data/raw/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
