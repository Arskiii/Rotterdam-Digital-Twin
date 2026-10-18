import type { Network } from "../sim/types";
import { World, type SignalMode } from "../sim/world";

export interface TrafficReading {
  id: string;
  name: string;
  lat: number;
  lon: number;
  observedAt: string;
  speedKmh: number | null;
  vehiclesPerHour: number | null;
}

export interface TrafficSample {
  observedAt: string;
  sensors: number;
  speedKmh: number | null;
  vehiclesPerHour: number | null;
}

export interface CorridorMatch {
  edgeIds: string[];
  distanceM: number;
}

export interface ScenarioConfig {
  mode: SignalMode;
  demandPerHour: number;
  preference: number;
  cycleMin: number;
  cycleMax: number;
  minGreen: number;
  maxGreen: number;
  passageTime: number;
}

export interface ScenarioResult {
  completed: number;
  travelTimeSec: number | null;
  waitSec: number | null;
  throughputPerHour: number;
  demandMet: number;
  avgQueue: number;
  corridorFlowPerHour: number;
  corridorSpeedKmh: number | null;
}

export function aggregateTraffic(readings: TrafficReading[]): TrafficSample[] {
  const byTime = new Map<string, TrafficReading[]>();
  for (const row of readings.slice(0, 3000)) {
    if (!row || typeof row.id !== "string" || typeof row.observedAt !== "string" ||
        !Number.isFinite(Date.parse(row.observedAt)) || !Number.isFinite(row.lat) || !Number.isFinite(row.lon) ||
        Math.abs(row.lat) > 90 || Math.abs(row.lon) > 180) continue;
    // Equivalent ISO offsets represent the same sample; normalize before grouping
    // so sorting is chronological and duplicate detectors cannot inflate flow.
    const timestamp = new Date(row.observedAt).toISOString();
    const rows = byTime.get(timestamp) ?? [];
    // One record per detector and timestamp, even if imports contain duplicates.
    if (!rows.some((item) => item.id === row.id)) rows.push(row);
    byTime.set(timestamp, rows);
  }
  return [...byTime.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([observedAt, rows]) => {
    const speed = rows.filter((r) => r.speedKmh !== null && Number.isFinite(r.speedKmh) && r.speedKmh >= 0 && r.speedKmh <= 200);
    const flow = rows.filter((r) => r.vehiclesPerHour !== null && Number.isFinite(r.vehiclesPerHour) && r.vehiclesPerHour >= 0 && r.vehiclesPerHour <= 100_000);
    return {
      observedAt, sensors: rows.length,
      speedKmh: speed.length ? speed.reduce((sum, r) => sum + r.speedKmh!, 0) / speed.length : null,
      vehiclesPerHour: flow.length ? flow.reduce((sum, r) => sum + r.vehiclesPerHour!, 0) : null,
    };
  });
}

function segmentDistance(point: { x: number; y: number }, start: { x: number; y: number }, end: { x: number; y: number }): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

export function matchCorridor(net: Network, point: { lat: number; lon: number }, origin: { lat: number; lon: number }): CorridorMatch | null {
  if (![point.lat, point.lon, origin.lat, origin.lon].every(Number.isFinite) ||
      Math.abs(point.lat) > 90 || Math.abs(origin.lat) > 90 ||
      Math.abs(point.lon) > 180 || Math.abs(origin.lon) > 180) return null;
  const projected = {
    x: (point.lon - origin.lon) * 111320 * Math.cos(origin.lat * Math.PI / 180),
    y: -(point.lat - origin.lat) * 111320,
  };
  let best: { id: string; distanceM: number } | null = null;
  for (const edge of net.edges.values()) {
    if (net.nodes.get(edge.from)?.kind !== "intersection" || net.nodes.get(edge.to)?.kind !== "intersection") continue;
    if (edge.length < 3) continue;
    const distanceM = segmentDistance(projected, edge.start, edge.end);
    if (!best || distanceM < best.distanceM) best = { id: edge.id, distanceM };
  }
  if (!best || best.distanceM > 40) return null;
  const edge = net.edges.get(best.id)!;
  const reverse = `${edge.to}->${edge.from}`;
  return { edgeIds: net.edges.has(reverse) ? [edge.id, reverse] : [edge.id], distanceM: best.distanceM };
}

