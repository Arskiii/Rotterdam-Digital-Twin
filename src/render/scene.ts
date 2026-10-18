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
  // SETUP render-scale override; null tracks the display's ratio (capped at 2)
  pixelRatioOverride: number | null = null;

  /**
   * Render scale the frame-rate governor has settled on, as a fraction of the
   * display's own ratio. 1 means "draw every device pixel we would have drawn".
   *
   * A phone's screen is three device pixels to the CSS pixel, so drawing this
   * city at the display's full ratio means four to nine times the fragments a
   * laptop does, on a fraction of the power budget. Guessing a fixed cap for
   * "phones" gets it wrong in both directions — a recent iPhone is faster than
   * plenty of laptops, and a five-year-old budget Android is not — so the
   * renderer measures instead of assuming. It only ever moves between the steps
   * below, with a wide dead band, so a scene that is comfortably fast stays
   * sharp and one that is struggling gets its frame rate back.
   */
  private renderScale = 1;
  private static readonly SCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.45];
  private scaleIdx = 0;
  private frameEma = 16.7;
  private lastFrameAt = 0;
  /** ms spent continuously slow / continuously fast, not frames spent */
  private slowMs = 0;
  private fastMs = 0;
  /** ms to ignore at startup, while tiles are still streaming in */
  private warmupMs = 4000;

  private desiredPixelRatio() {
    if (this.pixelRatioOverride !== null) return this.pixelRatioOverride;
    return Math.min(window.devicePixelRatio, 2) * this.renderScale;
  }

  /**
   * Watch the frame interval and trade resolution for smoothness when needed.
   *
   * Thresholds are deliberately far apart and measured against wall-clock frame
   * intervals, which are what the viewer actually perceives. Stepping down
   * needs a sustained interval worse than ~42fps — bad enough that nobody would
   * defend the sharpness — and stepping back up needs a much longer run at
   * essentially vsync, which on a 60Hz panel means we have headroom to spare
   * and on a 120Hz one is unmistakable. Nothing in between moves anything.
   */
  private governFrameRate(now: number) {
    if (this.pixelRatioOverride !== null) return; // the operator has pinned it
    const dt = now - this.lastFrameAt;
    this.lastFrameAt = now;
    // A tab that was backgrounded reports a gap of seconds to minutes and says
    // nothing about how fast this device draws. The cutoff has to stay well
    // clear of a genuinely struggling device, though: at 2fps the interval is
    // 500ms, and a governor that discards those readings would go quiet exactly
    // when it is most needed.
    if (dt <= 0 || dt > 3000) return;
    if (this.warmupMs > 0) {
      this.warmupMs -= dt;
      return;
    }
    this.frameEma += (dt - this.frameEma) * 0.06;

    // Counted in milliseconds, not frames. Frames would make every threshold
    // scale with the frame rate — a device at 8fps would have to stay bad for
    // eleven seconds to earn the same response a device at 60fps gets in one
    // and a half, which is precisely backwards.
    const steps = SceneCtx.SCALE_STEPS;
    if (this.frameEma > 24 && this.scaleIdx < steps.length - 1) {
      this.slowMs += dt;
      if (this.slowMs > 1500) this.setRenderScale(this.scaleIdx + 1);
    } else this.slowMs = 0;

    if (this.frameEma < 18.5 && this.scaleIdx > 0) {
      this.fastMs += dt;
      if (this.fastMs > 15000) this.setRenderScale(this.scaleIdx - 1);
    } else this.fastMs = 0;
  }

  private setRenderScale(idx: number) {
    this.scaleIdx = idx;
    this.renderScale = SceneCtx.SCALE_STEPS[idx];
    this.slowMs = 0;
    this.fastMs = 0;
    // give the new resolution time to show what it can do before judging it
    this.warmupMs = 1200;
    this.frameEma = 16.7;
    this.resize();
  }

  /** What the governor has settled on — for diagnostics and for tests. */
  get renderScaleNow() {
    return this.renderScale;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.desiredPixelRatio());
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
    this.renderer.setPixelRatio(this.desiredPixelRatio());
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

  /**
   * Whether the viewer has asked their system for less movement.
   *
   * Read once here rather than at each of the fourteen call sites: a camera
   * flight is the largest motion this product makes, and someone who has set
   * that preference should get a cut instead of a swoop wherever the camera
   * moves — a search result, an incident, a scenario, the boot framing.
   */
  private static readonly REDUCED =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  flyTo(target: THREE.Vector3, distance: number, dur = 900) {
    // 1ms, not 0: the easing divides by this, and a zero duration turns the
    // first frame's 0/0 into NaN positions for the camera.
    if (SceneCtx.REDUCED) dur = 1;
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
    this.governFrameRate(performance.now());
    // browser zoom and monitor moves change devicePixelRatio without a
    // reliable event — one comparison per frame keeps the canvas sharp
    if (this.renderer.getPixelRatio() !== this.desiredPixelRatio()) this.resize();
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
