import type { Network, NodeId } from "./types";
import { makeVehicle, randomRouteFrom, type Vehicle } from "./vehicle";

// Each entry has its own Poisson process — exponential inter-arrival times with mean 1/lambda.
// Lambda is in cars/second, derived from the user-facing carsPerHour.
export class Spawner {
  carsPerHour = 600; // global rate, divided evenly across entries
  private nextArrival = new Map<NodeId, number>();

  constructor(private net: Network, private rng: () => number) {
    for (const id of net.entries) this.nextArrival.set(id, 0);
  }

  reset(simTime: number) {
    for (const id of this.net.entries) {
      this.nextArrival.set(id, simTime + this.sampleGap());
    }
  }

  private sampleGap(): number {
    const lambdaPerEntry =
      this.carsPerHour / 3600 / Math.max(1, this.net.entries.length);
    if (lambdaPerEntry <= 0) return Infinity;
    // Inverse-CDF sample of exponential.
    const u = Math.max(1e-9, this.rng());
    return -Math.log(u) / lambdaPerEntry;
  }

  // Drains all events scheduled before `simTime` and returns the spawned vehicles.
  drain(simTime: number, vehiclesAtEntry: (entryId: NodeId) => number): Vehicle[] {
    const out: Vehicle[] = [];
    for (const entryId of this.net.entries) {
      let next = this.nextArrival.get(entryId) ?? simTime;
      while (next <= simTime) {
        // Don't spawn on top of a queued car at the entry stub — wait until next tick.
        if (vehiclesAtEntry(entryId) === 0) {
          const route = randomRouteFrom(this.net, entryId, this.rng);
          if (route.length > 0) {
            out.push(makeVehicle(route, next, 8.0));
          }
        }
        next = next + this.sampleGap();
      }
      this.nextArrival.set(entryId, next);
    }
    return out;
  }
}
