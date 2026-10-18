import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { after, test } from "node:test";
import { createServer } from "vite";

const httpServer = createHttpServer();
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: { server: httpServer } },
});
after(() => server.close());
const { applyOverrides, parseOverrides } = await server.ssrLoadModule("/src/v03/overrides.ts");
const { World } = await server.ssrLoadModule("/src/sim/world.ts");
const { makeVehicle, randomRouteFrom, stepVehicles, STOP_LINE_OFFSET } = await server.ssrLoadModule("/src/sim/vehicle.ts");
const { computeLaneOffsets } = await server.ssrLoadModule("/src/sim/lanes.ts");
const { aggregateTraffic, matchCorridor, calibrationError, simulateScenario } = await server.ssrLoadModule("/src/v03/scenario.ts");

test("override imports reject invalid types and lane counts", () => {
  assert.throws(() => parseOverrides("null"));
  assert.throws(() => parseOverrides(JSON.stringify({ addedEdges: [{ from: "a", to: "b", oneway: false, lanes: 1000 }] })));
  assert.throws(() => parseOverrides(JSON.stringify({ phaseAssignments: { edge: -1 } })));
  assert.throws(() => parseOverrides(JSON.stringify({ roadConfigs: { "a|b": { forwardLanes: 0, backwardLanes: 0 } } })));
  const valid = parseOverrides(JSON.stringify({ signals: { a: true } }));
  assert.deepEqual({ ...valid.signals }, { a: true });
  assert.equal(Object.getPrototypeOf(valid.signals), null);
  assert.deepEqual(valid.addedEdges, []);
});

test("edge edits keep signal phases in sync with the network", () => {
  const { net } = new World(7);
  const removed = "i_0_0->i_1_0";
  const added = "i_0_0->i_1_1";
  applyOverrides(net, parseOverrides(JSON.stringify({
    removedEdges: [removed],
    addedEdges: [{ from: "i_0_0", to: "i_1_1", oneway: true }],
  })));
  assert.equal(net.edges.has(removed), false);
  assert.equal(net.nodes.get("i_1_0").phaseOf.has(removed), false);
  assert.equal(net.edges.has(added), true);
  assert.equal(net.nodes.get("i_1_1").phaseOf.has(added), true);
});

test("network swaps retain live controller settings and demand counters", () => {
  const world = new World(42);
  world.fixedLights.preference = 0.8;
  world.actuatedLights.maxGreen = 45;
  world.spawner.carsPerHour = 1000;
  world.spawner.spawned = 12;
  world.mode = "actuated";
  world.swapNetwork(world.net);
  assert.equal(world.fixedLights.preference, 0.8);
  assert.equal(world.actuatedLights.maxGreen, 45);
  assert.equal(world.spawner.carsPerHour, 1000);
  assert.equal(world.spawner.spawned, 12);
  assert.equal(world.lights, world.actuatedLights);
});

test("demand can resume from zero and respects the vehicle cap", () => {
  const world = new World(1);
  world.spawner.carsPerHour = 0;
  world.step(1);
  assert.equal(world.spawner.spawned, 0);
  world.spawner.carsPerHour = 4000;
  world.maxVehicles = 1;
  for (let i = 0; i < 200; i++) {
    world.step(0.05);
    assert.ok(world.vehicles.length <= 1);
  }
  assert.ok(world.spawner.spawned > 0);
  assert.ok(world.spawner.rejected > 0);
});

test("generated routes reach an exit after crossing a road", () => {
  const { net } = new World(3);
  for (const entry of net.entries) {
    const route = randomRouteFrom(net, entry, () => 0.25);
    assert.ok(route.length >= 3);
    const finalEdge = net.edges.get(route.at(-1));
    assert.equal(net.nodes.get(finalEdge.to)?.kind, "exit");
  }
});

test("observation replay deduplicates detector timestamps and preserves missing values", () => {
  const base = { id: "one", name: "Detector", lat: 51.915, lon: 4.482,
    observedAt: "2026-09-25T10:00:00Z", speedKmh: 35, vehiclesPerHour: 120 };
  const samples = aggregateTraffic([base, base, { ...base, id: "two", speedKmh: null, vehiclesPerHour: 80 }]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].sensors, 2);
  assert.equal(samples[0].speedKmh, 35);
  assert.equal(samples[0].vehiclesPerHour, 200);
});

