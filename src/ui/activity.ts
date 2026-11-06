import type { MapMode, MapPage } from "./header";
import { isWorkspace } from "./navigation";

/** Only the visible city view needs its interactive simulation to advance. */
export function mapSimulationRunning(page: MapPage, mode: MapMode, paused: boolean, visible: boolean): boolean {
  return visible && !isWorkspace(page) && (mode === "live" || mode === "sim" && !paused);
}
