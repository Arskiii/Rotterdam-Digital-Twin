import "./style.css";
import "./ui/workspace.css";
import "./lab/lab.css";
import intelligenceMarkup from "./intelligence/view.html?raw";
import labMarkup from "./lab/view.html?raw";
import { buildChrome } from "./ui/chrome";
import { PHONE_MQ, type MapMode, type MapPage } from "./ui/header";
import { isWorkspace, normalizePlatformRoute, platformRouteUrl, readPlatformRoute, type PlatformRoute } from "./ui/navigation";
import { siteUrl } from "./ui/siteUrl";
import { currentLiveSnapshot, LiveFeed } from "./data/live";
import { TIMEZONE } from "./config";
import { fmtClockAmPm } from "./ui/format";
import type { App } from "./ui/app";
import { registerServiceWorker } from "./data/sw-register";
import { preloadCity } from "./data/city-assets";
import { StudySelection } from "./study/context";

const ui = buildChrome(document.getElementById("app")!);
const siteRoot = siteUrl("./");
const phone = matchMedia(PHONE_MQ).matches;
if (phone) document.body.dataset.phone = "1";
const initial = readPlatformRoute(new URL(location.href), siteRoot);
function savedMode(): MapMode {
  try {
    const mode = JSON.parse(localStorage.getItem("rtm.mode") ?? "null");
    if (mode === "sim" || mode === "history") return mode;
  } catch { /* private browsing or invalid saved preferences */ }
  return "live";
}
let route: PlatformRoute = { page: initial?.page ?? "map", mode: initial?.mode ?? savedMode() };
let map: App | null = null;
let mapPromise: Promise<void> | null = null;
let mapFailed = false;
let syncingMap = false;
const selection = new StudySelection(new URL(location.href).searchParams.get("corridor"), (page) => navigate(page));
selection.subscribe((id) => {
  const url = new URL(location.href);
  if (url.searchParams.get("corridor") === id) return;
  if (id) url.searchParams.set("corridor", id); else url.searchParams.delete("corridor");
  url.searchParams.delete("handoff");
  history.pushState(null, "", url);
});

// Retain each view and its DOM instead of rebuilding forms or discarding results.
const mapRail = document.createElement("div");
mapRail.className = "rail-view";
mapRail.id = "map-rail-tools";
mapRail.append(...ui.rail.childNodes);
ui.rail.append(mapRail);
ui.viewport.append(ui.boot); // the header remains usable while the map initializes
const workspaces = Object.fromEntries((["intelligence", "lab"] as const).map((page) => {
  const view = document.createElement("section");
  view.id = `page-${page}`;
  view.dataset.workspace = page;
  view.className = `workspace-view workspace-page ${page}-page`;
  view.hidden = true;
  view.innerHTML = page === "lab" ? labMarkup : intelligenceMarkup;
  // Old deep links and static JSON/document links retain their original roots.
  for (const link of view.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    link.href = new URL(link.getAttribute("href")!, new URL(`${page}/`, siteRoot)).href;
  }
  document.getElementById("stage")!.append(view);
  return [page, view];
})) as Record<"intelligence" | "lab", HTMLElement>;
const feed = new LiveFeed(siteUrl("data/").href);
interface WorkspaceController { setActive(active: boolean): void }
const controllers: Partial<Record<"intelligence" | "lab", WorkspaceController>> = {};
const workspacePromises: Partial<Record<"intelligence" | "lab", Promise<void>>> = {};

