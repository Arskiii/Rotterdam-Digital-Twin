import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { after, test } from "node:test";
import { Color, Matrix4, Raycaster, Vector3 } from "three";
import { createServer } from "vite";

const vite = await createServer({ configFile: false,
  server: { middlewareMode: true, hmr: { server: createHttpServer() } } });
after(() => vite.close());
const { World } = await vite.ssrLoadModule("/src/sim/world.ts");
const { Metrics } = await vite.ssrLoadModule("/src/sim/metrics.ts");
const { makeVehicle } = await vite.ssrLoadModule("/src/sim/vehicle.ts");
const { VehicleRenderer } = await vite.ssrLoadModule("/src/render/vehicles.ts");
const { buildNetworkMesh, roadEdgesForHit } = await vite.ssrLoadModule("/src/render/network.ts");
const { buildTrafficLightMeshes } = await vite.ssrLoadModule("/src/render/lights.ts");
const { simulateScenario } = await vite.ssrLoadModule("/src/v03/scenario.ts");
const { ScenarioRunner } = await vite.ssrLoadModule("/src/lab/scenarioRunner.ts");

function mockGlobal(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
}

test("vehicle buffers draw only active cars and replace a full population in the same frame", () => {
  const { net } = new World(42);
  const edge = net.edges.values().next().value;
  const car = () => makeVehicle([edge.id], 0, 5, 10);
  const renderer = new VehicleRenderer(2);
  assert.equal(renderer.mesh.count, 0);
  renderer.sync([car(), car()], net);
  assert.equal(renderer.mesh.count, 2);
  const replacement = car(); replacement.s = 25;
  renderer.sync([replacement], net);
  assert.equal(renderer.mesh.count, 1);
  const matrix = new Matrix4(); renderer.mesh.getMatrixAt(0, matrix);
  assert.equal(matrix.elements[12], edge.start.x + edge.dir.x * 25 + edge.laneOffsets[0].x);
  assert.deepEqual(renderer.mesh.instanceMatrix.updateRanges, [{ start: 0, count: 16 }]);
  renderer.sync([], net);
  assert.equal(renderer.mesh.count, 0);
});

test("vehicle colours survive buffer compaction and renderer capacity stays bounded", () => {
  const { net } = new World(42);
  const id = net.edges.keys().next().value;
  const a = makeVehicle([id], 0, 5, 10), b = makeVehicle([id], 0, 5, 10);
  const renderer = new VehicleRenderer(2);
  renderer.sync([a, b], net);
  const before = new Color(); renderer.mesh.getColorAt(1, before);
  renderer.sync([b], net);
  const after = new Color(); renderer.mesh.getColorAt(0, after);
  assert.ok(before.equals(after));
  renderer.sync([a, b, makeVehicle([id], 0, 5, 10)], net);
  assert.equal(renderer.mesh.count, 2);
});

test("batched road ribbons retain corridor picking for both directions", () => {
  const { net } = new World(42);
  const mesh = buildNetworkMesh(net);
  const roads = mesh.group.children.filter((child) => child.userData.corridorEdges);
  assert.equal(roads.length, 1, "all road ribbons share one draw");
  assert.ok(mesh.group.children.length < 45, "decorations and roads stay batched");
  mesh.group.updateMatrixWorld(true);
  for (const ids of roads[0].userData.corridorEdges) {
    const edge = net.edges.get(ids[0]);
    const ray = new Raycaster(new Vector3((edge.start.x + edge.end.x) / 2, 100,
      (edge.start.y + edge.end.y) / 2), new Vector3(0, -1, 0));
    const hit = ray.intersectObject(mesh.group, true).find((hit) => roadEdgesForHit(hit).includes(edge.id));
    assert.ok(hit, `road ${edge.id} remains selectable`);
    assert.deepEqual(roadEdgesForHit(hit), ids);
  }
});

test("signal poles sit on the right shoulder rather than inside the traffic lane", () => {
  const { net } = new World(42);
  for (const handle of buildTrafficLightMeshes(net).handles) {
    const edge = net.edges.get(handle.edgeId);
    const lane = edge.laneOffsets[0];
    const x = handle.mesh.position.x - (edge.end.x - edge.dir.x * 6 + lane.x);
    const y = handle.mesh.position.z - (edge.end.y - edge.dir.y * 6 + lane.y);
    assert.ok(Math.abs(x * -edge.dir.y + y * edge.dir.x - 1.6) < 1e-8);
  }
});

