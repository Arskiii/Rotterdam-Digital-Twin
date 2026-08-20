import "./style.css";
import * as THREE from "three";
import { buildChrome, setMeter } from "./ui/chrome";
import { SceneCtx } from "./render/scene";
import { buildCity, buildDistrictBounds, syncFog, setAmbient, RoofStreamer } from "./render/city";
import type { RoofIndex } from "./data/loader";
import { SignalsLayer, VehiclesLayer, CongestionLayer, NdwLayer, AirLayer, LiveIncidentsLayer } from "./render/dynamic";
import { TransitLayer, LiveTransitLayer, LiveStopsLayer } from "./render/transit";
import { loadCity } from "./data/loader";
import { LiveFeed, type LiveSnapshot } from "./data/live";
import { App } from "./ui/app";

const root = document.getElementById("app")!;
const ui = buildChrome(root);

const stageFracs: Record<string, number> = { grid: 0, signals: 0, structures: 0, sim: 0 };
function paintBoot(stage: string, frac: number) {
  stageFracs[stage] = Math.max(stageFracs[stage], frac);
  const s = ui.bootStages[stage];
  if (s) {
    setMeter(s.bars, stageFracs[stage]);
    s.pct.textContent = `${Math.round(stageFracs[stage] * 100)}%`;
  }
}

// Data binaries live in-repo (public/data). Deployments that ship only source
// (e.g. Vercel file deploys) fall back to the pinned GitHub mirror via jsDelivr.
const DATA_FALLBACK =
  "https://cdn.jsdelivr.net/gh/Arskiii/Rotterdam-Digital-Twin@2ac52386897c1be74a128ca095acd73fc05a8f26/public/data/";

async function resolveDataBase(): Promise<string> {
  const local = `${import.meta.env.BASE_URL}data/`;
  try {
    const res = await fetch(`${local}meta.json`, { method: "HEAD" });
    if (res.ok) return local;
  } catch {
    /* fall through */
  }
  return DATA_FALLBACK;
}

/**
 * Stand-in for a sim core that would not start.
 *
 * The app posts parameter changes from seventeen places and reads frames from
 * onmessage; none of it is load-bearing for the live map, and its metrics and
 * frame fields are already nullable. Swallowing the messages keeps every one
 * of those call sites honest without a null check apiece.
 */
function inertWorker(): Worker {
  return {
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    terminate() {},
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    dispatchEvent: () => false,
  } as unknown as Worker;
}

