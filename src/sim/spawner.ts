import type { EdgeId, Network, NodeId } from "./types";
import { makeVehicle, pickLaneOnEntry, randomRouteFrom, type Vehicle } from "./vehicle";

// Each entry has its own Poisson process — exponential inter-arrival times with mean 1/lambda.
// Lambda is in cars/second, derived from the user-facing carsPerHour.
export class Spawner {
  private _carsPerHour = 600; // global rate, divided evenly across entries
  private lastTime = 0;
  get carsPerHour() { return this._carsPerHour; }
  set carsPerHour(rate: number) {
    if (!Number.isFinite(rate) || rate < 0) return;
    if (rate === this._carsPerHour) return;
    this._carsPerHour = rate;
    // The old arrival schedule belongs to the old rate (and may be Infinity when
    // demand was zero). Start a fresh exponential clock at the last processed time.
    this.resetArrivals(this.lastTime);
  }
  // Capacity diagnostics: how much demand the network actually absorbed vs. dropped.
  spawned = 0;
  rejected = 0;
  private nextArrival = new Map<NodeId, number>();

  constructor(private net: Network, private rng: () => number) {
    this.resetArrivals(0);
  }

  reset(simTime: number) {
    this.spawned = 0;
    this.rejected = 0;
    this.resetArrivals(simTime);
  }

  private resetArrivals(simTime: number) {
    this.lastTime = simTime;
    for (const id of this.net.entries) {
      this.nextArrival.set(id, simTime + this.sampleGap());
    }
  }

  private sampleGap(): number {
    const lambdaPerEntry =
      this._carsPerHour / 3600 / Math.max(1, this.net.entries.length);
    if (lambdaPerEntry <= 0) return Infinity;
    // Inverse-CDF sample of exponential.
    const u = Math.max(1e-9, this.rng());
    return -Math.log(u) / lambdaPerEntry;
  }

  // Free-flow time for a route — denominator of the delay ratio.
  private freeFlowTime(route: EdgeId[]): number {
    let t = 0;
    for (const eid of route) {
      const e = this.net.edges.get(eid)!;
      t += e.length / Math.max(1, e.speedLimit);
    }
    return t;
  }

  // Drains all events scheduled before `simTime` and returns the spawned vehicles.
  drain(simTime: number, vehiclesAtEntry: (entryId: NodeId) => number, capacity = Infinity): Vehicle[] {
    const out: Vehicle[] = [];
    const occupiedThisDrain = new Set<NodeId>();
    this.lastTime = simTime;
    for (const entryId of this.net.entries) {
      let next = this.nextArrival.get(entryId) ?? simTime;
      while (next <= simTime) {
        // Sample every attempted trip, including blocked demand. Otherwise a
        // controller that rejects one car changes the random stream (and all
        // later arrivals) in a paired scenario with the same seed.
        const route = randomRouteFrom(this.net, entryId, this.rng);
        if (out.length < capacity && vehiclesAtEntry(entryId) === 0 &&
            !occupiedThisDrain.has(entryId)) {
          if (route.length > 0) {
            // Spawn into the lane that already lines up with the first turn — saves a
            // pointless lane "change" on the very first edge. The entry-stub edge has
            // laneCount=1 so this only matters for the second edge onward, but we plumb
            // it through via the route lookahead so v0.4 OSM entries with multi-lane
            // first edges work too.
            const firstEdge = this.net.edges.get(route[0])!;
            const initialLane = pickLaneOnEntry(this.net, firstEdge, route, 0);
            out.push(makeVehicle(route, next, Math.min(8, firstEdge.speedLimit), this.freeFlowTime(route), initialLane));
            occupiedThisDrain.add(entryId);
            this.spawned++;
          } else {
            this.rejected++;
          }
        } else {
          // Entry stub blocked → arrival is dropped, not queued, so demand is lost.
          this.rejected++;
        }
        next = next + this.sampleGap();
      }
      this.nextArrival.set(entryId, next);
    }
    return out;
  }
}
