import * as THREE from "three";
import { LANE_WIDTH_M, type Network, type NetworkEdge, type NodeId } from "../sim/types";
import { STOP_LINE_OFFSET } from "../sim/vehicle";

const MIN_RIBBON_HALF_WIDTH = LANE_WIDTH_M; // floor so single-lane stubs still draw something visible

// Total visual width of a corridor — sums forward + backward lane counts and converts
// to metres. Falls back to a single-lane width if the edge has no reverse twin.
function corridorWidth(net: Network, edge: NetworkEdge): number {
  const reverse = net.edges.get(`${edge.to}->${edge.from}`);
  const totalLanes = edge.laneCount + (reverse?.laneCount ?? 0);
  return Math.max(totalLanes, 1) * LANE_WIDTH_M;
}

// Centroid of an edge's lane group, perpendicular to the corridor centreline. Used to
// place stop bars at the lane group's middle (not on the corridor centreline, which
// would land between forward and backward traffic on a two-way road).
function laneGroupCenter(edge: NetworkEdge): THREE.Vector2 {
  if (edge.laneOffsets.length === 0) return new THREE.Vector2();
  const sum = new THREE.Vector2();
  for (const o of edge.laneOffsets) sum.add(o);
  return sum.divideScalar(edge.laneOffsets.length);
}

// Heatmap colors for the per-intersection queue overlay.
const PAD_BASE = new THREE.Color(0x4a5066);
const PAD_HOT = new THREE.Color(0xd04a4a);
const PAD_QUEUE_SATURATION = 12; // queue size that maps to fully-hot

export interface NetworkMesh {
  group: THREE.Group;
  // Per-intersection pad meshes, keyed by node id, used by the heatmap updater.
  padHandles: Map<NodeId, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>>;
  // Stop-bar meshes keyed by their inbound edge id — used by the editor's "cycle
  // phase" mode to identify which approach was clicked.
  stopBarHandles: Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>>;
}

/** Resolve an editor hit on either an instanced road or an individual road mesh. */
export function roadEdgesForHit(hit: Pick<THREE.Intersection, "object" | "instanceId">): string[] {
  if (hit.instanceId !== undefined) {
    return hit.object.userData.corridorEdges?.[hit.instanceId] ?? [];
  }
  return hit.object.userData.edgeIds ?? [];
}

