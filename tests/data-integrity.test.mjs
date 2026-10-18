import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { after, test } from "node:test";
import { createServer } from "vite";

const httpServer = createHttpServer();
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: { server: httpServer } },
});
after(() => vite.close());
const { applyOverrides, parseOverrides, corridorKey, saveOverrides, clearOverrides, loadOverrides } =
  await vite.ssrLoadModule("/src/v03/overrides.ts");
const { World } = await vite.ssrLoadModule("/src/sim/world.ts");
const { safeReading, parseImported } = await vite.ssrLoadModule("/src/lab/imports.ts");

const reading = { id: "detector-1", name: "Coolsingel", lat: 51.915, lon: 4.482,
  observedAt: "2026-09-25T11:55:00Z", speedKmh: 32, vehiclesPerHour: 120 };

test("history imports preserve optional measurements and reject coercion or empty observations", () => {
  assert.equal(safeReading({ ...reading, vehiclesPerHour: undefined }).vehiclesPerHour, null);
  assert.equal(safeReading({ ...reading, speedKmh: "", vehiclesPerHour: "0" }).vehiclesPerHour, 0);
  for (const invalid of [false, true, [], {}, "0x12", "Infinity"]) {
    assert.equal(safeReading({ ...reading, speedKmh: invalid }), null);
  }
  assert.equal(safeReading({ ...reading, speedKmh: null, vehiclesPerHour: undefined }), null);
  assert.equal(safeReading({ ...reading, id: "x".repeat(101) }), null);
});

test("history imports normalize timezone offsets and reject ambiguous or nonexistent dates", () => {
  assert.equal(safeReading({ ...reading, observedAt: "2026-09-25T13:55:00+02:00" }).observedAt,
    "2026-09-25T11:55:00.000Z");
  assert.equal(safeReading({ ...reading, observedAt: "2026-09-25T11:55:00" }), null);
  assert.equal(safeReading({ ...reading, observedAt: "2026-02-30T11:55:00Z" }), null);
});

test("CSV imports support quoted commas, escaped quotes and multiline sensor names", () => {
  const csv = '\uFEFFid,name,lat,lon,observedAt,speedKmh\r\n' +
    'detector-1,"Coolsingel, ""north""\nside",51.915,4.482,2026-09-25T11:55:00Z,32\r\n';
  const rows = parseImported(csv, "history.csv");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Coolsingel, "north"\nside');
  assert.equal(rows[0].vehiclesPerHour, null);
});

test("CSV imports reject excess records and malformed rows without silently dropping data", () => {
  const header = "id,lat,lon,observedAt,speedKmh\n";
  const row = "detector-1,51.915,4.482,2026-09-25T11:55:00Z,32\n";
  assert.equal(parseImported(header + row.repeat(3000), "history.csv").length, 3000);
  assert.throws(() => parseImported(header + row.repeat(3001), "history.csv"), /3,000/);
  assert.throws(() => parseImported(header + row.trim() + ",extra", "history.csv"), /number of fields/);
  assert.throws(() => parseImported(header + '"unterminated', "history.csv"), /unclosed/);
  assert.throws(() => parseImported(header.replace("id,", "id,id,") + row, "history.csv"), /duplicate/);
});

test("JSON and CSV enforce the same record and UTF-8 byte limits", () => {
  assert.equal(parseImported(JSON.stringify([reading]), "history.json").length, 1);
  const compact = { ...reading, name: "" };
  assert.throws(() => parseImported(JSON.stringify(Array(3001).fill(compact)), "history.json"), /3,000/);
  assert.throws(() => parseImported(JSON.stringify([{ ...reading, name: "é".repeat(500_000) }]), "history.json"), /1 MB/);
});

test("replacing every approach retains the existing traffic signal", () => {
  const { net } = new World(7);
  const node = net.nodes.get("i_1_1");
  const removedEdges = [...net.edges.values()].filter((edge) => edge.to === node.id).map((edge) => edge.id);
  assert.ok(node.phaseOf.size > 0);
  const added = "i_0_0->i_1_1";
  applyOverrides(net, parseOverrides(JSON.stringify({
    removedEdges,
    addedEdges: [{ from: "i_0_0", to: node.id, oneway: true }],
  })));
  assert.equal(node.phaseOf.size, 1);
  assert.equal(node.phaseOf.has(added), true);
});

