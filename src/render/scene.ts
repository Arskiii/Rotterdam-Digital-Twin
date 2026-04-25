import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  resize: () => void;
}

export function createScene(container: HTMLElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setClearColor(0x0b0d12);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b0d12, 600, 1400);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
  camera.position.set(220, 260, 260);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 30;
  controls.maxDistance = 1200;

  // Lighting — keep it cheap. Hemisphere + a directional for shadows-without-shadows feel.
  scene.add(new THREE.HemisphereLight(0xa6c8ff, 0x1a1f2c, 0.55));
  const sun = new THREE.DirectionalLight(0xfff1d4, 0.9);
  sun.position.set(180, 320, 120);
  scene.add(sun);

  // Ground plane.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2200, 2200),
    new THREE.MeshLambertMaterial({ color: 0x12161f }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);

  // Faint reference grid on the ground.
  const grid = new THREE.GridHelper(2000, 40, 0x1c2234, 0x161b27);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.55;
  scene.add(grid);

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);

  return { renderer, scene, camera, controls, resize };
}
