import type { StudySelection } from "./context";
import { loadStudy } from "./data";
import { corridorHistory } from "./history";
import { corridorLabel, corridorReadings, freshness, historyGapLabel, selectedCorridor } from "../v03/corridors";
import { aggregateTraffic } from "../v03/scenario";
import { drawCorridorMap } from "../lab/corridorMap";

export function mountCorridorEvidence(root: HTMLElement, selection: StudySelection) {
  const section = document.createElement("section"); section.id = "selected-corridor-evidence";
  section.className = "workspace-section brk study-evidence";
  section.innerHTML = `<div class="section-head"><div><p class="eyebrow">Selected corridor / Map → Evidence → Compare</p><h2>Choose a road section</h2></div><span class="badge source">CORRIDOR STUDY</span></div><div class="study-evidence-body"><canvas width="168" height="100" role="img" aria-label="Selected study corridor"></canvas><div><p class="study-evidence-status" role="status"></p><p class="study-evidence-metrics"></p><p class="minor">Road geometry and detector history from the corridor study. City-wide live feeds are assessed below.</p><div class="controls"><button data-action="map">Show on Unit Map</button><button data-action="lab" disabled>Compare in Scenario Lab</button></div></div></div>`;
  root.querySelector(".workspace-sections")!.prepend(section);
  const status = section.querySelector<HTMLElement>(".study-evidence-status")!, metrics = section.querySelector<HTMLElement>(".study-evidence-metrics")!;
  const lab = section.querySelector<HTMLButtonElement>('[data-action="lab"]')!, canvas = section.querySelector("canvas")!;
  section.querySelector<HTMLButtonElement>('[data-action="map"]')!.onclick = () => selection.open("map");
  lab.onclick = () => selection.open("lab");
  let revision = 0;
  let redraw = () => {};
  new ResizeObserver(() => redraw()).observe(canvas);
  function render(id: string | null, loading = true) {
    const request = ++revision;
    if (loading) {
      section.querySelector("h2")!.textContent = id ? "Loading selected corridor…" : "Choose a road section";
      status.textContent = id ? "Loading corridor evidence…" : "Open Study corridors on Unit Map, then select a road to inspect its observations here.";
      metrics.textContent = ""; lab.disabled = true; canvas.hidden = !id;
    }
    if (!id) return;
    void loadStudy().then((study) => {
      if (request !== revision) return;
      const corridor = selectedCorridor(study.network, id), edge = study.network.edges.get(id);
      lab.disabled = !corridor;
      section.querySelector("h2")!.textContent = corridor && edge ? edge.name || "Selected road section" : "Requested section unavailable";
      section.querySelector("h2")!.title = edge ? corridorLabel(edge) : "";
      redraw = () => drawCorridorMap(canvas, study.network, corridor?.edgeIds ?? []);
      redraw();
      if (!corridor) { status.textContent = "Choose another section in the bundled study area on Unit Map."; return; }
      const samples = aggregateTraffic(corridorReadings(study.network, study.readings, study.origin, corridor));
      const latest = samples.at(-1);
      status.textContent = latest ? `${freshness(latest.observedAt)} · ${samples.length} observation times. ${historyGapLabel(samples)}`
        : "No matched detector observations. You can compare model scenarios; demand cannot be fitted to this section.";
      if (corridorHistory.error) status.textContent += ` ${corridorHistory.error}`;
      section.querySelector<HTMLElement>(".minor")!.textContent = `NDW detector history · ${corridorHistory.snapshot?.source === "published" ? "Latest published observations" : "Saved fallback observations"}. Observation dates above show the age of the measurements.`;
      metrics.textContent = `${Math.round(edge!.length)} m · ${Math.round(edge!.speedLimit * 3.6)} km/h limit · Latest measured speed: ${latest?.speedKmh == null ? "—" : `${latest.speedKmh.toFixed(1)} km/h`} · Flow: ${latest?.vehiclesPerHour == null ? "—" : `${Math.round(latest.vehiclesPerHour)} veh/h`}`;
    }).catch((error) => {
      if (request !== revision) return;
      status.textContent = `Corridor evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
      const retry = document.createElement("button"); retry.textContent = "Retry evidence";
      retry.onclick = () => render(selection.id);
      status.append(" ", retry);
    });
  }
  selection.subscribe(render);
  corridorHistory.subscribe(() => { if (!corridorHistory.refreshing && !root.hidden && !document.hidden) render(selection.id, false); });
  return { refresh: () => render(selection.id, false) };
}
