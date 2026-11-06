import * as THREE from "three";
import { type buildChrome, setMeter } from "./ui/chrome";
import { SceneCtx } from "./render/scene";
import { buildCity, buildBuildings, buildDistrictBounds, syncFog, setAmbient, releaseToGPU, RoofStreamer } from "./render/city";
import type { CityData, Meta, RoofIndex } from "./data/loader";
import { SignalsLayer, VehiclesLayer, CongestionLayer, NdwLayer, AirLayer, LiveIncidentsLayer } from "./render/dynamic";
import { TransitLayer, LiveTransitLayer, LiveStopsLayer } from "./render/transit";
import { ResilienceLayers } from "./render/resilience";
import { ObservedSignalsLayer } from "./render/observed-signals";
import { pollObservedSignals } from "./data/live-signals";
import { CityParser } from "./data/city-parser";
import { DeferredWorker } from "./sim/deferred-worker";
import { type LiveFeed, currentLiveSnapshot, type LiveSnapshot } from "./data/live";
import { watchForNewBuild } from "./data/buildwatch";
import { CityVersionError, fetchCityBuffer, fetchCityJson } from "./data/city-assets";
import { startSimulationWorker } from "./sim/start-worker";
import { App } from "./ui/app";
import { LocalActivity } from "./sim/local-activity";
import { siteUrl } from "./ui/siteUrl";
import { performanceStage, performanceFrame } from "./ui/performance";
import type { StudySelection } from "./study/context";
import { mountStudyMap } from "./study/map";

// Data binaries live in-repo (public/data). Deployments that ship only source
// (e.g. Vercel file deploys) fall back to the pinned GitHub mirror via jsDelivr.
const DATA_FALLBACK =
  "https://cdn.jsdelivr.net/gh/Arskiii/Rotterdam-Digital-Twin@2ac52386897c1be74a128ca095acd73fc05a8f26/public/data/";

async function resolveDataBase(): Promise<{ base: string; meta: Meta }> {
  const local = siteUrl("data/").href;
  try {
    return { base: local, meta: await fetchCityJson<Meta>(local, "meta.json", 8_000) };
  } catch (error) {
    if (error instanceof CityVersionError) throw error;
    /* fall through */
  }
  return { base: DATA_FALLBACK, meta: await fetchCityJson<Meta>(DATA_FALLBACK, "meta.json", 8_000) };
}

