// Miniature rotating wireframe quadcopter for the unit detail card.

import * as THREE from "three";

export class DroneViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rig = new THREE.Group();
  private props: THREE.Group[] = [];
  active = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);
    this.camera.position.set(2.75, 1.1, 3.2);
    this.camera.lookAt(0, -0.14, 0);

    const mat = new THREE.LineBasicMaterial({ color: 0xd8d8d8, transparent: true, opacity: 0.9 });
    const dim = new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.55 });

    const edges = (geo: THREE.BufferGeometry, m = mat, threshold = 12) =>
      new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), m);

    // body
    const body = edges(new THREE.BoxGeometry(1.15, 0.34, 0.78));
    const canopy = edges(new THREE.BoxGeometry(0.62, 0.22, 0.5));
    canopy.position.set(0.12, 0.28, 0);
    // camera gimbal
    const gimbal = edges(new THREE.SphereGeometry(0.17, 8, 6), dim);
    gimbal.position.set(0.32, -0.28, 0);
    const lens = edges(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 8), dim);
    lens.rotation.z = Math.PI / 2;
    lens.position.set(0.5, -0.28, 0);
    this.rig.add(body, canopy, gimbal, lens);

    // arms + rotors
    const armPos = [
      [0.78, 0.62],
      [0.78, -0.62],
      [-0.78, 0.62],
      [-0.78, -0.62],
    ];
    for (const [ax, az] of armPos) {
      const arm = edges(new THREE.BoxGeometry(Math.hypot(ax, az) * 0.94, 0.09, 0.09), dim);
      arm.position.set(ax / 2, 0.06, az / 2);
      arm.rotation.y = -Math.atan2(az, ax);
      this.rig.add(arm);

      const ring = edges(new THREE.TorusGeometry(0.46, 0.018, 6, 26), mat, 1);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(ax, 0.12, az);
      this.rig.add(ring);

      const hub = edges(new THREE.CylinderGeometry(0.06, 0.08, 0.16, 6), dim);
      hub.position.set(ax, 0.12, az);
      this.rig.add(hub);

      const prop = new THREE.Group();
      for (let b = 0; b < 2; b++) {
        const blade = edges(new THREE.BoxGeometry(0.78, 0.015, 0.07), dim);
        blade.rotation.y = b * Math.PI * 0.5 + 0.4;
        prop.add(blade);
      }
      prop.position.set(ax, 0.15, az);
      this.rig.add(prop);
      this.props.push(prop);
    }

    // legs
    for (const sz of [-1, 1]) {
      const leg = edges(new THREE.BoxGeometry(0.06, 0.5, 0.06), dim);
      leg.position.set(-0.15, -0.4, 0.32 * sz);
      const skid = edges(new THREE.BoxGeometry(0.8, 0.05, 0.06), dim);
      skid.position.set(-0.05, -0.64, 0.32 * sz);
      this.rig.add(leg, skid);
    }

    this.rig.rotation.z = 0.06;
    this.scene.add(this.rig);
  }

  render(t: number) {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || 200;
    const h = canvas.clientHeight || 116;
    if (canvas.width !== Math.round(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.rig.rotation.y = t * 0.00042;
    this.rig.position.y = Math.sin(t * 0.0012) * 0.05 - 0.05;
    for (let i = 0; i < this.props.length; i++) {
      this.props[i].rotation.y = t * 0.02 * (i % 2 === 0 ? 1 : -1);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
