// Local diagnostics only: no telemetry or network delivery. ?diagnostics=1
// exposes the same bounded measurements used for before/after browser checks.
export class PerformanceSample {
  stages: Record<string, number> = {};
  frames: number[] = [];
  longTaskMs = 0;
  peakHeapBytes: number | null = null;
  private previous = 0;
  stage(name: string, at: number) { this.stages[name] ??= Math.round(at); }
  frame(at: number, active: boolean) {
    const elapsed = at - this.previous;
    if (active && this.previous && elapsed > 0 && elapsed < 3000 && this.frames.length < 900) this.frames.push(elapsed);
    this.previous = active ? at : 0;
  }
  heap(bytes?: number) {
    if (bytes && Number.isFinite(bytes)) this.peakHeapBytes = Math.max(bytes, this.peakHeapBytes ?? 0);
  }
  report() {
    const sorted = [...this.frames].sort((a, b) => a - b);
    return { stagesMs: this.stages, sampledFrames: sorted.length,
      frameP95Ms: sorted.length ? Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10 : null,
      framesOver50ms: sorted.filter((value) => value > 50).length,
      longTaskMs: Math.round(this.longTaskMs), peakJsHeapMBApprox: this.peakHeapBytes ? Math.round(this.peakHeapBytes / 1e5) / 10 : null };
  }
}

const enabled = typeof location !== "undefined" && new URLSearchParams(location.search).has("diagnostics");
const sample = new PerformanceSample();
let output: HTMLPreElement | null = null;
let lastUpdate = 0;
if (enabled && typeof PerformanceObserver !== "undefined") {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) sample.longTaskMs += Math.max(0, entry.duration - 50);
  });
  try { observer.observe({ type: "longtask", buffered: true }); setTimeout(() => observer.disconnect(), 30_000); }
  catch { /* Unsupported browsers still report startup and frame intervals. */ }
}
function update() {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  if (sample.frames.length < 900) sample.heap(memory?.usedJSHeapSize);
  if (!output) {
    const details = document.createElement("details");
    details.id = "performance-diagnostics";
    details.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:10000;background:#141518;color:#ddd;border:1px solid #444;padding:10px;font:11px monospace;max-width:420px";
    const summary = document.createElement("summary"); summary.textContent = "Performance diagnostics";
    output = document.createElement("pre"); output.id = "performance-report";
    details.append(summary, output); document.body.append(details);
  }
  output.textContent = JSON.stringify(sample.report(), null, 2);
}
export function performanceStage(name: string) {
  if (!enabled || name in sample.stages) return;
  sample.stage(name, performance.now()); update();
}
export function performanceFrame(at: number, active: boolean) {
  if (!enabled) return;
  sample.frame(at, active);
  if (at - lastUpdate > 1000) { lastUpdate = at; update(); }
}