test("lane edits preserve each direction's speed limit and unchanged turn restrictions", () => {
  const { net } = new World(7);
  const a = "i_0_0";
  const b = "i_1_0";
  const forward = net.edges.get(`${a}->${b}`);
  const backward = net.edges.get(`${b}->${a}`);
  forward.speedLimit = 8.33;
  backward.speedLimit = 11.11;
  backward.laneTurns = Array.from({ length: backward.laneCount }, () => new Set(["right"]));
  const previousTurns = backward.laneTurns;
  applyOverrides(net, parseOverrides(JSON.stringify({
    roadConfigs: { [corridorKey(a, b)]: { forwardLanes: 3, backwardLanes: backward.laneCount } },
  })));
  assert.equal(net.edges.get(forward.id).laneCount, 3);
  assert.equal(net.edges.get(forward.id).speedLimit, 8.33);
  assert.equal(net.edges.get(backward.id).speedLimit, 11.11);
  assert.deepEqual(net.edges.get(backward.id).laneTurns, previousTurns);
  assert.notEqual(net.edges.get(backward.id).laneTurns, previousTurns);
});

test("disconnecting, reconnecting and editing a corridor retains the chosen lane counts", () => {
  const { net } = new World(7);
  const a = "i_0_0";
  const b = "i_1_0";
  const forward = `${a}->${b}`;
  const backward = `${b}->${a}`;
  net.edges.get(forward).speedLimit = 8.33;
  applyOverrides(net, parseOverrides(JSON.stringify({
    removedEdges: [forward, backward],
    addedEdges: [{ from: a, to: b, oneway: false }],
    roadConfigs: { [corridorKey(a, b)]: { forwardLanes: 3, backwardLanes: 2 } },
  })));
  assert.equal(net.edges.get(forward).laneCount, 3);
  assert.equal(net.edges.get(backward).laneCount, 2);
  assert.equal(net.edges.get(forward).speedLimit, 8.33);
});

test("editing a newly connected corridor to one way does not recreate its reverse road", () => {
  const { net } = new World(7);
  const a = "i_0_0";
  const b = "i_1_1";
  applyOverrides(net, parseOverrides(JSON.stringify({
    addedEdges: [{ from: a, to: b, oneway: false }],
    roadConfigs: { [corridorKey(a, b)]: { forwardLanes: 2, backwardLanes: 0 } },
  })));
  assert.equal(net.edges.get(`${a}->${b}`).laneCount, 2);
  assert.equal(net.edges.has(`${b}->${a}`), false);
});

test("disconnecting an edited corridor still removes it on rebuild", () => {
  const { net } = new World(7);
  const a = "i_0_0";
  const b = "i_1_0";
  applyOverrides(net, parseOverrides(JSON.stringify({
    removedEdges: [`${a}->${b}`, `${b}->${a}`],
    roadConfigs: { [corridorKey(a, b)]: { forwardLanes: 3, backwardLanes: 2 } },
  })));
  assert.equal(net.edges.has(`${a}->${b}`), false);
  assert.equal(net.edges.has(`${b}->${a}`), false);
});

test("editor persistence reports blocked storage and can recover without losing session edits", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const edits = parseOverrides(JSON.stringify({ signals: { junction: true } }));
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem() { throw new Error("Storage disabled"); },
      setItem() { throw new Error("Quota exceeded"); },
      removeItem() { throw new Error("Storage disabled"); },
    } });
    assert.equal(saveOverrides(edits), false);
    assert.equal(clearOverrides(), false);
    assert.deepEqual(loadOverrides().addedEdges, []);
    assert.equal(edits.signals.junction, true);
    const storage = new Map();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); },
    } });
    assert.equal(saveOverrides(edits), true);
    assert.equal(loadOverrides().signals.junction, true);
    assert.equal(clearOverrides(), true);
    assert.deepEqual(loadOverrides().signals, {});
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});
