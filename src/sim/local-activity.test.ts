import { expect, it } from "vitest";
import type { Graph } from "../data/loader";
import { LocalActivity } from "./local-activity";

it("phone preview moves all three modes on the real graph with bounded reusable buffers", () => {
  const graph = { nodesXY: new Float32Array([0, 0, 100, 0, 100, 100]),
    geo: new Float32Array([0, 0, 100, 0, 100, 0, 100, 100]),
    edges: { count: 2, a: new Uint32Array([0, 1]), b: new Uint32Array([1, 2]),
      len: new Float32Array([100, 100]), geoOff: new Uint32Array([0, 2]), geoCount: new Uint16Array([2, 2]),
      modeMask: new Uint8Array([7, 7]), flags: new Uint8Array([1, 1]), speed: new Uint16Array([30, 30]) } } as Graph;
  const preview = new LocalActivity(graph);
  preview.update(1000, 0, 0);
  expect(preview.count).toBe(240);
  const modes = new Set(Array.from({ length: preview.count }, (_, i) => Math.floor(preview.data[i * 4 + 3] / 4)));
  expect([...modes].sort()).toEqual([0, 1, 2]);
  const before = preview.data.slice();
  expect(preview.update(1020, 0, 0)).toBe(false);
  for (let t = 1100; t < 11000; t += 100) preview.update(t, 0, 0);
  expect(preview.data).not.toEqual(before);
  expect(preview.data.length).toBe(240 * 4);
  expect(preview.data.every(Number.isFinite)).toBe(true);
  preview.update(12000, 10000, 10000);
  expect(preview.count).toBeLessThanOrEqual(240);
  expect(preview.data.every(Number.isFinite)).toBe(true);
});
