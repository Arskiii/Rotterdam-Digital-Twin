import type { EdgeId, Network, NodeId } from "./types";

export type Phase = 0 | 1;
export type LightColor = "red" | "yellow" | "green";

// Each intersection runs a fixed-time two-phase cycle:
//   phase 0 = N-S green, phase 1 = E-W green, separated by yellow intervals.
// The "throughput preference" knob (0..1) interpolates total cycle length:
//   0  -> short cycle (low wait time, more startup-loss, lower max throughput)
//   1  -> long cycle  (higher throughput, longer worst-case wait)
// Green time is split between phases proportional to demand-agnostic 50/50 for v1.
export class TrafficLightController {
  private offsets = new Map<NodeId, number>();
  // Live, externally tunable.
  cycleMin = 24; // s, when preference = 0
  cycleMax = 90; // s, when preference = 1
  yellow = 3; // s
  preference = 0.5; // 0..1

  constructor(private net: Network) {
    // Stagger offsets so neighbouring intersections aren't perfectly in phase.
    let i = 0;
    for (const node of net.nodes.values()) {
      if (node.kind === "intersection") {
        this.offsets.set(node.id, (i * 7) % 20);
        i++;
      }
    }
  }

  cycleLength(): number {
    return this.cycleMin + (this.cycleMax - this.cycleMin) * this.preference;
  }

  // Returns the current light color for a specific incoming edge into an intersection.
  colorFor(simTime: number, intersectionId: NodeId, incomingEdge: EdgeId): LightColor {
    const node = this.net.nodes.get(intersectionId);
    if (!node || node.kind !== "intersection") return "green";
    const phase = node.phaseOf?.get(incomingEdge);
    if (phase === undefined) return "green";

    const cycle = this.cycleLength();
    const offset = this.offsets.get(intersectionId) ?? 0;
    const t = ((simTime + offset) % cycle + cycle) % cycle;

    const halfGreen = cycle / 2 - this.yellow;
    // Phase 0 layout: [green0 | yellow | green1 | yellow]
    const g0End = halfGreen;
    const y0End = g0End + this.yellow;
    const g1End = y0End + halfGreen;
    // y1End == cycle

    let activePhase: Phase;
    let isYellow: boolean;
    if (t < g0End) {
      activePhase = 0;
      isYellow = false;
    } else if (t < y0End) {
      activePhase = 0;
      isYellow = true;
    } else if (t < g1End) {
      activePhase = 1;
      isYellow = false;
    } else {
      activePhase = 1;
      isYellow = true;
    }

    if (phase === activePhase) return isYellow ? "yellow" : "green";
    return "red";
  }
}
