// Runs the browser's simulation worker (src/sim/worker.ts) under Node.
//
// The engine only talks through `self.postMessage` and `self.onmessage`, so a
// worker_threads shim is all it needs. The TypeScript is bundled once with
// rolldown (already a dependency through Vite) into node_modules/.cache, so
// the headless runs execute exactly the code the browser ships.

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(ROOT, "node_modules", ".cache", "sim-host");

if (!isMainThread && workerData?.simHost) {
  globalThis.self = { postMessage: (msg, transfer) => parentPort.postMessage(msg, transfer) };
  parentPort.on("message", (data) => globalThis.self.onmessage?.({ data }));
  await import(workerData.engine);
  parentPort.postMessage({ type: "hostReady" });
}

const ENTRIES = {
  worker: "src/sim/worker.ts",
  loader: "src/data/loader.ts",
  validation: "src/intelligence/validation.ts",
  model: "src/intelligence/model.ts",
};

/** Bundle the engine and the app modules a script needs; returns file URLs. */
export async function bundleEngine() {
  const { build } = await import("rolldown");
  mkdirSync(CACHE, { recursive: true });
  const out = {};
  for (const [name, input] of Object.entries(ENTRIES)) {
    const file = join(CACHE, `${name}.mjs`);
    await build({ input: join(ROOT, input), output: { file, format: "esm" }, platform: "node", logLevel: "warn" });
    out[name] = pathToFileURL(file).href;
  }
  return out;
}

/**
 * Run one headless experiment (see InitMsg.experiment in src/sim/protocol.ts)
 * and resolve with its ExperimentResultMsg.
 */
export function runExperiment(engineUrl, graph, districts, experiment, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { simHost: true, engine: engineUrl } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("simulation run timed out")); }, timeoutMs);
    const done = (fn) => (value) => { clearTimeout(timer); void worker.terminate(); fn(value); };
    worker.on("message", (msg) => {
      if (msg?.type === "hostReady") {
        const copy = graph.slice(0);
        worker.postMessage({ type: "init", graphBuffer: copy, districtCount: districts.length, districts, experiment }, [copy]);
      } else if (msg?.type === "experimentResult") done(resolve)(msg);
    });
    worker.on("error", done(reject));
  });
}
