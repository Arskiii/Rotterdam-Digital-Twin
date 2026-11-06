import type { MainToWorker, WorkerToMain } from "./protocol";

export interface SimulationPort {
  onmessage: ((event: MessageEvent<WorkerToMain>) => void) | null;
  postMessage(message: MainToWorker): void;
}

/** Retain controls while the optional engine starts, then replay them in order. */
export class DeferredWorker implements SimulationPort {
  onmessage: SimulationPort["onmessage"] = null;
  private worker: Worker | null = null;
  private queue: MainToWorker[] = [];
  private failed = false;
  postMessage(message: MainToWorker) {
    if (this.failed) return;
    if (this.worker) { this.worker.postMessage(message); return; }
    const previous = this.queue.at(-1);
    if (message.type === "params" && previous?.type === "params") this.queue[this.queue.length - 1] = { ...previous, ...message };
    else this.queue.push(message); // the startup deadline bounds this queue's lifetime
  }
  attach(worker: Worker) {
    if (this.failed) { worker.terminate(); return; }
    this.worker = worker;
    worker.onmessage = (event) => this.onmessage?.(event);
    for (const message of this.queue) worker.postMessage(message);
    this.queue = [];
  }
  dispose() { this.failed = true; this.queue = []; this.worker?.terminate(); this.worker = null; }
}
