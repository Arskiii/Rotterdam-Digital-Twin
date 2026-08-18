// Dynamic layers driven by the simulation worker:
// traffic-signal points, instanced vehicles, per-edge congestion lines.

import * as THREE from "three";
import type { Graph } from "../data/loader";

// signal state codes from the worker: 0 red, 1 amber, 2 green, 3 off
const SIG_COLORS = [
  [255, 64, 62],
  [255, 176, 32],
  [64, 224, 94],
  [58, 58, 60],
];

export class SignalsLayer {
  points: THREE.Points;
  colors: Uint8Array;
  count: number;

  constructor(graph: Graph) {
    const n = graph.signals.count + graph.aux.count;
    this.count = n;
    const pos = new Float32Array(n * 3);
    this.colors = new Uint8Array(n * 3);
    for (let i = 0; i < graph.signals.count; i++) {
      const ni = graph.signals.nodeIdx[i];
      pos[i * 3] = graph.nodesXY[ni * 2];
      pos[i * 3 + 1] = 6.5;
      pos[i * 3 + 2] = -graph.nodesXY[ni * 2 + 1];
    }
    for (let i = 0; i < graph.aux.count; i++) {
      const j = graph.signals.count + i;
      pos[j * 3] = graph.aux.xy[i * 2];
      pos[j * 3 + 1] = 6.5;
      pos[j * 3 + 2] = -graph.aux.xy[i * 2 + 1];
    }
    this.colors.fill(60);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.colors, 3, true));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 40000);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 color;
        varying vec3 vC;
        void main() {
          vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float size = clamp(2600.0 / -mv.z, 1.6, 9.0);
          gl_PointSize = size;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.18, d);
          gl_FragColor = vec4(vC, a * 0.95);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** states: Uint8Array of length count (net signals then aux). */
  update(states: Uint8Array) {
    const c = this.colors;
    const n = Math.min(states.length, this.count);
    for (let i = 0; i < n; i++) {
      const col = SIG_COLORS[states[i] & 3];
      c[i * 3] = col[0];
      c[i * 3 + 1] = col[1];
      c[i * 3 + 2] = col[2];
    }
    (this.points.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }
}

class AgentMesh {
  mesh: THREE.InstancedMesh;
  capacity: number;
  cursor = 0;

