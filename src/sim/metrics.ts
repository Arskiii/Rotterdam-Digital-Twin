// Rolling metrics used by the HUD. The simulation drives all updates; the renderer just reads.
export class Metrics {
  simTime = 0;
  completed = 0;
  totalWaitCompleted = 0;
  // Throughput uses a sliding window: count completions in the last `windowSec` seconds.
  private completionTimes: number[] = [];
  windowSec = 60;
  // Queue averaging: at every tick, accumulate sum of "waiting cars" across intersections.
  queueAccum = 0;
  queueSamples = 0;

  recordCompletions(simTime: number, count: number, totalWait: number) {
    this.completed += count;
    this.totalWaitCompleted += totalWait;
    for (let i = 0; i < count; i++) this.completionTimes.push(simTime);
  }

  recordQueueSample(waitingCars: number) {
    this.queueAccum += waitingCars;
    this.queueSamples++;
  }

  throughputPerMin(): number {
    const cutoff = this.simTime - this.windowSec;
    while (this.completionTimes.length && this.completionTimes[0] < cutoff) {
      this.completionTimes.shift();
    }
    if (this.completionTimes.length === 0) return 0;
    const span = Math.min(this.windowSec, this.simTime || 1);
    return (this.completionTimes.length / span) * 60;
  }

  avgWait(): number {
    if (this.completed === 0) return 0;
    return this.totalWaitCompleted / this.completed;
  }

  avgQueue(): number {
    if (this.queueSamples === 0) return 0;
    return this.queueAccum / this.queueSamples;
  }

  reset() {
    this.simTime = 0;
    this.completed = 0;
    this.totalWaitCompleted = 0;
    this.completionTimes = [];
    this.queueAccum = 0;
    this.queueSamples = 0;
  }
}
