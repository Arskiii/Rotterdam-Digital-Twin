import * as THREE from "three";
import type { Network } from "../sim/types";
import type { TrafficLightController } from "../sim/trafficLight";

const RED = new THREE.Color(0xff3b3b);
const YELLOW = new THREE.Color(0xffd24a);
const GREEN = new THREE.Color(0x33d27a);

interface LightHandle {
  intersection: string;
  edgeId: string;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
}

// One emissive sphere per (intersection, incoming edge) so the user sees per-approach state.
export function buildTrafficLightMeshes(net: Network): {
  group: THREE.Group;
  handles: LightHandle[];
} {
  const group = new THREE.Group();
  group.name = "lights";
  const handles: LightHandle[] = [];

  for (const edge of net.edges.values()) {
    const downstream = net.nodes.get(edge.to)!;
    if (downstream.kind !== "intersection") continue;
    if (downstream.phaseOf?.has(edge.id) !== true) continue;

    // Place the bulb just before the stop line, on the right side of the lane.
    const stopOffset = 6;
    const px = edge.end.x - edge.dir.x * stopOffset + edge.laneOffset.x * 1.4;
    const pz = edge.end.y - edge.dir.y * stopOffset + edge.laneOffset.y * 1.4;
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 12, 12),
      new THREE.MeshBasicMaterial({ color: RED }),
    );
    bulb.position.set(px, 4.5, pz);
    group.add(bulb);

    // A thin pole.
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 4.5, 6),
      new THREE.MeshLambertMaterial({ color: 0x1a1f2a }),
    );
    pole.position.set(px, 2.25, pz);
    group.add(pole);

    handles.push({ intersection: edge.to, edgeId: edge.id, mesh: bulb });
  }

  return { group, handles };
}

export function updateTrafficLightColors(
  handles: LightHandle[],
  lights: TrafficLightController,
  simTime: number,
) {
  for (const h of handles) {
    const c = lights.colorFor(simTime, h.intersection, h.edgeId);
    const target = c === "red" ? RED : c === "yellow" ? YELLOW : GREEN;
    if (!h.mesh.material.color.equals(target)) h.mesh.material.color.copy(target);
  }
}
