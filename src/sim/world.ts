import { buildGridNetwork } from "./network";
import { Metrics } from "./metrics";
import { Spawner } from "./spawner";
import { TrafficLightController } from "./trafficLight";
import { stepVehicles, type Vehicle } from "./vehicle";
import type { Network } from "./types";

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
  lights: TrafficLightController;
  spawner: Spawner;
  metrics = new Metrics();
  // Live tunables exposed to the GUI.
  paused = false;
  timeScale = 1; // sim seconds per real second
  maxVehicles = 800;
  private rand: () => number;

  constructor(seed = 1) {
    this.rand = rng(seed);
    this.net = buildGridNetwork();
    this.lights = new TrafficLightController(this.net);
    this.spawner = new Spawner(this.net, this.rand);
  }

  reset() {
    this.vehicles = [];
    this.metrics.reset();
    this.spawner.reset(0);
  }

  // Steps the simulation forward by `realDt` seconds of wall-clock time.
  // Internally we may sub-step to keep IDM stable when timeScale is high.
  step(realDt: number) {
    if (this.paused) return;
    const simDt = realDt * this.timeScale;
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
    if (this.vehicles.length < this.maxVehicles) {
      const fresh = this.spawner.drain(this.metrics.simTime, (entryId) => {
        let n = 0;
        for (const v of this.vehicles) {
          if (v.done) continue;
          if (v.edge.startsWith(entryId + "->") && v.s < 12) n++;
        }
        return n;
      });
      this.vehicles.push(...fresh);
    }

    // Advance physics.
    const out = stepVehicles(this.vehicles, this.net, this.lights, this.metrics.simTime, dt);
    if (out.completed > 0) {
      this.metrics.recordCompletions(this.metrics.simTime, out.completed, out.totalWaitOfCompleted);
    }

    // Sample queue: count waiting (v < 0.5 m/s) cars currently on edges leading into intersections.
    let waiting = 0;
    for (const v of this.vehicles) {
      if (v.done) continue;
      if (v.v < 0.5) waiting++;
    }
    this.metrics.recordQueueSample(waiting);

    // Garbage-collect completed vehicles every tick so arrays stay tight.
    if (out.completed > 0) {
      this.vehicles = this.vehicles.filter((v) => !v.done);
    }
  }
}
