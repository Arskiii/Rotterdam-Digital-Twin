import { describe, expect, it } from "vitest";
import { heldoutStations, qualityRows, validateHoldout } from "./model";
import type { ExperimentResultMsg } from "../sim/protocol";

describe("intelligence evidence", () => {
  it("reports a zero bridge count as a current no-report observation", () => {
    const t = "2026-09-26T12:00:00Z";
    const rows = qualityRows({ v: 3, t, bridges: [] }, Date.parse(t));
    expect(rows.find((row) => row.id === "bridges")).toMatchObject({ count: 0, status: "current" });
    expect(rows.find((row) => row.id === "traffic")?.status).toBe("missing");
  });
  it("does not present an omitted bridge feed or future timestamp as current", () => {
    const t = "2026-09-26T12:00:00Z";
    const rows = qualityRows({ v: 3, t, weather: { t: "2026-09-26T14:00:00Z", temp: 18, wind: 2, dir: 90, gust: 3, rain: 0, desc: "" } }, Date.parse(t));
    expect(rows.find((row) => row.id === "bridges")?.status).toBe("missing");
    expect(rows.find((row) => row.id === "weather")?.status).toBe("missing");
  });
  it("keeps the NDW holdout stable and reports weighted flow error", () => {
    const stations = Array.from({ length: 50 }, (_, edge) => ({ edge, flow: 100 }));
    expect(heldoutStations(stations)).toEqual(heldoutStations(stations));
    expect(heldoutStations(stations).length).toBeGreaterThan(0);
    const result = { stationFlows: [{ edge: 1, observed: 100, simulated: 80 }, { edge: 2, observed: 200, simulated: 140 }] } as ExperimentResultMsg;
    expect(validateHoldout(result)).toMatchObject({ matched: 2, observed: 300, simulated: 220, mae: 40, wmapePct: 26.7 });
  });
});
