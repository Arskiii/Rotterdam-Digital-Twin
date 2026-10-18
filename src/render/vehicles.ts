import * as THREE from "three";
import type { Network } from "../sim/types";
import type { Vehicle } from "../sim/vehicle";

const CAR_W = 1.9;
const CAR_H = 1.45;
const CAR_L = 4.5;

const PALETTE = [0x4cc2ff, 0xff7d6b, 0xffd24a, 0x9bf06a, 0xc78bff, 0xf5f5f5, 0xff9ad1]
  .map((color) => new THREE.Color(color));

// Keep active cars in a dense prefix so idle capacity costs no draw or upload work.
export class VehicleRenderer {
  mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();

  constructor(private capacity = 1024) {
    const geo = new THREE.BoxGeometry(CAR_L, CAR_H, CAR_W);
    geo.translate(0, CAR_H / 2, 0);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  sync(vehicles: Vehicle[], net: Network) {
    let index = 0;
    for (const v of vehicles) {
      if (v.done) continue;
      if (index === this.capacity) break;
      const edge = net.edges.get(v.edge);
      if (!edge) continue;
      const t = Math.min(1, v.s / edge.length);
      const lane = edge.laneOffsets[Math.min(v.laneIdx, edge.laneOffsets.length - 1)];
      const px = edge.start.x + (edge.end.x - edge.start.x) * t + lane.x;
      const pz = edge.start.y + (edge.end.y - edge.start.y) * t + lane.y;
      this.dummy.position.set(px, 0, pz);
      this.dummy.rotation.set(0, -Math.atan2(edge.dir.y, edge.dir.x), 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(index, this.dummy.matrix);
      // Vehicle identity determines colour even when completion compacts the buffer.
      this.mesh.setColorAt(index, PALETTE[v.id % PALETTE.length]);
      index++;
    }
    this.mesh.count = index;
    const colors = this.mesh.instanceColor!;
    this.mesh.instanceMatrix.clearUpdateRanges();
    colors.clearUpdateRanges();
    if (index > 0) {
      this.mesh.instanceMatrix.addUpdateRange(0, index * 16);
      colors.addUpdateRange(0, index * 3);
      this.mesh.instanceMatrix.needsUpdate = true;
      colors.needsUpdate = true;
    }
  }
}