test("actuated detectors include vehicles at the stop line of a short approach", () => {
  const world = new World(42);
  world.spawner.carsPerHour = 0;
  const edge = [...world.net.edges.values()].find((edge) => world.net.nodes.get(edge.to)?.phaseOf?.has(edge.id));
  edge.length = 3;
  world.vehicles = [makeVehicle([edge.id], 0, 0, 1)];
  let detected;
  world.lights = { colorFor: () => "red", phaseGroups: [], update: (_time, _dt, edges) => { detected = edges; } };
  world.step(0.05);
  assert.equal(detected.has(edge.id), true);
});

test("headless metric collection keeps rolling history bounded without HUD reads", () => {
  const metrics = new Metrics();
  for (let i = 0; i < 20_000; i++) {
    metrics.simTime = i;
    metrics.recordCompletion(i, i % 10, 1, 20, 10);
  }
  assert.ok(metrics.completionTimes.length < 400);
  assert.equal(metrics.throughputPerMin(), 61);
  assert.equal(metrics.completed, 20_000);
  assert.equal(metrics.avgWait(), 4.5);
  metrics.simTime += 61;
  assert.equal(metrics.throughputPerMin(), 0);
  metrics.reset();
  assert.equal(metrics.throughputPerMin(), 0);
});

test("tail metrics stay finite for out-of-range percentiles and refresh after completions", () => {
  const metrics = new Metrics();
  metrics.recordCompletion(0, 10, 0, 20, 10);
  metrics.recordCompletion(0, 30, 0, 40, 10);
  assert.equal(metrics.worstWaitAvg(), 30);
  assert.equal(metrics.worstWaitAvg(2), 20);
  assert.equal(metrics.worstWaitAvg(NaN), 30);
  metrics.recordCompletion(0, 50, 0, 60, 10);
  assert.equal(metrics.worstWaitAvg(), 50);
});

const config = { mode: "actuated", demandPerHour: 1200, preference: 0.5,
  cycleMin: 40, cycleMax: 90, minGreen: 6, maxGreen: 30, passageTime: 2.5 };

test("worker protocol returns identical results from a structured-cloned network", async (t) => {
  const { net } = new World(42);
  const corridor = { edgeIds: [net.edges.keys().next().value], distanceM: 0 };
  const expected = await simulateScenario(net, config, 42, corridor, () => {}, undefined, () => Promise.resolve());
  const messages = [];
  const scope = { postMessage: (message) => messages.push(message) };
  mockGlobal(t, "self", scope);
  await vite.ssrLoadModule("/src/lab/scenario.worker.ts");
  await scope.onmessage({ data: { type: "initialize", network: structuredClone(net) } });
  await scope.onmessage({ data: { type: "run", config, seed: 42, corridor } });
  assert.deepEqual(messages.at(-1), { type: "complete", result: expected });
  assert.equal(messages.filter((message) => message.type === "progress").at(-1).fraction, 1);
});

class FakeWorker extends EventTarget {
  static instances = [];
  messages = [];
  terminated = false;
  constructor() { super(); FakeWorker.instances.push(this); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  respond(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
}

test("scenario cancellation terminates work and cannot publish a late result", async (t) => {
  mockGlobal(t, "Worker", FakeWorker);
  const runner = new ScenarioRunner(new World(42).net);
  const controller = new AbortController();
  const promise = runner.run(config, 42, null, () => controller.abort(), controller.signal);
  const worker = FakeWorker.instances.at(-1);
  worker.respond({ type: "progress", fraction: 1 });
  worker.respond({ type: "complete", result: {} });
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(worker.terminated, true);
  const retry = runner.run(config, 42, null, () => {});
  const replacement = FakeWorker.instances.at(-1);
  assert.notEqual(replacement, worker);
  assert.equal(replacement.messages[0].type, "initialize");
  replacement.respond({ type: "complete", result: { completed: 5 } });
  assert.deepEqual(await retry, { completed: 5 });
  runner.dispose();
});

test("paired runs reuse a worker, prevent overlapping jobs, and release it on disposal", async (t) => {
  mockGlobal(t, "Worker", FakeWorker);
  const runner = new ScenarioRunner(new World(42).net);
  const first = runner.run(config, 42, null, () => {});
  const worker = FakeWorker.instances.at(-1);
  await assert.rejects(runner.run(config, 99, null, () => {}), /already running/);
  worker.respond({ type: "complete", result: { completed: 1 } });
  await first;
  const second = runner.run(config, 99, null, () => {});
  assert.equal(FakeWorker.instances.at(-1), worker);
  assert.equal(worker.messages.filter((message) => message.type === "initialize").length, 1);
  runner.dispose();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(worker.terminated, true);
  await assert.rejects(runner.run(config, 123, null, () => {}), /disposed/);
});
