import type { Network } from "../sim/types";
import type { CorridorMatch, ScenarioConfig, ScenarioResult } from "../v03/scenario";
import type { ScenarioWorkerRequest, ScenarioWorkerResponse } from "./scenarioProtocol";

/** Reuse one worker and one network clone for an entire paired comparison or fit. */
export class ScenarioRunner {
  private worker: Worker | null = null;
  private cancel: (() => void) | null = null;
  private disposed = false;

  constructor(private network: Network) {}

  async run(
    config: ScenarioConfig,
    seed: number,
    corridor: CorridorMatch | null,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<ScenarioResult> {
    if (this.disposed) throw new Error("Scenario runner has been disposed.");
    if (this.cancel) throw new Error("A scenario is already running.");
    if (signal?.aborted) throw new DOMException("Scenario cancelled", "AbortError");
    const initialize = !this.worker;
    if (!this.worker) {
      this.worker = new Worker(new URL("./scenario.worker.ts", import.meta.url), { type: "module" });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: ScenarioResult | null, error?: Error) => {
        if (settled) return;
        settled = true;
        worker.removeEventListener("message", receive);
        worker.removeEventListener("error", failed);
        worker.removeEventListener("messageerror", unreadable);
        signal?.removeEventListener("abort", abort);
        this.cancel = null;
        if (error) {
          worker.terminate();
          this.worker = null;
          reject(error);
        } else {
          resolve(result!);
        }
      };
      const abort = () => finish(null, new DOMException("Scenario cancelled", "AbortError"));
      const failed = (event: ErrorEvent) => {
        event.preventDefault();
        finish(null, new Error(event.message || "Scenario worker failed."));
      };
      const unreadable = () => finish(null, new Error("Could not read the scenario worker response."));
      const receive = ({ data }: MessageEvent<ScenarioWorkerResponse>) => {
        if (signal?.aborted) { abort(); return; }
        if (data.type === "progress") {
          try { onProgress(data.fraction); }
          catch (error) { finish(null, error instanceof Error ? error : new Error(String(error))); }
        } else if (data.type === "complete") {
          finish(data.result);
        } else {
          finish(null, new Error(data.message));
        }
      };
      this.cancel = abort;
      worker.addEventListener("message", receive);
      worker.addEventListener("error", failed);
      worker.addEventListener("messageerror", unreadable);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        // Initialize only once; subsequent runs retain the worker's network clone.
        if (initialize) {
          worker.postMessage({ type: "initialize", network: this.network } satisfies ScenarioWorkerRequest);
        }
        worker.postMessage({ type: "run", config, seed, corridor } satisfies ScenarioWorkerRequest);
      } catch (error) {
        finish(null, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.cancel?.();
    this.worker?.terminate();
    this.worker = null;
  }
}
