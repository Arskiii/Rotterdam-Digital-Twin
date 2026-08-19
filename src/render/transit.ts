// RET public transport: trams and metros gliding along their real OSM route
// geometries, braking into stops, dwelling, and continuing. Deterministic
// kinematics on the main thread (no interaction with road traffic).

import * as THREE from "three";
import type { TransitRoute } from "../data/loader";

const VMAX = [11, 21]; // m/s: tram, metro
const ACC = [1.0, 0.9];
const DWELL = [13, 22]; // s at a stop
const SPACING = [1500, 2600]; // one vehicle per N meters of route

interface Veh {
  route: number;
  s: number;
  v: number;
  dwellUntil: number; // sim-relative seconds
  seg: number; // cached polyline segment
  stopIdx: number;
}

export class TransitLayer {
  group = new THREE.Group();
  trams: THREE.InstancedMesh;
  metros: THREE.InstancedMesh;
  stopsPoints: THREE.Points | null = null;
  vehicles: Veh[] = [];
  tramVehIdx: number[] = []; // instance index → vehicles[] index (picking)
  metroVehIdx: number[] = [];
  serviceLevel = 1; // fraction of the fleet in service (night thinning)
  private cum: Float32Array[] = [];
  private time = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(public routes: TransitRoute[]) {
    const mk = (w: number, h: number, d: number, cap: number) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      geo.translate(0, h / 2 + 0.5, 0);
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ fog: true }), cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 7;
      return mesh;
    };
    this.trams = mk(27, 3.2, 2.6, 300);
    this.metros = mk(56, 3.7, 3.0, 300);
    this.group.add(this.trams, this.metros);

    // cumulative arc lengths + seed vehicles with even spacing
    routes.forEach((r, ri) => {
      const n = r.pts.length / 2;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) {
        cum[i] =
          cum[i - 1] +
          Math.hypot(r.pts[i * 2] - r.pts[(i - 1) * 2], r.pts[i * 2 + 1] - r.pts[(i - 1) * 2 + 1]);
      }
      this.cum.push(cum);
      const len = cum[n - 1];
      const count = Math.max(1, Math.min(9, Math.round(len / SPACING[r.kind])));
      for (let k = 0; k < count; k++) {
        this.vehicles.push({
          route: ri,
          s: (len * (k + 0.3)) / count,
          v: VMAX[r.kind] * 0.6,
          dwellUntil: 0,
          seg: 0,
          stopIdx: 0,
        });
      }
    });

    // stop markers
    const stopPos: number[] = [];
    routes.forEach((r, ri) => {
      const cum = this.cum[ri];
      for (const s of r.stops) {
        const p = this.sample(r, cum, s, { seg: 0 });
        stopPos.push(p.x, 1.4, p.z);
      }
    });
    if (stopPos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(stopPos), 3));
      const mat = new THREE.PointsMaterial({ color: 0x9aa4a8, size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0.55 });
      this.stopsPoints = new THREE.Points(geo, mat);
      this.stopsPoints.frustumCulled = false;
      this.stopsPoints.renderOrder = 5;
      this.group.add(this.stopsPoints);
    }
  }

  get vehicleCount() {
    return this.vehicles.length;
  }

  private sample(
    r: TransitRoute,
    cum: Float32Array,
    s: number,
    cache: { seg: number }
  ): { x: number; z: number; hx: number; hy: number; tunnel: boolean } {
    const n = r.pts.length / 2;
    let i = Math.max(0, Math.min(cache.seg, n - 2));
    while (i < n - 2 && cum[i + 1] < s) i++;
    while (i > 0 && cum[i] > s) i--;
    cache.seg = i;
    const segLen = cum[i + 1] - cum[i] || 1;
    const t = Math.max(0, Math.min(1, (s - cum[i]) / segLen));
    const x1 = r.pts[i * 2], y1 = r.pts[i * 2 + 1];
    const x2 = r.pts[(i + 1) * 2], y2 = r.pts[(i + 1) * 2 + 1];
    return {
      x: x1 + (x2 - x1) * t,
      z: -(y1 + (y2 - y1) * t),
      hx: x2 - x1,
      hy: y2 - y1,
      tunnel: r.tunnel[i] === 1,
    };
  }

  /** dt in sim-seconds (already multiplied by physics rate; 0 when paused). */
  update(dt: number) {
    this.time += dt;
    let ti = 0;
    let mi = 0;
    for (let vIdx = 0; vIdx < this.vehicles.length; vIdx++) {
      if (vIdx % 20 >= this.serviceLevel * 20) continue; // parked overnight
      const veh = this.vehicles[vIdx];
      const r = this.routes[veh.route];
      const cum = this.cum[veh.route];
      const len = cum[cum.length - 1];
      const vmax = VMAX[r.kind];
      const acc = ACC[r.kind];

      if (dt > 0 && this.time >= veh.dwellUntil) {
        // next stop ahead
        while (veh.stopIdx < r.stops.length && r.stops[veh.stopIdx] <= veh.s + 1) veh.stopIdx++;
        const nextStop = veh.stopIdx < r.stops.length ? r.stops[veh.stopIdx] : Infinity;
        const distToStop = nextStop - veh.s;
        const brakeV = Math.sqrt(2 * acc * Math.max(0, distToStop));
        const target = Math.min(vmax, brakeV);
        veh.v += Math.max(-acc * 1.6, Math.min(acc, target - veh.v)) * dt;
        veh.v = Math.max(0, veh.v);
        veh.s += veh.v * dt;
        if (distToStop <= 1 && veh.v < 0.6) {
          veh.v = 0;
          veh.dwellUntil = this.time + DWELL[r.kind] * (0.8 + Math.random() * 0.5);
          veh.stopIdx++;
        }
        if (veh.s >= len - 2) {
          veh.s = 0.1;
          veh.v = 0;
          veh.seg = 0;
          veh.stopIdx = 0;
          veh.dwellUntil = this.time + 8;
        }
      }

      const p = this.sample(r, cum, veh.s, veh);
      this.dummy.position.set(p.x, 0.55, p.z);
      this.dummy.rotation.set(0, Math.atan2(p.hy, p.hx), 0);
      this.dummy.updateMatrix();
      const dim = p.tunnel ? 0.3 : 1;
      if (r.kind === 0) {
        this.trams.setMatrixAt(ti, this.dummy.matrix);
        this.color.setRGB(0.93 * dim, 0.96 * dim, 0.93 * dim);
        this.trams.setColorAt(ti, this.color);
        this.tramVehIdx[ti] = vIdx;
        ti++;
      } else {
        this.metros.setMatrixAt(mi, this.dummy.matrix);
        this.color.setRGB(0.62 * dim, 0.76 * dim, 0.98 * dim);
        this.metros.setColorAt(mi, this.color);
        this.metroVehIdx[mi] = vIdx;
        mi++;
      }
    }
    this.trams.count = ti;
    this.metros.count = mi;
    this.trams.instanceMatrix.needsUpdate = true;
    this.metros.instanceMatrix.needsUpdate = true;
    this.trams.instanceColor!.needsUpdate = true;
    this.metros.instanceColor!.needsUpdate = true;
  }

  /** Current world position of a vehicle (for camera tracking). */
  vehicleInfo(index: number): { x: number; z: number; speed: number; label: string } | null {
    const veh = this.vehicles[index];
    if (!veh) return null;
    const r = this.routes[veh.route];
    const p = this.sample(r, this.cum[veh.route], veh.s, { seg: veh.seg });
    return {
      x: p.x,
      z: p.z,
      speed: veh.v,
      label: `${r.kind === 0 ? "TRAM" : "METRO"} ${r.ref.toUpperCase()}`,
    };
  }
}
