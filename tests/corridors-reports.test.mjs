import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { after, test } from "node:test";
import { createServer } from "vite";
import findHistory from "../scripts/find_history_artifact.cjs";

const vite = await createServer({ configFile: false,
  server: { middlewareMode: true, hmr: { server: createHttpServer() } } });
after(() => vite.close());
const { World } = await vite.ssrLoadModule("/src/sim/world.ts");
const { simulateScenario } = await vite.ssrLoadModule("/src/v03/scenario.ts");
const { selectedCorridor, corridorReadings, freshness, historyGapLabel } = await vite.ssrLoadModule("/src/v03/corridors.ts");
const { packNetwork, unpackNetwork } = await vite.ssrLoadModule("/src/lab/networkSnapshot.ts");
const { sealReport, parseReport, saveReport, readSavedReports, deleteReport, MODEL_VERSION } = await vite.ssrLoadModule("/src/lab/reports.ts");
const { stageHandoff, readHandoff } = await vite.ssrLoadModule("/src/lab/handoff.ts");
const { mean, metricChange } = await vite.ssrLoadModule("/src/lab/presentation.ts");

test("result summaries preserve missing values, real zeroes and objective direction", () => {
  assert.equal(mean([null, NaN, Infinity]), null);
  assert.equal(mean([null, 0, 10]), 5);
  assert.deepEqual(metricChange(null, 12, 1, "higher"), { text: "—", tone: "neutral" });
  assert.deepEqual(metricChange(20, 18.2, 1, "lower"), { text: "-1.8", tone: "positive" });
  assert.deepEqual(metricChange(20, 18.2, 1, "higher"), { text: "-1.8", tone: "negative" });
  assert.deepEqual(metricChange(0, 12, 0, "higher"), { text: "+12", tone: "positive" });
  assert.deepEqual(metricChange(50, 60, 1), { text: "+10.0", tone: "neutral" });
  assert.deepEqual(metricChange(1, .999, 1, "lower"), { text: "0.0", tone: "neutral" });
  assert.deepEqual(metricChange(1, Infinity, 1, "lower"), { text: "—", tone: "neutral" });
});

const settings = { mode: "fixed", demandPerHour: 600, preference: 0.5, cycleMin: 40, cycleMax: 90,
  minGreen: 6, maxGreen: 30, passageTime: 2.5 };
const origin = { lat: 51.915, lon: 4.482 };
const reading = { id: "detector", name: "Example", ...origin, observedAt: "2026-10-18T06:00:00.000Z", speedKmh: 0, vehiclesPerHour: null };
const run = { completed: 12, travelTimeSec: 20, waitSec: 1, throughputPerHour: 144, demandMet: 0.8,
  avgQueue: 2, corridorFlowPerHour: 0, corridorSpeedKmh: null };
const json = (value) => JSON.parse(JSON.stringify(value));

async function report() {
  return sealReport({ name: "Trial", network: packNetwork(new World(42).net), origin,
    corridorEdgeId: "i_0_0->i_1_0", observedDetector: null, observations: [],
    seeds: [42, 99, 123], warmupSeconds: 60, measurementSeconds: 300,
    baseline: { config: settings, runs: [run, run, run] }, candidate: { config: { ...settings, mode: "actuated" }, runs: [run, run, run] } });
}

test("portable graph retains order, geometry, lane movements and exact seeded simulation results", async () => {
  const net = new World(42).net;
  const restored = unpackNetwork(json(packNetwork(net)));
  assert.deepEqual(json(packNetwork(restored)), json(packNetwork(net)));
  const corridor = selectedCorridor(net, "i_0_0->i_1_0");
  const original = await simulateScenario(net, settings, 99, corridor, () => {}, undefined, () => Promise.resolve());
  const replay = await simulateScenario(restored, settings, 99, corridor, () => {}, undefined, () => Promise.resolve());
  assert.deepEqual(replay, original);
  assert.ok(original.completed > 0);
});

test("network imports reject broken references, phases, oversized lane geometry and duplicates", () => {
  const base = json(packNetwork(new World(42).net));
  for (const mutate of [
    (v) => { v.edges[0].outgoing = ["missing->edge"]; },
    (v) => { v.edges[0].laneOffsets[0] = [1e8, 0]; },
    (v) => { v.nodes[0].phaseOf = [["missing->edge", 0]]; },
    (v) => { v.edges.push(v.edges[0]); },
    (v) => { v.entries = [v.exits[0]]; },
    (v) => { v.edges[0].speedLimit = Infinity; },
  ]) {
    const input = structuredClone(base); mutate(input); assert.throws(() => unpackNetwork(input), /Invalid saved road network/);
  }
});

