import type { EdgeId, Network, NodeId } from "./types";

// A phase index — 0..N-1 for an intersection that runs N phases. Defaults are 2 (NS/EW)
// from the OSM parser and grid builder; the editor lets the user introduce phases 2, 3,
// … to give complex intersections protected movements.
export type Phase = number;
export type LightColor = "red" | "yellow" | "green";

// Precomputed grouping of edges by (intersection, phase) for the phase-utilization metric
// and for the actuated controller's per-phase demand check.
export interface PhaseGroup {
  nodeId: NodeId;
  phase: Phase;
  edges: EdgeId[];
}

// Common surface so the world can swap controllers without other code knowing which is active.
//   - colorFor: pure query — what color should this approach show right now?
//   - update:   stateful tick — actuated controllers refresh internal timers here.
//   - reset:    re-initialize state to a clean slate at simTime.
export interface SignalController {
  phaseGroups: PhaseGroup[];
  colorFor(simTime: number, intersectionId: NodeId, incomingEdge: EdgeId): LightColor;
  update?(simTime: number, dt: number, detected: Set<EdgeId>): void;
  reset?(simTime: number): void;
}

// Distance back from the intersection center within which a vehicle counts as "demand"
// for the actuated controller. ~3 s of approach time at the 50 km/h speed limit.
export const DETECTOR_RANGE = 40;

// Returns the group key for a node — its `signalGroupId` if set, else its own id.
// Logical signal groups let multiple physical junctions share one cycle.
function groupKeyFor(node: { id: NodeId; signalGroupId?: string }): string {
  return node.signalGroupId ?? node.id;
}

interface BuiltGroups {
  groups: PhaseGroup[];
  // Per-node phase-group lookup, used by ActuatedController for fast demand checks
  // when iterating a single node's incoming edges.
  byIntersection: Map<NodeId, Map<Phase, PhaseGroup>>;
  // Map from a node's group key to the same per-phase lookup, but UNIONED across all
  // nodes in the group. Lets the ActuatedController treat grouped junctions as one
  // ring when checking demand on every approach.
  byGroup: Map<string, Map<Phase, PhaseGroup>>;
  // Phase count per group (= max phase number used in the group + 1). Drives cycle
  // math + the ActuatedController's "next phase" rotation.
  phaseCountByGroup: Map<string, number>;
  // Reverse lookup: which group does a given node belong to?
  groupKeyByNode: Map<NodeId, string>;
}

function buildPhaseGroups(net: Network): BuiltGroups {
  const groups: PhaseGroup[] = [];
  const byIntersection = new Map<NodeId, Map<Phase, PhaseGroup>>();
  const byGroup = new Map<string, Map<Phase, PhaseGroup>>();
  const phaseCountByGroup = new Map<string, number>();
  const groupKeyByNode = new Map<NodeId, string>();

  for (const node of net.nodes.values()) {
    if (node.kind !== "intersection" || !node.phaseOf || node.phaseOf.size === 0) continue;
    const groupKey = groupKeyFor(node);
    groupKeyByNode.set(node.id, groupKey);

    const grouped = new Map<Phase, EdgeId[]>();
    let maxPhase = 0;
    for (const [eid, p] of node.phaseOf) {
      if (p > maxPhase) maxPhase = p;
      let arr = grouped.get(p);
      if (!arr) {
        arr = [];
        grouped.set(p, arr);
      }
      arr.push(eid);
    }
    const phaseMap = new Map<Phase, PhaseGroup>();
    for (const [phase, edges] of grouped) {
      const pg: PhaseGroup = { nodeId: node.id, phase, edges };
      groups.push(pg);
      phaseMap.set(phase, pg);
      // Aggregate into the group-level lookup — multiple nodes in the same group
      // contribute their edges to the same per-phase entry.
      let groupPhaseMap = byGroup.get(groupKey);
      if (!groupPhaseMap) {
        groupPhaseMap = new Map();
        byGroup.set(groupKey, groupPhaseMap);
      }
      const existing = groupPhaseMap.get(phase);
      if (existing) {
        for (const eid of edges) existing.edges.push(eid);
      } else {
        groupPhaseMap.set(phase, { nodeId: groupKey, phase, edges: [...edges] });
      }
    }
    byIntersection.set(node.id, phaseMap);
    const prevMax = (phaseCountByGroup.get(groupKey) ?? 0) - 1;
    const newMax = Math.max(prevMax, maxPhase);
    phaseCountByGroup.set(groupKey, newMax + 1);
  }
  return { groups, byIntersection, byGroup, phaseCountByGroup, groupKeyByNode };
}