export async function mountMap(ui: ReturnType<typeof buildChrome>, live: LiveFeed, selection: StudySelection) {
  const parser = new CityParser();
  const lifetime = new AbortController();
  const sim = new DeferredWorker();
  if (App.PHONE) sim.dispose(); // phones never attach an engine; do not retain controls indefinitely
  let scene: SceneCtx | null = null;
  const cleanups: Array<() => void> = [];
  let cancelSim = () => {};
  const cleanup = () => lifetime.abort();
  lifetime.signal.addEventListener("abort", () => {
    cancelSim(); parser.dispose(); sim.dispose();
    for (const clean of cleanups) clean();
    scene?.dispose();
  }, { once: true });
  try {
    performanceStage("map-start");
    const stageFracs: Record<string, number> = { grid: 0, signals: 0, structures: 0, sim: 0 };
    function paintBoot(stage: string, frac: number) {
      stageFracs[stage] = Math.max(stageFracs[stage], frac);
      const s = ui.bootStages[stage];
      if (s) {
        setMeter(s.bars, stageFracs[stage]);
        s.pct.textContent = `${Math.round(stageFracs[stage] * 100)}%`;
      }
    }

    const { base: dataBase, meta } = await resolveDataBase();

    // The optional engine starts after graph parsing and runs in parallel with
    // mesh building. The map remains usable if the engine is slow or blocked.
    let worker: Worker | null = null;
    let simReady: Promise<void> | null = null;
    const startSim = (graphBuffer: ArrayBuffer, meta: { districts: { name: string; x: number; y: number }[] }) => {
      const startup = startSimulationWorker(
        () => new Worker(new URL("./sim/worker.ts", import.meta.url), { type: "module" }),
        graphBuffer, meta.districts.map(({ name, x, y }) => ({ name, x, y })),
        (fraction) => paintBoot("sim", fraction),
        true, // parsing has finished; the raw graph has no remaining main-thread readers
      );
      worker = startup.worker;
      simReady = startup.ready;
      cancelSim = startup.cancel;
    };

    // roofs index is tiny — fetch it alongside everything else, attach later
    const roofsIndexP = fetchCityJson<RoofIndex>(dataBase, "roofs/index.json")
      .catch(() => null);

    // A phone never starts the simulation core. iOS refuses it under memory
    // pressure anyway, and trying costs the boot a worker's worth of allocation
    // and a failure path for a mode the phone is not offered. LIVE is the whole
    // point on a phone and it needs no simulation.
    if (App.PHONE) document.body.dataset.phone = "1";

    const data: CityData = await parser.base(dataBase, meta, paintBoot);
    performanceStage("city-parsed");
    paintBoot("grid", 1); paintBoot("signals", 1);
    if (!App.PHONE) startSim(data.graphBuffer!, data.meta);
    data.graphBuffer = null;
    scene = new SceneCtx(ui.sceneCanvas);
    const view = scene;
    const meshes = await buildCity(data, view.scene, () => {}, true);
    let roofs: RoofStreamer | null = null;

    const signals = new SignalsLayer(data.graph);
    const vehicles = new VehiclesLayer();
    const congestion = new CongestionLayer(data.graph);
    const transit = new TransitLayer(data.transit);
    const districtLines = buildDistrictBounds(data.districtBounds);
    releaseToGPU(districtLines.geometry); // fixed boundaries, drawn once, never edited
    const ndwLayer = new NdwLayer(data.ndw?.stations ?? []);
    const airLayer = new AirLayer();
    const fixesLayer = new LiveTransitLayer();
    const stopsLayer = new LiveStopsLayer();
    const liveIncidentsLayer = new LiveIncidentsLayer();
    const resilience = new ResilienceLayers(dataBase, view.scene);
    const observedSignals = new ObservedSignalsLayer(data.graph);
    view.scene.add(signals.points, observedSignals.points, ...vehicles.meshes, congestion.lines, transit.group, districtLines, ndwLayer.points, airLayer.points, fixesLayer.group, stopsLayer.points, liveIncidentsLayer.points);

    const app = new App(ui, view, data, meshes, { signals, observedSignals, vehicles, congestion, transit, districtLines, ndwLayer, airLayer, fixesLayer, stopsLayer, resilience }, sim, lifetime);
    const localActivity = new LocalActivity(data.graph);
    const loadingStatus = document.createElement("div");
    loadingStatus.id = "map-loading-status";
    loadingStatus.setAttribute("role", "status");
    ui.hud.append(loadingStatus);
    let buildingsState = "Loading buildings…";
    let buildingsError = false;
    let simState = App.PHONE ? "" : "Simulation starting…";
    const status = () => {
      loadingStatus.textContent = [buildingsState, simState].filter(Boolean).join(" · ");
      loadingStatus.hidden = !loadingStatus.textContent;
      if (buildingsError) {
        const retry = document.createElement("button"); retry.textContent = "Retry buildings";
        retry.onclick = () => { void finishBuildings(); }; loadingStatus.append(" ", retry);
      }
    };
    status();
    let buildingsLoading = false;
    async function finishBuildings() {
      if (buildingsLoading || lifetime.signal.aborted) return;
      buildingsLoading = true; buildingsError = false; buildingsState = "Loading buildings…"; loadingStatus.title = ""; status();
      try {
        const tiles = await parser.buildings(dataBase, meta);
        lifetime.signal.throwIfAborted();
        for (const child of [...meshes.buildings.children]) {
          (child as THREE.Mesh).geometry?.dispose(); meshes.buildings.remove(child);
        }
        data.buildings = tiles;
        await buildBuildings(tiles, (fraction) => { buildingsState = `Loading buildings ${Math.round(fraction * 100)}%`; status(); }, meshes.buildings, lifetime.signal);
        performanceStage("buildings-ready"); buildingsState = ""; status(); parser.dispose();
        void roofsIndexP.then((index) => {
          if (index && !lifetime.signal.aborted) roofs = new RoofStreamer(dataBase, index, tiles, meshes.buildings);
        }).catch((error) => console.warn("Roof detail unavailable", error));
      } catch (error) {
        if (lifetime.signal.aborted) return;
        loadingStatus.title = error instanceof Error ? error.message : String(error);
        buildingsError = true; buildingsState = "Building detail unavailable."; status();
      } finally { buildingsLoading = false; }
    }
    async function finishSimulation() {
      if (App.PHONE) return;
      try {
        try { await simReady!; }
        catch (error) {
          if (!worker) throw error; // blocked construction cannot recover by refetching the graph
          (worker as Worker | null)?.terminate();
          const buffer = await fetchCityBuffer(dataBase, "graph.bin");
          lifetime.signal.throwIfAborted();
          startSim(buffer, meta); await simReady!;
        }
        if (lifetime.signal.aborted) return;
        sim.attach(worker!); app.simReady = true; simState = "";
        performanceStage("simulation-ready"); status();
      } catch (error) {
        if (lifetime.signal.aborted) return;
        sim.dispose();
        app.disableSim(error instanceof Error ? error.message : String(error));
        simState = "Simulation unavailable · Live map ready"; status();
      }
    }
    // Let the first usable map paint before starting optional building work.
    requestAnimationFrame(() => { if (!lifetime.signal.aborted) void finishBuildings(); });
    void finishSimulation();

    const signalStatus = document.getElementById("ivri-feed-status");
    cleanups.push(pollObservedSignals(import.meta.env.VITE_LIVE_SIGNALS_URL?.trim() ?? "",
      data.graph.signals.count + data.graph.aux.count, data.meta.graphSha256, (snapshot, state) => {
        observedSignals.set(snapshot);
        if (signalStatus) signalStatus.textContent = state;
      }));

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
    let liveValidity = "";
    const validity = (snap: LiveSnapshot) => [snap.traffic?.t, snap.vehicles?.t, snap.departures?.t,
      snap.bridges?.length, snap.incidents?.length].join("|");
    const applyLive = (raw: LiveSnapshot) => {
      const snap = currentLiveSnapshot(raw);
      liveValidity = validity(snap);
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
      const at = Date.parse(snap.vehicles?.t ?? "");
      fixesLayer.set(snap.vehicles?.v ?? [], snap.vehicles?.plan, Number.isFinite(at) ? at : undefined);
      stopsLayer.set(snap.departures?.stops ?? {}, snap.departures?.dep ?? {});
      if (!snap.traffic) ndwLayer.setLive(data.ndw?.stations.map(() => null) ?? []);
      if (snap.air) airLayer.set(snap.air.s);
      if (snap.weather) {
        // wet roads slow motorized traffic
        const rain = snap.weather.rain ?? 0;
        sim.postMessage({ type: "params", speedFactor: rain > 2 ? 0.85 : rain > 0.2 ? 0.93 : 1 });
      }
      if (snap.water) liveWater = snap.water;
      app.setLive(snap);
    };
    cleanups.push(live.subscribe(applyLive));

    // A tab left open keeps refreshing its data but never its code
    cleanups.push(watchForNewBuild(() => app.offerReload()));

    // initial camera frame on the city center, looking north-north-east
    view.camera.position.set(-2600, 10600, 8600);
    view.controls.target.set(300, 0, -900);
    view.flyTo(new THREE.Vector3(300, 0, -900), 12800, 1600);

    ui.boot.classList.add("done");
    ui.boot.hidden = true;

    const fpsBox = { frames: 0, t0: performance.now() };
    const lineMat = meshes.roadLines.material as THREE.LineBasicMaterial;
    let lastNow = performance.now();
    let lastLiveRefresh = 0;
    function loop(now: number) {
      if (lifetime.signal.aborted) return;
      requestAnimationFrame(loop);
      performanceFrame(now, !document.hidden && !ui.viewport.hidden);
      const realDt = Math.min(0.1, (now - lastNow) / 1000);
      lastNow = now;
      if (document.hidden || ui.viewport.hidden) return; // retain the scene without rendering an invisible map
      if (!app.simReady && app.mode === "live" && localActivity.update(now, view.controls.target.x, -view.controls.target.z)) {
        app.setRoadFrame(localActivity.data, localActivity.ids, localActivity.speeds, localActivity.count);
      }
      transit.update(app.paused ? 0 : realDt * app.simSpeed);
      // live vehicles run on real time, never on the sim clock: a snapshot is a
      // measurement of now, so it must not be scrubbed, paused or compressed
      fixesLayer.update(); // real positions run on wall clock, never on sim time
      view.update();
      syncFog(view.fog);
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
      waterMat.fogNear.value = view.fog.near;
      waterMat.fogFar.value = view.fog.far;
      // 1px line overlay exists for far readability; drop it to a whisper up
      // close where ribbons + junction plates carry the picture (kills junction
      // spaghetti while keeping street definition)
      const t = THREE.MathUtils.clamp((view.distance - 1500) / 2300, 0, 1);
      lineMat.opacity = 0.13 + 0.49 * t;
      meshes.roadLines.visible = meshes.roads.visible;
      roofs?.update(view.controls.target, now);
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
      if (now - lastLiveRefresh > 1000) {
        lastLiveRefresh = now;
        observedSignals.refresh();
        if (live.snapshot && validity(currentLiveSnapshot(live.snapshot)) !== liveValidity) applyLive(live.snapshot);
      }
      app.frame(now);
      view.renderer.render(view.scene, view.camera);
      performanceStage("map-ready");
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
    void mountStudyMap(ui, view, data.meta.origin, selection, lifetime.signal);

    (window as unknown as { __meshes: unknown }).__meshes = meshes;
    (window as unknown as { __layers: unknown }).__layers = { signals, vehicles, congestion };
    (window as unknown as { __scene: unknown }).__scene = scene;
    (window as unknown as { __app: unknown }).__app = app;
    // headless perf probe: window.__bench(n) → avg ms per full render
    (window as unknown as { __bench: (n?: number) => string }).__bench = (n = 30) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) view.renderer.render(view.scene, view.camera);
      const ms = (performance.now() - t0) / n;
      const info = view.renderer.info.render;
      return JSON.stringify({ msPerFrame: +ms.toFixed(2), calls: info.calls, tris: info.triangles });
    };
    return app;
  } catch (error) { cleanup(); throw error; }
}
