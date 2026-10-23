import { BRAND, LOCATION_LABEL } from "../config";
import { icons } from "./icons";

export type MapMode = "live" | "sim" | "history";
export type MapPage = "map" | "brief" | "setup" | "intelligence" | "lab";
export const PHONE_MQ = "(max-width: 780px), (max-height: 520px) and (pointer: coarse)";

/** Only the map destinations exposed by the shared navigation can be opened. */
export function readMapNavigation(search: string): { mode?: MapMode; page?: MapPage } {
  const params = new URLSearchParams(search);
  const mode = params.get("mode");
  const page = params.get("page");
  return {
    mode: mode === "live" || mode === "sim" || mode === "history" ? mode : undefined,
    page: page === "map" || page === "brief" || page === "setup" || page === "intelligence" || page === "lab" ? page : undefined,
  };
}

/** Every destination switches a persistent view in the same application. */
export function buildHeader({ page }: { page: MapPage }): string {
  const modes = `<button data-mode="live" class="on" aria-pressed="true">Live</button>
        <button data-mode="sim" aria-pressed="false">Simulation</button>
        <button data-mode="history" aria-pressed="false">History</button>`;
  const navigation = ([["brief", "Brief"], ["map", "Unit&nbsp;Map"], ["setup", "Setup"],
    ["intelligence", "Intelligence"], ["lab", "Scenario lab"]] as const).map(([id, label]) =>
    `<button class="nav-btn${page === id ? " on" : ""}" data-page="${id}"${page === id ? ' aria-current="page"' : ""}>${label}</button>`).join("\n");

  return `<header id="topbar" class="brk"><i class="tick tl"></i><i class="tick tr"></i><i class="tick bl"></i><i class="tick br"></i>
      <div id="brand">${icons.logo()} <span>${BRAND}</span></div>
      <div id="mode-switch" role="group" aria-label="What the map is showing">
        ${modes}
      </div>
      <nav id="topnav" aria-label="Pages">
        ${navigation}
      </nav>
      <div id="topmeta">
        <span class="meta-item" id="live-chip" title="Live city feeds" style="display:none"><span id="live-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3ddc84;margin-right:6px"></span><span id="live-text">LIVE</span></span>
        <span class="meta-item" id="loc-chip">${icons.pin()} <span>${LOCATION_LABEL}</span></span>
        <span class="meta-item">${icons.clock()} <span id="clock">--:--</span></span>
      </div>
    </header>`;
}
