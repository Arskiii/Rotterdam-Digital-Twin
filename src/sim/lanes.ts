// Turn classification + lane-choice helpers shared by the engine and the OSM adapter.
//
// Lane indexing convention: lane 0 is the rightmost lane in the direction of travel,
// lane (laneCount - 1) is the leftmost. This is the convention every right-hand-traffic
// jurisdiction uses (NL, US, DE, …) and matches OSM's `turn:lanes` ordering, which lists
// lanes from left to right when read left-to-right but is conventionally reversed when
// stored — we explicitly reverse it on parse so index 0 always means rightmost.

import { Vector2 } from "three/src/math/Vector2.js";
import { LANE_WIDTH_M, type NetworkEdge, type TurnDir } from "./types";

const ALL_TURNS: TurnDir[] = ["left", "through", "right"];
const STRAIGHT_THRESHOLD_RAD = Math.PI / 6; // ±30° counts as "through"

// Classifies the turn movement from `incoming` (an edge ending at the intersection)
// to `outgoing` (an edge leaving it). Uses the angle between their direction vectors.
//
// In our 2D plane, +x is east and +y is south (Three.js z = south). A right turn
// rotates the heading clockwise in screen-space, which corresponds to a positive angle
// difference in atan2(y, x). A left turn rotates anticlockwise → negative diff.
export function classifyTurn(incoming: NetworkEdge, outgoing: NetworkEdge): TurnDir {
  const a1 = Math.atan2(incoming.dir.y, incoming.dir.x);
  const a2 = Math.atan2(outgoing.dir.y, outgoing.dir.x);
  let diff = a2 - a1;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  if (Math.abs(diff) < STRAIGHT_THRESHOLD_RAD) return "through";
  return diff > 0 ? "right" : "left";
}

// Pick the best lane on `edge` for a vehicle that needs to make turn `turn` at the end
// of this edge. Right turns prefer the rightmost matching lane, left turns the leftmost,
// and through traffic prefers a middle lane (so it doesn't collide with future
// turn-only lanes on the next edge).
export function chooseLaneForTurn(edge: NetworkEdge, turn: TurnDir): number {
  const n = edge.laneCount;
  if (n === 1) return 0;
  if (turn === "right") {
    for (let i = 0; i < n; i++) if (edge.laneTurns[i].has("right")) return i;
  } else if (turn === "left") {
    for (let i = n - 1; i >= 0; i--) if (edge.laneTurns[i].has("left")) return i;
  } else {
    // Through: prefer middle, fall back outward.
    const mid = Math.floor((n - 1) / 2);
    for (let d = 0; d < n; d++) {
      const i1 = mid + d;
      const i2 = mid - d;
      if (i1 < n && edge.laneTurns[i1].has("through")) return i1;
      if (i2 >= 0 && edge.laneTurns[i2].has("through")) return i2;
    }
  }
  // No lane explicitly allows the requested turn — fall back to the one closest to the
  // expected side of the road. Better than throwing an error mid-simulation.
  if (turn === "right") return 0;
  if (turn === "left") return n - 1;
  return Math.floor(n / 2);
}

// Build a sensible default per-lane turn assignment for an edge with `laneCount` lanes.
// This is what we use when OSM doesn't provide `turn:lanes`. Conventions:
//   - Single lane: all turns allowed.
//   - 2 lanes: right lane = right + through, left lane = left + through.
//   - 3+ lanes: outermost lanes get the side turn + through; interior lanes are
//     through-only.
export function defaultLaneTurns(laneCount: number): Set<TurnDir>[] {
  if (laneCount <= 1) return [new Set(ALL_TURNS)];
  const out: Set<TurnDir>[] = [];
  for (let i = 0; i < laneCount; i++) {
    if (i === 0) out.push(new Set<TurnDir>(["right", "through"]));
    else if (i === laneCount - 1) out.push(new Set<TurnDir>(["left", "through"]));
    else out.push(new Set<TurnDir>(["through"]));
  }
  return out;
}

// Compute per-lane perpendicular offsets relative to the edge's geometric centreline.
//
// `centerOffset` shifts the whole lane group along perpRight: pass 0 for two-way roads
// (each direction's lanes start at the corridor centreline and extend outward into
// their own half) and -laneCount × LANE_WIDTH_M / 2 for one-way roads (lane group
// straddles the centreline). The resulting offsets make `position(t, i) = lerp(start,
// end, t) + laneOffsets[i]` produce the correct lane-centred world position.
export function computeLaneOffsets(
  dir: Vector2,
  laneCount: number,
  centerOffset: number,
): Vector2[] {
  // +y is south: the right side of an eastbound road is therefore +y.
  const perpRight = new Vector2(-dir.y, dir.x);
  const offsets: Vector2[] = [];
  for (let i = 0; i < laneCount; i++) {
    const distance = centerOffset + (laneCount - i - 0.5) * LANE_WIDTH_M;
    offsets.push(perpRight.clone().multiplyScalar(distance));
  }
  return offsets;
}