function renderRoute() {
  document.body.dataset.page = route.page;
  document.body.dataset.mode = route.mode;
  ui.viewport.hidden = isWorkspace(route.page);
  mapRail.hidden = isWorkspace(route.page);
  for (const page of ["intelligence", "lab"] as const) {
    const active = route.page === page;
    workspaces[page].hidden = !active;
    document.querySelector<HTMLElement>(`[data-workspace-rail="${page}"]`)?.toggleAttribute("hidden", !active);
    controllers[page]?.setActive(active);
    if (active) workspaces[page].dispatchEvent(new Event("viewchange"));
  }
  for (const button of ui.navBtns) {
    const active = button.dataset.page === route.page;
    button.classList.toggle("on", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const button of ui.modeBtns) {
    const active = button.dataset.mode === route.mode;
    button.classList.toggle("on", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = route.page === "setup" && button.dataset.mode !== "sim"
      || button.dataset.mode === "sim" && (phone || map?.simAvailable === false);
  }
  document.title = `SurveilTrack — ${{ map: "Rotterdam", brief: "Brief", setup: "Setup", intelligence: "Intelligence", lab: "Scenario Lab" }[route.page]}`;
}

function syncMap() {
  if (!map) return;
  syncingMap = true;
  try {
    // Leaving Setup releases its mode lock before applying another mode.
    if (map.page === "setup" && route.page !== "setup") map.setPage(route.page);
    if (map.mode !== route.mode) map.setMode(route.mode, true);
    map.setPage(route.page);
    route = { page: map.page, mode: map.mode };
  } finally { syncingMap = false; }
}

function navigate(page: MapPage, mode = route.mode, historyMode: "push" | "replace" | "none" = "push", hash = "") {
  route = normalizePlatformRoute({ page, mode }, !phone && map?.simAvailable !== false);
  syncMap();
  const next = platformRouteUrl(new URL(location.href), siteRoot, route, hash);
  if (historyMode !== "none" && next.href !== location.href) {
    history[historyMode === "replace" ? "replaceState" : "pushState"](null, "", next);
  }
  renderRoute();
  if (!isWorkspace(route.page)) void ensureMap();
}

function ensureMap(): Promise<void> {
  if (mapFailed) return Promise.resolve();
  if (!mapPromise) preloadCity(siteUrl("data/").href);
  mapPromise ??= import("./main").then(async ({ mountMap }) => {
    map = await mountMap(ui, feed, selection);
    map.onNavigate = (page, mode) => { if (!syncingMap) navigate(page, mode); };
    syncMap();
    navigate(route.page, route.mode, "replace", location.hash);
  }).catch((error) => {
    map?.dispose(); map = null;
    mapFailed = true;
    mapPromise = null;
    console.error(error);
    ui.bootError.style.display = "block";
    ui.bootError.textContent = `MAP UNAVAILABLE — ${error?.message ?? error}`;
    const retry = document.createElement("button"); retry.textContent = "Retry map";
    retry.addEventListener("click", () => {
      if (!mapFailed) return;
      mapFailed = false;
      // Replace only the failed map surface. Workspace forms, comparisons and
      // the shared navigation keep their existing DOM and controller instances.
      const fresh = buildChrome(document.createElement("div"));
      const shared = { rail: ui.rail, clock: ui.clock, liveChip: ui.liveChip, liveDot: ui.liveDot, liveText: ui.liveText, navBtns: ui.navBtns, modeBtns: ui.modeBtns };
      mapRail.replaceChildren(...fresh.rail.childNodes);
      fresh.viewport.append(fresh.boot);
      ui.viewport.replaceWith(fresh.viewport);
      Object.assign(ui, fresh, shared);
      renderRoute(); void ensureMap();
    });
    ui.bootError.append(" ", retry);
  });
  return mapPromise;
}

function ensureWorkspace(page: "intelligence" | "lab"): Promise<void> {
  workspacePromises[page] ??= (page === "lab"
    ? import("./lab/main").then(({ mountLab }) => mountLab(workspaces.lab, selection))
    : import("./intelligence/main").then(({ mountIntelligence }) => mountIntelligence(workspaces.intelligence, feed, siteUrl("data/").href, selection)))
    .then((controller) => {
      controllers[page] = controller;
      controller.setActive(route.page === page);
      workspaces[page].dispatchEvent(new Event("viewchange"));
    }).catch((error) => {
      console.error(error);
      const status = workspaces[page].querySelector<HTMLElement>(page === "lab" ? "#load-status" : "#snapshot-status")!;
      status.textContent = `Workspace unavailable: ${error?.message ?? error}`;
    });
  return workspacePromises[page]!;
}

ui.navBtns.forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page as MapPage)));
ui.modeBtns.forEach((button) => button.addEventListener("click", () => {
  if (!button.disabled) navigate(isWorkspace(route.page) ? "map" : route.page, button.dataset.mode as MapMode);
}));
// Section anchors, return links and legacy workspace links also stay in this document.
document.addEventListener("click", (event) => {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!link || link.hasAttribute("download") || link.target && link.target !== "_self") return;
  const url = new URL(link.href);
  const target = readPlatformRoute(url, siteRoot);
  if (!target) return;
  event.preventDefault();
  if (url.searchParams.has("corridor")) selection.select(url.searchParams.get("corridor"));
  const owner = link.closest<HTMLElement>("[data-workspace], [data-workspace-rail]");
  const page = link.getAttribute("href")?.startsWith("#") && owner
    ? (owner.dataset.workspace ?? owner.dataset.workspaceRail) as MapPage : target.page;
  navigate(page, target.mode ?? route.mode, "push", url.hash);
});
const restoreRoute = () => {
  selection.select(new URL(location.href).searchParams.get("corridor"));
  const target = readPlatformRoute(new URL(location.href), siteRoot);
  if (target) navigate(target.page, target.mode ?? "live", "none", location.hash);
};
window.addEventListener("popstate", restoreRoute);
window.addEventListener("hashchange", restoreRoute);

