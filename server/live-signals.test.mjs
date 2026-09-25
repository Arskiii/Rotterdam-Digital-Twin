import { describe, expect, it } from "vitest";
import { validateSnapshot, createLiveSignalHandler } from "./live-signals.mjs";

const now = Date.parse("2026-09-25T12:00:00Z");
const graphSha256 = "a".repeat(64);
const good = { source: "provider", graphSha256, updatedAt: "2026-09-25T11:59:58Z",
  signals: [{ signalIndex: 3, state: "red", observedAt: "2026-09-25T11:59:58Z" }] };

describe("authorized signal bridge", () => {
  it("rejects stale, duplicate and malformed observations", () => {
    expect(validateSnapshot(good, now).signals).toHaveLength(1);
    expect(() => validateSnapshot({ ...good, signals: [...good.signals, ...good.signals] }, now)).toThrow();
    expect(() => validateSnapshot({ ...good, signals: [{ ...good.signals[0], signalIndex: -1 }] }, now)).toThrow();
    expect(() => validateSnapshot({ ...good, updatedAt: "2026-09-25T11:59:00Z" }, now)).toThrow();
    expect(() => validateSnapshot(good, now, "b".repeat(64))).toThrow();
  });
  it("requires a long ingest secret and explicit public display origin", () => {
    expect(() => createLiveSignalHandler({ token: "weak" })).toThrow();
    expect(() => createLiveSignalHandler({ token: "x".repeat(32), graphSha256, publicRead: true })).toThrow();
    expect(createLiveSignalHandler({ token: "x".repeat(32), graphSha256, publicRead: false })).toBeTypeOf("function");
  });
});