test("sensor matching requires a nearby mapped road", () => {
  const { net } = new World(5);
  const edge = [...net.edges.values()].find((item) =>
    net.nodes.get(item.from)?.kind === "intersection" && net.nodes.get(item.to)?.kind === "intersection");
  assert.ok(edge);
  const midpoint = edge.start.clone().add(edge.end).multiplyScalar(0.5);
  const origin = { lat: 0, lon: 0 };
  const point = { lat: -midpoint.y / 111320, lon: midpoint.x / 111320 };
  assert.ok(matchCorridor(net, point, origin)?.edgeIds.includes(edge.id));
  assert.equal(matchCorridor(net, { lat: 10, lon: 10 }, origin), null);
});

test("calibration uses only comparable observed metrics", () => {
  const model = { corridorSpeedKmh: 50, corridorFlowPerHour: 300 };
  assert.equal(calibrationError(model, { speedKmh: 35, vehiclesPerHour: null }), 1);
});

test("lane geometry follows Dutch right-hand traffic and rightmost-first lane numbering", () => {
  const { net } = new World(1);
  const eastbound = net.edges.get("i_0_0->i_1_0");
  const westbound = net.edges.get("i_1_0->i_0_0");
  assert.ok(eastbound.laneOffsets[0].y > 0);
  assert.ok(westbound.laneOffsets[0].y < 0);
  const lanes = computeLaneOffsets(eastbound.dir, 3, 0);
  assert.ok(lanes[0].y > lanes[1].y && lanes[1].y > lanes[2].y);
  const oneWay = computeLaneOffsets(eastbound.dir, 2, -3.5);
  assert.ok(oneWay[0].y > 0 && oneWay[1].y < 0);
});

const alwaysGreen = { phaseGroups: [], colorFor: () => "green" };
const alwaysRed = { phaseGroups: [], colorFor: () => "red" };
const eastRoute = ["i_0_0->i_1_0", "i_1_0->i_2_0", "i_2_0->exit_E_0"];

test("a leader changing edges does not make its follower brake for a false obstacle", () => {
  const { net } = new World(1);
  const leader = makeVehicle(eastRoute, 0, 10, 30);
  const follower = makeVehicle(eastRoute, 0, 10, 30);
  leader.s = 119.9;
  follower.s = 90;
  stepVehicles([leader, follower], net, alwaysGreen, 1, 0.05);
  assert.equal(leader.edge, eastRoute[1]);
  assert.ok(follower.v > 9.9);
});

test("cars stop before a red line but clear a junction after crossing the line", () => {
  const { net } = new World(1);
  const stopLine = net.edges.get(eastRoute[0]).length - STOP_LINE_OFFSET;
  const approaching = makeVehicle(eastRoute, 0, 13, 30);
  approaching.s = stopLine - 0.1;
  stepVehicles([approaching], net, alwaysRed, 1, 0.05);
  assert.ok(approaching.s <= stopLine);
  assert.equal(approaching.v, 0);
  const committed = makeVehicle(eastRoute, 0, 2, 30);
  committed.s = stopLine + 1;
  stepVehicles([committed], net, alwaysRed, 1, 0.05);
  assert.ok(committed.v > 2);
});

test("queues remain collision-free across road segment boundaries", () => {
  const { net } = new World(1);
  const queued = makeVehicle(eastRoute.slice(1), 0, 0, 20);
  queued.s = queued.length;
  const approaching = makeVehicle(eastRoute, 0, 10, 30);
  approaching.s = 119;
  for (let tick = 0; tick < 20; tick++) {
    stepVehicles([approaching, queued], net, alwaysGreen, 1 + tick * 0.05, 0.05);
    const front = approaching.edge === eastRoute[0] ? approaching.s - 120 : approaching.s;
    assert.ok(front <= queued.s - queued.length + 1e-9, "rear bumper was penetrated");
  }
});

test("drivers see a red light beyond a short road geometry segment", () => {
  const { net } = new World(1);
  net.edges.get(eastRoute[1]).length = 3;
  const vehicle = makeVehicle(eastRoute, 0, 8, 30);
  vehicle.s = 110;
  const lights = { phaseGroups: [], colorFor: (_time, _node, edge) => edge === eastRoute[1] ? "red" : "green" };
  for (let tick = 0; tick < 100; tick++) {
    stepVehicles([vehicle], net, lights, 1 + tick * 0.05, 0.05);
  }
  assert.equal(vehicle.edge, eastRoute[0]);
  assert.ok(vehicle.s <= 120);
  assert.ok(vehicle.v < 0.5);
});

