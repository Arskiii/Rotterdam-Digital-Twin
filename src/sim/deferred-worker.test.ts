import { describe, expect, it, vi } from "vitest";
import { DeferredWorker } from "./deferred-worker";

describe("controls during progressive map startup", () => {
  it("preserves action order and the latest controls until the engine is ready", () => {
    const port = new DeferredWorker();
    const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null };
    const params = { type: "params" as const, density: 1200 };
    port.postMessage(params);
    port.postMessage({ type: "params", density: 2400, speedFactor: .8 });
    port.postMessage({ type: "incident", action: "random" });
    port.postMessage({ type: "params", density: 1800 });
    expect(worker.postMessage).not.toHaveBeenCalled();
    port.attach(worker as unknown as Worker);
    expect(worker.postMessage.mock.calls.map(([m]) => m)).toEqual([
      { type: "params", density: 2400, speedFactor: .8 }, { type: "incident", action: "random" }, { type: "params", density: 1800 },
    ]);
    expect(params.density).toBe(1200);
    port.postMessage({ type: "incident", action: "clearAll" });
    expect(worker.postMessage).toHaveBeenCalledTimes(4);
  });
  it("drops cancelled startup controls and terminates a late engine", () => {
    const port = new DeferredWorker(), worker = { postMessage: vi.fn(), terminate: vi.fn() };
    port.postMessage({ type: "params", density: 2400 }); port.dispose();
    port.attach(worker as unknown as Worker);
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(worker.postMessage).not.toHaveBeenCalled();
  });
});