test("corridor coverage associates each detector only with its nearest mapped section", () => {
  const net = new World(42).net;
  const edge = net.edges.get("i_0_0->i_1_0");
  const midpoint = { x: (edge.start.x + edge.end.x) / 2, y: (edge.start.y + edge.end.y) / 2 };
  const row = { ...reading, lat: origin.lat - midpoint.y / 111320,
    lon: origin.lon + midpoint.x / (111320 * Math.cos(origin.lat * Math.PI / 180)) };
  const matched = selectedCorridor(net, edge.id);
  assert.equal(corridorReadings(net, [row], origin, matched).length, 1);
  assert.equal(corridorReadings(net, [row], origin, selectedCorridor(net, "i_1_0->i_2_0")).length, 0);
  assert.equal(selectedCorridor(net, "unknown"), null);
  assert.equal(selectedCorridor(net, [...net.edges.values()].find((e) => net.entries.includes(e.from)).id), null);
  assert.match(freshness(reading.observedAt, Date.parse("2026-10-18T08:00:00Z")), /^Historical/);
  assert.match(freshness("2099-01-01T00:00:00Z"), /^Invalid/);
  assert.equal(historyGapLabel([reading]), "");
  assert.match(historyGapLabel([reading, { ...reading, observedAt: "2026-10-19T06:00:00.000Z" }]), /24.0 hours/);
});

test("reports verify embedded datasets and reject altered graphs, observations, settings or results", async () => {
  const source = await report();
  const reopened = await parseReport(JSON.stringify(source));
  assert.equal(reopened.modelVersion, MODEL_VERSION);
  assert.deepEqual(json(reopened), json(source));
  for (const mutate of [
    (v) => { v.network.edges[0].speedLimit += 1; },
    (v) => { v.observations = [reading]; },
    (v) => { v.baseline.config.demandPerHour = -1; },
    (v) => { v.candidate.runs[0].waitSec = -1; },
    (v) => { v.seeds = [42, 42, 99]; },
    (v) => { v.corridorEdgeId = "missing"; },
  ]) {
    const input = json(source); mutate(input); await assert.rejects(parseReport(JSON.stringify(input)));
  }
  // Old model reports may be inspected, but the UI refuses to run them as this model.
  const older = { ...source, modelVersion: "older-model" };
  assert.equal((await parseReport(JSON.stringify(older))).modelVersion, "older-model");
  await assert.rejects(parseReport(' '.repeat(2_000_001)), /2 MB/);
});

test("report storage replaces by name, bounds collection size and leaves existing data on quota failure", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map();
  let blocked = false;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { if (blocked) throw new Error("Quota exceeded"); data.set(key, value); },
  } });
  try {
    const source = await report();
    saveReport(source); saveReport({ ...source, name: "Second" }); saveReport({ ...source, name: "Third" });
    assert.equal(readSavedReports().length, 3);
    saveReport({ ...source, name: "Trial", createdAt: "2026-10-18T08:00:00Z" });
    assert.equal(readSavedReports().length, 3);
    assert.throws(() => saveReport({ ...source, name: "Fourth" }), /Three reports/);
    const before = [...data.entries()]; blocked = true;
    assert.throws(() => saveReport(source), /Quota/);
    assert.deepEqual([...data.entries()], before);
    blocked = false; deleteReport("Second");
    assert.equal(readSavedReports().length, 2);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage;
  }
});

test("handoff preserves session road edits and rejects expired, wrong-road or unavailable transfers", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  let raw;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: () => raw ?? null, setItem: (_key, value) => { raw = value; },
  } });
  try {
    const net = new World(42).net;
    const edgeId = "i_0_0->i_1_0";
    net.edges.get(edgeId).name = "Edited road";
    const token = stageHandoff(net, origin, edgeId, [reading]);
    const restored = readHandoff(token, edgeId);
    assert.equal(restored.network.edges.get(edgeId).name, "Edited road");
    assert.equal(restored.readings[0].speedKmh, 0);
    assert.throws(() => readHandoff(token, "i_1_0->i_2_0"), /invalid or expired/);
    const expired = JSON.parse(raw); expired.createdAt -= 3 * 60 * 60_000; raw = JSON.stringify(expired);
    assert.throws(() => readHandoff(token, edgeId), /expired/);
    raw = null; assert.throws(() => readHandoff(token, edgeId), /unavailable/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); else delete globalThis.sessionStorage;
  }
});

test("history artifact restore chooses newest same-branch repository artifact and handles first run", async () => {
  const now = Date.now();
  const artifact = (id, branch, repository = 1) => ({ id, name: "traffic-history-v1", expired: false,
    created_at: new Date(now - (100 - id) * 1000).toISOString(), expires_at: new Date(now + 86400000).toISOString(),
    workflow_run: { id, head_branch: branch, head_repository_id: repository } });
  const all = [artifact(2, "main"), artifact(3, "dev"), artifact(4, "main", 99), artifact(1, "main"),
    { ...artifact(5, "main"), expired: true }, artifact(10, "main")];
  let output;
  const core = { setOutput: (_key, value) => { output = value; }, info() {}, notice() {} };
  const context = { ref: "refs/heads/main", runId: 10, repo: { owner: "example", repo: "twin" }, payload: { repository: { id: 1 } } };
  const github = { rest: { actions: { listArtifactsForRepo: "list" } }, paginate: async (_method, params) => {
    assert.equal(params.name, "traffic-history-v1"); return all;
  } };
  await findHistory({ github, context, core }); assert.equal(output, "2");
  context.ref = "refs/heads/first-run";
  await findHistory({ github, context, core }); assert.equal(output, "");
});