// Each intersection runs a fixed-time multi-phase cycle. The number of phases at a
// given intersection is determined by the max phase number used in `node.phaseOf`
// (defaulting to 2: phase 0 = N-S green, phase 1 = E-W green). Custom phase
// assignments via the editor can introduce phases 2..N-1 for protected movements.
//
// Cycle layout per intersection: [green0 | yellow | green1 | yellow | … | greenN-1 | yellow]
// Each green slot gets `(cycle − N · yellow) / N` seconds.
//
// The "throughput preference" knob (0..1) interpolates total cycle length:
//   0  -> short cycle (low wait time, more startup-loss, lower max throughput)
//   1  -> long cycle  (higher throughput, longer worst-case wait)
export class TrafficLightController implements SignalController {
  // State is keyed by group key (signalGroupId, falling back to node id), so all
  // nodes in a logical group share the same cycle/offset and stay in lock-step.
  private offsets = new Map<string, number>();
  private phaseCountByGroup: Map<string, number>;
  private groupKeyByNode: Map<NodeId, string>;
  readonly phaseGroups: PhaseGroup[];
  // Live, externally tunable.
  cycleMin = 24; // s, when preference = 0
  cycleMax = 90; // s, when preference = 1
  yellow = 3; // s
  preference = 0.5; // 0..1

  constructor(private net: Network) {
    const built = buildPhaseGroups(net);
    this.phaseGroups = built.groups;
    this.phaseCountByGroup = built.phaseCountByGroup;
    this.groupKeyByNode = built.groupKeyByNode;
    // Stagger offsets per group so neighbouring intersections aren't perfectly in phase.
    let i = 0;
    for (const groupKey of this.phaseCountByGroup.keys()) {
      this.offsets.set(groupKey, (i * 7) % 20);
      i++;
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
    const groupKey = this.groupKeyByNode.get(intersectionId) ?? intersectionId;
    const numPhases = this.phaseCountByGroup.get(groupKey) ?? 1;
    if (numPhases <= 0) return "green";

    const cycle = this.cycleLength();
    const offset = this.offsets.get(groupKey) ?? 0;
    const t = ((simTime + offset) % cycle + cycle) % cycle;

    // Each phase gets one slot (green + yellow). Green is "slot − yellow"; if green
    // would go negative (very short cycle, many phases), we degrade gracefully into
    // a thin all-yellow rotation rather than NaN.
    const slot = cycle / numPhases;
    const greenLen = Math.max(0, slot - this.yellow);
    const phaseIdx = Math.min(numPhases - 1, Math.floor(t / slot));
    const tInSlot = t - phaseIdx * slot;
    const isYellow = tInSlot >= greenLen;

    if (phase === phaseIdx) return isYellow ? "yellow" : "green";
    return "red";
  }
}

// Per-intersection mutable state for actuated control.
interface ActuatedState {
  currentPhase: Phase;
  inYellow: boolean;
  phaseStartTime: number;     // simTime at which the current phase (green or yellow) began
  lastDetectionTime: number;  // simTime at which the active phase last saw demand
}

// Vehicle-actuated controller (NEMA-style ring-and-barrier, generalised to N phases).
//
// While in green:
//   - every tick, if any approach in the active phase has a vehicle within DETECTOR_RANGE
//     of the stop line, refresh `lastDetectionTime`;
//   - the green terminates on the first of these:
//       (a) `maxGreen` elapsed since green started — hard cap;
//       (b) `minGreen` elapsed AND the gap since last detection exceeds `passageTime`
//           AND any other phase has waiting demand — gap-out yielding to cross traffic.
//   - if no other phase has demand, the active phase rests until `maxGreen`.
//
// On termination, the active phase enters yellow for `yellow` seconds, then advances to
// (currentPhase + 1) mod N. Each intersection is independent — no inter-junction
// coordination.
export class ActuatedController implements SignalController {
  readonly phaseGroups: PhaseGroup[];
  // State is keyed by group key so all nodes in a group share the same currentPhase
  // and detection timer. byGroup unions every member's per-phase edges so demand on
  // any approach in the group counts towards keeping that phase green.
  private byGroup: Map<string, Map<Phase, PhaseGroup>>;
  private phaseCountByGroup: Map<string, number>;
  private groupKeyByNode: Map<NodeId, string>;
  private states = new Map<string, ActuatedState>();
  yellow = 3;
  minGreen = 6;
  maxGreen = 30;
  passageTime = 2.5;

