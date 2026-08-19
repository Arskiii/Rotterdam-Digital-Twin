import "./style.css";
import * as THREE from "three";
import { buildChrome, setMeter } from "./ui/chrome";
import { SceneCtx } from "./render/scene";
import { buildCity, buildDistrictBounds, syncFog, setAmbient } from "./render/city";
import { SignalsLayer, VehiclesLayer, CongestionLayer, buildNdwLayer } from "./render/dynamic";
import { TransitLayer } from "./render/transit";
import { loadCity } from "./data/loader";
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
  "https://cdn.jsdelivr.net/gh/Arskiii/Rotterdam-Digital-Twin@815172ab9a85ba4ace839e6e75918ce8390b0160/public/data/";

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

async function boot() {
  const scene = new SceneCtx(ui.sceneCanvas);

  const data = await loadCity(await resolveDataBase(), paintBoot);
  paintBoot("grid", 1);
  paintBoot("signals", 1);

  const meshes = await buildCity(data, scene.scene, (f) => paintBoot("structures", 0.55 + f * 0.45));
  paintBoot("structures", 1);

  const signals = new SignalsLayer(data.graph);
  const vehicles = new VehiclesLayer();
  const congestion = new CongestionLayer(data.graph);
  const transit = new TransitLayer(data.transit);
  const districtLines = buildDistrictBounds(data.districtBounds);
  const ndwPoints = buildNdwLayer(data.ndw?.stations ?? []);
  scene.scene.add(signals.points, ...vehicles.meshes, congestion.lines, transit.group, districtLines, ndwPoints);

  paintBoot("sim", 0.2);
  const worker = new Worker(new URL("./sim/worker.ts", import.meta.url), { type: "module" });
  const graphCopy = data.graphBuffer.slice(0);
  worker.postMessage(
    {
      type: "init",
      graphBuffer: graphCopy,
      districtCount: data.meta.districts.length,
      districts: data.meta.districts.map((d) => ({ name: d.name, x: d.x, y: d.y })),
    },
    [graphCopy]
  );

  await new Promise<void>((resolve) => {
    const h = (ev: MessageEvent) => {
      if (ev.data?.type === "ready") {
        worker.removeEventListener("message", h);
        resolve();
      }
    };
    worker.addEventListener("message", h);
  });
  paintBoot("sim", 1);

  const app = new App(ui, scene, data, meshes, { signals, vehicles, congestion, transit, districtLines, ndwPoints }, worker);

  // feed the NDW snapshot into the sim's calibration loop
  if (data.ndw?.stations.length) {
    worker.postMessage({
      type: "ndw",
      stations: data.ndw.stations.map((s) => ({ edge: s.edge, flow: s.flow })),
      todMin: data.ndw.todMin,
    });
  }

  // initial camera frame on the city center, looking north-north-east
  scene.camera.position.set(-2600, 10600, 8600);
  scene.controls.target.set(300, 0, -900);
  scene.flyTo(new THREE.Vector3(300, 0, -900), 12800, 1600);

  setTimeout(() => ui.boot.classList.add("done"), 350);
  setTimeout(() => ui.boot.remove(), 1200);

  const fpsBox = { frames: 0, t0: performance.now() };
  const lineMat = meshes.roadLines.material as THREE.LineBasicMaterial;
  let lastNow = performance.now();
  function loop(now: number) {
    requestAnimationFrame(loop);
    const realDt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    transit.update(app.paused ? 0 : realDt * app.simSpeed);
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
