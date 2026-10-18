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
  renderer.setClearColor(0x182330);
  renderer.domElement.setAttribute("aria-label", "3D traffic map. Drag to orbit, scroll to zoom, and use arrow keys to pan.");
  renderer.domElement.tabIndex = 0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Push fog far out — the original 600-1400 m range was tuned for the v0.2 toy grid
  // (~360 m wide). On the v0.3 OSM tile (~860 m wide) those numbers ate the far half of
  // the network at any low orbit angle, which is what looks like "the map disappeared".
  scene.fog = new THREE.Fog(0x182330, 2000, 4000);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
  camera.position.set(220, 260, 260);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Cap the orbit at ~14° above horizontal — going lower turns flat road planes into
  // invisible slivers and looks broken, especially on the larger v0.3 OSM tile.
  controls.maxPolarAngle = Math.PI * 0.42;
  controls.minDistance = 30;
  controls.maxDistance = 1200;
  // Trackpad-friendly speeds. Without these, panning a Mac trackpad with right-click
  // emulation feels glacial.
  controls.panSpeed = 1.4;
  controls.zoomSpeed = 1.2;
  controls.rotateSpeed = 0.9;
  // Arrow-key panning is the killer feature for laptop users — they don't have to
  // remember the right-click-drag dance.
  controls.keyPanSpeed = 28;
  // Only pan when the map has focus; arrow keys must still edit form fields.
  controls.listenToKeyEvents(renderer.domElement);
  renderer.domElement.addEventListener("pointerdown", () => renderer.domElement.focus({ preventScroll: true }));

  // Lighting — keep it cheap. Hemisphere + a directional for shadows-without-shadows feel.
  scene.add(new THREE.HemisphereLight(0xd7e8ff, 0x566373, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1d4, 2.2);
  sun.position.set(180, 320, 120);
  scene.add(sun);

  // Ground plane.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2200, 2200),
    new THREE.MeshLambertMaterial({ color: 0x182330 }),
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
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(container);

  return { renderer, scene, camera, controls, resize };
}