async function boot() {
  const scene = new SceneCtx(ui.sceneCanvas);

  const dataBase = await resolveDataBase();

  // The sim engine boots on its own thread the moment graph.bin lands —
  // in parallel with the rest of the download and all mesh building. Its
  // init posts progress so SIM CORE keeps moving on slow devices, and a
  // worker failure surfaces as a boot error instead of a silent hang.
  let worker: Worker | null = null;
  let simReady: Promise<void> | null = null;
  const startSim = (graphBuffer: ArrayBuffer, meta: { districts: { name: string; x: number; y: number }[] }) => {
    const w = new Worker(new URL("./sim/worker.ts", import.meta.url), { type: "module" });
    worker = w;
    paintBoot("sim", 0.04);
    simReady = new Promise<void>((resolve, reject) => {
      const h = (ev: MessageEvent) => {
        if (ev.data?.type === "initProgress") paintBoot("sim", 0.04 + 0.92 * ev.data.frac);
        else if (ev.data?.type === "ready") {
          paintBoot("sim", 1);
          w.removeEventListener("message", h);
          resolve();
        }
      };
      w.addEventListener("message", h);
      // A worker that dies from memory pressure reports an empty message — the
      // common case on phones, where the graph and its derived tables are a
      // lot to hold beside a 3D scene. Saying "see console" there is useless:
      // the device that fails is the one with no console.
      w.addEventListener("error", (e) =>
        reject(new Error(e.message || "out of memory, or workers are blocked in this browser"))
      );
      w.addEventListener("messageerror", () => reject(new Error("message decode error")));
    });
    simReady.catch(() => {}); // surfaced at the await below
    const graphCopy = graphBuffer.slice(0);
    w.postMessage(
      {
        type: "init",
        graphBuffer: graphCopy,
        districtCount: meta.districts.length,
        districts: meta.districts.map((d) => ({ name: d.name, x: d.x, y: d.y })),
      },
      [graphCopy]
    );
  };

  // roofs index is tiny — fetch it alongside everything else, attach later
  const roofsIndexP: Promise<RoofIndex | null> = fetch(`${dataBase}roofs/index.json`)
    .then((res) => (res.ok ? (res.json() as Promise<RoofIndex>) : null))
    .catch(() => null);

  const data = await loadCity(dataBase, paintBoot, startSim);
  paintBoot("grid", 1);
  paintBoot("signals", 1);
  if (!simReady) startSim(data.graphBuffer, data.meta);

  const meshes = await buildCity(data, scene.scene, (f) => paintBoot("structures", 0.55 + f * 0.45));
  paintBoot("structures", 1);

  // true LoD2.2 roofs stream in around the camera when the data is present
  let roofs: RoofStreamer | null = null;
  roofsIndexP.then((index) => {
    if (index) roofs = new RoofStreamer(dataBase, index, data.buildings, meshes.buildings);
  });

  const signals = new SignalsLayer(data.graph);
  const vehicles = new VehiclesLayer();
  const congestion = new CongestionLayer(data.graph);
  const transit = new TransitLayer(data.transit);
  const districtLines = buildDistrictBounds(data.districtBounds);
  const ndwLayer = new NdwLayer(data.ndw?.stations ?? []);
  const airLayer = new AirLayer();
  const fixesLayer = new LiveTransitLayer();
  const stopsLayer = new LiveStopsLayer();
  const liveIncidentsLayer = new LiveIncidentsLayer();
  scene.scene.add(signals.points, ...vehicles.meshes, congestion.lines, transit.group, districtLines, ndwLayer.points, airLayer.points, fixesLayer.group, stopsLayer.points, liveIncidentsLayer.points);

  // The engine has been initializing since graph.bin arrived — usually done.
  //
  // A failure here used to end the boot with BOOT FAILURE and a blank city,
  // which is the wrong trade: the simulation is only needed for SIMULATION
  // mode. Everything a live map shows — real transit, departure boards,
  // sensor congestion, incidents, weather, tide — is main-thread and comes
  // from the snapshot. On a phone, where the sim core is most likely to be
  // refused, the live map is also the only thing anyone wants. So the app
  // carries on without it and says what is missing.
  let simError: string | null = null;
  try {
    await simReady!;
    paintBoot("sim", 1);
  } catch (err) {
    simError = (err as Error)?.message ?? String(err);
    // `worker` is only ever assigned inside startSim's closure, so control-flow
    // analysis still has it as null here — the annotation restores the truth
    (worker as Worker | null)?.terminate();
    worker = null;
    paintBoot("sim", 1);
  }
  const sim = (worker as Worker | null) ?? inertWorker();

  const app = new App(ui, scene, data, meshes, { signals, vehicles, congestion, transit, districtLines, ndwLayer, airLayer, fixesLayer, stopsLayer }, sim);
  if (simError) app.disableSim(simError);

  // feed the NDW snapshot into the sim's calibration loop
  if (data.ndw?.stations.length) {
    sim.postMessage({
      type: "ndw",
      stations: data.ndw.stations.map((s) => ({ edge: s.edge, flow: s.flow })),
      todMin: data.ndw.todMin,
    });
  }

  // ---- live city feeds: NDW traffic + bridges, OVapi transit, water, weather, air ----
  let liveWater: LiveSnapshot["water"] | null = null;
  const applyLive = (snap: LiveSnapshot) => {
    if (snap.traffic?.s.length && data.ndw?.stations.length) {
      // refresh station flows in place; unmeasured stations keep their snapshot value
      const flows = data.ndw.stations.map((s) => s.flow);
      for (const [i, flow] of snap.traffic.s) if (i < flows.length) flows[i] = flow;
      sim.postMessage({
        type: "ndw",
        stations: data.ndw.stations.map((s, i) => ({ edge: s.edge, flow: flows[i] })),
        todMin: snap.traffic.todMin,
        live: true,
      });
    }
    sim.postMessage({
      type: "liveBridges",
      bridges: (snap.bridges ?? []).map((b) => ({ name: b.name, edges: b.edges, x: b.x, y: b.y })),
    });
    // real incidents: markers for all, physics for accidents/obstructions/closures
    liveIncidentsLayer.set(snap.incidents ?? []);
    sim.postMessage({
      type: "liveIncidents",
      incidents: (snap.incidents ?? []).map((i) => ({ edge: i.edge, kind: i.kind, x: i.x, y: i.y, name: i.name })),
    });
    // live congestion: measured station speed vs the matched edge's limit
    if (snap.traffic?.s.length && data.ndw?.stations.length) {
      const ratios: (number | null)[] = data.ndw.stations.map(() => null);
      for (const [i, , speed] of snap.traffic.s) {
        const st = data.ndw.stations[i];
        if (!st || !speed) continue;
        const limit = data.graph.edges.speed[st.edge] || 50;
        ratios[i] = Math.min(1.5, speed / limit);
      }
      ndwLayer.setLive(ratios);
    }
    if (snap.vehicles) {
      const at = Date.parse(snap.vehicles.t);
      fixesLayer.set(snap.vehicles.v, snap.vehicles.plan, Number.isFinite(at) ? at : undefined);
    }
    if (snap.departures) stopsLayer.set(snap.departures.stops, snap.departures.dep);
    if (snap.air) airLayer.set(snap.air.s);
    if (snap.weather) {
      // wet roads slow motorized traffic
      const rain = snap.weather.rain ?? 0;
      sim.postMessage({ type: "params", speedFactor: rain > 2 ? 0.85 : rain > 0.2 ? 0.93 : 1 });
    }
    if (snap.water) liveWater = snap.water;
    app.setLive(snap, live.fresh);
  };
  const live = new LiveFeed(dataBase, applyLive);

  // initial camera frame on the city center, looking north-north-east
  scene.camera.position.set(-2600, 10600, 8600);
  scene.controls.target.set(300, 0, -900);
  scene.flyTo(new THREE.Vector3(300, 0, -900), 12800, 1600);

  setTimeout(() => ui.boot.classList.add("done"), 350);
  setTimeout(() => ui.boot.remove(), 1200);

  const fpsBox = { frames: 0, t0: performance.now() };
  const lineMat = meshes.roadLines.material as THREE.LineBasicMaterial;
  let lastNow = performance.now();
  let lastLiveChip = 0;
  function loop(now: number) {
    requestAnimationFrame(loop);
    const realDt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    transit.update(app.paused ? 0 : realDt * app.simSpeed);
    // live vehicles run on real time, never on the sim clock: a snapshot is a
    // measurement of now, so it must not be scrubbed, paused or compressed
    fixesLayer.update(); // real positions run on wall clock, never on sim time
    scene.update();
    syncFog(scene.fog);
    // sim-clock daylight: dawn ~06:00, dusk ~21:30 (subtle, keeps the night-ops look)
    const hh = app.clockMin / 60;
    const sstep = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const daylight = sstep(5.4, 7.6, hh) * (1 - sstep(20.4, 22.6, hh));
    setAmbient(0.78 + 0.5 * daylight);
    // RET service level: skeleton fleet deep at night
    transit.serviceLevel = hh > 0.5 && hh < 5.5 ? 0.35 : 1;
    const waterMat = (meshes.water.material as THREE.ShaderMaterial).uniforms;
    waterMat.uTime.value = now / 1000;
    waterMat.fogNear.value = scene.fog.near;
    waterMat.fogFar.value = scene.fog.far;
    // 1px line overlay exists for far readability; drop it to a whisper up
    // close where ribbons + junction plates carry the picture (kills junction
    // spaghetti while keeping street definition)
    const t = THREE.MathUtils.clamp((scene.distance - 1500) / 2300, 0, 1);
    lineMat.opacity = 0.13 + 0.49 * t;
    meshes.roadLines.visible = meshes.roads.visible;
    roofs?.update(scene.controls.target, now);
    liveIncidentsLayer.update(now / 1000);
    // real Maas level (Boompjes gauge): the flat world puts quay lips near y 0,
    // so NAP maps 1:1 onto mesh height, eased, clamped just below flood
    if (liveWater) {
      const target = THREE.MathUtils.clamp(-0.45 + liveWater.cm / 100, -1.6, -0.08);
      const y = meshes.water.position.y;
      if (Math.abs(target - y) > 0.002) {
        meshes.water.position.y = y + (target - y) * 0.02;
        meshes.water.updateMatrix();
      }
    }
    if (now - lastLiveChip > 1000) {
      lastLiveChip = now;
      const age = live.ageMin();
      if (live.snapshot) {
        ui.liveChip.style.display = "";
        // the chip states the real age of the data rather than a green light:
        // a snapshot the pipeline stopped feeding should look wrong, not fine
        const health = live.health();
        ui.liveDot.style.background =
          health === "live" ? "#3ddc84" : health === "lagging" ? "#e3b23c" : "#d0453c";
        const w = live.snapshot.weather;
        const ageTxt = age < 1 ? "<1M" : `${Math.round(age)}M`;
        if (health === "stale") {
          ui.liveText.textContent = `FEED STALE — ${ageTxt} OLD`;
        } else {
          const parts = [`LIVE ${ageTxt}`];
          if (w?.temp != null) parts.push(`${Math.round(w.temp)}°C`);
          if (liveWater) parts.push(`MAAS ${liveWater.cm >= 0 ? "+" : ""}${liveWater.cm}CM`);
          const all = live.snapshot.incidents ?? [];
          const nWrk = all.filter((i) => i.kind === 4).length;
          const nInc = all.length - nWrk;
          const nBridge = live.snapshot.bridges?.length ?? 0;
          if (nInc) parts.push(`${nInc} INC`);
          if (nWrk) parts.push(`${nWrk} WRK`);
          if (nBridge) parts.push(`${nBridge} BRUG`);
          ui.liveText.textContent = parts.join(" · ");
        }
      }
    }
    app.frame(now);
    scene.renderer.render(scene.scene, scene.camera);
    fpsBox.frames++;
    const span = now - fpsBox.t0;
    if (span > 2500) {
      // hidden-tab gap: restart the window
      fpsBox.frames = 0;
      fpsBox.t0 = now;
    } else if (span > 1000) {
      (window as unknown as { __fps: number }).__fps = Math.round((fpsBox.frames * 1000) / span);
      fpsBox.frames = 0;
      fpsBox.t0 = now;
    }
  }
  requestAnimationFrame(loop);

  (window as unknown as { __meshes: unknown }).__meshes = meshes;
  (window as unknown as { __layers: unknown }).__layers = { signals, vehicles, congestion };
  (window as unknown as { __scene: unknown }).__scene = scene;
  (window as unknown as { __app: unknown }).__app = app;
  // headless perf probe: window.__bench(n) → avg ms per full render
  (window as unknown as { __bench: (n?: number) => string }).__bench = (n = 30) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) scene.renderer.render(scene.scene, scene.camera);
    const ms = (performance.now() - t0) / n;
    const info = scene.renderer.info.render;
    return JSON.stringify({ msPerFrame: +ms.toFixed(2), calls: info.calls, tris: info.triangles });
  };
}

boot().catch((err) => {
  console.error(err);
  ui.bootError.style.display = "block";
  ui.bootError.textContent = `BOOT FAILURE — ${err?.message ?? err}`;
});
