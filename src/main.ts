import "./style.css";
import * as THREE from "three";
import { buildChrome, setMeter } from "./ui/chrome";
import { SceneCtx } from "./render/scene";
import { buildCity, syncFog } from "./render/city";
import { SignalsLayer, VehiclesLayer, CongestionLayer } from "./render/dynamic";
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

async function boot() {
  const scene = new SceneCtx(ui.sceneCanvas);

  const data = await loadCity(`${import.meta.env.BASE_URL}data/`, paintBoot);
  paintBoot("grid", 1);
  paintBoot("signals", 1);

  const meshes = await buildCity(data, scene.scene, (f) => paintBoot("structures", 0.55 + f * 0.45));
  paintBoot("structures", 1);

  const signals = new SignalsLayer(data.graph);
  const vehicles = new VehiclesLayer(14000);
  const congestion = new CongestionLayer(data.graph);
  scene.scene.add(signals.points, vehicles.mesh, congestion.lines);

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

  const app = new App(ui, scene, data, meshes, { signals, vehicles, congestion }, worker);

  // initial camera frame on the city center, looking north-north-east
  scene.camera.position.set(-2600, 10600, 8600);
  scene.controls.target.set(300, 0, -900);
  scene.flyTo(new THREE.Vector3(300, 0, -900), 12800, 1600);

  setTimeout(() => ui.boot.classList.add("done"), 350);
  setTimeout(() => ui.boot.remove(), 1200);

  const fpsBox = { frames: 0, t0: performance.now() };
  function loop(now: number) {
    requestAnimationFrame(loop);
    scene.update();
    syncFog(scene.fog);
    const waterMat = (meshes.water.material as THREE.ShaderMaterial).uniforms;
    waterMat.uTime.value = now / 1000;
    waterMat.fogNear.value = scene.fog.near;
    waterMat.fogFar.value = scene.fog.far;
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
