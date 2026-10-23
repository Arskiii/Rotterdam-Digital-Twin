import { afterEach, expect, it, vi } from "vitest";
import { VehiclesLayer } from "./dynamic";
import { LiveTransitLayer } from "./transit";

afterEach(() => vi.useRealTimers());

it("city agents retain visible overview marks and upload only active buffer slots", () => {
  const layer = new VehiclesLayer();
  layer.update(new Float32Array([10, 20, 0, 1, 30, 40, 0, 9, 50, 60, 0, 13]), 3);
  expect([layer.cars.mesh.count, layer.peds.mesh.count, layer.trucks.mesh.count]).toEqual([1, 1, 1]);
  expect(layer.cars.markers.parent).toBe(layer.cars.mesh);
  expect(layer.peds.markers.geometry.drawRange.count).toBe(1);
  expect(layer.cars.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 16 }]);
  expect(layer.peds.positions.slice(0, 3)).toEqual(new Float32Array([30, 3, -40]));
  layer.update(new Float32Array(), 0);
  expect(layer.peds.markers.geometry.drawRange.count).toBe(0);
  expect(layer.trucks.mesh.count).toBe(0);
});

it("live transit moves by wall clock and expires rather than freezing at an old fix", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T18:00:00Z"));
  const layer = new LiveTransitLayer();
  layer.set([[0, 0, 0, "4", "trip", 1, 0, "vehicle", 0]], { trip: [[0, 0, 0], [100, 0, 100]] }, Date.now());
  vi.advanceTimersByTime(30_000); layer.update();
  expect(layer.vehicles[0].x).toBeGreaterThan(25);
  expect(layer.trams.count).toBe(1);
  expect(layer.road.geometry.drawRange.count).toBe(1);
  vi.advanceTimersByTime(21 * 60_000); layer.update();
  expect(layer.vehicles).toHaveLength(0);
  expect(layer.trams.count).toBe(0);
  expect(layer.road.geometry.drawRange.count).toBe(0);
});
