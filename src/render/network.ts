import * as THREE from "three";
import type { Network } from "../sim/types";

const LANE_WIDTH = 4.0;
const ROAD_HALF_WIDTH = LANE_WIDTH; // two lanes per direction-pair => total 2*LANE_WIDTH

// Renders the road network as flat ribbons + intersection pads. We don't draw both directions of
// a pair separately — for visual clarity each undirected corridor becomes one ribbon.
export function buildNetworkMesh(net: Network): THREE.Group {
  const group = new THREE.Group();
  group.name = "network";

  const roadMat = new THREE.MeshLambertMaterial({ color: 0x2a2f3d });
  const padMat = new THREE.MeshLambertMaterial({ color: 0x32384a });
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xf5d27a, transparent: true, opacity: 0.55 });

  const seenCorridors = new Set<string>();

  for (const edge of net.edges.values()) {
    const key = [edge.from, edge.to].sort().join("|");
    if (seenCorridors.has(key)) continue;
    seenCorridors.add(key);

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

    const ribbon = new THREE.Mesh(
      new THREE.PlaneGeometry(len, ROAD_HALF_WIDTH * 2),
      roadMat,
    );
    ribbon.rotation.x = -Math.PI / 2;
    ribbon.rotation.z = -angle;
    ribbon.position.set(cx, 0, cz);
    group.add(ribbon);

    // Center dashed line: only if the corridor is long enough to make sense.
    if (len > 30) {
      const dashGeo = new THREE.PlaneGeometry(len - 24, 0.25);
      const dashes = new THREE.Mesh(dashGeo, dashMat);
      dashes.rotation.x = -Math.PI / 2;
      dashes.rotation.z = -angle;
      dashes.position.set(cx, 0.02, cz);
      group.add(dashes);
    }
  }

  // Intersection pads.
  for (const node of net.nodes.values()) {
    if (node.kind !== "intersection") continue;
    const size = ROAD_HALF_WIDTH * 2 + 1;
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(size, size), padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(node.position.x, 0.01, node.position.y);
    group.add(pad);
  }

  return group;
}
