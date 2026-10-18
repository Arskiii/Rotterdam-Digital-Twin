import type { Network } from "../sim/types";
import { simulateScenario } from "../v03/scenario";
import type { ScenarioWorkerRequest, ScenarioWorkerResponse } from "./scenarioProtocol";

let network: Network | null = null;
const send = (message: ScenarioWorkerResponse) => self.postMessage(message);

self.onmessage = async ({ data }: MessageEvent<ScenarioWorkerRequest>) => {
  if (data.type === "initialize") {
    // Structured cloning preserves Maps, Sets, and vector coordinates. The physics
    // engine only reads x/y; it never calls methods on cloned vector instances.
    network = data.network;
    return;
  }
  try {
    if (!network) throw new Error("Scenario network is unavailable.");
    const result = await simulateScenario(network, data.config, data.seed, data.corridor,
      (fraction) => send({ type: "progress", fraction }), undefined,
      // The client terminates the worker on cancellation. No UI timer yields are
      // needed here, avoiding the browser's repeated-timeout delay in long runs.
      () => Promise.resolve());
    send({ type: "complete", result });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
