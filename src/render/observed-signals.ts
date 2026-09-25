import * as THREE from "three";
import type { Graph } from "../data/loader";
import type { ObservedSignalSnapshot } from "../data/live-signals";

const COLORS: Record<string, [number, number, number]> = {
  red: [255, 78, 75], yellow: [255, 191, 50], green: [70, 235, 124],
};

/** Small upper rings show only fresh provider observations, independent of the sim bulbs. */
export class ObservedSignalsLayer {
  points: THREE.Points;
  private allPositions: Float32Array;
  private positions: Float32Array;
  private colors: Uint8Array;
  private observed: ObservedSignalSnapshot | null = null;

  constructor(graph: Graph) {
    const count = graph.signals.count + graph.aux.count;
    this.allPositions = new Float32Array(count * 3);
    for (let i = 0; i < graph.signals.count; i++) {
      const node = graph.signals.nodeIdx[i];
      this.allPositions.set([graph.nodesXY[node * 2], 10, -graph.nodesXY[node * 2 + 1]], i * 3);
    }
    for (let i = 0; i < graph.aux.count; i++) {
      const j = graph.signals.count + i;
      this.allPositions.set([graph.aux.xy[i * 2], 10, -graph.aux.xy[i * 2 + 1]], j * 3);
    }
    this.positions = new Float32Array(count * 3);
    this.colors = new Uint8Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3, true));
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40_000);
    const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 color; varying vec3 vC;
        void main() {
          vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(3500.0 / -mv.z, 4.0, 14.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5 || d < 0.27) discard;
          gl_FragColor = vec4(vC, smoothstep(0.5, 0.3, d));
        }`,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;
  }

  set(snapshot: ObservedSignalSnapshot | null) {
    this.observed = snapshot;
    this.refresh();
  }

  refresh(now = Date.now()) {
    let count = 0;
    for (const signal of this.observed?.signals ?? []) {
      if (signal.observedAt > now + 2000 || now - signal.observedAt > 15_000) continue;
      this.positions.set(this.allPositions.subarray(signal.signalIndex * 3, signal.signalIndex * 3 + 3), count * 3);
      this.colors.set(COLORS[signal.state], count * 3);
      count++;
    }
    this.points.geometry.setDrawRange(0, count);
    (this.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }
}
