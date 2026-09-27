import { BRAND, LOCATION_LABEL } from "../config";
import { escapeHtml } from "./format";
import { icons } from "./icons";

export type MapMode = "live" | "sim" | "history";
export type MapPage = "map" | "brief" | "setup";

/** Only the map destinations exposed by the shared navigation can be opened. */
export function readMapNavigation(search: string): { mode?: MapMode; page?: MapPage } {
  const params = new URLSearchParams(search);
  const mode = params.get("mode");
  const page = params.get("page");
  return {
    mode: mode === "live" || mode === "sim" || mode === "history" ? mode : undefined,
    page: page === "map" || page === "brief" || page === "setup" ? page : undefined,
  };
}

/** Shared platform chrome. Map controls stay local; other pages link to them. */
export function buildHeader({ page, mapHref = "../" }: {
  page: "map" | "intelligence";
  mapHref?: string;
}): string {
  const intelligence = page === "intelligence";
  const mapLink = (mode: MapMode, destination: MapPage) =>
    escapeHtml(`${mapHref}?mode=${mode}&page=${destination}`);
  const modes = intelligence
    ? `<a class="mode-link" data-mode="live" href="${mapLink("live", "map")}" title="Open the live map">Live</a>
        <a class="mode-link" data-mode="sim" href="${mapLink("sim", "map")}" title="Open the simulation map">Simulation</a>
        <a class="mode-link" data-mode="history" href="${mapLink("history", "map")}" title="Open the history map">History</a>`
    : `<button data-mode="live" class="on" aria-pressed="true">Live</button>
        <button data-mode="sim" aria-pressed="false">Simulation</button>
        <button data-mode="history" aria-pressed="false">History</button>`;
  const navigation = intelligence
    ? `<a class="nav-btn" data-page="brief" href="${mapLink("live", "brief")}">Brief</a>
        <a class="nav-btn" data-page="map" href="${mapLink("live", "map")}">Unit&nbsp;Map</a>
        <a class="nav-btn" data-page="setup" href="${mapLink("sim", "setup")}">Setup</a>
        <a class="nav-btn on" href="./" aria-current="page">Intelligence</a>`
    : `<button class="nav-btn" data-page="brief">Brief</button>
        <button class="nav-btn on" data-page="map" aria-current="page">Unit&nbsp;Map</button>
        <button class="nav-btn" data-page="setup">Setup</button>
        <a class="nav-btn" href="./intelligence/">Intelligence</a>`;

  return `<header id="topbar" class="brk"><i class="tick tl"></i><i class="tick tr"></i><i class="tick bl"></i><i class="tick br"></i>
      <div id="brand">${icons.logo()} <span>${BRAND}</span></div>
      <div id="mode-switch" role="group" aria-label="${intelligence ? "Map modes" : "What the map is showing"}">
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
