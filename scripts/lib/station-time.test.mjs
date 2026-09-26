import { describe, expect, it } from "vitest";
import { dutchStationTime } from "./station-time.mjs";

describe("Dutch weather station timestamps", () => {
  it("converts winter and summer wall clocks to UTC", () => {
    expect(dutchStationTime("2026-01-26T17:30:00")).toBe("2026-01-26T16:30:00.000Z");
    expect(dutchStationTime("2026-09-26T17:30:00")).toBe("2026-09-26T15:30:00.000Z");
  });
  it("resolves the repeated autumn hour against receipt time", () => {
    expect(dutchStationTime("2026-10-25T02:30:00", Date.parse("2026-10-25T01:00:00Z"))).toBe("2026-10-25T00:30:00.000Z");
    expect(dutchStationTime("2026-10-25T02:30:00", Date.parse("2026-10-25T02:00:00Z"))).toBe("2026-10-25T01:30:00.000Z");
  });
  it("rejects an impossible future station reading", () => {
    expect(() => dutchStationTime("2026-09-26T17:30:00", Date.parse("2026-09-26T14:00:00Z"))).toThrow("future");
  });
});
