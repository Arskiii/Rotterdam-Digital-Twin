import * as THREE from "three";
import type { Network, NetworkEdge, NetworkNode, NodeId } from "./types";

// Builds a 2-row by 3-column grid of intersections (6 total) with one-way pairs of lanes between
// neighbors and "stub" entry/exit nodes hanging off the perimeter so cars can enter and leave.
//
// Coordinates: x = east, z = south (Three.js default has y up). Distances in meters.
export function buildGridNetwork(opts?: {
  cols?: number;
  rows?: number;
  spacing?: number;
  stubLength?: number;
  speedLimit?: number;
}): Network {
  const cols = opts?.cols ?? 3;
  const rows = opts?.rows ?? 2;
  const spacing = opts?.spacing ?? 120;
  const stubLength = opts?.stubLength ?? 60;
  const speedLimit = opts?.speedLimit ?? 13.9; // ~50 km/h

  const nodes = new Map<NodeId, NetworkNode>();
  const edges = new Map<string, NetworkEdge>();

  const intersectionId = (c: number, r: number) => `i_${c}_${r}`;
  const entryId = (side: string, k: number) => `entry_${side}_${k}`;
  const exitId = (side: string, k: number) => `exit_${side}_${k}`;

  // Center the grid around the origin.
  const xOf = (c: number) => (c - (cols - 1) / 2) * spacing;
  const zOf = (r: number) => (r - (rows - 1) / 2) * spacing;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.set(intersectionId(c, r), {
        id: intersectionId(c, r),
        position: new THREE.Vector2(xOf(c), zOf(r)),
        kind: "intersection",
        phaseOf: new Map(),
      });
    }
  }

  function addEdge(fromId: NodeId, toId: NodeId, phase?: 0 | 1): NetworkEdge {
    const from = nodes.get(fromId)!;
    const to = nodes.get(toId)!;
    const start = from.position.clone();
    const end = to.position.clone();
    const delta = end.clone().sub(start);
    const length = delta.length();
    const dir = delta.clone().normalize();
    // Right-hand traffic: lane sits on the right of the centerline (perpendicular, rotated -90°).
    const laneOffset = new THREE.Vector2(dir.y, -dir.x).multiplyScalar(2.0);
    const id = `${fromId}->${toId}`;
    const edge: NetworkEdge = {
      id,
      from: fromId,
      to: toId,
      length,
      start,
      end,
      dir,
      laneOffset,
      speedLimit,
      outgoing: [],
    };
    edges.set(id, edge);
    if (phase !== undefined && to.kind === "intersection") {
      to.phaseOf!.set(id, phase);
    }
    return edge;
  }

  // Internal grid: between every pair of adjacent intersections, add both directions.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const here = intersectionId(c, r);
      if (c + 1 < cols) {
        const east = intersectionId(c + 1, r);
        addEdge(here, east, 1); // E-bound is east-west phase
        addEdge(east, here, 1);
      }
      if (r + 1 < rows) {
        const south = intersectionId(c, r + 1);
        addEdge(here, south, 0); // S-bound is north-south phase
        addEdge(south, here, 0);
      }
    }
  }

  // Perimeter stubs — entry & exit pairs on every outer side of every border intersection.
  const entries: NodeId[] = [];
  const exits: NodeId[] = [];
  function addStub(
    interId: NodeId,
    side: "N" | "S" | "E" | "W",
    k: number,
    phase: 0 | 1,
  ) {
    const inter = nodes.get(interId)!;
    const off = new THREE.Vector2();
    if (side === "N") off.set(0, -stubLength);
    if (side === "S") off.set(0, stubLength);
    if (side === "E") off.set(stubLength, 0);
    if (side === "W") off.set(-stubLength, 0);
    const stubPos = inter.position.clone().add(off);
    const eId = entryId(side, k);
    const xId = exitId(side, k);
    nodes.set(eId, { id: eId, position: stubPos.clone(), kind: "entry" });
    nodes.set(xId, { id: xId, position: stubPos.clone(), kind: "exit" });
    addEdge(eId, interId, phase); // inbound (gated by light)
    addEdge(interId, xId); // outbound (always free)
    entries.push(eId);
    exits.push(xId);
  }

  for (let c = 0; c < cols; c++) {
    addStub(intersectionId(c, 0), "N", c, 0);
    addStub(intersectionId(c, rows - 1), "S", c, 0);
  }
  for (let r = 0; r < rows; r++) {
    addStub(intersectionId(0, r), "W", r, 1);
    addStub(intersectionId(cols - 1, r), "E", r, 1);
  }

  // Populate `outgoing` for routing — at each downstream node, which edges are reachable
  // (excluding U-turns back along the same corridor).
  for (const edge of edges.values()) {
    const downstream = nodes.get(edge.to)!;
    if (downstream.kind !== "intersection") continue;
    for (const candidate of edges.values()) {
      if (candidate.from !== downstream.id) continue;
      if (candidate.to === edge.from) continue; // no U-turns
      edge.outgoing.push(candidate.id);
    }
  }

  return { nodes, edges, entries, exits };
}
