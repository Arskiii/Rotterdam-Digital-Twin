import { describe, expect, it } from "vitest";
import { parseObservedSignals } from "./live-signals";

const now = Date.parse("2026-09-25T12:00:00Z");
const graphSha256 = "a".repeat(64);
const good = { source: "approved provider", graphSha256, updatedAt: "2026-09-25T11:59:58Z",
  signals: [{ signalIndex: 12, state: "green", observedAt: "2026-09-25T11:59:57Z" }] };

describe("observed iVRI snapshots", () => {
  it("accepts a fresh mapped head", () => {
    const parsed = parseObservedSignals(good, 100, graphSha256, now);
    expect(parsed.signals).toEqual([{ signalIndex: 12, state: "green", observedAt: now - 3000 }]);
  });
  it("rejects stale, duplicate and out-of-network readings", () => {
    expect(() => parseObservedSignals(good, 10, graphSha256, now)).toThrow();
    expect(() => parseObservedSignals(good, 100, "b".repeat(64), now)).toThrow();
    expect(() => parseObservedSignals({ ...good, updatedAt: "2026-09-25T11:59:30Z" }, 100, graphSha256, now)).toThrow();
    expect(() => parseObservedSignals({ ...good, signals: [good.signals[0], good.signals[0]] }, 100, graphSha256, now)).toThrow();
  });
});
