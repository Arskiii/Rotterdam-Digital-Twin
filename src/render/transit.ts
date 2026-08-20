// RET public transport: trams and metros gliding along their real OSM route
// geometries, braking into stops, dwelling, and continuing. Deterministic
// kinematics on the main thread (no interaction with road traffic).

import * as THREE from "three";
import type { TransitRoute } from "../data/loader";

const VMAX = [11, 21]; // m/s: tram, metro
const ACC = [1.0, 0.9];
const DWELL = [13, 22]; // s at a stop
const SPACING = [1700, 3800]; // one vehicle per N meters of route
// same-kind separation: a vehicle closing on another one ahead on the same
// heading brakes like a block signal, so fleets can't bunch nose-to-tail —
// also across the parallel OSM relation variants that share physical track
const MIN_GAP = [70, 140]; // m: tram, metro

interface Veh {
  route: number;
  s: number;
  v: number;
  dwellUntil: number; // sim-relative seconds
  seg: number; // cached polyline segment
  stopIdx: number;
  // last sampled world pose (for cross-route separation)
  px: number;
  pz: number;
  dx: number; // normalized world heading
  dz: number;
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
      // deterministic per-route phase so near-identical relation variants
      // (directions, short-turn services) don't seed lockstep twins
      const phase = (((ri + 1) * 2654435761) >>> 0) % 97 / 97;
      for (let k = 0; k < count; k++) {
        this.vehicles.push({
          route: ri,
          s: (len * ((k + phase) / count)) % len,
          v: VMAX[r.kind] * 0.6,
          dwellUntil: 0,
          seg: 0,
          stopIdx: 0,
          px: NaN,
          pz: NaN,
          dx: 0,
          dz: 0,
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
    // spatial hash of last-frame poses per kind (cell 120 m) for separation
    const CELL = 120;
    const hash = new Map<string, number[]>();
    for (let vIdx = 0; vIdx < this.vehicles.length; vIdx++) {
      const veh = this.vehicles[vIdx];
      if (Number.isNaN(veh.px)) continue;
      const k = `${this.routes[veh.route].kind}:${Math.floor(veh.px / CELL)},${Math.floor(veh.pz / CELL)}`;
      let cell = hash.get(k);
      if (!cell) hash.set(k, (cell = []));
      cell.push(vIdx);
    }
    const gapAhead = (vIdx: number): number => {
      const veh = this.vehicles[vIdx];
      if (Number.isNaN(veh.px)) return Infinity;
      const kind = this.routes[veh.route].kind;
      const cx = Math.floor(veh.px / CELL), cz = Math.floor(veh.pz / CELL);
      let best = Infinity;
      for (let gx = cx - 1; gx <= cx + 1; gx++)
        for (let gz = cz - 1; gz <= cz + 1; gz++)
          for (const oIdx of hash.get(`${kind}:${gx},${gz}`) ?? []) {
            if (oIdx === vIdx) continue;
            const o = this.vehicles[oIdx];
            const ddx = o.px - veh.px, ddz = o.pz - veh.pz;
            const d = Math.hypot(ddx, ddz);
            if (d >= best || d > 2 * MIN_GAP[kind]) continue;
            // only vehicles ahead on a similar heading count (not oncoming passes)
            if (ddx * veh.dx + ddz * veh.dz <= 0) continue;
            if (o.dx * veh.dx + o.dz * veh.dz < 0.3) continue;
            best = d;
          }
      return best;
    };
    for (let vIdx = 0; vIdx < this.vehicles.length; vIdx++) {
      if (vIdx % 20 >= this.serviceLevel * 20) continue; // parked overnight
      const veh = this.vehicles[vIdx];
      const r = this.routes[veh.route];
      const cum = this.cum[veh.route];
      const len = cum[cum.length - 1];
      const vmax = VMAX[r.kind];
      const acc = ACC[r.kind];

      if (dt > 0 && this.time >= veh.dwellUntil) {
        // next stop ahead — only skip stops clearly behind us; a pending stop
        // less than a meter ahead is still a stop (the old +1 m tolerance let
        // a braking vehicle creep into the window and lose its stop entirely)
        while (veh.stopIdx < r.stops.length && r.stops[veh.stopIdx] < veh.s - 0.5) veh.stopIdx++;
        const nextStop = veh.stopIdx < r.stops.length ? r.stops[veh.stopIdx] : Infinity;
        const distToStop = nextStop - veh.s;
        const brakeV = Math.sqrt(2 * acc * Math.max(0, distToStop));
        const gap = gapAhead(vIdx);
        const sepCap = gap === Infinity ? vmax : vmax * Math.min(1, Math.max(0, (gap - 28) / MIN_GAP[r.kind]));
        const target = Math.min(vmax, brakeV, sepCap);
        veh.v += Math.max(-acc * 1.6, Math.min(acc, target - veh.v)) * dt;
        veh.v = Math.max(0, veh.v);
        const advanced = veh.s + veh.v * dt;
        if (advanced >= nextStop - 0.6) {
          // arrival capture must be frame-rate independent: crossing the stop
          // in one integration step still means the service calls there, so
          // snap to the platform instead of sailing through on a large dt
          veh.s = nextStop;
          veh.v = 0;
          veh.dwellUntil = this.time + DWELL[r.kind] * (0.8 + Math.random() * 0.5);
          veh.stopIdx++;
        } else {
          veh.s = advanced;
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
      veh.px = p.x;
      veh.pz = p.z;
      const hl = Math.hypot(p.hx, p.hy) || 1;
      veh.dx = p.hx / hl;
      veh.dz = -p.hy / hl;
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

// ---------------- live vehicle fixes (OVapi GTFS-RT) ----------------
// Last-known real positions of trams, metros, buses and trains from the
// national GTFS-RT feed — rendered as glowing diamonds over the simulated
// fleet: the sim animates, the fixes are ground truth.

const FIX_COLORS: [number, number, number][] = [
  [95, 216, 141], // 0 tram
  [235, 96, 84], // 1 metro
  [235, 186, 92], // 2 bus
  [238, 238, 238], // 3 train
];

export class LiveFixesLayer {
  points: THREE.Points;
  count = 0;
  private cap = 600;
  private pos: Float32Array;
  private col: Uint8Array;

  constructor() {
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Uint8Array(this.cap * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3, true));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 color;
        varying vec3 vC;
        void main() {
          vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(2600.0 / -mv.z, 3.0, 10.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC;
        void main() {
          vec2 uv = abs(gl_PointCoord - 0.5);
          float d = uv.x + uv.y;
          if (d > 0.5) discard;
          float ring = smoothstep(0.5, 0.34, d);
          gl_FragColor = vec4(vC, 0.5 + 0.45 * ring);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    // starts empty (drawRange 0); the layer checkbox controls visibility
  }

  /** vehicles: [x, y, kind, bearing, line] in projected data coords. */
  set(vehicles: [number, number, number, number, string][]) {
    const n = Math.min(this.cap, vehicles.length);
    for (let i = 0; i < n; i++) {
      const [x, y, kind] = vehicles[i];
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = 8;
      this.pos[i * 3 + 2] = -y;
      const c = FIX_COLORS[kind] ?? FIX_COLORS[2];
      this.col[i * 3] = c[0];
      this.col[i * 3 + 1] = c[1];
      this.col[i * 3 + 2] = c[2];
    }
    this.count = n;
    const geo = this.points.geometry;
    geo.setDrawRange(0, n);
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }
}
