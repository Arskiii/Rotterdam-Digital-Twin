import * as THREE from "three";
import type { Network } from "../sim/types";
import type { SignalController } from "../sim/trafficLight";
import { isLiveReadingFresh, type LiveSignalReading } from "../v03/liveSignals";

const RED = new THREE.Color(0xff3b3b);
const YELLOW = new THREE.Color(0xffd24a);
const GREEN = new THREE.Color(0x33d27a);

interface LightHandle {
  intersection: string;
  edgeId: string;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  liveMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
}

// One bulb per signaled approach (per inbound edge tagged in phaseOf). Trusts OSM —
// if an intersection's signal is modeled with multiple per-approach signal heads in
// OSM, it visually shows multiple heads here too.
export function buildTrafficLightMeshes(net: Network): {
  group: THREE.Group;
  handles: LightHandle[];
} {
  const group = new THREE.Group();
  group.name = "lights";
  const handles: LightHandle[] = [];

  for (const edge of net.edges.values()) {
    const downstream = net.nodes.get(edge.to);
    if (!downstream || downstream.kind !== "intersection") continue;
    if (downstream.phaseOf?.has(edge.id) !== true) continue;

    // Place the bulb just before the stop line, slightly outside the rightmost lane
    // (so it sits on the road shoulder rather than over the lane itself).
    const stopOffset = 6;
    const rightLane = edge.laneOffsets[0];
    const perpRight = new THREE.Vector2(-edge.dir.y, edge.dir.x);
    const SHOULDER_M = 1.6;
    const px = edge.end.x - edge.dir.x * stopOffset + rightLane.x + perpRight.x * SHOULDER_M;
    const pz = edge.end.y - edge.dir.y * stopOffset + rightLane.y + perpRight.y * SHOULDER_M;

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 12, 12),
      new THREE.MeshBasicMaterial({ color: RED }),
    );
    bulb.position.set(px, 4.5, pz);
    // Tagged so the editor's cycle-phase mode can identify which approach was clicked.
    bulb.userData.edgeId = edge.id;
    group.add(bulb);

    // A separate, smaller bulb above the simulated one shows an observed state.
    // It is hidden whenever the observation expires or the feed is unavailable.
    const liveBulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.72, 12, 12),
      new THREE.MeshBasicMaterial({ color: RED }),
    );
    liveBulb.position.set(px, 7.2, pz);
    liveBulb.visible = false;
    group.add(liveBulb);

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 4.5, 6),
      new THREE.MeshLambertMaterial({ color: 0x1a1f2a }),
    );
    pole.position.set(px, 2.25, pz);
    group.add(pole);

    handles.push({ intersection: edge.to, edgeId: edge.id, mesh: bulb, liveMesh: liveBulb });
  }

  return { group, handles };
}

export function updateLiveTrafficLightColors(
  handles: LightHandle[],
  readings: Map<string, LiveSignalReading>,
  now = Date.now(),
): number {
  let visible = 0;
  for (const h of handles) {
    const reading = readings.get(h.edgeId);
    const fresh = reading !== undefined && isLiveReadingFresh(reading, now);
    h.liveMesh.visible = fresh;
    if (fresh) {
      const target = reading.state === "red" ? RED : reading.state === "yellow" ? YELLOW : GREEN;
      if (!h.liveMesh.material.color.equals(target)) h.liveMesh.material.color.copy(target);
      visible++;
    }
  }
  return visible;
}

export function updateTrafficLightColors(
  handles: LightHandle[],
  lights: SignalController,
  simTime: number,
) {
  for (const h of handles) {
    const c = lights.colorFor(simTime, h.intersection, h.edgeId);
    const target = c === "red" ? RED : c === "yellow" ? YELLOW : GREEN;
    if (!h.mesh.material.color.equals(target)) h.mesh.material.color.copy(target);
  }
}