  constructor(capacity: number, w: number, h: number, dpt: number) {
    this.capacity = capacity;
    const geo = new THREE.BoxGeometry(w, h, dpt);
    geo.translate(0, h / 2 + 0.25, 0);
    const mat = new THREE.MeshBasicMaterial({ fog: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // instances span the whole city
    this.mesh.renderOrder = 7;
  }
}

export class VehiclesLayer {
  cars: AgentMesh;
  bikes: AgentMesh;
  peds: AgentMesh;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor() {
    this.cars = new AgentMesh(15000, 4.5, 1.7, 2.0);
    this.bikes = new AgentMesh(8000, 1.9, 1.15, 0.5);
    this.peds = new AgentMesh(8000, 0.46, 1.1, 0.46);
  }

  get meshes(): THREE.InstancedMesh[] {
    return [this.cars.mesh, this.bikes.mesh, this.peds.mesh];
  }

  /**
   * data: [x, y(north), heading, k]; k = speed01 + (tunnel?2:0) + mode*4.
   * viewScale inflates instances at far zoom so tracks stay readable.
   */
  update(data: Float32Array, count: number, viewScale = 1) {
    this.cars.cursor = 0;
    this.bikes.cursor = 0;
    this.peds.cursor = 0;
    const carScale = Math.min(6, Math.max(1.45, viewScale));
    const softScale = Math.min(3, Math.max(1.2, viewScale * 0.75));
    for (let i = 0; i < count; i++) {
      let k = data[i * 4 + 3];
      const mode = k >= 8 ? 2 : k >= 4 ? 1 : 0;
      k -= mode * 4;
      const tunnel = k >= 2;
      if (tunnel) k -= 2;
      const target = mode === 0 ? this.cars : mode === 1 ? this.bikes : this.peds;
      if (target.cursor >= target.capacity) continue;
      const x = data[i * 4];
      const z = -data[i * 4 + 1];
      this.dummy.position.set(x, 0.55, z);
      this.dummy.rotation.set(0, data[i * 4 + 2], 0);
      const s = mode === 0 ? carScale : softScale;
      this.dummy.scale.set(s, 1, s);
      this.dummy.updateMatrix();
      const idx = target.cursor++;
      target.mesh.setMatrixAt(idx, this.dummy.matrix);
      const slow = 1 - k;
      let r: number, g: number, b: number;
      if (mode === 0) {
        // headlight amber-white · crawling: brake red
        r = 1.0;
        g = 0.88 - slow * 0.5;
        b = 0.6 - slow * 0.42;
      } else if (mode === 1) {
        // bikes: cool mint
        r = 0.5 - slow * 0.12;
        g = 0.92 - slow * 0.25;
        b = 0.8 - slow * 0.22;
      } else {
        // pedestrians: warm amber-gray
        r = 0.78 - slow * 0.2;
        g = 0.7 - slow * 0.2;
        b = 0.56 - slow * 0.16;
      }
      if (tunnel) { r *= 0.3; g *= 0.3; b *= 0.32; }
      this.color.setRGB(r, g, b);
      target.mesh.setColorAt(idx, this.color);
    }
    for (const t of [this.cars, this.bikes, this.peds]) {
      t.mesh.count = t.cursor;
      t.mesh.instanceMatrix.needsUpdate = true;
      t.mesh.instanceColor!.needsUpdate = true;
    }
  }
}

export class CongestionLayer {
  lines: THREE.LineSegments;
  private colAttr: THREE.BufferAttribute;
  private edgeSegOffset: Uint32Array; // per edge: first vertex index (2 per segment)
  private edgeSegCount: Uint32Array;

  constructor(graph: Graph) {
    let segTotal = 0;
    for (let e = 0; e < graph.edges.count; e++) segTotal += Math.max(0, graph.edges.geoCount[e] - 1);
    const pos = new Float32Array(segTotal * 2 * 3);
    const col = new Uint8Array(segTotal * 2 * 3);
    this.edgeSegOffset = new Uint32Array(graph.edges.count);
    this.edgeSegCount = new Uint32Array(graph.edges.count);
    let v = 0;
    for (let e = 0; e < graph.edges.count; e++) {
      const off = graph.edges.geoOff[e];
      const n = graph.edges.geoCount[e];
      this.edgeSegOffset[e] = v;
      this.edgeSegCount[e] = Math.max(0, n - 1);
      for (let k = 0; k < n - 1; k++) {
        for (const kk of [k, k + 1]) {
          pos[v * 3] = graph.geo[(off + kk) * 2];
          pos[v * 3 + 1] = 1.1;
          pos[v * 3 + 2] = -graph.geo[(off + kk) * 2 + 1];
          v++;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.colAttr = new THREE.BufferAttribute(col, 3, true);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", this.colAttr);
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, fog: true, depthWrite: false })
    );
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.renderOrder = 6;
  }

  /** congestion: Float32Array per edge, 0 free … 1 jammed */
  update(congestion: Float32Array) {
    if (!this.lines.visible) return;
    const col = this.colAttr.array as Uint8Array;
    const n = Math.min(congestion.length, this.edgeSegCount.length);
    for (let e = 0; e < n; e++) {
      const c = congestion[e];
      // green → amber → red ramp
      let r: number, g: number, b: number;
      if (c < 0.5) {
        const t = c / 0.5;
        r = 40 + t * 215;
        g = 200 - t * 30;
        b = 70 - t * 40;
      } else {
        const t = (c - 0.5) / 0.5;
        r = 255;
        g = 170 - t * 120;
        b = 30;
      }
      const v0 = this.edgeSegOffset[e];
      const segs = this.edgeSegCount[e];
      for (let k = 0; k < segs * 2; k++) {
        col[(v0 + k) * 3] = r;
        col[(v0 + k) * 3 + 1] = g;
        col[(v0 + k) * 3 + 2] = b;
      }
    }
    this.colAttr.needsUpdate = true;
  }
}