  constructor(private net: Network) {
    const built = buildPhaseGroups(net);
    this.phaseGroups = built.groups;
    this.byGroup = built.byGroup;
    this.phaseCountByGroup = built.phaseCountByGroup;
    this.groupKeyByNode = built.groupKeyByNode;
    this.reset(0);
  }

  reset(simTime: number) {
    // Alternate starting phase across groups so the network doesn't begin in lock-step.
    let i = 0;
    for (const groupKey of this.byGroup.keys()) {
      const numPhases = this.phaseCountByGroup.get(groupKey) ?? 1;
      const startPhase: Phase = i % Math.max(1, numPhases);
      this.states.set(groupKey, {
        currentPhase: startPhase,
        inYellow: false,
        phaseStartTime: simTime,
        lastDetectionTime: simTime,
      });
      i++;
    }
  }

  update(simTime: number, _dt: number, detected: Set<EdgeId>) {
    for (const [groupKey, st] of this.states) {
      const phaseMap = this.byGroup.get(groupKey);
      if (!phaseMap) continue;
      const numPhases = this.phaseCountByGroup.get(groupKey) ?? 1;
      const nextPhase: Phase = (st.currentPhase + 1) % numPhases;
      const currentPG = phaseMap.get(st.currentPhase);
      const elapsed = simTime - st.phaseStartTime;

      if (st.inYellow) {
        if (elapsed >= this.yellow) {
          st.currentPhase = nextPhase;
          st.inYellow = false;
          st.phaseStartTime = simTime;
          st.lastDetectionTime = simTime;
        }
        continue;
      }

      // Green: refresh detection, then evaluate termination conditions.
      if (currentPG && phaseHasDemand(currentPG, detected)) {
        st.lastDetectionTime = simTime;
      }
      let endGreen = false;
      if (elapsed >= this.maxGreen) {
        endGreen = true;
      } else if (elapsed >= this.minGreen) {
        const gap = simTime - st.lastDetectionTime;
        if (gap > this.passageTime) {
          // Gap-out yields only when ANY other phase has waiting demand; otherwise
          // rest in current to avoid pointless cycling.
          let otherDemand = false;
          for (const [phase, pg] of phaseMap) {
            if (phase === st.currentPhase) continue;
            if (phaseHasDemand(pg, detected)) {
              otherDemand = true;
              break;
            }
          }
          if (otherDemand) endGreen = true;
        }
      }
      if (endGreen) {
        st.inYellow = true;
        st.phaseStartTime = simTime;
      }
    }
  }

  colorFor(_simTime: number, intersectionId: NodeId, incomingEdge: EdgeId): LightColor {
    const node = this.net.nodes.get(intersectionId);
    if (!node || node.kind !== "intersection") return "green";
    const phase = node.phaseOf?.get(incomingEdge);
    if (phase === undefined) return "green";
    const groupKey = this.groupKeyByNode.get(intersectionId) ?? intersectionId;
    const st = this.states.get(groupKey);
    if (!st) return "green";
    if (st.currentPhase === phase) return st.inYellow ? "yellow" : "green";
    return "red";
  }
}

function phaseHasDemand(pg: PhaseGroup, detected: Set<EdgeId>): boolean {
  for (const eid of pg.edges) {
    if (detected.has(eid)) return true;
  }
  return false;
}
