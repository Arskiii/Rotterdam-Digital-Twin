// three.js scene, camera and map-style navigation with City/District/Street presets.

import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";

export type ScaleName = "city" | "district" | "street";

const SCALE_DIST: Record<ScaleName, number> = { city: 13500, district: 3800, street: 950 };

export class SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: MapControls;
  private flyFrom?: { pos: THREE.Vector3; tgt: THREE.Vector3; t0: number; dur: number; pos1: THREE.Vector3; tgt1: THREE.Vector3 };
  onScaleChange?: (s: ScaleName) => void;
  private lastScale: ScaleName = "city";
  fog: THREE.Fog;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0a0a0b, 1);

    this.scene = new THREE.Scene();
    this.fog = new THREE.Fog(0x0a0a0b, 8000, 30000);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(46, 1, 5, 90000);
    const d = SCALE_DIST.city;
    this.camera.position.set(d * 0.28, d * 0.78, d * 0.55);
    this.camera.lookAt(0, 0, 0);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.minDistance = 260;
    this.controls.maxDistance = 26000;
    this.controls.maxPolarAngle = Math.PI * 0.36;
    this.controls.zoomToCursor = true;
    this.controls.panSpeed = 1.1;
    this.controls.rotateSpeed = 0.55;

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize() {
    const el = this.renderer.domElement;
    const w = el.clientWidth || el.parentElement?.clientWidth || 800;
    const h = el.clientHeight || el.parentElement?.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get distance() {
    return this.camera.position.distanceTo(this.controls.target);
  }

  scaleForDistance(): ScaleName {
    const d = this.distance;
    if (d > 7200) return "city";
    if (d > 1750) return "district";
    return "street";
  }

  flyTo(target: THREE.Vector3, distance: number, dur = 900) {
    const dir = this.camera.position.clone().sub(this.controls.target);
    const polar = Math.min(Math.PI * 0.33, Math.acos(dir.y / dir.length()));
    const azim = Math.atan2(dir.x, dir.z);
    const pos1 = new THREE.Vector3(
      target.x + Math.sin(azim) * Math.sin(polar) * distance,
      target.y + Math.cos(polar) * distance,
      target.z + Math.cos(azim) * Math.sin(polar) * distance
    );
    this.flyFrom = {
      pos: this.camera.position.clone(),
      tgt: this.controls.target.clone(),
      pos1,
      tgt1: target.clone(),
      t0: performance.now(),
      dur,
    };
  }

  setScale(s: ScaleName) {
    this.flyTo(this.controls.target.clone(), SCALE_DIST[s]);
  }

  zoomBy(factor: number) {
    const dir = this.camera.position.clone().sub(this.controls.target);
    const d = THREE.MathUtils.clamp(dir.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.flyTo(this.controls.target.clone(), d, 380);
  }

  update() {
    if (this.flyFrom) {
      const f = this.flyFrom;
      const t = Math.min(1, (performance.now() - f.t0) / f.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.controls.target.lerpVectors(f.tgt, f.tgt1, e);
      this.camera.position.lerpVectors(f.pos, f.pos1, e);
      if (t >= 1) this.flyFrom = undefined;
    }
    this.controls.update();

    // distance-adaptive fog: far city view sees everything, street view fades fast
    const d = this.distance;
    this.fog.near = d * 1.15;
    this.fog.far = d * 4.6;

    // adaptive clip planes keep depth precision high at every zoom (kills
    // z-shimmer between flat layers while the camera moves)
    const near = THREE.MathUtils.clamp(d * 0.04, 2, 420);
    const far = d * 9 + 6000;
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.08 || Math.abs(far - this.camera.far) / this.camera.far > 0.08) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }

    const s = this.scaleForDistance();
    if (s !== this.lastScale) {
      this.lastScale = s;
      this.onScaleChange?.(s);
    }
  }

  /** Project world point to CSS pixels within the canvas; returns null if behind camera. */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const v = _projV.set(x, y, z).project(this.camera);
    if (v.z > 1) return false;
    const el = this.renderer.domElement;
    out.x = (v.x * 0.5 + 0.5) * el.clientWidth;
    out.y = (-v.y * 0.5 + 0.5) * el.clientHeight;
    return v.x > -1.15 && v.x < 1.15 && v.y > -1.15 && v.y < 1.15;
  }
}

const _projV = new THREE.Vector3();