export function sampleMean(samples: TrafficSample[]): { speedKmh: number | null; vehiclesPerHour: number | null } {
  const speeds = samples.map((s) => s.speedKmh).filter((value): value is number => value !== null && Number.isFinite(value));
  const flows = samples.map((s) => s.vehiclesPerHour).filter((value): value is number => value !== null && Number.isFinite(value));
  return { speedKmh: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null,
    vehiclesPerHour: flows.length ? flows.reduce((a, b) => a + b, 0) / flows.length : null };
}

export function calibrationError(result: ScenarioResult, observed: ReturnType<typeof sampleMean>): number | null {
  const terms: number[] = [];
  if (observed.speedKmh !== null && result.corridorSpeedKmh !== null) {
    terms.push(Math.abs(result.corridorSpeedKmh - observed.speedKmh) / 15);
  }
  if (observed.vehiclesPerHour !== null) {
    terms.push(Math.abs(result.corridorFlowPerHour - observed.vehiclesPerHour) / Math.max(50, observed.vehiclesPerHour * 0.25));
  }
  return terms.length ? terms.reduce((a, b) => a + b, 0) / terms.length : null;
}

export async function simulateScenario(
  net: Network,
  config: ScenarioConfig,
  seed: number,
  corridor: CorridorMatch | null,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
  yieldToHost: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<ScenarioResult> {
  const world = new World(seed, net);
  world.maxVehicles = 1200;
  world.trackEdgeObservations = !!corridor;
  world.observedEdgeIds = corridor ? new Set(corridor.edgeIds) : null;
  world.spawner.carsPerHour = config.demandPerHour;
  world.fixedLights.preference = config.preference;
  world.fixedLights.cycleMin = config.cycleMin;
  world.fixedLights.cycleMax = config.cycleMax;
  world.actuatedLights.minGreen = config.minGreen;
  world.actuatedLights.maxGreen = config.maxGreen;
  world.actuatedLights.passageTime = config.passageTime;
  world.mode = config.mode;

  const warmupSec = 60;
  const measureSec = 300;
  const stepSec = 0.25;
  let baseline = { completed: 0, travel: 0, wait: 0, spawned: 0, rejected: 0, queue: 0, samples: 0 };
  for (let step = 0; step < (warmupSec + measureSec) / stepSec; step++) {
    if (signal?.aborted) throw new DOMException("Scenario cancelled", "AbortError");
    world.step(stepSec);
    if (step === warmupSec / stepSec - 1) {
      baseline = { completed: world.metrics.completed, travel: world.metrics.totalTravelCompleted,
        wait: world.metrics.totalWaitCompleted, spawned: world.spawner.spawned,
        rejected: world.spawner.rejected, queue: world.metrics.queueAccum,
        samples: world.metrics.queueSamples };
      world.resetEdgeObservations();
    }
    if (step % 80 === 79) {
      onProgress((step + 1) / ((warmupSec + measureSec) / stepSec));
      await yieldToHost();
    }
  }
  // The final progress update also yields to the UI. Honor cancellation received
  // during that yield before a comparison or demand fit can publish its result.
  if (signal?.aborted) throw new DOMException("Scenario cancelled", "AbortError");
  const completed = world.metrics.completed - baseline.completed;
  const demand = world.spawner.spawned + world.spawner.rejected - baseline.spawned - baseline.rejected;
  const spawned = world.spawner.spawned - baseline.spawned;
  let crossings = 0;
  let speedMetres = 0;
  let vehicleSeconds = 0;
  for (const id of corridor?.edgeIds ?? []) {
    const observation = world.edgeObservations.get(id);
    if (!observation) continue;
    crossings += observation.crossings;
    speedMetres += observation.speedMetres;
    vehicleSeconds += observation.vehicleSeconds;
  }
  return {
    completed,
    travelTimeSec: completed ? (world.metrics.totalTravelCompleted - baseline.travel) / completed : null,
    waitSec: completed ? (world.metrics.totalWaitCompleted - baseline.wait) / completed : null,
    throughputPerHour: completed / measureSec * 3600,
    demandMet: demand ? spawned / demand : 1,
    avgQueue: (world.metrics.queueAccum - baseline.queue) / Math.max(1, world.metrics.queueSamples - baseline.samples),
    corridorFlowPerHour: crossings / measureSec * 3600,
    corridorSpeedKmh: vehicleSeconds ? speedMetres / vehicleSeconds * 3.6 : null,
  };
}
