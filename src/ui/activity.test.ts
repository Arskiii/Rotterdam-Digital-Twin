import { expect, it } from "vitest";
import { mapSimulationRunning } from "./activity";

it("suspends the city while hidden and restores the user's pause and mode choices", () => {
  for (const page of ["map", "brief", "setup"] as const) {
    expect(mapSimulationRunning(page, "live", false, false)).toBe(false);
    expect(mapSimulationRunning(page, "sim", false, false)).toBe(false);
    expect(mapSimulationRunning(page, "live", true, true)).toBe(true);
    expect(mapSimulationRunning(page, "sim", false, true)).toBe(true);
    expect(mapSimulationRunning(page, "sim", true, true)).toBe(false);
    expect(mapSimulationRunning(page, "history", false, true)).toBe(false);
  }
});

it("keeps the city paused on either workspace even after a visibility or mode change", () => {
  for (const page of ["lab", "intelligence"] as const) {
    for (const mode of ["live", "sim", "history"] as const) {
      expect(mapSimulationRunning(page, mode, false, true)).toBe(false);
      expect(mapSimulationRunning(page, mode, false, false)).toBe(false);
    }
  }
});