test("simultaneous merging approaches reserve their destination lane", () => {
  const { net } = new World(1);
  const first = makeVehicle(eastRoute, 0, 10, 30);
  const second = makeVehicle(["entry_N_1->i_1_0", ...eastRoute.slice(1)], 0, 10, 30);
  first.s = net.edges.get(first.edge).length - 0.01;
  second.s = net.edges.get(second.edge).length - 0.01;
  stepVehicles([first, second], net, alwaysGreen, 1, 0.05);
  assert.equal([first, second].filter((vehicle) => vehicle.edge === eastRoute[1]).length, 1);
});

test("paired scenarios receive identical demand despite differing entry congestion", () => {
  const open = new World(42);
  const blocked = new World(42);
  open.spawner.carsPerHour = blocked.spawner.carsPerHour = 1500;
  for (let step = 1; step <= 400; step++) {
    const time = step * 0.25;
    open.spawner.drain(time, () => 0);
    blocked.spawner.drain(time, () => 1);
    assert.equal(open.spawner.spawned + open.spawner.rejected, blocked.spawner.rejected);
  }
  assert.ok(open.spawner.spawned > 0);
});

test("corridor observations retain actual final-edge distance when a trip completes", () => {
  const world = new World(1);
  world.spawner.carsPerHour = 0;
  world.trackEdgeObservations = true;
  const route = ["i_2_0->exit_E_0"];
  const vehicle = makeVehicle(route, 0, 10, 6);
  vehicle.s = world.net.edges.get(route[0]).length - 0.1;
  world.vehicles.push(vehicle);
  world.step(0.05);
  assert.equal(world.metrics.completed, 1);
  assert.ok(Math.abs(world.edgeObservations.get(route[0]).speedMetres - 0.1) < 1e-9);
  assert.ok(world.edgeObservations.get(route[0]).vehicleSeconds > 0);
});

test("corridor observations include every short edge crossed during a single tick", () => {
  const world = new World(1);
  world.spawner.carsPerHour = 0;
  world.trackEdgeObservations = true;
  world.lights = alwaysGreen;
  world.net.edges.get(eastRoute[0]).length = 0.1;
  world.net.edges.get(eastRoute[1]).length = 0.1;
  const vehicle = makeVehicle(eastRoute, 0, 8, 6);
  world.vehicles.push(vehicle);
  world.step(0.05);
  assert.equal(vehicle.edge, eastRoute[2]);
  assert.equal(world.edgeObservations.get(eastRoute[1]).crossings, 1);
  assert.equal(world.edgeObservations.get(eastRoute[2]).crossings, 1);
  assert.equal(world.edgeObservations.get(eastRoute[0]).speedMetres, 0.1);
  assert.equal(world.edgeObservations.get(eastRoute[1]).speedMetres, 0.1);
  const totalTime = [...world.edgeObservations.values()].reduce((sum, row) => sum + row.vehicleSeconds, 0);
  assert.ok(Math.abs(totalTime - 0.05) < 1e-9);
});

test("replay combines equivalent timestamps and retains stopped traffic", () => {
  const reading = { id: "one", name: "Detector", lat: 51.915, lon: 4.482,
    observedAt: "2026-09-25T10:00:00Z", speedKmh: 0, vehiclesPerHour: 120 };
  const samples = aggregateTraffic([
    reading,
    { ...reading, observedAt: "2026-09-25T12:00:00+02:00" },
    { ...reading, observedAt: "2026-09-25T11:30:00+02:00", vehiclesPerHour: 100 },
  ]);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].observedAt, "2026-09-25T09:30:00.000Z");
  assert.equal(samples[1].sensors, 1);
  assert.equal(samples[1].vehiclesPerHour, 120);
  assert.equal(samples[1].speedKmh, 0);
});

test("invalid map coordinates do not silently select an arbitrary corridor", () => {
  const { net } = new World(1);
  assert.equal(matchCorridor(net, { lat: NaN, lon: 0 }, { lat: 0, lon: 0 }), null);
});

test("invalid elapsed time cannot hang or poison the simulation clock", () => {
  const world = new World(1);
  world.step(Infinity);
  world.step(NaN);
  world.timeScale = Infinity;
  world.step(0.05);
  assert.equal(world.metrics.simTime, 0);
});

test("cancelling at final scenario progress prevents publishing a completed result", async () => {
  const { net } = new World(42);
  const controller = new AbortController();
  const config = { mode: "fixed", demandPerHour: 600, preference: 0.5,
    cycleMin: 40, cycleMax: 90, minGreen: 6, maxGreen: 30, passageTime: 2.5 };
  await assert.rejects(simulateScenario(net, config, 42, null, (fraction) => {
    if (fraction === 1) controller.abort();
  }, controller.signal), { name: "AbortError" });
  assert.equal(controller.signal.aborted, true);
});
