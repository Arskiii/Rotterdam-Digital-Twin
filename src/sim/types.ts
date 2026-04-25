import * as THREE from "three";

export type NodeId = string;
export type EdgeId = string;

// An intersection or a network entry/exit point.
export interface NetworkNode {
  id: NodeId;
  position: THREE.Vector2; // x, z plane (meters)
  kind: "intersection" | "entry" | "exit";
  // For intersections: which incoming edges share each phase group.
  // Phase 0 = north–south through, phase 1 = east–west through.
  phaseOf?: Map<EdgeId, 0 | 1>;
}

// A directed lane segment from `from` to `to`. Cars enter at offset 0 and leave at `length`.
export interface NetworkEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  length: number; // meters
  // Cached geometry helpers.
  start: THREE.Vector2;
  end: THREE.Vector2;
  dir: THREE.Vector2; // unit vector
  // Lateral offset perpendicular to dir, used to place the lane on the right side of the road.
  laneOffset: THREE.Vector2;
  speedLimit: number; // m/s
  // Turn options at the downstream node, populated after graph build.
  outgoing: EdgeId[];
}

export interface Network {
  nodes: Map<NodeId, NetworkNode>;
  edges: Map<EdgeId, NetworkEdge>;
  entries: NodeId[];
  exits: NodeId[];
}
