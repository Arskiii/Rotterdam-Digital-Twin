interface District { name: string; x: number; y: number }

/** Start the optional simulation without allowing a blocked/stalled worker to strand the map. */
export function startSimulationWorker(
  createWorker: () => Worker,
  graphBuffer: ArrayBuffer,
  districts: District[],
  onProgress: (fraction: number) => void,
) {
  let worker: Worker | null = null;
  let cancel = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    try { worker = createWorker(); }
    catch (error) { reject(error); return; }
    const w = worker;
    let settled = false;
    let progress = 0;
    let idle: ReturnType<typeof setTimeout>;
    let deadline: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(deadline);
      w.removeEventListener("message", message);
      w.removeEventListener("error", failed);
      w.removeEventListener("messageerror", unreadable);
      if (error) { w.terminate(); reject(error); }
      else { onProgress(1); resolve(); }
    };
    const timedOut = () => finish(new Error("Simulation startup timed out; the live map remains available."));
    const message = (event: MessageEvent) => {
      if (event.data?.type === "ready") { finish(); return; }
      const fraction = event.data?.frac;
      if (event.data?.type === "initProgress" && Number.isFinite(fraction) && fraction > progress && fraction <= 1) {
        progress = fraction;
        clearTimeout(idle);
        idle = setTimeout(timedOut, 20_000);
        onProgress(0.04 + 0.92 * fraction);
      }
    };
    const failed = (event: ErrorEvent) => {
      event.preventDefault();
      finish(new Error(event.message || "out of memory, or workers are blocked in this browser"));
    };
    const unreadable = () => finish(new Error("Simulation message decode error"));
    cancel = () => { finish(new Error("Map startup cancelled")); w.terminate(); };
    w.addEventListener("message", message);
    w.addEventListener("error", failed);
    w.addEventListener("messageerror", unreadable);
    idle = setTimeout(timedOut, 20_000);
    deadline = setTimeout(timedOut, 120_000);
    onProgress(0.04);
    try {
      const copy = graphBuffer.slice(0);
      w.postMessage({ type: "init", graphBuffer: copy, districtCount: districts.length, districts }, [copy]);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  // Startup overlaps city downloads; its owner awaits the outcome afterwards.
  void ready.catch(() => {});
  return { worker, ready, cancel: () => cancel() };
}
