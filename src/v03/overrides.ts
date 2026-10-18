// User-authored edits that sit on top of the OSM-parsed network.
//
// Overrides are persisted to localStorage so they survive reloads, and can also be
// exported/imported as JSON. They're applied as a post-pass after `buildOsmNetwork`
// completes, mutating the network in place.

import { computeLaneOffsets, defaultLaneTurns } from "../sim/lanes";
import { LANE_WIDTH_M, type Network, type NetworkEdge } from "../sim/types";

export interface NetworkOverrides {
  // node-id → desired signaled state. true = force-signal, false = force-unsignal.
  // Nodes not present here keep whatever the OSM parse decided.
  signals: Record<string, boolean>;
  // node-id → desired isJunction state (controls whether the renderer draws a pad).
  junctions: Record<string, boolean>;
  // edge-id → desired phase number. Lets the user split a junction's approaches into
  // more than the default two phases (e.g. each leg of a 4-way gets its own protected
  // phase). Capped at MAX_PHASES — UIs that cycle just take `(current + 1) % MAX_PHASES`.
  phaseAssignments: Record<string, number>;
  // Edge IDs (e.g. "node1->node2") that should be removed from the network.
  removedEdges: string[];
  // Brand-new edges added by the user. Two-way edges get materialised as both
  // directions automatically.
  addedEdges: Array<{ from: string; to: string; oneway: boolean; lanes?: number }>;
  // Per-corridor lane configuration. Key is the sorted "<a>|<b>" pair (a < b) so both
  // directions of the corridor share one entry. forward = a→b lanes, backward = b→a
  // lanes; setting one to 0 makes that side a one-way road.
  roadConfigs: Record<string, { forwardLanes: number; backwardLanes: number }>;
  // Logical signal groups. Each inner array is a list of node ids that should run as a
  // single signal (shared cycle, shared phase numbers). Used to glue OSM-modeled
  // multi-node intersections back into one operational signal.
  nodeGroups: string[][];
}

export const MAX_PHASES = 4;
const MAX_EDITS = 10_000;
const MAX_ID_LENGTH = 120;

export const EMPTY_OVERRIDES: NetworkOverrides = {
  signals: {},
  junctions: {},
  phaseAssignments: {},
  removedEdges: [],
  addedEdges: [],
  roadConfigs: {},
  nodeGroups: [],
};

// Canonical key for a corridor — same value regardless of which direction's edge id
// you pass in. "<from>|<to>" sorted alphabetically so forward and backward edges hash
// to the same entry.
export function corridorKey(fromId: string, toId: string): string {
  return [fromId, toId].sort().join("|");
}

const STORAGE_KEY = "rotterdam-v03-overrides";

export function loadOverrides(): NetworkOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneEmpty();
    return parseOverrides(raw);
  } catch {
    return cloneEmpty();
  }
}

// JSON imports and local storage are untrusted input. Copy only known fields into fresh
// objects so malformed data cannot corrupt the graph or create enormous meshes.
export function parseOverrides(json: string): NetworkOverrides {
  if (json.length > 1_000_000) throw new Error("Override file is too large (1 MB maximum)");
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("Overrides must be a JSON object");
  const ids = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
  const record = <T>(v: unknown, valid: (key: string, item: unknown) => item is T): Record<string, T> => {
    if (!isRecord(v) || Object.keys(v).length > MAX_EDITS) throw new Error("Invalid override map");
    const out: Record<string, T> = Object.create(null);
    for (const [key, item] of Object.entries(v)) {
      if (!ids(key) || !valid(key, item)) throw new Error(`Invalid override entry: ${key}`);
      out[key] = item;
    }
    return out;
  };
  const list = <T>(v: unknown, valid: (item: unknown) => item is T): T[] => {
    if (!Array.isArray(v) || v.length > MAX_EDITS || !v.every(valid)) {
      throw new Error("Invalid override list");
    }
    return v;
  };
  const lanes = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 8;
  return {
    signals: record(value.signals ?? {}, (_key, item): item is boolean => typeof item === "boolean"),
    junctions: record(value.junctions ?? {}, (_key, item): item is boolean => typeof item === "boolean"),
    phaseAssignments: record(value.phaseAssignments ?? {}, (_key, item): item is number =>
      Number.isInteger(item) && (item as number) >= 0 && (item as number) < MAX_PHASES),
    removedEdges: list(value.removedEdges ?? [], ids),
    addedEdges: list(value.addedEdges ?? [], (item): item is NetworkOverrides["addedEdges"][number] =>
      isRecord(item) && ids(item.from) && ids(item.to) && item.from !== item.to &&
      typeof item.oneway === "boolean" &&
      (item.lanes === undefined || (lanes(item.lanes) && item.lanes > 0))),
    roadConfigs: record(value.roadConfigs ?? {}, (key, item): item is NetworkOverrides["roadConfigs"][string] =>
      key.split("|").length === 2 && isRecord(item) && lanes(item.forwardLanes) &&
      lanes(item.backwardLanes) && (item.forwardLanes > 0 || item.backwardLanes > 0)),
    nodeGroups: list(value.nodeGroups ?? [], (item): item is string[] =>
      Array.isArray(item) && item.length >= 2 && item.length <= 64 &&
      item.every(ids) && new Set(item).size === item.length),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function saveOverrides(overrides: NetworkOverrides): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    return true;
  } catch {
    return false;
  }
}

