import * as THREE from "three";
import type { Network } from "../sim/types";
import type { Vehicle } from "../sim/vehicle";

const CAR_W = 1.9;
const CAR_H = 1.45;
const CAR_L = 4.5;

const PALETTE = [0x4cc2ff, 0xff7d6b, 0xffd24a, 0x9bf06a, 0xc78bff, 0xf5f5f5, 0xff9ad1];

// One InstancedMesh holds all cars. Capacity is fixed; unused instances scaled to 0.
export class VehicleRenderer {
  mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private idToInstance = new Map<number, number>();
  private freeList: number[] = [];

  constructor(capacity = 1024) {
    const geo = new THREE.BoxGeometry(CAR_L, CAR_H, CAR_W);
    geo.translate(0, CAR_H / 2, 0);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this.hidden);
      this.freeList.push(i);
      const c = new THREE.Color(PALETTE[i % PALETTE.length]);
      this.mesh.instanceColor.setXYZ(i, c.r, c.g, c.b);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.count = capacity;
    this.mesh.frustumCulled = false;
  }

  sync(vehicles: Vehicle[], net: Network) {
    const seen = new Set<number>();

    for (const v of vehicles) {
      if (v.done) continue;
      seen.add(v.id);
      let inst = this.idToInstance.get(v.id);
      if (inst === undefined) {
        const free = this.freeList.pop();
        if (free === undefined) continue; // capacity exhausted, skip
        inst = free;
        this.idToInstance.set(v.id, inst);
      }
      const edge = net.edges.get(v.edge)!;
      const t = Math.min(1, v.s / edge.length);
      const px = edge.start.x + (edge.end.x - edge.start.x) * t + edge.laneOffset.x;
      const pz = edge.start.y + (edge.end.y - edge.start.y) * t + edge.laneOffset.y;
      this.dummy.position.set(px, 0, pz);
      this.dummy.rotation.set(0, -Math.atan2(edge.dir.y, edge.dir.x), 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(inst, this.dummy.matrix);
    }

    // Hide instances whose vehicle is gone.
    for (const [id, inst] of [...this.idToInstance]) {
      if (!seen.has(id)) {
        this.idToInstance.delete(id);
        this.freeList.push(inst);
        this.mesh.setMatrixAt(inst, this.hidden);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
