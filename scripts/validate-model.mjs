#!/usr/bin/env node
// Score the simulation against what NDW's road sensors measured, and publish
// the score.
//
//   node scripts/validate-model.mjs --archive <archive work tree>
//        [--days 45] [--seeds 1,2,3] [--density 5200] [--out public/data/model-validation.json]
//
// For each time slot (morning peak, midday, evening peak) this takes the
// median of every station's archived weekday readings within ±30 minutes,
// runs the engine headless from the same seeds at that time of day, and
// compares flow and speed station by station. A 20% held-out sample of
// stations (the same stable edge hash the Intelligence page uses) is never
// used to fit the one flow scale, so its error is an honest out-of-sample
// figure. Corridor rows group stations by motorway number or street name.
//
// The archive is the `archive` branch: `git worktree add /tmp/archive origin/archive`.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { CITY } from "./lib/city.mjs";
import { bundleEngine, runExperiment } from "./lib/sim-host.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const ARCHIVE = arg("--archive", null);
const DAYS = Number(arg("--days", "45")); // the fine tier keeps 45 days
const SEEDS = arg("--seeds", "1,2,3").split(",").map(Number);
const DENSITY = Number(arg("--density", "5200")); // the live map's default
const OUT = arg("--out", join(ROOT, "public", "data", "model-validation.json"));
const WARMUP = 120, MEASURE = 300, WINDOW_MIN = 30;
const SLOTS = [
  { label: "Morning peak", clockMin: 8 * 60 },
  { label: "Midday", clockMin: 12 * 60 + 30 },
  { label: "Evening peak", clockMin: 17 * 60 },
];
if (!ARCHIVE || !existsSync(join(ARCHIVE, "f"))) {
  console.error("usage: validate-model.mjs --archive <archive work tree with f/YYYY/MM/DD/HH.bin>");
  process.exit(2);
}

// ---------------- measured: archived weekday medians per slot ----------------

const localParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: CITY.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
});
function local(ms) {
  const p = Object.fromEntries(localParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** Every fine-tier record: { t, flows: Uint16Array, speeds: Uint8Array }. */
function* fineRecords(stationCount, fromMs) {
  const base = join(ARCHIVE, "f");
  for (const y of readdirSync(base).sort()) for (const m of readdirSync(join(base, y)).sort()) for (const d of readdirSync(join(base, y, m)).sort()) {
    for (const file of readdirSync(join(base, y, m, d)).sort()) {
      const hourStart = Date.UTC(+y, +m - 1, +d, parseInt(file, 10));
      if (hourStart + 3_600_000 < fromMs) continue;
      const buf = readFileSync(join(base, y, m, d, file));
      if (buf.length < 14 || buf.toString("ascii", 0, 4) !== "RTAF") continue;
      if (buf.readUInt16LE(10) !== stationCount) continue; // a different station table
      const hourEpoch = buf.readUInt32LE(6), records = buf.readUInt16LE(12), size = 1 + stationCount * 3;
      for (let r = 0; r < records; r++) {
        const p = 14 + r * size;
        if (p + size > buf.length) break;
        const flows = new Uint16Array(stationCount), speeds = new Uint8Array(stationCount);
        for (let i = 0; i < stationCount; i++) {
          flows[i] = buf.readUInt16LE(p + 1 + i * 3);
          speeds[i] = buf.readUInt8(p + 3 + i * 3);
        }
        yield { t: (hourEpoch + buf.readUInt8(p) * 60) * 1000, flows, speeds };
      }
    }
  }
}

// ---------------- main ----------------

async function main() {
  const ndw = JSON.parse(readFileSync(join(ROOT, "public", "data", "ndw.json"), "utf8"));
  const meta = JSON.parse(readFileSync(join(ROOT, "public", "data", "meta.json"), "utf8"));
  const raw = readFileSync(join(ROOT, "public", "data", "graph.bin"));
  const graphBuf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const n = ndw.stations.length;

  console.log("bundling the engine …");
  const urls = await bundleEngine();
  const { parseGraph } = await import(urls.loader);
  const V = await import(urls.validation);
  const { heldoutStations } = await import(urls.model);
  const graph = parseGraph(graphBuf.slice(0));
  const heldEdges = new Set(heldoutStations(ndw.stations.map((s) => ({ edge: s.edge, flow: 1 }))).map((s) => s.edge));

  // newest archived record decides the window's end
  let newest = 0;
  for (const rec of fineRecords(n, 0)) newest = Math.max(newest, rec.t);
  if (!newest) throw new Error("no fine-tier records match the current station table");
  const fromMs = newest - DAYS * 86_400_000;

  const samples = SLOTS.map(() => ({ flows: Array.from({ length: n }, () => []), speeds: Array.from({ length: n }, () => []), days: new Set(), readings: 0 }));
  const weekdays = new Set();
  for (const rec of fineRecords(n, fromMs)) {
    if (rec.t < fromMs) continue;
    const at = local(rec.t);
    if (at.weekday === "Sat" || at.weekday === "Sun") continue;
    weekdays.add(at.day);
    SLOTS.forEach((slot, k) => {
      if (Math.abs(at.min - slot.clockMin) > WINDOW_MIN) return;
      const bucket = samples[k];
      bucket.days.add(at.day);
      bucket.readings++;
      for (let i = 0; i < n; i++) {
        // 65535 is the archive's clamp: the true flow is unknown, so skip it
        if (rec.flows[i] > 0 && rec.flows[i] < 65535) bucket.flows[i].push(rec.flows[i]);
        if (rec.speeds[i] > 0) bucket.speeds[i].push(rec.speeds[i]);
      }
    });
  }

  const workers = Math.max(1, Math.min(availableParallelism() - 1, 4));
  const slots = [];
  for (const [k, slot] of SLOTS.entries()) {
    const bucket = samples[k];
    const observed = ndw.stations.map((s, i) => ({
      edge: s.edge,
      flow: bucket.flows[i].length >= 3 ? V.median(bucket.flows[i]) : 0,
      kmh: bucket.speeds[i].length >= 3 ? V.median(bucket.speeds[i]) : null,
    }));
    console.log(`${slot.label}: ${bucket.readings} archived readings on ${bucket.days.size} weekdays; running ${SEEDS.length} seeds …`);
    const stations = observed.filter((o) => o.edge >= 0).map((o) => ({ edge: o.edge, flow: o.flow }));
    const results = [];
    for (let i = 0; i < SEEDS.length; i += workers) {
      const batch = SEEDS.slice(i, i + workers).map((seed) => runExperiment(urls.worker, graphBuf, meta.districts,
        { seed, program: "actuated", clockMin: slot.clockMin, density: DENSITY, warmupSec: WARMUP, measureSec: MEASURE, stations }));
      results.push(...(await Promise.all(batch)));
    }
    // mean over seeds, per station edge
    const simByEdge = new Map();
    for (const result of results) for (const row of result.stationFlows) {
      const acc = simByEdge.get(row.edge) ?? { flow: 0, kmh: 0, kmhN: 0 };
      acc.flow += row.simulated / results.length;
      if (row.simulatedKmh !== null) { acc.kmh += row.simulatedKmh; acc.kmhN++; }
      simByEdge.set(row.edge, acc);
    }
    const rows = ndw.stations.map((s, i) => {
      const sim = simByEdge.get(s.edge);
      const motorway = s.cls === 0;
      return {
        edge: s.edge,
        corridor: V.corridorOf(s.name, graph.names[graph.edges.nameIdx[s.edge]] ?? "", motorway),
        motorway,
        heldOut: heldEdges.has(s.edge),
        obsFlow: observed[i].flow,
        simFlow: sim?.flow ?? 0,
        obsKmh: observed[i].kmh,
        simKmh: sim && sim.kmhN ? sim.kmh / sim.kmhN : null,
      };
    }).filter((row) => row.edge >= 0 && (row.obsFlow > 0 || row.obsKmh !== null));
    const scale = V.fitFlowScale(rows);
    const held = rows.filter((row) => row.heldOut);
    const groups = new Map();
    for (const row of rows) groups.set(row.corridor, [...(groups.get(row.corridor) ?? []), row]);
    const corridors = [...groups].filter(([, list]) => list.length >= 3)
      .map(([corridor, list]) => ({ corridor, motorway: list[0].motorway, ...V.score(list, scale) }))
      .sort((a, b) => b.stations - a.stations || a.corridor.localeCompare(b.corridor));
    slots.push({
      label: slot.label, clockMin: slot.clockMin,
      observedDays: bucket.days.size, observedReadings: bucket.readings,
      flowScale: Math.round(scale * 100) / 100,
      heldOut: V.score(held, scale),
      motorway: V.score(held.filter((row) => row.motorway), scale),
      urban: V.score(held.filter((row) => !row.motorway), scale),
      corridors,
    });
    const h = slots.at(-1).heldOut;
    console.log(`  held-out: ${h.stations} stations, flow WMAPE ${h.flowWmapePct}%, GEH<5 ${h.gehUnder5Pct}%, rank r ${h.rankCorrelation}, speed MAE ${h.speedMaeKmh} km/h (bias ${h.speedBiasKmh})`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: new Date(fromMs).toISOString(), to: new Date(newest).toISOString(), weekdays: weekdays.size },
    runs: { seeds: SEEDS, density: DENSITY, warmupSec: WARMUP, measureSec: MEASURE, program: "actuated" },
    slots,
    method: `Measured: median of each NDW station's archived weekday readings within ±${WINDOW_MIN} min of the slot (at least 3 readings). Simulated: mean over ${SEEDS.length} seeds of a ${MEASURE} s measurement after a ${WARMUP} s warmup at the live map's default density, actuated signals, clock held at the slot. One city-wide flow scale is fitted on the 80% calibration stations; held-out figures use the other 20% only. Corridor rows use all stations and so share that fitted scale.`,
    limitations: [
      "NDW stations combine every lane and both directions within 30 m; the simulation counts the one matched road edge, so parallel carriageways and ramps are a source of error the model cannot remove.",
      "NDW speed is a detector average; simulated speed is the mean speed of cars on the matched edge. They measure the same road, not the same quantity.",
      "Few city streets carry NDW sensors, so motorway figures rest on far more stations than urban ones.",
      "The archive is sampled when the publishing job runs, not every five minutes, so some slots rest on few days.",
      "A flow error this size means the model shows plausible patterns, not forecasts fit for operational decisions.",
    ],
    references: [
      { label: "GEH statistic and the 85%-of-links criterion: DfT TAG unit M3.1, Highway Assignment Modelling", url: "https://www.gov.uk/government/publications/tag-unit-m3-1-highway-assignment-modelling" },
      { label: "NDW open data", url: "https://opendata.ndw.nu/" },
    ],
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  console.log(`wrote ${OUT}`);
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