// Renders the road network as flat ribbons + intersection pads. We don't draw both directions of
// a pair separately — for visual clarity each undirected corridor becomes one ribbon.
export function buildNetworkMesh(net: Network): NetworkMesh {
  const group = new THREE.Group();
  group.name = "network";

  // Road material is brighter than before so the network reads against the dark ground
  // even at low orbit angles — the previous #2a2f3d sat barely above the ground luminance.
  const roadMat = new THREE.MeshLambertMaterial({ color: 0x3e4458 });
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xf5d27a, transparent: true, opacity: 0.55 });
  const padHandles = new Map<NodeId, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>>();
  const stopBarHandles = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>>();
  const widestInbound = new Map<NodeId, number>();
  for (const edge of net.edges.values()) {
    widestInbound.set(
      edge.to,
      Math.max(widestInbound.get(edge.to) ?? 0, corridorWidth(net, edge)),
    );
  }

  // Index forward and backward edges by their (from, to)-sorted key so the ribbon's
  // userData.edgeIds covers both directions of a two-way corridor.
  const corridorEdges = new Map<string, string[]>();
  for (const edge of net.edges.values()) {
    const key = [edge.from, edge.to].sort().join("|");
    let arr = corridorEdges.get(key);
    if (!arr) {
      arr = [];
      corridorEdges.set(key, arr);
    }
    arr.push(edge.id);
  }

  // Static ribbons, centre lines, and arrows each need only one draw call.
  const ribbons = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), roadMat, corridorEdges.size);
  ribbons.userData.corridorEdges = [...corridorEdges.values()];
  const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dashMat, corridorEdges.size);
  const dummy = new THREE.Object3D();
  let ribbonIndex = 0;
  let dashIndex = 0;
  for (const edgeIds of corridorEdges.values()) {
    const edge = net.edges.get(edgeIds[0])!;

    const fromNode = net.nodes.get(edge.from)!;
    const toNode = net.nodes.get(edge.to)!;
    const start = fromNode.position;
    const end = toNode.position;
    const dx = end.x - start.x;
    const dz = end.y - start.y;
    const len = Math.hypot(dx, dz);
    const cx = (start.x + end.x) / 2;
    const cz = (start.y + end.y) / 2;
    const angle = Math.atan2(dz, dx);

    // Extend each ribbon by a small amount so adjacent ribbons overlap at bends and the
    // network looks continuous even where polylines kink. Capped at 30% of the edge so
    // very short segments don't visibly bulge. Kept small to avoid the heavy z-fighting
    // patches we get when adjacent ribbons overlap a lot at oblique camera angles.
    const overshoot = Math.min(0.3, len * 0.2);
    const ribbonWidth = Math.max(MIN_RIBBON_HALF_WIDTH * 2, corridorWidth(net, edge));
    dummy.rotation.set(-Math.PI / 2, 0, -angle);
    dummy.position.set(cx, 0, cz);
    dummy.scale.set(len + overshoot, ribbonWidth, 1);
    dummy.updateMatrix();
    ribbons.setMatrixAt(ribbonIndex++, dummy.matrix);

    // Center dashed line: only if the corridor is long enough to make sense.
    if (len > 30) {
      dummy.position.y = 0.05;
      dummy.scale.set(len - 24, 0.25, 1);
      dummy.updateMatrix();
      dashes.setMatrixAt(dashIndex++, dummy.matrix);
    }
  }
  dashes.count = dashIndex;
  ribbons.instanceMatrix.needsUpdate = true;
  dashes.instanceMatrix.needsUpdate = true;
  group.add(ribbons, dashes);

  // Intersection pads cover the seams between approach ribbons at every real junction,
  // signalled or not — without a pad, multi-lane edges of differing widths visibly butt
  // against each other and look broken. Signalled junctions are tracked in padHandles
  // so the queue-heatmap updater can recolor them; uncontrolled junctions stay neutral.
  // Pass-through waypoints (curved-road geometry filler) get no pad.
  for (const node of net.nodes.values()) {
    if (node.kind !== "intersection") continue;
    if (!node.isJunction) continue;
    // Find the widest approaching corridor so the pad always covers it. We look at
    // every inbound edge, not just the lit ones, because uncontrolled junctions have
    // no phaseOf entries.
    const widest = Math.max(MIN_RIBBON_HALF_WIDTH * 2, widestInbound.get(node.id) ?? 0);
    const size = widest + 1;
    const padMat = new THREE.MeshLambertMaterial({ color: PAD_BASE.clone() });
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(size, size), padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(node.position.x, 0.10, node.position.y);
    group.add(pad);
    if (node.phaseOf && node.phaseOf.size > 0) padHandles.set(node.id, pad);
  }

  // White stop bars across every lit approach, sitting STOP_LINE_OFFSET back from the
  // intersection center. The bar spans the full lane group of the inbound edge —
  // multi-lane approaches get a wide bar instead of a per-lane stub.
  for (const edge of net.edges.values()) {
    const downstream = net.nodes.get(edge.to);
    if (!downstream || downstream.kind !== "intersection") continue;
    if (downstream.phaseOf?.has(edge.id) !== true) continue;
    const angle = Math.atan2(edge.dir.y, edge.dir.x);
    const center = laneGroupCenter(edge);
    const px = edge.end.x - edge.dir.x * STOP_LINE_OFFSET + center.x;
    const pz = edge.end.y - edge.dir.y * STOP_LINE_OFFSET + center.y;
    const barWidth = edge.laneCount * LANE_WIDTH_M;
    // Use a per-edge material instance so the editor can highlight a specific stop bar
    // (e.g. when hovering in cycle-phase mode) without affecting siblings. 1.2 m thick
    // (was 0.5 m) so the bar stays clickable at reasonable orbit angles.
    const barMat = new THREE.MeshBasicMaterial({ color: 0xeef1f6, transparent: true, opacity: 0.85 });
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(1.2, barWidth), barMat);
    bar.rotation.x = -Math.PI / 2;
    bar.rotation.z = -angle;
    bar.position.set(px, 0.15, pz);
    bar.userData.edgeId = edge.id;
    group.add(bar);
    stopBarHandles.set(edge.id, bar);
  }

  // One-way direction arrows. Drawn for every edge whose corridor has only one
  // direction in the network — these are the roads where the user can't infer flow
  // direction from cars (especially when traffic is sparse). One yellow chevron at
  // the lane-group midpoint, scaled with the edge length so very short stubs don't
  // get a comically large arrow.
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(2.0, 0);
  arrowShape.lineTo(-1.4, 1.1);
  arrowShape.lineTo(-0.6, 0);
  arrowShape.lineTo(-1.4, -1.1);
  arrowShape.lineTo(2.0, 0);
  const arrowGeo = new THREE.ShapeGeometry(arrowShape);
  const arrowMat = new THREE.MeshBasicMaterial({
    color: 0xf5d27a,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  });
  const arrows = new THREE.InstancedMesh(arrowGeo, arrowMat, net.edges.size);
  let arrowIndex = 0;
  for (const edge of net.edges.values()) {
    const reverseId = `${edge.to}->${edge.from}`;
    if (net.edges.has(reverseId)) continue; // two-way corridor — no arrow needed
    if (edge.length < 6) continue; // too short for a useful arrow
    const center = laneGroupCenter(edge);
    const cx = (edge.start.x + edge.end.x) / 2 + center.x;
    const cz = (edge.start.y + edge.end.y) / 2 + center.y;
    dummy.position.set(cx, 0.07, cz);
    dummy.rotation.set(-Math.PI / 2, 0, -Math.atan2(edge.dir.y, edge.dir.x));
    const scale = Math.min(1.2, edge.length / 16);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    arrows.setMatrixAt(arrowIndex++, dummy.matrix);
  }
  arrows.count = arrowIndex;
  arrows.instanceMatrix.needsUpdate = true;
  group.add(arrows);

  return { group, padHandles, stopBarHandles };
}

// Recolors intersection pads as a queue heatmap (gray → red). Idempotent — call every frame.
export function updateIntersectionQueueColors(
  handles: Map<NodeId, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>>,
  queueByIntersection: Map<NodeId, number>,
) {
  for (const [nodeId, mesh] of handles) {
    const q = queueByIntersection.get(nodeId) ?? 0;
    const t = Math.min(1, q / PAD_QUEUE_SATURATION);
    mesh.material.color.copy(PAD_BASE).lerp(PAD_HOT, t);
  }
}
