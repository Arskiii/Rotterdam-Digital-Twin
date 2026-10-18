import { createScene } from "./render/scenarioScene";
import { buildNetworkMesh, updateIntersectionQueueColors } from "./render/network";
import { buildTrafficLightMeshes, updateTrafficLightColors } from "./render/lights";
import { VehicleRenderer } from "./render/vehicles";
import { World } from "./sim/world";
import { createControls } from "./ui/controls";
import { Sparkline } from "./ui/sparkline";
import { installNavigation } from "./ui/platform";
import { createQuickControls } from "./ui/quickControls";

installNavigation("grid");

const container = document.getElementById("app")!;
const { renderer, scene, camera, controls } = createScene(container);

const world = new World(42);
const networkMesh = buildNetworkMesh(world.net);
scene.add(networkMesh.group);
const lightBundle = buildTrafficLightMeshes(world.net);
scene.add(lightBundle.group);
const vehicleRenderer = new VehicleRenderer(2000);
scene.add(vehicleRenderer.mesh);

// HUD elements.
const hud = {
  time: document.getElementById("m-time")!,
  active: document.getElementById("m-active")!,
  done: document.getElementById("m-done")!,
  thru: document.getElementById("m-thru")!,
  wait: document.getElementById("m-wait")!,
  waitTail: document.getElementById("m-wait-tail")!,
  waitMax: document.getElementById("m-wait-max")!,
  stops: document.getElementById("m-stops")!,
  delay: document.getElementById("m-delay")!,
  phase: document.getElementById("m-phase")!,
  demand: document.getElementById("m-demand")!,
  queue: document.getElementById("m-queue")!,
  fps: document.getElementById("m-fps")!,
};

const sparks = {
  thru: new Sparkline(document.getElementById("s-thru") as HTMLCanvasElement, 120, "#7fb3ff"),
  wait: new Sparkline(document.getElementById("s-wait") as HTMLCanvasElement, 120, "#ffd24a"),
  worst: new Sparkline(document.getElementById("s-worst") as HTMLCanvasElement, 120, "#ff7d6b"),
};

function resetView() {
  camera.position.set(220, 260, 260);
  controls.target.set(0, 0, 0);
  controls.update();
}
const updateQuickControls = createQuickControls(world, resetView, () => {
  camera.position.set(0, 550, 0.01);
  controls.target.set(0, 0, 0);
  controls.update();
});

createControls(
  world,
  () => {
    world.reset();
    sparks.thru.reset();
    sparks.wait.reset();
    sparks.worst.reset();
    lastSparkSimTime = 0;
  },
  resetView,
);

let lastWall = performance.now();
let fpsAccum = 0;
let fpsCount = 0;
let lastHudUpdate = 0;
let lastSparkSimTime = 0;

function loop(now: number) {
  const realDt = Math.min(0.1, (now - lastWall) / 1000);
  lastWall = now;

  world.step(realDt);
  vehicleRenderer.sync(world.vehicles, world.net);
  updateTrafficLightColors(lightBundle.handles, world.lights, world.metrics.simTime);
  updateIntersectionQueueColors(networkMesh.padHandles, world.queueByIntersection);

  controls.update();
  renderer.render(scene, camera);

  // Sparkline samples advance with sim time, so pause freezes them and 10× speed scrolls 10× faster.
  while (world.metrics.simTime - lastSparkSimTime >= 1) {
    lastSparkSimTime += 1;
    sparks.thru.push(world.metrics.throughputPerMin());
    sparks.wait.push(world.metrics.avgWait());
    sparks.worst.push(world.metrics.worstWaitAvg());
  }

  fpsAccum += realDt;
  fpsCount++;
  if (now - lastHudUpdate > 200) {
    lastHudUpdate = now;
    updateQuickControls();
    const m = world.metrics;
    const sp = world.spawner;
    const demand = sp.spawned + sp.rejected;
    hud.time.textContent = `${m.simTime.toFixed(1)} s`;
    hud.active.textContent = String(world.vehicles.length);
    hud.done.textContent = String(m.completed);
    hud.thru.textContent = `${m.throughputPerMin().toFixed(1)} /min`;
    hud.wait.textContent = `${m.avgWait().toFixed(1)} s`;
    hud.waitTail.textContent = `${m.worstWaitAvg().toFixed(1)} s`;
    hud.waitMax.textContent = `${m.maxActiveWait.toFixed(1)} s`;
    hud.stops.textContent = m.avgStops().toFixed(2);
    hud.delay.textContent = `${m.delayRatio().toFixed(2)}×`;
    hud.phase.textContent = `${(m.phaseUtilization() * 100).toFixed(0)}%`;
    hud.demand.textContent =
      demand === 0 ? "100%" : `${((sp.spawned / demand) * 100).toFixed(0)}%`;
    hud.queue.textContent = m.avgQueue().toFixed(1);
    const fps = fpsCount / Math.max(0.0001, fpsAccum);
    hud.fps.textContent = fps.toFixed(0);
    fpsAccum = 0;
    fpsCount = 0;
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
