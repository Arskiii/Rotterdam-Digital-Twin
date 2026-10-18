// v0.3 entry point — real Rotterdam street data from a downloaded OSM file.
// Reuses the v0.2 simulation engine and renderer; only the network construction differs.
// User edits to the parsed network live in localStorage as a NetworkOverrides object
// (see src/v03/overrides.ts) and are applied immediately after the OSM parse.

import { Fog } from "three";
import { createScene } from "../render/scene";
import { buildNetworkMesh, updateIntersectionQueueColors } from "../render/network";
import { buildTrafficLightMeshes, updateLiveTrafficLightColors, updateTrafficLightColors } from "../render/lights";
import { VehicleRenderer } from "../render/vehicles";
import { World } from "../sim/world";
import { createControls } from "../ui/controls";
import { Sparkline } from "../ui/sparkline";
import { buildOsmNetwork } from "./osm";
import { applyOverrides, loadOverrides } from "./overrides";
import { createEditor } from "./editor";
import { startLiveSignalPolling, type LiveSignalSnapshot } from "./liveSignals";
import { installCityLayers } from "./cityLayers";
import { installNavigation, siteUrl } from "../ui/platform";
import { createQuickControls } from "../ui/quickControls";
import { createCorridorInspector } from "./corridorInspector";

installNavigation("map");

const container = document.getElementById("app")!;
const loading = document.getElementById("loading")!;

