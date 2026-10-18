import * as THREE from "three";
import type { Network } from "../sim/types";
import type { NetworkMesh } from "../render/network";
import { roadEdgesForHit } from "../render/network";
import { siteUrl } from "../ui/platform";
import { safeReading } from "../lab/imports";
import { stageHandoff } from "../lab/handoff";
import { aggregateTraffic, matchCorridor, type TrafficReading } from "./scenario";
import { corridorLabel, corridorReadings, freshness, historyGapLabel, selectedCorridor } from "./corridors";

interface Options {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  origin: { lat: number; lon: number };
  network: () => Network;
  mesh: () => NetworkMesh;
  editing: () => boolean;
}

export function createCorridorInspector(options: Options) {
  const panel = document.createElement("section");
  panel.id = "corridor-panel";
  panel.setAttribute("aria-label", "Corridor evidence");
  const title = document.createElement("h2"); title.textContent = "Explore a road section";
  const hint = document.createElement("p"); hint.textContent = "Click a road on the map or choose a section. Highlighting covers one mapped segment.";
  const label = document.createElement("label"); label.textContent = "Road section";
  const select = document.createElement("select"); select.id = "corridor-select"; label.append(select);
  const geometry = document.createElement("p");
  const evidence = document.createElement("div"); evidence.id = "corridor-evidence"; evidence.setAttribute("role", "status");
  const source = document.createElement("a"); source.href = "https://opendata.ndw.nu/"; source.textContent = "NDW observation source"; source.target = "_blank"; source.rel = "noopener noreferrer";
  const open = document.createElement("a"); open.id = "corridor-open-lab"; open.className = "corridor-action"; open.textContent = "Test this section in the lab"; open.hidden = true;
  const warning = document.createElement("p"); warning.setAttribute("role", "status");
  panel.append(title, hint, label, geometry, evidence, source, open, warning);
  document.getElementById("hud")!.before(panel);
  const highlight = new THREE.Group(); options.scene.add(highlight);
  let rows: TrafficReading[] = [];
  let historical: TrafficReading[] = [];
  let current: TrafficReading[] = [];
  let historyState = "Loading observation history…";
  let health = "";
  let net: Network | null = null;
  let selected = new URL(location.href).searchParams.get("corridor") ?? "";
  let wasEditing = options.editing();
  let lastEvidenceMinute = -1;

  function clearHighlight() {
    for (const child of [...highlight.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      highlight.remove(child);
    }
  }
  function renderEvidence() {
    evidence.replaceChildren();
    const corridor = selectedCorridor(options.network(), selected);
    if (!corridor) {
      evidence.textContent = selected ? "This road is unavailable in the current network. Choose another section." : "Choose a section to inspect detector coverage.";
      return;
    }
    const matched = corridorReadings(options.network(), rows, options.origin, corridor);
    const latest = new Map<string, TrafficReading>();
    for (const row of matched) if (!latest.has(row.id) || row.observedAt > latest.get(row.id)!.observedAt) latest.set(row.id, row);
    const summary = document.createElement("p");
    const samples = aggregateTraffic(matched);
    summary.textContent = latest.size ? `${latest.size} matched detector(s) · ${samples.length} observation times. Direction is unknown.`
      : `No detector observations matched to this section. ${historyState} Scenario comparisons remain available; demand fitting needs measured speed.`;
    evidence.append(summary);
    for (const row of [...latest.values()].slice(0, 6)) {
      const item = document.createElement("p");
      const name = document.createElement("strong"); name.textContent = `${row.name} · ${row.id}`;
      const time = document.createElement("small"); time.textContent = freshness(row.observedAt);
      const values = document.createElement("small");
      values.textContent = `Speed ${row.speedKmh === null ? "unavailable" : `${row.speedKmh.toFixed(1)} km/h`} · Flow ${row.vehiclesPerHour === null ? "unavailable" : `${Math.round(row.vehiclesPerHour)} veh/h`}`;
      item.append(name, time, values); evidence.append(item);
    }
    if (samples.length) {
      const coverage = document.createElement("p");
      coverage.textContent = `History: ${new Date(samples[0].observedAt).toLocaleString()} to ${new Date(samples.at(-1)!.observedAt).toLocaleString()}. ${historyGapLabel(samples)} ${historyState} ${health}`;
      evidence.append(coverage);
    }
  }
  function choose(id: string, writeUrl = true) {
    selected = id;
    const network = options.network();
    const corridor = selectedCorridor(network, id);
    if (corridor && ![...select.options].some((option) => option.value === id)) {
      const representative = [...select.options].find((option) => corridor.edgeIds.includes(option.value));
      if (representative) { id = representative.value; selected = id; }
    }
    select.value = corridor ? id : "";
    clearHighlight();
    open.hidden = !corridor;
    warning.textContent = "";
    geometry.textContent = "";
    if (corridor) {
      const edge = network.edges.get(id)!;
      const lanes = corridor.edgeIds.reduce((sum, edgeId) => sum + network.edges.get(edgeId)!.laneCount, 0);
      geometry.textContent = `${Math.round(edge.length)} m · ${lanes} lane(s) · ${corridor.edgeIds.length === 2 ? "two directions" : "one direction"} · ${Math.round(edge.speedLimit * 3.6)} km/h mapped limit`;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(edge.length, 0.3, Math.max(9, lanes * 3.5 + 3)),
        new THREE.MeshBasicMaterial({ color: 0x91dfc5, transparent: true, opacity: 0.5, depthWrite: false }));
      mesh.position.set((edge.start.x + edge.end.x) / 2, 0.45, (edge.start.y + edge.end.y) / 2);
      mesh.rotation.y = -Math.atan2(edge.dir.y, edge.dir.x);
      highlight.add(mesh);
      const url = siteUrl("lab/"); url.searchParams.set("corridor", id); open.href = url.href;
    }
    if (writeUrl) {
      const url = new URL(location.href);
      if (selected) url.searchParams.set("corridor", selected); else url.searchParams.delete("corridor");
      history.replaceState(null, "", url);
    }
    renderEvidence();
  }
  function rebuild() {
    net = options.network();
    const measured = new Set<string>();
    const unique = new Map(rows.map((row) => [`${row.id}|${row.lat}|${row.lon}`, row]));
    for (const row of unique.values()) matchCorridor(net, row, options.origin)?.edgeIds.forEach((id) => measured.add(id));
    const seen = new Set<string>();
    const edges = [...net.edges.values()].filter((edge) => {
      const key = [edge.from, edge.to].sort().join("|");
      if (seen.has(key) || !selectedCorridor(net!, edge.id)) return false;
      seen.add(key); return true;
    }).sort((a, b) => Number(measured.has(b.id)) - Number(measured.has(a.id)) || corridorLabel(a).localeCompare(corridorLabel(b)));
    select.replaceChildren();
    const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a road section…"; select.append(placeholder);
    for (const edge of edges) {
      const option = document.createElement("option"); option.value = edge.id;
      option.textContent = `${measured.has(edge.id) ? "Measured · " : ""}${corridorLabel(edge)}`; select.append(option);
    }
    // A bookmarked reverse edge may share the dropdown's forward representative.
    if (selected && !edges.some((edge) => edge.id === selected)) {
      const match = selectedCorridor(net, selected);
      const representative = edges.find((edge) => match?.edgeIds.includes(edge.id));
      if (representative) selected = representative.id;
    }
    choose(selected, false);
  }
  function mergeRows() {
    const byKey = new Map<string, TrafficReading>();
    for (const row of [...historical, ...current]) byKey.set(`${row.id}|${row.observedAt}`, row);
    rows = [...byKey.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).slice(-3000);
    rebuild();
  }
  function safeRows(value: unknown): TrafficReading[] {
    return Array.isArray(value) ? value.slice(0, 3000).map(safeReading).filter((row): row is TrafficReading => row !== null) : [];
  }
  function setSnapshot(snapshot: { traffic?: { readings?: unknown }; health?: { traffic?: { status?: string } } }) {
    current = safeRows(snapshot.traffic?.readings);
    health = snapshot.health?.traffic?.status ? `NDW fetch status: ${snapshot.health.traffic.status}. Observation times determine freshness.` : "";
    mergeRows();
  }
  select.addEventListener("change", () => choose(select.value));
  open.addEventListener("click", (event) => {
    if (!selectedCorridor(options.network(), selected)) { event.preventDefault(); return; }
    try {
      const token = stageHandoff(options.network(), options.origin, selected, rows);
      const url = siteUrl("lab/"); url.searchParams.set("corridor", selected); url.searchParams.set("handoff", token); open.href = url.href;
    } catch (error) { event.preventDefault(); warning.textContent = error instanceof Error ? error.message : String(error); }
  });
  const ray = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  let multitouch = false;
  const pointers = new Set<number>();
  options.renderer.domElement.addEventListener("pointerdown", (event) => {
    pointers.add(event.pointerId);
    if (pointers.size > 1) multitouch = true;
    if (event.button === 0 && !options.editing()) down = { x: event.clientX, y: event.clientY };
  });
  options.renderer.domElement.addEventListener("pointercancel", (event) => { pointers.delete(event.pointerId); down = null; if (!pointers.size) multitouch = false; });
  options.renderer.domElement.addEventListener("pointerup", (event) => {
    pointers.delete(event.pointerId);
    const start = down; down = null;
    const moved = !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5;
    const blocked = multitouch; if (!pointers.size) multitouch = false;
    if (moved || blocked || options.editing() || event.button !== 0) return;
    const rect = options.renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), options.camera);
    for (const hit of ray.intersectObjects([options.mesh().group], true)) {
      const id = roadEdgesForHit(hit).find((edgeId) => selectedCorridor(options.network(), edgeId));
      if (id) { choose(id); break; }
    }
  });
  rebuild();
  void fetch(siteUrl("data/traffic-history.json"), { signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const history = await response.json() as { readings?: unknown };
      historical = safeRows(history.readings); historyState = historical.length ? "Retained observations loaded." : "Retained history is empty.";
      mergeRows();
    }).catch(() => { historyState = "Retained history could not load."; renderEvidence(); });
  return { setSnapshot, update() {
    const editing = options.editing();
    if (editing !== wasEditing) { wasEditing = editing; select.disabled = editing; open.hidden = editing || !selectedCorridor(options.network(), selected); }
    if (net !== options.network()) rebuild();
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== lastEvidenceMinute) { lastEvidenceMinute = minute; renderEvidence(); }
  } };
}
