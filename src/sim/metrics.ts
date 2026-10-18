// Rolling metrics used by the HUD. The simulation drives all updates; the renderer just reads.
const RECENT_CAP = 500; // ring size for percentile/tail metrics

export class Metrics {
  simTime = 0;
  completed = 0;
  totalWaitCompleted = 0;
  totalStopsCompleted = 0;
  totalTravelCompleted = 0; // sum of actual trip times (s)
  totalFreeFlowCompleted = 0; // sum of free-flow trip times (s)
  // Throughput uses a sliding window: count completions in the last `windowSec` seconds.
  private completionTimes: number[] = [];
  private completionHead = 0;
  windowSec = 60;
  // Queue averaging: at every tick, accumulate sum of "waiting cars" across intersections.
  queueAccum = 0;
  queueSamples = 0;
  // Live worst-case wait among any active (still-driving) vehicle. Set externally each tick.
  maxActiveWait = 0;
  // Phase-utilization counters: every tick, every intersection-phase that is currently green
  // increments greenAccum; if any approach in that phase has a vehicle, usefulAccum increments
  // too. Ratio = "fraction of green time actually serving cars".
  phaseGreenAccum = 0;
  phaseUsefulAccum = 0;
  // Bounded log of recent completed-car experiences for tail metrics (worst 5%).
  private recentWaits: number[] = [];
  private sortedWaits: number[] | null = null;

  recordCompletion(
    simTime: number,
    wait: number,
    stops: number,
    travelTime: number,
    freeFlowTime: number,
  ) {
    this.completed++;
    this.totalWaitCompleted += wait;
    this.totalStopsCompleted += stops;
    this.totalTravelCompleted += travelTime;
    this.totalFreeFlowCompleted += freeFlowTime;
    this.completionTimes.push(simTime);
    // Headless scenarios do not read the HUD, so prune on writes as well as reads.
    this.pruneCompletions();
    this.recentWaits.push(wait);
    this.sortedWaits = null;
    if (this.recentWaits.length > RECENT_CAP) {
      this.recentWaits.shift();
    }
  }

  recordQueueSample(waitingCars: number) {
    this.queueAccum += waitingCars;
    this.queueSamples++;
  }

  private pruneCompletions() {
    const cutoff = this.simTime - this.windowSec;
    while (this.completionHead < this.completionTimes.length && this.completionTimes[this.completionHead] < cutoff) {
      this.completionHead++;
    }
    // Compact in batches instead of shifting the entire array for every departure.
    if (this.completionHead > 256 && this.completionHead >= this.completionTimes.length / 2) {
      this.completionTimes = this.completionTimes.slice(this.completionHead);
      this.completionHead = 0;
    }
  }

  throughputPerMin(): number {
    this.pruneCompletions();
    const count = this.completionTimes.length - this.completionHead;
    if (count === 0) return 0;
    const span = Math.min(this.windowSec, this.simTime || 1);
    return (count / span) * 60;
  }

  avgWait(): number {
    if (this.completed === 0) return 0;
    return this.totalWaitCompleted / this.completed;
  }

  // Mean wait of the worst 5% of recent completions — fairness/tail metric.
  // Captures "how bad is it for the unluckiest cars" rather than the average.
  worstWaitAvg(pct = 0.05): number {
    const n = this.recentWaits.length;
    if (n === 0) return 0;
    const sorted = this.sortedWaits ??= [...this.recentWaits].sort((a, b) => b - a);
    const k = Math.max(1, Math.min(n, Math.ceil(n * (Number.isFinite(pct) ? pct : 0.05))));
    let sum = 0;
    for (let i = 0; i < k; i++) sum += sorted[i];
    return sum / k;
  }

  avgStops(): number {
    if (this.completed === 0) return 0;
    return this.totalStopsCompleted / this.completed;
  }

  // Total travel time / free-flow travel time. 1.0 = no delay, 1.5 = 50% longer than ideal.
  // Trip-weighted (longer trips count more), which is what the network as a whole experienced.
  delayRatio(): number {
    if (this.totalFreeFlowCompleted === 0) return 1;
    return this.totalTravelCompleted / this.totalFreeFlowCompleted;
  }

  phaseUtilization(): number {
    if (this.phaseGreenAccum === 0) return 0;
    return this.phaseUsefulAccum / this.phaseGreenAccum;
  }

  avgQueue(): number {
    if (this.queueSamples === 0) return 0;
    return this.queueAccum / this.queueSamples;
  }

  reset() {
    this.simTime = 0;
    this.completed = 0;
    this.totalWaitCompleted = 0;
    this.totalStopsCompleted = 0;
    this.totalTravelCompleted = 0;
    this.totalFreeFlowCompleted = 0;
    this.completionTimes = [];
    this.completionHead = 0;
    this.queueAccum = 0;
    this.queueSamples = 0;
    this.maxActiveWait = 0;
    this.phaseGreenAccum = 0;
    this.phaseUsefulAccum = 0;
    this.recentWaits = [];
    this.sortedWaits = null;
  }
}
