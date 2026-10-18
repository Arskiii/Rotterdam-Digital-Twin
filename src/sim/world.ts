import { buildGridNetwork } from "./network";
import { Metrics } from "./metrics";
import { Spawner } from "./spawner";
import {
  ActuatedController,
  DETECTOR_RANGE,
  TrafficLightController,
  type SignalController,
} from "./trafficLight";
import { stepVehicles, STOP_LINE_OFFSET, type Vehicle } from "./vehicle";
import type { EdgeId, Network, NodeId } from "./types";

export type SignalMode = "fixed" | "actuated";

// A small mulberry32 PRNG so the simulation is deterministic when seeded.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class World {
  net: Network;
  vehicles: Vehicle[] = [];
  // Both signal controllers exist concurrently; `lights` is the active one. Switching
  // modes is instant and doesn't disturb in-flight vehicles.
  fixedLights: TrafficLightController;
  actuatedLights: ActuatedController;
  lights: SignalController;
  spawner: Spawner;
  metrics = new Metrics();
  // Per-intersection queue (stopped cars on inbound edges) — read by the heatmap renderer.
  queueByIntersection = new Map<NodeId, number>();
  // Optional diagnostics for offline calibration. Disabled during normal animation.
  trackEdgeObservations = false;
  observedEdgeIds: ReadonlySet<EdgeId> | null = null;
  edgeObservations = new Map<EdgeId, { crossings: number; speedMetres: number; vehicleSeconds: number }>();
  // Live tunables exposed to the GUI.
  paused = false;
  timeScale = 1; // sim seconds per real second
  maxVehicles = 800;
  private _mode: SignalMode = "fixed";
  private rand: () => number;

  // `net` is optional — passing one (e.g. from OSM) lets v0.3 reuse this engine without
  // touching v0.2 callers, which still get the 2x3 grid for free.
  constructor(seed = 1, net?: Network) {
    this.rand = rng(seed);
    this.net = net ?? buildGridNetwork();
    this.fixedLights = new TrafficLightController(this.net);
    this.actuatedLights = new ActuatedController(this.net);
    this.lights = this.fixedLights;
    this.spawner = new Spawner(this.net, this.rand);
  }

  // Property-style access so the GUI can `gui.add(world, 'mode', ...)` and changes flow through.
  get mode(): SignalMode {
    return this._mode;
  }
  set mode(m: SignalMode) {
    if (m === this._mode) return;
    this._mode = m;
    if (m === "actuated") this.actuatedLights.reset(this.metrics.simTime);
    this.lights = m === "fixed" ? this.fixedLights : this.actuatedLights;
  }

  reset() {
    this.vehicles = [];
    this.metrics.reset();
    this.spawner.reset(0);
    this.queueByIntersection.clear();
    this.actuatedLights.reset(0);
    this.edgeObservations.clear();
  }

  resetEdgeObservations() {
    this.edgeObservations.clear();
  }

  // Hot-swap the underlying network (e.g. after the v0.3 editor changes overrides).
  // Rebuilds dependent controllers + spawner so phaseGroups, entry stubs, and outgoing
  // tables stay consistent with the new edges. Caller is expected to also drain
  // vehicles via reset() if their routes referenced deleted edges.
  swapNetwork(net: Network) {
    const oldFixed = this.fixedLights;
    const oldActuated = this.actuatedLights;
    const oldSpawner = this.spawner;
    this.net = net;
    this.fixedLights = new TrafficLightController(this.net);
    this.actuatedLights = new ActuatedController(this.net);
    this.fixedLights.preference = oldFixed.preference;
    this.fixedLights.cycleMin = oldFixed.cycleMin;
    this.fixedLights.cycleMax = oldFixed.cycleMax;
    this.fixedLights.yellow = oldFixed.yellow;
    this.actuatedLights.yellow = oldActuated.yellow;
    this.actuatedLights.minGreen = oldActuated.minGreen;
    this.actuatedLights.maxGreen = oldActuated.maxGreen;
    this.actuatedLights.passageTime = oldActuated.passageTime;
    this.lights = this._mode === "fixed" ? this.fixedLights : this.actuatedLights;
    this.spawner = new Spawner(this.net, this.rand);
    this.spawner.carsPerHour = oldSpawner.carsPerHour;
    this.spawner.reset(this.metrics.simTime);
    this.spawner.spawned = oldSpawner.spawned;
    this.spawner.rejected = oldSpawner.rejected;
    this.queueByIntersection.clear();
    this.edgeObservations.clear();
  }

  // Steps the simulation forward by `realDt` seconds of wall-clock time.
  // Internally we may sub-step to keep IDM stable when timeScale is high.
  step(realDt: number) {
    if (this.paused) return;
    const simDt = realDt * this.timeScale;
    if (!Number.isFinite(simDt) || simDt <= 0) return;
    const SUB = 0.05; // 50 ms sub-step
    let remaining = simDt;
    while (remaining > 1e-6) {
      const dt = Math.min(SUB, remaining);
      this.tick(dt);
      remaining -= dt;
    }
  }

  private tick(dt: number) {
    this.metrics.simTime += dt;

    // Spawn new vehicles based on Poisson process.
    const fresh = this.spawner.drain(this.metrics.simTime, (entryId) => {
        let n = 0;
        for (const v of this.vehicles) {
          if (v.done) continue;
          if (v.edge.startsWith(entryId + "->") && v.s < 12) n++;
        }
        return n;
      }, Math.max(0, this.maxVehicles - this.vehicles.length));
    this.vehicles.push(...fresh);

    // Advance physics.
    const previousPositions = this.trackEdgeObservations
      ? new Map(this.vehicles.map((vehicle) => [vehicle.id, { routeIdx: vehicle.routeIdx, s: vehicle.s }]))
      : null;
    const out = stepVehicles(this.vehicles, this.net, this.lights, this.metrics.simTime, dt);
    for (const c of out.completed) {
      this.metrics.recordCompletion(
        this.metrics.simTime,
        c.wait,
        c.stops,
        c.travelTime,
        c.freeFlowTime,
      );
    }

    // Single pass over active vehicles: queue sample, max wait, per-edge population
    // (used by phase utilization), per-intersection queue (used by the heatmap), and
    // the detector set (used by the actuated controller).
    let waiting = 0;
    let maxWait = 0;
    this.queueByIntersection.clear();
    const vehiclesByEdge = new Map<EdgeId, number>();
    const detected = new Set<EdgeId>();
    const needDetection = !!this.lights.update;
    for (const v of this.vehicles) {
      if (previousPositions) {
        const previous = previousPositions.get(v.id)!;
        const lastIdx = Math.min(v.routeIdx, v.route.length - 1);
        const segments: { id: EdgeId; distance: number; crossing: boolean }[] = [];
        let distance = 0;
        for (let idx = previous.routeIdx; idx <= lastIdx; idx++) {
          const id = v.route[idx];
          const edge = this.net.edges.get(id)!;
          const start = idx === previous.routeIdx ? previous.s : 0;
          const end = idx === v.routeIdx ? Math.min(edge.length, v.s) : edge.length;
          const travelled = Math.max(0, end - start);
          distance += travelled;
          segments.push({ id, distance: travelled, crossing: idx > previous.routeIdx });
        }
        const vehicleDt = Math.min(dt, Math.max(0, this.metrics.simTime - v.spawnTime));
        for (const segment of segments) {
          if (this.observedEdgeIds && !this.observedEdgeIds.has(segment.id)) continue;
          const observation = this.edgeObservations.get(segment.id) ?? { crossings: 0, speedMetres: 0, vehicleSeconds: 0 };
          if (segment.crossing) observation.crossings++;
          observation.speedMetres += segment.distance;
          observation.vehicleSeconds += distance > 0
            ? vehicleDt * segment.distance / distance
            : segment === segments.at(-1) ? vehicleDt : 0;
          this.edgeObservations.set(segment.id, observation);
        }
      }
      if (v.done) continue;
      vehiclesByEdge.set(v.edge, (vehiclesByEdge.get(v.edge) ?? 0) + 1);
      if (v.totalWait > maxWait) maxWait = v.totalWait;
      const edge = this.net.edges.get(v.edge);
      const downstream = edge ? this.net.nodes.get(edge.to) : undefined;
      const facingIntersection = downstream?.kind === "intersection";
      if (v.v < 0.5) {
        waiting++;
        if (edge && facingIntersection) {
          this.queueByIntersection.set(
            edge.to,
            (this.queueByIntersection.get(edge.to) ?? 0) + 1,
          );
        }
      }
      if (needDetection && edge && facingIntersection) {
        // A vehicle is "detected" if it sits within DETECTOR_RANGE of the stop line on an
        // intersection-bound edge — including stopped cars already at the stop bar.
        const distToStopLine = Math.max(0, edge.length - STOP_LINE_OFFSET) - v.s;
        if (distToStopLine >= 0 && distToStopLine <= DETECTOR_RANGE) {
          detected.add(v.edge);
        }
      }
    }
    this.metrics.recordQueueSample(waiting);
    this.metrics.maxActiveWait = maxWait;

    // Stateful controllers update their phase timers from the detector set.
    this.lights.update?.(this.metrics.simTime, dt, detected);

    // Phase utilization: every green phase-tick is "useful" iff at least one approach has a car.
    for (const grp of this.lights.phaseGroups) {
      const color = this.lights.colorFor(this.metrics.simTime, grp.nodeId, grp.edges[0]);
      if (color !== "green") continue;
      this.metrics.phaseGreenAccum++;
      for (const eid of grp.edges) {
        if ((vehiclesByEdge.get(eid) ?? 0) > 0) {
          this.metrics.phaseUsefulAccum++;
          break;
        }
      }
    }

    // Garbage-collect completed vehicles every tick so arrays stay tight.
    if (out.completed.length > 0) {
      this.vehicles = this.vehicles.filter((v) => !v.done);
    }
  }
}
