import type { Vector2 } from "three";

export type NodeId = string;
export type EdgeId = string;

// Allowed turn movements at the downstream intersection. Used to assign cars to lanes
// (left-turners pick a lane that allows "left", straight-through cars prefer "through",
// right-turners pick a "right" lane).
export type TurnDir = "left" | "through" | "right";

// Standard urban lane width in metres (Dutch streets are 3.0–3.5 m; we use 3.5 so the
// visuals are comfortably readable).
export const LANE_WIDTH_M = 3.5;

// An intersection or a network entry/exit point.
export interface NetworkNode {
  id: NodeId;
  position: Vector2; // x, z plane (meters)
  kind: "intersection" | "entry" | "exit";
  // For intersections: which incoming edges belong to which phase group. Phase numbers
  // are non-negative integers; the highest phase number used at a node + 1 gives the
  // node's total phase count, which the controller cycles through. With the default
  // OSM importer this is 0 = N-S, 1 = E-W, but the editor can introduce phases 2, 3, …
  // to give complex intersections protected movements.
  phaseOf?: Map<EdgeId, number>;
  // True if this node is a real road junction (≥2 distinct ways meet); false for
  // pass-through waypoints used to model curved street geometry. The renderer uses it
  // to decide where to draw intersection pads (which cover the seams between approach
  // ribbons), independently of whether the junction carries a signal.
  isJunction?: boolean;
  // Identifier shared by all junction nodes that should operate as a single signal —
  // useful for OSM-modeled "complex" intersections (divided roads, scissor crossings)
  // that consist of multiple junction nodes but logically run as one controller. When
  // unset the node's id is used, so an unsignaled or solo signaled junction looks the
  // same as before. Populated by the v0.3 editor's "Group junctions" mode.
  signalGroupId?: string;
}

// A directed road segment from `from` to `to`. Cars enter at offset 0 and leave at `length`.
// Each segment carries `laneCount` parallel lanes, all in the same direction; lane 0 is
// the rightmost in the direction of travel.
export interface NetworkEdge {
  id: EdgeId;
  name?: string; // Source street name, where available.
  from: NodeId;
  to: NodeId;
  length: number; // meters
  // Cached geometry helpers.
  start: Vector2;
  end: Vector2;
  dir: Vector2; // unit vector along start → end
  speedLimit: number; // m/s
  laneCount: number;
  // Per-lane allowed turn directions at the downstream intersection (index 0 = rightmost).
  laneTurns: Set<TurnDir>[];
  // Per-lane perpendicular offset from the edge's geometric centreline to the lane
  // centre. Used by both the renderer and the vehicle integrator. The forward and
  // backward edges of a two-way road place their lane groups on opposite sides of the
  // corridor centreline, so the renderer doesn't need any extra "side" flag.
  laneOffsets: Vector2[];
  // Turn options at the downstream node, populated after graph build.
  outgoing: EdgeId[];
}

export interface Network {
  nodes: Map<NodeId, NetworkNode>;
  edges: Map<EdgeId, NetworkEdge>;
  entries: NodeId[];
  exits: NodeId[];
}
