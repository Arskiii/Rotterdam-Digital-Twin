import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSimulationWorker } from "./start-worker";

class TestWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();
  send(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
const districts = [{ name: "Centrum", x: 0, y: 0 }];
function start(worker = new TestWorker()) {
  const progress = vi.fn();
  const graph = new Uint8Array([1, 2, 3]).buffer;
  return { ...startSimulationWorker(() => worker as unknown as Worker, graph, districts, progress), fake: worker, progress, graph };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("simulation startup", () => {
  it("can transfer raw graph ownership after the renderer has parsed its own arrays", async () => {
    const fake = new TestWorker(), graph = new Uint8Array([1, 2, 3]).buffer;
    const run = startSimulationWorker(() => fake as unknown as Worker, graph, districts, () => {}, true);
    expect(fake.postMessage.mock.calls[0][0].graphBuffer).toBe(graph);
    expect(fake.postMessage.mock.calls[0][1]).toEqual([graph]);
    fake.send({ type: "ready" }); await run.ready;
  });
  it("transfers a separate graph copy and cleans its startup listeners/timers on readiness", async () => {
    const run = start();
    const sent = run.fake.postMessage.mock.calls[0];
    expect(sent[0].graphBuffer).not.toBe(run.graph);
    expect(new Uint8Array(sent[0].graphBuffer)).toEqual(new Uint8Array(run.graph));
    run.fake.send({ type: "ready" });
    await expect(run.ready).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    run.fake.send({ type: "initProgress", frac: 0.9 });
    expect(run.progress).toHaveBeenLastCalledWith(1);
    expect(run.fake.terminate).not.toHaveBeenCalled();
  });

  it("rejects and terminates a silent worker so the map can take its fallback path", async () => {
    const run = start();
    const rejected = expect(run.ready).rejects.toThrow("startup timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(run.fake.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a slow worker that is making progress, without accepting repeated progress as activity", async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(19_000);
    run.fake.send({ type: "initProgress", frac: 0.42 });
    await vi.advanceTimersByTimeAsync(19_000);
    run.fake.send({ type: "initProgress", frac: 0.42 });
    const rejected = expect(run.ready).rejects.toThrow("startup timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });

  it("has an overall deadline even if progress continues", async () => {
    const run = start();
    const rejected = expect(run.ready).rejects.toThrow("startup timed out");
    for (let step = 1; step <= 12; step++) {
      await vi.advanceTimersByTimeAsync(10_000);
      run.fake.send({ type: "initProgress", frac: step / 20 });
    }
    await rejected;
  });

  it("converts constructor and postMessage failures into the same recoverable outcome", async () => {
    const blocked = startSimulationWorker(() => { throw new Error("Worker blocked"); }, new ArrayBuffer(0), districts, () => {});
    await expect(blocked.ready).rejects.toThrow("Worker blocked");
    expect(blocked.worker).toBeNull();
    const fake = new TestWorker();
    fake.postMessage.mockImplementation(() => { throw new Error("Cannot transfer"); });
    const run = start(fake);
    await expect(run.ready).rejects.toThrow("Cannot transfer");
    expect(fake.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unreadable worker messages and cancels workers when city loading fails", async () => {
    const run = start();
    run.fake.dispatchEvent(new Event("messageerror"));
    await expect(run.ready).rejects.toThrow("decode error");
    const cancelled = start();
    cancelled.cancel();
    await expect(cancelled.ready).rejects.toThrow("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(cancelled.fake.terminate).toHaveBeenCalled();
  });
});