export function clearOverrides(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function cloneEmpty(): NetworkOverrides {
  return JSON.parse(JSON.stringify(EMPTY_OVERRIDES));
}

// Mutates `net` to reflect the overrides. Order of operations matters:
//   1. Apply per-corridor lane configs first (replaces edges with new lane counts).
//   2. Remove edges (so re-added edges with the same ID can replace them).
//   3. Add user-authored edges, respecting any later corridor lane configuration.
//   4. Apply junction-pad overrides (visual only).
//   5. Apply signal overrides (rebuild phaseOf for affected nodes).
//   6. Apply per-edge phase-number overrides on top of step 5's defaults.
//   7. Recompute `outgoing` so routing stays consistent with the new edge set.
export function applyOverrides(net: Network, overrides: NetworkOverrides) {
  for (const [key, cfg] of Object.entries(overrides.roadConfigs)) {
    applyRoadConfig(net, key, cfg);
  }

  const removed = new Map<string, NetworkEdge>();
  for (const eid of overrides.removedEdges) {
    const edge = net.edges.get(eid);
    if (edge) removed.set(eid, edge);
    net.edges.delete(eid);
  }

  for (const ae of overrides.addedEdges) {
    const key = corridorKey(ae.from, ae.to);
    const config = overrides.roadConfigs[key];
    if (config) {
      // Connections remain in addedEdges after the lane editor changes them.
      // Recreating their original defaults would undo lane counts or reintroduce
      // the forbidden direction of a one-way road, especially after reconnecting.
      const [a, b] = key.split("|");
      const oneway = config.forwardLanes === 0 || config.backwardLanes === 0;
      if (config.forwardLanes > 0) {
        addUserEdge(net, a, b, config.forwardLanes, oneway, removed.get(`${a}->${b}`));
      }
      if (config.backwardLanes > 0) {
        addUserEdge(net, b, a, config.backwardLanes, oneway, removed.get(`${b}->${a}`));
      }
      continue;
    }
    addUserEdge(net, ae.from, ae.to, ae.lanes ?? 1, ae.oneway, removed.get(`${ae.from}->${ae.to}`));
    if (!ae.oneway) {
      addUserEdge(net, ae.to, ae.from, ae.lanes ?? 1, false, removed.get(`${ae.to}->${ae.from}`));
    }
  }

  // Edge edits must also update signal approaches. Otherwise removed roads keep
  // ghost phases and newly connected roads bypass an existing signal.
  for (const node of net.nodes.values()) {
    if (!node.phaseOf || node.phaseOf.size === 0) continue;
    for (const edgeId of node.phaseOf.keys()) {
      if (!net.edges.has(edgeId)) node.phaseOf.delete(edgeId);
    }
    // A signaled node stays signaled when its last original approach is replaced.
    // Its now-empty map still needs to acquire the newly added approaches.
    for (const edge of net.edges.values()) {
      if (edge.to !== node.id || node.phaseOf.has(edge.id)) continue;
      node.phaseOf.set(edge.id, Math.abs(edge.dir.x) > Math.abs(edge.dir.y) ? 1 : 0);
    }
  }

  for (const [nid, isJunction] of Object.entries(overrides.junctions)) {
    const node = net.nodes.get(nid);
    if (node) node.isJunction = isJunction;
  }

  for (const [nid, signaled] of Object.entries(overrides.signals)) {
    const node = net.nodes.get(nid);
    if (!node) continue;
    if (!node.phaseOf) node.phaseOf = new Map();
    if (!signaled) {
      node.phaseOf.clear();
    } else {
      node.phaseOf.clear();
      // Default phase rule the OSM adapter uses: NS = phase 0, EW = phase 1.
      for (const e of net.edges.values()) {
        if (e.to !== nid) continue;
        const phase = Math.abs(e.dir.x) > Math.abs(e.dir.y) ? 1 : 0;
        node.phaseOf.set(e.id, phase);
      }
    }
  }

  // Per-edge phase overrides — applied last so they win over the default NS/EW split.
  // Skip edges whose downstream isn't a signaled junction (the override would be
  // meaningless and the controller wouldn't read it anyway).
  for (const [edgeId, phase] of Object.entries(overrides.phaseAssignments)) {
    const edge = net.edges.get(edgeId);
    if (!edge) continue;
    const node = net.nodes.get(edge.to);
    if (!node || node.kind !== "intersection") continue;
    if (!node.phaseOf || node.phaseOf.size === 0) continue; // not signaled — skip
    node.phaseOf.set(edgeId, phase);
  }

  // Logical signal groups: every node in a group gets the same signalGroupId, derived
  // from the group's sorted member ids so the same group always produces the same key
  // (deterministic and persistence-friendly).
  for (const group of overrides.nodeGroups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort();
    const groupId = `group_${sorted.join("_")}`;
    for (const nid of group) {
      const node = net.nodes.get(nid);
      if (node) node.signalGroupId = groupId;
    }
  }

  recomputeOutgoing(net);
}

// Replace a corridor's edges with the user's desired lane configuration. We delete the
// existing forward/backward edges and rebuild whichever directions the user wants
// (forwardLanes > 0 means a→b exists with that many lanes; backwardLanes > 0 means
// b→a exists with that many lanes). One-way roads have one of the two = 0.
function applyRoadConfig(
  net: Network,
  key: string,
  cfg: { forwardLanes: number; backwardLanes: number },
) {
  const [a, b] = key.split("|");
  if (!a || !b) return;
  // Find the existing edges between these two nodes (in either direction). They might
  // be split across multiple OSM-derived segments at intermediate waypoints — for v0.4
  // we assume a single segment per direction (true for the great majority of cases).
  const fwdId = `${a}->${b}`;
  const bwdId = `${b}->${a}`;
  const oldForward = net.edges.get(fwdId);
  const oldBackward = net.edges.get(bwdId);
  net.edges.delete(fwdId);
  net.edges.delete(bwdId);
  const isOneWay = cfg.forwardLanes === 0 || cfg.backwardLanes === 0;
  if (cfg.forwardLanes > 0) {
    addUserEdge(net, a, b, cfg.forwardLanes, isOneWay, oldForward ?? oldBackward);
  }
  if (cfg.backwardLanes > 0) {
    addUserEdge(net, b, a, cfg.backwardLanes, isOneWay, oldBackward ?? oldForward);
  }
}

// Build a single edge from one user-added connection. Geometry mirrors the OSM
// adapter's logic so the resulting edge is indistinguishable from a parsed one.
function addUserEdge(
  net: Network,
  fromId: string,
  toId: string,
  laneCount: number,
  isOneWay: boolean,
  original?: NetworkEdge,
) {
  const from = net.nodes.get(fromId);
  const to = net.nodes.get(toId);
  if (!from || !to) return;
  const id = `${fromId}->${toId}`;
  if (net.edges.has(id)) return;
  const start = from.position.clone();
  const end = to.position.clone();
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length < 0.5) return;
  const dir = delta.clone().normalize();
  const centerOffset = isOneWay ? -(laneCount * LANE_WIDTH_M) / 2 : 0;
  net.edges.set(id, {
    id,
    name: original?.name,
    from: fromId,
    to: toId,
    length,
    start,
    end,
    dir,
    speedLimit: original?.speedLimit ?? 13.9,
    laneCount,
    laneTurns: original?.id === id && original.laneCount === laneCount
      ? original.laneTurns.map((turns) => new Set(turns))
      : defaultLaneTurns(laneCount),
    laneOffsets: computeLaneOffsets(dir, laneCount, centerOffset),
    outgoing: [],
  });
}

function recomputeOutgoing(net: Network) {
  const byFrom = new Map<string, NetworkEdge[]>();
  for (const edge of net.edges.values()) {
    const edges = byFrom.get(edge.from) ?? [];
    edges.push(edge);
    byFrom.set(edge.from, edges);
  }
  for (const edge of net.edges.values()) {
    edge.outgoing = [];
    const downstream = net.nodes.get(edge.to);
    if (!downstream || downstream.kind !== "intersection") continue;
    for (const candidate of byFrom.get(downstream.id) ?? []) {
      if (candidate.to === edge.from) continue;
      edge.outgoing.push(candidate.id);
    }
  }
}