async function boot() {
  const xml = await fetch(siteUrl("map.osm"), { signal: AbortSignal.timeout(15_000) }).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch map.osm: ${r.status}`);
    return r.text();
  });
  const summary = buildOsmNetwork(xml);

  // Apply any persisted user edits before the renderer or simulation see the network.
  const overrides = loadOverrides();
  applyOverrides(summary.network, overrides);

  const { renderer, scene, camera, controls } = createScene(container);
  const span = Math.max(summary.bbox.widthM, summary.bbox.heightM);
  controls.maxDistance = span * 2.5;
  controls.minDistance = 20;
  function allowFit(distance: number) {
    controls.maxDistance = Math.max(span * 2.5, distance * 1.2);
    camera.far = Math.max(4000, distance + span * 3);
    camera.updateProjectionMatrix();
    if (scene.fog instanceof Fog) {
      scene.fog.near = distance + span;
      scene.fog.far = distance + span * 3;
    }
  }
  function resetView() {
    const fitDistance = Math.max(summary.bbox.heightM, summary.bbox.widthM / camera.aspect) * 0.8 / Math.tan(camera.fov * Math.PI / 360);
    allowFit(fitDistance);
    camera.position.set(0, fitDistance * 0.8, fitDistance * 0.55);
    controls.target.set(0, 0, 0);
    controls.update();
  }
  resetView();

  const world = new World(42, summary.network);
  world.spawner.carsPerHour = 1200;
  world.maxVehicles = 1200;
  const updateQuickControls = createQuickControls(world, resetView, () => {
    const distance = Math.max(summary.bbox.heightM, summary.bbox.widthM / camera.aspect) * 0.58 / Math.tan(camera.fov * Math.PI / 360);
    allowFit(distance);
    camera.position.set(0, distance, 0.01);
    controls.target.set(0, 0, 0);
    controls.update();
  });

  // Mutable handles — the editor replaces these wholesale on each network rebuild.
  // The render loop dereferences through `refs` so it always sees the latest meshes.
  const refs = {
    networkMesh: buildNetworkMesh(world.net),
    lightBundle: buildTrafficLightMeshes(world.net),
  };
  scene.add(refs.networkMesh.group);
  scene.add(refs.lightBundle.group);
  const vehicleRenderer = new VehicleRenderer(2000);
  scene.add(vehicleRenderer.mesh);
  // Public observations are an independent visual layer; they never drive the simulator.
  let inspector: ReturnType<typeof createCorridorInspector> | undefined;
  void installCityLayers(scene, summary, (snapshot) => inspector?.setSnapshot(snapshot)).catch((error) => {
    console.error("City layers failed", error);
    document.getElementById("city-data-cards")!.textContent = "City data could not be displayed.";
  });

  // Source coverage remains fixed; mutable network counts also update in the HUD loop.
  document.getElementById("m-area")!.textContent =
    `${Math.round(summary.bbox.widthM)} × ${Math.round(summary.bbox.heightM)} m`;
  document.getElementById("m-junctions")!.textContent =
    `${summary.junctionCount} / ${summary.signalCount}`;
  document.getElementById("m-signals-match")!.textContent =
    `${summary.signalsMatched} / ${summary.signalsTagged}`;
  document.getElementById("m-edges")!.textContent = String(summary.edgeCount);

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

  let lastSparkSimTime = 0;
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

  // The network editor reads/writes localStorage and mutates `refs` when overrides
  // change. It re-parses the original OSM each time so we always start from a known
  // baseline, then layers the latest overrides on top.
  const editor = createEditor({ world, scene, camera, renderer, osmXml: xml, refs });
  inspector = createCorridorInspector({ scene, camera, renderer, origin: summary.origin,
    network: () => world.net, mesh: () => refs.networkMesh, editing: () => editor.mode !== "off" });
  document.getElementById("editor-panel")!.addEventListener("toggle", (event) => {
    if (!(event.target as HTMLDetailsElement).open) editor.setMode("off");
  });

  let liveSnapshot: LiveSignalSnapshot | null = null;
  let liveStatus = "Not configured";
  const liveUrl = import.meta.env.VITE_LIVE_SIGNALS_URL?.trim() ?? "";
  startLiveSignalPolling(liveUrl, (snapshot, status) => {
    liveSnapshot = snapshot;
    liveStatus = status;
  });
  const liveHud = document.getElementById("m-live-status")!;
  const liveSource = document.getElementById("m-live-source")!;
  const liveCount = document.getElementById("m-live-count")!;
  const liveUpdated = document.getElementById("m-live-updated")!;
  const emptyReadings = new Map();

  let lastWall = performance.now();
  let fpsAccum = 0;
  let fpsCount = 0;
  let lastHudUpdate = 0;

  loading.classList.add("hidden");

  function loop(now: number) {
    const realDt = Math.min(0.1, (now - lastWall) / 1000);
    lastWall = now;

    world.step(realDt);
    vehicleRenderer.sync(world.vehicles, world.net);
    updateTrafficLightColors(refs.lightBundle.handles, world.lights, world.metrics.simTime);
    const liveVisible = updateLiveTrafficLightColors(
      refs.lightBundle.handles,
      liveSnapshot?.signals ?? emptyReadings,
    );
    updateIntersectionQueueColors(refs.networkMesh.padHandles, world.queueByIntersection);

    controls.update();
    renderer.render(scene, camera);

    // Editor imports and clears also reset model time.
    if (world.metrics.simTime < lastSparkSimTime) {
      lastSparkSimTime = 0;
      Object.values(sparks).forEach((spark) => spark.reset());
    }
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
      inspector!.update();
      const m = world.metrics;
      const sp = world.spawner;
      const demand = sp.spawned + sp.rejected;
      hud.time.textContent = `${m.simTime.toFixed(1)} s`;
      hud.active.textContent = String(world.vehicles.length);
      hud.done.textContent = String(m.completed);
      hud.thru.textContent = `${m.throughputPerMin().toFixed(1)} /min`;
      hud.wait.textContent = m.completed ? `${m.avgWait().toFixed(1)} s` : "—";
      hud.waitTail.textContent = `${m.worstWaitAvg().toFixed(1)} s`;
      hud.waitMax.textContent = `${m.maxActiveWait.toFixed(1)} s`;
      hud.stops.textContent = m.avgStops().toFixed(2);
      hud.delay.textContent = `${m.delayRatio().toFixed(2)}×`;
      hud.phase.textContent = `${(m.phaseUtilization() * 100).toFixed(0)}%`;
      hud.demand.textContent =
        demand === 0 ? "—" : `${((sp.spawned / demand) * 100).toFixed(0)}%`;
      hud.queue.textContent = m.avgQueue().toFixed(1);
      const fps = fpsCount / Math.max(0.0001, fpsAccum);
      hud.fps.textContent = fps.toFixed(0);
      const nodes = [...world.net.nodes.values()];
      document.getElementById("m-junctions")!.textContent = `${nodes.filter((node) => node.isJunction).length} / ${nodes.filter((node) => node.phaseOf?.size).length}`;
      document.getElementById("m-edges")!.textContent = String(world.net.edges.size);
      liveHud.textContent = liveVisible > 0 ? "Connected" : liveStatus === "Connected" ? "No mapped signals" : liveStatus;
      liveSource.textContent = liveSnapshot?.source ?? "—";
      liveCount.textContent = String(liveVisible);
      liveUpdated.textContent = liveSnapshot && liveVisible > 0
        ? `${Math.max(0, Math.round((Date.now() - liveSnapshot.updatedAt) / 1000))} s ago`
        : "—";
      fpsAccum = 0;
      fpsCount = 0;
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot().catch((err) => {
  console.error(err);
  loading.textContent = `The map could not start. ${err instanceof Error ? err.message : String(err)}`;
  const retry = document.createElement("button");
  retry.textContent = "Try again";
  retry.addEventListener("click", () => window.location.reload());
  loading.append(retry);
});