// One clock and one observation poller serve every tab, even before WebGL loads.
function renderHeader() {
  ui.clock.textContent = fmtClockAmPm(new Date(), TIMEZONE);
  refreshFeed.disabled = feed.refreshing;
  refreshFeed.textContent = feed.refreshing ? "Refreshing…" : "Refresh feeds";
  refreshFeed.hidden = !!feed.snapshot && feed.health() === "live" && !feed.refreshing;
  ui.liveChip.style.display = "";
  if (!feed.snapshot) {
    ui.liveText.textContent = feed.refreshing ? "CONNECTING TO FEEDS…" : "FEEDS UNAVAILABLE";
    ui.liveDot.style.background = "#e3b23c"; return;
  }
  const health = feed.health();
  ui.liveDot.style.background = health === "live" ? "#3ddc84" : health === "lagging" ? "#e3b23c" : "#d0453c";
  const age = feed.ageMin();
  const ageText = age < 1 ? "<1M" : `${Math.round(age)}M`;
  if (health === "stale") { ui.liveText.textContent = `FEED STALE — ${ageText} OLD`; return; }
  const snap = currentLiveSnapshot(feed.snapshot);
  const parts = [`LIVE ${ageText}`];
  if (snap.weather?.temp != null) parts.push(`${Math.round(snap.weather.temp)}°C`);
  if (snap.water) parts.push(`MAAS ${snap.water.cm >= 0 ? "+" : ""}${snap.water.cm}CM`);
  const works = snap.incidents?.filter((i) => i.kind === 4).length ?? 0;
  const incidents = (snap.incidents?.length ?? 0) - works;
  if (incidents) parts.push(`${incidents} INC`);
  if (works) parts.push(`${works} WRK`);
  if (snap.bridges?.length) parts.push(`${snap.bridges.length} BRUG`);
  ui.liveText.textContent = parts.join(" · ");
}
const refreshFeed = document.createElement("button");
refreshFeed.id = "refresh-feeds"; refreshFeed.type = "button";
refreshFeed.addEventListener("click", () => void feed.refresh());
ui.liveChip.append(refreshFeed);
feed.subscribeStatus(renderHeader);
feed.subscribe(renderHeader);
renderHeader();
setInterval(renderHeader, 1000);
navigate(route.page, route.mode, "replace", location.hash);
void registerServiceWorker();
// Prepare controllers and their data in parallel with the first map load.
// Switching views never imports a new document or creates a second controller.
void ensureWorkspace("intelligence");
void ensureWorkspace("lab");
