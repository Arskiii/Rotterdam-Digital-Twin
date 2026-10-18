export type ObservedSignalState = "red" | "yellow" | "green";
export interface ObservedSignal {
  signalIndex: number;
  state: ObservedSignalState;
  observedAt: number;
}
export interface ObservedSignalSnapshot {
  source: string;
  graphSha256: string;
  updatedAt: number;
  signals: ObservedSignal[];
}

const MAX_AGE_MS = 15_000;
const MAX_BYTES = 128 * 1024;

function utcTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    throw new Error("Expected UTC timestamp");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("Invalid timestamp");
  return time;
}

export function parseObservedSignals(value: unknown, maxIndex: number, graphSha256: string, now = Date.now()): ObservedSignalSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid signal snapshot");
  const raw = value as Record<string, unknown>;
  if (typeof raw.source !== "string" || raw.source.length < 1 || raw.source.length > 100 ||
      !/^[a-f0-9]{64}$/.test(graphSha256) || raw.graphSha256 !== graphSha256 ||
      !Array.isArray(raw.signals) || raw.signals.length > 5000) throw new Error("Invalid signal snapshot");
  const updatedAt = utcTime(raw.updatedAt);
  if (updatedAt > now + 2000 || now - updatedAt > MAX_AGE_MS) throw new Error("Stale signal snapshot");
  const seen = new Set<number>();
  const signals: ObservedSignal[] = [];
  for (const item of raw.signals) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid signal entry");
    const signal = item as Record<string, unknown>;
    const i = signal.signalIndex;
    if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= maxIndex || seen.has(i as number) ||
        !["red", "yellow", "green"].includes(String(signal.state))) throw new Error("Invalid signal entry");
    seen.add(i as number);
    const observedAt = utcTime(signal.observedAt);
    if (observedAt <= now + 2000 && now - observedAt <= MAX_AGE_MS) {
      signals.push({ signalIndex: i as number, state: signal.state as ObservedSignalState, observedAt });
    }
  }
  return { source: raw.source, graphSha256, updatedAt, signals };
}

export function pollObservedSignals(
  url: string,
  maxIndex: number,
  graphSha256: string,
  update: (snapshot: ObservedSignalSnapshot | null, status: string) => void,
): () => void {
  if (!url) { update(null, "No authorized feed connected"); return () => {}; }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  async function poll() {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 4000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store", credentials: "omit" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error("Signal response too large");
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const snapshot = parseObservedSignals(JSON.parse(new TextDecoder().decode(bytes)), maxIndex, graphSha256);
      if (!stopped) update(snapshot, snapshot.signals.length ? `${snapshot.signals.length} observed heads · ${snapshot.source}` : "No fresh signal states");
    } catch {
      if (!stopped) update(null, "Authorized feed unavailable");
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(poll, 2500);
    }
  }
  update(null, "Connecting to authorized feed");
  void poll();
  return () => { stopped = true; if (timer) clearTimeout(timer); controller?.abort(); };
}
