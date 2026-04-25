import { createScene } from "./render/scene";
import { buildNetworkMesh } from "./render/network";
import { buildTrafficLightMeshes, updateTrafficLightColors } from "./render/lights";
import { VehicleRenderer } from "./render/vehicles";
import { World } from "./sim/world";
import { createControls } from "./ui/controls";

const container = document.getElementById("app")!;
const { renderer, scene, camera, controls } = createScene(container);

const world = new World(42);
scene.add(buildNetworkMesh(world.net));
const lightBundle = buildTrafficLightMeshes(world.net);
scene.add(lightBundle.group);
const vehicleRenderer = new VehicleRenderer(1500);
scene.add(vehicleRenderer.mesh);

createControls(world, () => world.reset());

// HUD elements.
const hud = {
  time: document.getElementById("m-time")!,
  active: document.getElementById("m-active")!,
  done: document.getElementById("m-done")!,
  thru: document.getElementById("m-thru")!,
  wait: document.getElementById("m-wait")!,
  queue: document.getElementById("m-queue")!,
  fps: document.getElementById("m-fps")!,
};

let lastWall = performance.now();
let fpsAccum = 0;
let fpsCount = 0;
let lastHudUpdate = 0;

function loop(now: number) {
  const realDt = Math.min(0.1, (now - lastWall) / 1000);
  lastWall = now;

  world.step(realDt);
  vehicleRenderer.sync(world.vehicles, world.net);
  updateTrafficLightColors(lightBundle.handles, world.lights, world.metrics.simTime);

  controls.update();
  renderer.render(scene, camera);

  fpsAccum += realDt;
  fpsCount++;
  if (now - lastHudUpdate > 200) {
    lastHudUpdate = now;
    hud.time.textContent = `${world.metrics.simTime.toFixed(1)} s`;
    hud.active.textContent = String(world.vehicles.length);
    hud.done.textContent = String(world.metrics.completed);
    hud.thru.textContent = `${world.metrics.throughputPerMin().toFixed(1)} /min`;
    hud.wait.textContent = `${world.metrics.avgWait().toFixed(1)} s`;
    hud.queue.textContent = world.metrics.avgQueue().toFixed(1);
    const fps = fpsCount / Math.max(0.0001, fpsAccum);
    hud.fps.textContent = fps.toFixed(0);
    fpsAccum = 0;
    fpsCount = 0;
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
