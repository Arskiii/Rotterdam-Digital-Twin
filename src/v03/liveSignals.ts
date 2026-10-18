export type LiveSignalColor = "red" | "yellow" | "green";

export interface LiveSignalReading {
  edgeId: string;
  state: LiveSignalColor;
  observedAt: number;
}

export interface LiveSignalSnapshot {
  source: string;
  updatedAt: number;
  signals: Map<string, LiveSignalReading>;
}

export const MAX_SIGNAL_AGE_MS = 15_000;
const MAX_FUTURE_SKEW_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    throw new Error("Expected a UTC ISO timestamp");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error("Invalid timestamp");
  }
  return timestamp;
}

export function parseLiveSignalSnapshot(value: unknown, now = Date.now()): LiveSignalSnapshot {
  if (!isRecord(value) || !Array.isArray(value.signals) || value.signals.length > 1000) {
    throw new Error("Invalid live signal snapshot");
  }
  if (typeof value.source !== "string" || value.source.length < 1 || value.source.length > 100) {
    throw new Error("Invalid source name");
  }
  const updatedAt = parseTimestamp(value.updatedAt);
  if (updatedAt > now + MAX_FUTURE_SKEW_MS || now - updatedAt > MAX_SIGNAL_AGE_MS) {
    throw new Error("Snapshot is not fresh");
  }
  const signals = new Map<string, LiveSignalReading>();
  const seen = new Set<string>();
  for (const item of value.signals) {
    if (!isRecord(item) || typeof item.edgeId !== "string" || item.edgeId.length < 1 || item.edgeId.length > 160 ||
        (item.state !== "red" && item.state !== "yellow" && item.state !== "green")) {
      throw new Error("Invalid signal reading");
    }
    if (seen.has(item.edgeId)) throw new Error("Duplicate signal reading");
    seen.add(item.edgeId);
    const observedAt = parseTimestamp(item.observedAt);
    if (observedAt > now + MAX_FUTURE_SKEW_MS || now - observedAt > MAX_SIGNAL_AGE_MS) {
      continue;
    }
    signals.set(item.edgeId, { edgeId: item.edgeId, state: item.state, observedAt });
  }
  return { source: value.source, updatedAt, signals };
}

export function isLiveReadingFresh(reading: LiveSignalReading, now = Date.now()): boolean {
  return reading.observedAt <= now + MAX_FUTURE_SKEW_MS && now - reading.observedAt <= MAX_SIGNAL_AGE_MS;
}

export function startLiveSignalPolling(
  url: string,
  onUpdate: (snapshot: LiveSignalSnapshot | null, status: string) => void,
): () => void {
  if (!url) {
    onUpdate(null, "Not configured");
    return () => {};
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  async function readSnapshot(response: Response): Promise<unknown> {
    if (!response.body) throw new Error("Empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new Error("Response too large");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async function poll() {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 4000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = parseLiveSignalSnapshot(await readSnapshot(response));
      if (!stopped) onUpdate(snapshot, snapshot.signals.size ? "Connected" : "No fresh observations");
    } catch {
      if (!stopped) onUpdate(null, "Unavailable");
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(poll, 2500);
    }
  }
  onUpdate(null, "Connecting");
  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}
