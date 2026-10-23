import { safeReading, parseImported } from "./imports";
import { mountWorkspaceChrome } from "../ui/workspace";
import { siteUrl } from "../ui/siteUrl";
import { buildOsmNetwork } from "../v03/osm";
import { applyOverrides, loadOverrides } from "../v03/overrides";
import { ScenarioRunner } from "./scenarioRunner";
import {
  aggregateTraffic, calibrationError, matchCorridor, sampleMean,
  type CorridorMatch, type ScenarioConfig, type ScenarioResult, type TrafficReading,
  type TrafficSample,
} from "../v03/scenario";
import type { SignalMode } from "../sim/world";
import type { Network } from "../sim/types";
import { corridorLabel, corridorReadings, freshness, historyGapLabel, MAX_OBSERVATION_GAP_MS, selectedCorridor } from "../v03/corridors";
import { readHandoff } from "./handoff";
import { packNetwork, unpackNetwork } from "./networkSnapshot";
import { MODEL_VERSION, REPORT_LIMIT_BYTES, sealReport, parseReport, saveReport, readSavedReports, deleteReport, type ScenarioReport } from "./reports";
import { drawCorridorMap } from "./corridorMap";
import { mean, metricChange, nearestObservation } from "./presentation";
import { DEFAULT_SETUP, SetupValidationError, defaultScenarioConfig as config, matchingPreset, sameScenarioPair,
  scenarioPair, setupFromPair, timingPresets, type LabSetup } from "./setup";

export function mountLab(root: HTMLElement) {
  mountWorkspaceChrome({ root, page: "lab", sections: [
    { id: "observations", label: "Traffic observations", icon: "shield" },
    { id: "scenario-setup", label: "Signal comparison", icon: "sliders" },
    { id: "results-panel", label: "Comparison results", icon: "target" },
    { id: "reports-panel", label: "Scenario reports", icon: "layers", breakBefore: true },
  ] });

  const el = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  const status = el<HTMLDivElement>("load-status");
  const sensorSelect = el<HTMLSelectElement>("sensor-select");
  const slider = el<HTMLInputElement>("replay-position");
  const chart = el<HTMLCanvasElement>("history-chart");
  const fitButton = el<HTMLButtonElement>("fit-demand");
  const runButton = el<HTMLButtonElement>("run-compare");
  const cancelButton = el<HTMLButtonElement>("cancel-run");
  const exportButton = el<HTMLButtonElement>("export-results");
  let readings: TrafficReading[] = [];
  let samples: TrafficSample[] = [];
  let network: Network;
  let origin: { lat: number; lon: number };
  let corridor: CorridorMatch | null = null;
  let replayTimer: number | undefined;
  let controller: AbortController | null = null;
  let activeTask: "comparison" | "fit" | null = null;
  let exportData: ScenarioReport | null = null;
  let networkReady = false;
  let sourceFailed = false;
  let importing = false;
  let eligibleReadings: TrafficReading[] = [];
  let lockedEdgeId: string | null = new URL(location.href).searchParams.get("corridor");
  let activeSeeds = [42, 99, 123];
  let modelCompatible = true;
  let restoredReport = false;
  let transferredNetwork = false;
  let savedReports: ReturnType<typeof readSavedReports> = [];
  let reportStorageIssue = false;
  const sourceLoadController = new AbortController();
  type ResultsState = "empty" | "running" | "complete" | "stale" | "error" | "cancelled";
  let resultsState: ResultsState = "empty";

  function setResultsState(state: ResultsState) {
    resultsState = state;
    const hasResults = exportData !== null;
    const missingSection = networkReady && !!lockedEdgeId && !corridor;
    el<HTMLElement>("results-panel").dataset.state = state;
    el<HTMLElement>("results-panel").setAttribute("aria-busy", String(state === "running"));
    el<HTMLElement>("results-empty").hidden = hasResults;
    el<HTMLElement>("results-content").hidden = !hasResults;
    el<HTMLProgressElement>("compare-progress").hidden = state !== "running";
    const badge = el<HTMLElement>("results-badge");
    badge.textContent = state === "complete" ? `${activeSeeds.length} paired runs` : state === "stale" ? "Settings changed" : state === "running" ? "Simulation running" : state === "error" ? "Check comparison" : state === "cancelled" ? "Run cancelled"
      : sourceFailed ? "Network unavailable" : !networkReady ? "Loading network" : missingSection ? "Section unavailable" : "Ready when you are";
    badge.dataset.tone = state === "complete" ? "positive" : state === "stale" ? "historical" : "neutral";
    el<HTMLElement>("workflow-result").dataset.state = state;
    el<HTMLElement>("results-empty-title").textContent = state === "running" ? "Testing both signal plans…" : state === "error" ? "Your comparison needs a quick check." : state === "cancelled" ? "Ready to try another plan."
      : sourceFailed ? "The study network could not be loaded." : !networkReady ? "Preparing your study area…" : missingSection ? "Choose an available road section." : "A clearer view of what changes.";
    el<HTMLElement>("results-empty-copy").textContent = state === "running" ? "The same traffic, the same seeds. You can keep exploring the observations while the model runs."
      : sourceFailed ? "Try loading again, return to the map, or open a saved report below to restore its network and results."
        : !networkReady ? "The road network and available observations will appear here. You can also open a saved report below."
          : missingSection ? "Open the map to select another section, or use all detector locations above."
            : "Configure your candidate, then compare trip times, queues and throughput across paired runs.";
    el<HTMLElement>("previous-results").hidden = !hasResults || state === "complete";
    el<HTMLElement>("previous-results-copy").textContent = state === "running" ? "Last completed comparison shown while the new plan runs."
      : state === "stale" ? "Settings have changed. These results show the last tested plan. Run again to update them."
        : state === "cancelled" ? "Run cancelled. Your last completed comparison is still shown."
          : "The new comparison did not complete. Your last tested results are still shown.";
    el<HTMLButtonElement>("restore-settings").hidden = !hasResults || currentSettingsMatch() || !modelCompatible;
  }

  function setReplayPlaying(playing: boolean) {
    const button = el<HTMLButtonElement>("replay-play");
    button.textContent = playing ? "Pause" : "Play";
    button.setAttribute("aria-pressed", String(playing));
    button.setAttribute("aria-label", `${playing ? "Pause" : "Play"} observation history`);
  }

  function invalidateComparison(preserveResults = false) {
    el<HTMLElement>("config-error").hidden = true;
    root.querySelectorAll(".config [aria-invalid]").forEach((field) => { field.removeAttribute("aria-invalid"); field.removeAttribute("aria-describedby"); });
    if (!preserveResults) {
      exportData = null;
      el<HTMLElement>("comparison-body").replaceChildren();
      el<HTMLElement>("observation-comparison").textContent = "";
    }
    const current = currentSettingsMatch();
    el<HTMLProgressElement>("compare-progress").value = 0;
    el<HTMLElement>("compare-status").textContent = current ? "Settings match the completed comparison. Results show the mean and run-to-run range."
      : exportData ? "Run a new comparison or restore the tested settings to save these results." : "Both plans use identical seeds. Results show the mean and run-to-run range.";
    el<HTMLElement>("report-status").textContent = reportStorageIssue ? "Saved reports could not be read. You can still export results or open a report JSON file."
      : current ? "The tested settings and results are ready to save or download." : "Run a comparison with the current settings to save a report.";
    setResultsState(exportData ? current ? "complete" : "stale" : "empty");
    updateAvailability();
  }

  function stopReplay() {
    window.clearInterval(replayTimer);
    replayTimer = undefined;
    setReplayPlaying(false);
  }

  function selectedReadings(): TrafficReading[] {
    return eligibleReadings.filter((row) => row.id === sensorSelect.value);
  }

  function showReplay() {
    const index = Math.max(0, Math.min(samples.length - 1, Number(slider.value) || 0));
    const current = samples[index];
    el<HTMLElement>("replay-time").textContent = current ? new Date(current.observedAt).toLocaleString() : "No observations";
    el<HTMLElement>("replay-speed").textContent = current?.speedKmh !== null && current?.speedKmh !== undefined ? `${current.speedKmh.toFixed(1)} km/h` : "—";
    el<HTMLElement>("replay-flow").textContent = current?.vehiclesPerHour !== null && current?.vehiclesPerHour !== undefined ? `${Math.round(current.vehiclesPerHour)} veh/h` : "—";
    el<HTMLElement>("replay-sensors").textContent = current ? String(current.sensors) : "—";
    el<HTMLElement>("replay-count").textContent = `${current ? index + 1 : 0} / ${samples.length}`;
    slider.setAttribute("aria-valuetext", current ? new Date(current.observedAt).toLocaleString() : "No observations");
    drawChart(index);
  }

  function drawChart(selected: number) {
    const ctx = chart.getContext("2d");
    if (!ctx) return;
    const width = Math.max(1, chart.clientWidth);
    const height = 220;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    chart.width = Math.round(width * ratio);
    chart.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const style = getComputedStyle(chart);
    const color = (name: string) => style.getPropertyValue(name).trim();
    ctx.font = `9px ${style.fontFamily}`;
    ctx.fillStyle = color("--text-dim");
    if (!samples.length) { ctx.fillText("No observations for this selection. Import history or choose another detector.", 16, 40, width - 32); return; }
    const firstTime = Date.parse(samples[0].observedAt);
    const span = Date.parse(samples.at(-1)!.observedAt) - firstTime;
    const xAt = (index: number) => 18 + (width - 36) * (span ? (Date.parse(samples[index].observedAt) - firstTime) / span : 0.5);
    ctx.strokeStyle = color("--line-bright"); ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(xAt(selected), 30); ctx.lineTo(xAt(selected), 188); ctx.stroke(); ctx.setLineDash([]);
    const series: Array<{ key: "speedKmh" | "vehiclesPerHour"; label: string; color: string; unit: string }> = [
      { key: "speedKmh", label: "Speed", color: color("--text"), unit: "km/h" },
      { key: "vehiclesPerHour", label: "Flow", color: color("--text-dim"), unit: "veh/h" },
    ];
    for (let panel = 0; panel < 2; panel++) {
      const { key, label, color, unit } = series[panel];
      const top = 7 + panel * 96;
      const values = samples.map((s) => s[key]);
      const max = Math.max(1, ...values.filter((v): v is number => v !== null)) * 1.1;
      ctx.fillStyle = style.getPropertyValue("--text-dim").trim();
      ctx.fillText(`${label} · ${unit}`, 18, top + 12);
      ctx.textAlign = "right";
      ctx.fillText(`${Math.round(max)}`, width - 18, top + 12);
      ctx.textAlign = "left";
      ctx.strokeStyle = style.getPropertyValue("--line-faint").trim();
      ctx.lineWidth = .7;
      for (const offset of [40, 82]) {
        ctx.beginPath(); ctx.moveTo(18, top + offset); ctx.lineTo(width - 18, top + offset); ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let drawing = false;
      values.forEach((value, i) => {
        if (i > 0 && Date.parse(samples[i].observedAt) - Date.parse(samples[i - 1].observedAt) > MAX_OBSERVATION_GAP_MS) drawing = false;
        if (value === null) { drawing = false; return; }
        const x = xAt(i);
        const y = top + 82 - value / max * 54;
        if (drawing) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        drawing = true;
      });
      ctx.stroke();
      // Show every measured point, including isolated readings on either side of a history gap.
      values.forEach((value, i) => {
        if (value === null) return;
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(xAt(i), top + 82 - value / max * 54, 2, 0, Math.PI * 2); ctx.fill();
      });
      if (values[selected] !== null) {
        const x = xAt(selected);
        const y = top + 82 - values[selected]! / max * 54;
        ctx.fillStyle = `${color}25`; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = color("--text-dim");
    const label = (time: string) => new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    ctx.fillText(label(samples[0].observedAt), 18, 210);
    if (samples.length > 1) {
      ctx.textAlign = "right";
      ctx.fillText(label(samples.at(-1)!.observedAt), width - 18, 210);
      ctx.textAlign = "left";
    }
  }
  new ResizeObserver(showReplay).observe(chart);
  const corridorMap = el<HTMLCanvasElement>("corridor-map");
  const redrawCorridorMap = () => drawCorridorMap(corridorMap, network, corridor?.edgeIds ?? []);
  new ResizeObserver(redrawCorridorMap).observe(corridorMap);

  function refreshSelection() {
    stopReplay();
    invalidateComparison();
    samples = aggregateTraffic(selectedReadings());
    slider.max = String(Math.max(0, samples.length - 1));
    slider.value = String(Math.max(0, samples.length - 1));
    showReplay();
    const first = selectedReadings()[0];
    const mappedSelection = lockedEdgeId ? selectedCorridor(network, lockedEdgeId) : null;
    const detected = first ? matchCorridor(network, first, origin) : null;
    corridor = lockedEdgeId ? mappedSelection && { ...mappedSelection, distanceM: detected?.distanceM ?? 0 } : detected;
    el<HTMLElement>("match-status").textContent = corridor
      ? first ? `Matched to this section ${corridor.distanceM.toFixed(0)} m from the selected detector. Detector direction is unknown; model speed covers the mapped directions for this section.`
        : "This section has no matched detector observations. You can compare model scenarios; fitting demand requires measured speed."
      : lockedEdgeId ? "The requested road section is missing from this network. Choose another section on the map or use all detector locations."
        : "No mapped road within 40 m of this detector. Calibration is unavailable.";
    el<HTMLElement>("sample-status").textContent = `${samples.length} distinct observation times. ${samples.length < 6 ? "Demand fit is provisional; no holdout validation yet." : "Chronological holdout validation is available."} ${samples.length ? `Latest: ${freshness(samples.at(-1)!.observedAt)}.` : ""} ${historyGapLabel(samples)}`;
    const latest = samples.at(-1)?.observedAt;
    const historyTag = el<HTMLElement>("history-freshness");
    const age = latest ? freshness(latest) : "";
    const recent = age.startsWith("Recent");
    historyTag.textContent = latest ? age.startsWith("Invalid") ? "Invalid observation time" : recent ? "Recent observations" : "Historical snapshot" : "No observations";
    historyTag.dataset.tone = latest ? recent ? "positive" : "historical" : "neutral";
    historyTag.title = latest ? age : "Choose another detector or import observation history.";
    el<HTMLButtonElement>("replay-play").disabled = samples.length < 2;
    slider.disabled = samples.length < 2;
    el<HTMLElement>("fit-result").textContent = "Fit uses speed only because detector direction is unavailable. Model results are indicative for this mapped corridor.";
    renderSelectionContext();
    updateAvailability();
  }

  function renderSelectionContext() {
    el<HTMLElement>("selection-context").hidden = !networkReady;
    const edgeId = lockedEdgeId ?? corridor?.edgeIds[0];
    const edge = edgeId ? network.edges.get(edgeId) : undefined;
    corridorMap.setAttribute("aria-label", corridor ? `Road network around ${edge?.name || "the selected section"}, with the study corridor highlighted` : "Road network overview; no study corridor selected");
    el<HTMLElement>("selection-title").textContent = edge ? edge.name || "Selected road section" : lockedEdgeId ? "Requested section unavailable" : "Rotterdam road network";
    el<HTMLElement>("selection-title").title = edge ? corridorLabel(edge) : "";
    el<HTMLElement>("selection-meta").textContent = edge ? `${Math.round(edge.length)} m section · ${edge.laneCount} ${edge.laneCount === 1 ? "lane" : "lanes"} · ${Math.round(edge.speedLimit * 3.6)} km/h limit`
      : `${network.edges.size} directed roads${lockedEdgeId ? " · Choose another section to continue" : " · Model comparison available"}`;
    el<HTMLElement>("selection-detail").textContent = restoredReport
      ? "Saved report network and observations. The map opens with its current road edits."
      : transferredNetwork ? "Exact network transferred from the map, including your road edits." : "Bundled road network with edits saved in this browser.";
    const url = siteUrl("v03/"); if (edgeId) url.searchParams.set("corridor", edgeId);
    el<HTMLAnchorElement>("selection-map").href = url.href;
    el<HTMLButtonElement>("clear-corridor").hidden = !lockedEdgeId;
    redrawCorridorMap();
  }

  function readSetup(): LabSetup {
    const number = (id: string) => {
      const value = el<HTMLInputElement>(id).value.trim();
      return value === "" ? NaN : Number(value);
    };
    return {
      demandPerHour: number("scenario-demand"),
      baselineMode: el<HTMLSelectElement>("baseline-mode").value as SignalMode,
      candidateMode: el<HTMLSelectElement>("candidate-mode").value as SignalMode,
      preference: number("candidate-preference"), minGreen: number("candidate-min-green"),
      maxGreen: number("candidate-max-green"), passageTime: number("candidate-passage"),
    };
  }

  function writeSetup(setup: Readonly<LabSetup>) {
    el<HTMLSelectElement>("baseline-mode").value = setup.baselineMode;
    el<HTMLSelectElement>("candidate-mode").value = setup.candidateMode;
    for (const [id, value] of [["scenario-demand", setup.demandPerHour], ["candidate-preference", setup.preference],
      ["candidate-min-green", setup.minGreen], ["candidate-max-green", setup.maxGreen], ["candidate-passage", setup.passageTime]] as const) {
      el<HTMLInputElement>(id).value = String(value);
    }
    updateCandidateFields();
  }

  function currentSettingsMatch(): boolean {
    if (!exportData) return false;
    try { return sameScenarioPair(scenarioPair(readSetup()), [exportData.baseline.config, exportData.candidate.config]); }
    catch { return false; }
  }

  function busy(value: boolean, task: "comparison" | "fit" = "comparison") {
    controller = value ? new AbortController() : null;
    activeTask = value ? task : null;
    updateAvailability();
  }

  function updateAvailability() {
    const value = importing || controller !== null;
    fitButton.disabled = value || !networkReady || !modelCompatible || !corridor || !samples.some((sample) => sample.speedKmh !== null);
    runButton.disabled = value || !networkReady || !modelCompatible || (!!lockedEdgeId && !corridor);
    cancelButton.disabled = controller === null;
    cancelButton.hidden = controller === null;
    runButton.firstChild!.textContent = activeTask === "comparison" ? "Running comparison… " : activeTask === "fit" ? "Fitting demand… " : "Run comparison ";
    el<HTMLProgressElement>("fit-progress").hidden = activeTask !== "fit";
    el<HTMLElement>("run-method").textContent = `${activeSeeds.length} seeds · 5 min each`;
    el<HTMLElement>("run-hint").textContent = !modelCompatible ? "This saved report uses a different model version. Its results are read only."
      : sourceFailed ? "The network could not be loaded. Try again above or open a saved report below."
        : !networkReady ? "Loading the study network. Saved reports can be opened below."
        : lockedEdgeId && !corridor ? "This section is unavailable. Choose another on the map or use all detector locations."
          : "Both plans use identical random seeds and a 60-second warm-up.";
    sensorSelect.disabled = value || !networkReady || !modelCompatible;
    el<HTMLButtonElement>("replay-play").disabled = samples.length < 2;
    slider.disabled = samples.length < 2;
    el<HTMLInputElement>("history-import").disabled = value || !networkReady || !modelCompatible;
    el<HTMLButtonElement>("clear-corridor").disabled = value || !modelCompatible;
    el<HTMLInputElement>("report-import").disabled = value;
    el<HTMLSelectElement>("saved-reports").disabled = value;
    const canKeepResults = !value && currentSettingsMatch();
    el<HTMLButtonElement>("save-report").disabled = !canKeepResults;
    exportButton.disabled = !canKeepResults;
    el<HTMLButtonElement>("review-report").disabled = !canKeepResults;
    el<HTMLButtonElement>("restore-settings").disabled = value || !modelCompatible;
    el<HTMLButtonElement>("reset-setup").disabled = value || !modelCompatible;
    el<HTMLButtonElement>("open-report").disabled = value || !el<HTMLSelectElement>("saved-reports").value;
    el<HTMLButtonElement>("delete-report").disabled = value || !el<HTMLSelectElement>("saved-reports").value;
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".config input, .config select").forEach((input) => { input.disabled = value || !modelCompatible; });
    updateCandidateFields();
    if (resultsState === "empty") setResultsState("empty");
  }

  async function fitDemand() {
    if (!corridor || controller || importing || !modelCompatible) return;
    busy(true, "fit");
    el<HTMLProgressElement>("fit-progress").value = 0;
    const abort = controller!.signal;
    const matchedCorridor = corridor;
    const result = el<HTMLElement>("fit-result");
    const progress = el<HTMLProgressElement>("fit-progress");
    const valid = samples.filter((sample) => sample.speedKmh !== null);
    const split = valid.length >= 6 ? Math.max(1, Math.floor(valid.length * 0.7)) : valid.length;
    const observed = { ...sampleMean(valid.slice(0, split)), vehiclesPerHour: null };
    const holdout = valid.slice(split);
    const demands = [300, 600, 900, 1200, 1500, 1800, 2400];
    let best: { demand: number; error: number; model: ScenarioResult } | null = null;
    const runner = new ScenarioRunner(network);
    try {
      for (let i = 0; i < demands.length; i++) {
        result.textContent = `Evaluating demand ${demands[i]} vehicles/hour (${i + 1}/${demands.length})…`;
        const model = await runner.run(config("fixed", demands[i]), 42, matchedCorridor,
          (fraction) => { progress.value = (i + fraction) / demands.length; }, abort);
        const error = calibrationError(model, observed);
        if (error !== null && (!best || error < best.error)) best = { demand: demands[i], error, model };
      }
      if (!best || best.model.corridorSpeedKmh === null) {
        result.textContent = "No model vehicles crossed the matched corridor; this sensor cannot calibrate demand here.";
        return;
      }
      const trainingGap = Math.abs(best.model.corridorSpeedKmh - observed.speedKmh!);
      if (trainingGap > 5) {
        result.textContent = `Calibration failed: the closest model speed is ${best.model.corridorSpeedKmh.toFixed(1)} km/h versus ${observed.speedKmh?.toFixed(1)} km/h measured (${trainingGap.toFixed(1)} km/h gap). Demand was not changed. Review road geometry, detector direction, and route mix before using this corridor to calibrate.`;
        return;
      }
      el<HTMLInputElement>("scenario-demand").value = String(best.demand);
      invalidateComparison(true);
      const holdoutMean = sampleMean(holdout).speedKmh;
      const holdoutText = holdoutMean === null ? "No independent holdout yet."
        : `Holdout speed error: ${Math.abs(best.model.corridorSpeedKmh - holdoutMean).toFixed(1)} km/h across ${holdout.length} later snapshots.`;
      result.textContent = `Best pilot demand: ${best.demand} vehicles/hour. Training speed ${observed.speedKmh?.toFixed(1)} km/h; model ${best.model.corridorSpeedKmh.toFixed(1)} km/h. ${holdoutText} One detector cannot establish a citywide demand estimate.`;
    } catch (error) {
      result.textContent = error instanceof DOMException && error.name === "AbortError" ? "Fit cancelled." : `Fit failed: ${String(error)}`;
    } finally { runner.dispose(); busy(false); }
  }

  function format(values: Array<number | null>, unit: string, digits = 1): string {
    const avg = mean(values);
    if (avg === null) return "—";
    const valid = values.filter((v): v is number => v !== null && Number.isFinite(v));
    const range = valid.length > 1 ? ` (${Math.min(...valid).toFixed(digits)}–${Math.max(...valid).toFixed(digits)})` : "";
    return `${avg.toFixed(digits)}${unit}${range}`;
  }

  function showComparison(baseline: ScenarioResult[], candidate: ScenarioResult[]) {
    setResultsState("complete");
    if (exportData) {
      const describe = (plan: ScenarioConfig) => plan.mode === "fixed"
        ? `fixed ${Math.round(plan.cycleMin + (plan.cycleMax - plan.cycleMin) * plan.preference)} s cycle`
        : `actuated ${plan.minGreen}–${plan.maxGreen} s greens`;
      el<HTMLElement>("tested-settings").textContent = `Tested at ${exportData.baseline.config.demandPerHour} veh/h · A: ${describe(exportData.baseline.config)} · B: ${describe(exportData.candidate.config)}`;
    }
    const highlights = el<HTMLElement>("result-highlights");
    highlights.replaceChildren();
    for (const item of [
      { name: "Trip time", key: "travelTimeSec", unit: " s", digits: 1, better: "lower" },
      { name: "Waiting time", key: "waitSec", unit: " s", digits: 1, better: "lower" },
      { name: "Throughput", key: "throughputPerHour", unit: " veh/h", digits: 0, better: "higher" },
    ] as const) {
      const a = mean(baseline.map((row) => row[item.key]));
      const b = mean(candidate.map((row) => row[item.key]));
      const delta = metricChange(a, b, item.digits, item.better);
      const card = document.createElement("div"); card.className = "result-highlight";
      const title = document.createElement("span"); title.textContent = item.name;
      const change = document.createElement("strong");
      change.textContent = delta.text === "—" ? "—" : `${delta.text}${item.unit}`;
      change.className = `result-${delta.tone}`;
      const detail = document.createElement("small");
      detail.textContent = b === null || a === null ? "No completed measurement" : `${b.toFixed(item.digits)}${item.unit} candidate · ${a.toFixed(item.digits)} baseline`;
      card.append(title, change, detail); highlights.append(card);
    }
    const measured = sampleMean(samples).speedKmh;
    const gap = (runs: ScenarioResult[]) => {
      const model = mean(runs.map((run) => run.corridorSpeedKmh));
      return model === null || measured === null ? "unavailable" : `${Math.abs(model - measured).toFixed(1)} km/h`;
    };
    el<HTMLElement>("observation-comparison").textContent = measured === null
      ? "No measured speed for this section and detector. These results have no observed speed comparison."
      : `Observed mean speed: ${measured.toFixed(1)} km/h. Absolute model speed gap: baseline ${gap(baseline)}; candidate ${gap(candidate)}. Detector direction is unknown; this comparison does not establish calibration.`;
    const rows: Array<{ name: string; key: keyof ScenarioResult; unit: string; digits?: number; better?: "higher" | "lower" }> = [
      { name: "Completed trips per hour", key: "throughputPerHour", unit: " veh/h", digits: 0, better: "higher" },
      { name: "Mean trip time", key: "travelTimeSec", unit: " s", better: "lower" },
      { name: "Mean wait per trip", key: "waitSec", unit: " s", better: "lower" },
      { name: "Demand admitted", key: "demandMet", unit: "%", better: "higher" },
      { name: "Mean stopped queue", key: "avgQueue", unit: " vehicles", better: "lower" },
      { name: "Mapped corridor speed", key: "corridorSpeedKmh", unit: " km/h" },
      { name: "Mapped corridor flow", key: "corridorFlowPerHour", unit: " veh/h", digits: 0 },
    ];
    const body = el<HTMLTableSectionElement>("comparison-body");
    body.replaceChildren();
    for (const row of rows) {
      const get = (result: ScenarioResult) => row.key === "demandMet" ? result.demandMet * 100 : result[row.key];
      const a = baseline.map(get);
      const b = candidate.map(get);
      const delta = metricChange(mean(a), mean(b), row.digits ?? 1, row.better);
      const tr = document.createElement("tr");
      const unit = row.key === "demandMet" ? " pp" : row.unit;
      for (const value of [row.name, format(a, row.unit, row.digits ?? 1), format(b, row.unit, row.digits ?? 1),
        delta.text === "—" ? "—" : `${delta.text}${unit}`]) {
        const td = document.createElement("td"); td.textContent = value; tr.append(td);
      }
      tr.lastElementChild!.className = `result-${delta.tone}`;
      body.append(tr);
    }
  }

  async function compare() {
    if (controller || importing || !networkReady || !modelCompatible || (lockedEdgeId && !corridor)) return;
    let pair: [ScenarioConfig, ScenarioConfig];
    try { pair = scenarioPair(readSetup()); }
    catch (error) {
      setResultsState("error");
      const message = error instanceof Error ? error.message : String(error);
      el<HTMLElement>("compare-status").textContent = message;
      el<HTMLElement>("config-error").textContent = message;
      el<HTMLElement>("config-error").hidden = false;
      if (error instanceof SetupValidationError) {
        const input = el<HTMLInputElement>(error.fieldId);
        input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", "config-error");
        const details = input.closest("details"); if (details) details.open = true;
        input.focus();
      }
      return;
    }
    invalidateComparison(true);
    busy(true);
    setResultsState("running");
    const abort = controller!.signal;
    const matchedCorridor = corridor;
    const detectorId = sensorSelect.value;
    const progress = el<HTMLProgressElement>("compare-progress");
    const message = el<HTMLElement>("compare-status");
    const seeds = [...activeSeeds];
    const baseline: ScenarioResult[] = [];
    const candidate: ScenarioResult[] = [];
    const runner = new ScenarioRunner(network);
    exportButton.disabled = true;
    try {
      for (let i = 0; i < seeds.length; i++) {
        message.textContent = `Running paired seed ${i + 1} of ${seeds.length}…`;
        el<HTMLElement>("run-method").textContent = `Seed ${i + 1} of ${seeds.length}`;
        baseline.push(await runner.run(pair[0], seeds[i], matchedCorridor,
          (fraction) => { progress.value = (i * 2 + fraction) / (seeds.length * 2); }, abort));
        candidate.push(await runner.run(pair[1], seeds[i], matchedCorridor,
          (fraction) => { progress.value = (i * 2 + 1 + fraction) / (seeds.length * 2); }, abort));
      }
      const report = await sealReport({ name: el<HTMLInputElement>("report-name").value.trim() || "Untitled scenario",
        network: packNetwork(network), origin, corridorEdgeId: matchedCorridor?.edgeIds[0] ?? null,
        observedDetector: detectorId || null, observations: selectedReadings(),
        warmupSeconds: 60, measurementSeconds: 300, seeds, baseline: { config: pair[0], runs: baseline },
        candidate: { config: pair[1], runs: candidate } });
      if (abort.aborted) throw new DOMException("Comparison cancelled", "AbortError");
      exportData = report;
      showComparison(baseline, candidate);
      exportButton.disabled = false;
      message.textContent = `Comparison complete · ${seeds.length} paired runs. Changes are model outputs; run-to-run ranges are not confidence intervals.`;
      el<HTMLElement>("report-status").textContent = `Ready to save · model ${MODEL_VERSION} · network ${exportData.networkHash.slice(0, 12)} · observations ${exportData.observationsHash.slice(0, 12)}.`;
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      setResultsState(cancelled ? "cancelled" : "error");
      message.textContent = cancelled ? "Comparison cancelled. Adjust your settings or run again." : `Comparison failed: ${String(error)}`;
    } finally { runner.dispose(); busy(false); }
  }

  slider.addEventListener("input", () => { stopReplay(); showReplay(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopReplay(); });
  function scrubChart(clientX: number) {
    const bounds = chart.getBoundingClientRect();
    const index = nearestObservation(samples, (clientX - bounds.left - 18) / Math.max(1, bounds.width - 36));
    if (index < 0) return;
    stopReplay();
    if (Number(slider.value) !== index) { slider.value = String(index); showReplay(); }
  }
  let scrubPointer: number | null = null;
  let scrubFrame = 0;
  let scrubX = 0;
  chart.addEventListener("click", (event) => scrubChart(event.clientX));
  chart.addEventListener("pointerdown", (event) => {
    // Touch keeps native vertical scrolling; a tap still selects an observation.
    if (event.button !== 0 || !event.isPrimary || event.pointerType === "touch") return;
    scrubPointer = event.pointerId; chart.setPointerCapture(event.pointerId); scrubChart(event.clientX);
  });
  chart.addEventListener("pointermove", (event) => {
    if (event.pointerId !== scrubPointer) return;
    scrubX = event.clientX;
    if (!scrubFrame) scrubFrame = requestAnimationFrame(() => { scrubFrame = 0; scrubChart(scrubX); });
  });
  const endScrub = () => {
    if (scrubFrame) { cancelAnimationFrame(scrubFrame); scrubFrame = 0; }
    scrubPointer = null;
  };
  chart.addEventListener("lostpointercapture", endScrub);
  chart.addEventListener("pointercancel", endScrub);
  chart.addEventListener("pointerup", (event) => { if (event.pointerId === scrubPointer) { scrubChart(event.clientX); endScrub(); } });
  sensorSelect.addEventListener("change", refreshSelection);
  el<HTMLButtonElement>("replay-play").addEventListener("click", () => {
    if (replayTimer) { stopReplay(); return; }
    if (samples.length < 2) return;
    setReplayPlaying(true);
    replayTimer = window.setInterval(() => {
      slider.value = String((Number(slider.value) + 1) % samples.length);
      showReplay();
    }, 700);
  });
  el<HTMLInputElement>("history-import").addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || importing || controller || !networkReady) return;
    importing = true;
    updateAvailability();
    try {
      if (file.size > 1_000_000) throw new Error("File exceeds 1 MB.");
      readings = parseImported(await file.text(), file.name);
      populateSensors();
      status.textContent = `Imported ${readings.length} observations for this browser session.`;
      status.dataset.state = "ready";
    } catch (error) { status.textContent = `Import failed: ${String(error)}`; status.dataset.state = "error"; }
    finally {
      el<HTMLInputElement>("history-import").value = "";
      importing = false;
      updateAvailability();
    }
  });
  fitButton.addEventListener("click", () => { void fitDemand(); });
  runButton.addEventListener("click", () => { void compare(); });
  cancelButton.addEventListener("click", () => controller?.abort());
  exportButton.addEventListener("click", () => {
    if (!exportData || controller || importing || !currentSettingsMatch()) return;
    const name = el<HTMLInputElement>("report-name").value.trim().slice(0, 80) || exportData.name;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...exportData, name })], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "rotterdam-scenario-comparison.json"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  el<HTMLButtonElement>("clear-corridor").addEventListener("click", () => {
    lockedEdgeId = null;
    const url = new URL(location.href); url.searchParams.delete("corridor"); url.searchParams.delete("handoff"); history.replaceState(null, "", url);
    populateSensors();
  });

  function refreshSavedReports() {
    const select = el<HTMLSelectElement>("saved-reports");
    const selectedName = select.value;
    try {
      savedReports = readSavedReports();
      reportStorageIssue = false;
      select.replaceChildren();
      const placeholder = document.createElement("option"); placeholder.value = "";
      placeholder.textContent = savedReports.length ? "Choose a saved report…" : "No saved reports"; select.append(placeholder);
      for (const row of savedReports) {
        const option = document.createElement("option"); option.value = row.name;
        option.textContent = `${row.name} · ${new Date(row.createdAt).toLocaleString()}`; select.append(option);
      }
      if (savedReports.some((row) => row.name === selectedName)) select.value = selectedName;
    } catch {
      savedReports = [];
      reportStorageIssue = true;
      el<HTMLElement>("report-status").textContent = "Saved reports could not be read. You can still export results or open a report JSON file.";
    }
    el<HTMLElement>("saved-count").textContent = `${savedReports.length} / 3 saved`;
    updateAvailability();
  }

  function restoreReport(report: ScenarioReport) {
    const restored = unpackNetwork(report.network);
    network = restored;
    origin = report.origin;
    readings = report.observations;
    lockedEdgeId = report.corridorEdgeId;
    activeSeeds = [...report.seeds];
    restoredReport = true;
    networkReady = true;
    sourceFailed = false;
    sourceLoadController.abort();
    modelCompatible = report.modelVersion === MODEL_VERSION;
    el<HTMLInputElement>("report-name").value = report.name;
    writeSetup(setupFromPair(report.baseline.config, report.candidate.config));
    populateSensors();
    if (report.observedDetector) { sensorSelect.value = report.observedDetector; refreshSelection(); }
    exportData = report;
    showComparison(report.baseline.runs, report.candidate.runs);
    el<HTMLElement>("run-method").textContent = `${activeSeeds.length} seeds · 5 min each`;
    exportButton.disabled = false;
    el<HTMLProgressElement>("compare-progress").value = 1;
    el<HTMLElement>("compare-status").textContent = modelCompatible ? "Saved results restored. Run the paired comparison again to reproduce these results."
      : `Saved results use model ${report.modelVersion}. This app uses ${MODEL_VERSION}; rerunning is disabled to preserve the original model version.`;
    status.textContent = `Report opened: ${report.name} · ${network.edges.size} directed roads · ${readings.length} embedded observations.`;
    status.dataset.state = "ready";
    el<HTMLElement>("report-status").textContent = `Network ${report.networkHash.slice(0, 12)} and observation ${report.observationsHash.slice(0, 12)} fingerprints verified. ${modelCompatible ? "Inputs restored." : "Results are read only in this model version."}`;
    const url = new URL(location.href);
    url.searchParams.delete("handoff");
    if (lockedEdgeId) url.searchParams.set("corridor", lockedEdgeId); else url.searchParams.delete("corridor");
    history.replaceState(null, "", url);
  }

  async function openReport(raw: string | Promise<string>) {
    if (controller || importing) return;
    importing = true; updateAvailability();
    try { restoreReport(await parseReport(await raw)); }
    catch (error) { el<HTMLElement>("report-status").textContent = `Could not open report: ${error instanceof Error ? error.message : String(error)}`; }
    finally { importing = false; updateAvailability(); }
  }
  el<HTMLButtonElement>("save-report").addEventListener("click", () => {
    if (!exportData || controller || importing || !currentSettingsMatch()) return;
    const name = el<HTMLInputElement>("report-name").value.trim();
    if (!name) { el<HTMLElement>("report-status").textContent = "Enter a report name before saving."; el<HTMLInputElement>("report-name").focus(); return; }
    try {
      const report = { ...exportData, name: name.slice(0, 80) };
      saveReport(report);
      exportData = report;
      refreshSavedReports();
      el<HTMLSelectElement>("saved-reports").value = report.name;
      el<HTMLElement>("report-status").textContent = `Saved “${report.name}” in this browser. Saving the same name replaces that report. Download JSON for a portable copy.`;
      updateAvailability();
    } catch (error) { el<HTMLElement>("report-status").textContent = `Could not save report: ${error instanceof Error ? error.message : String(error)}. Export JSON to keep a copy.`; }
  });
  el<HTMLSelectElement>("saved-reports").addEventListener("change", updateAvailability);
  el<HTMLButtonElement>("open-report").addEventListener("click", () => {
    const row = savedReports.find((report) => report.name === el<HTMLSelectElement>("saved-reports").value);
    if (row) void openReport(row.raw);
  });
  el<HTMLButtonElement>("delete-report").addEventListener("click", () => {
    const name = el<HTMLSelectElement>("saved-reports").value;
    if (!name || controller || importing) return;
    try { deleteReport(name); refreshSavedReports(); el<HTMLElement>("report-status").textContent = `Deleted saved report “${name}”.`; }
    catch { el<HTMLElement>("report-status").textContent = "Could not delete the saved report. Browser storage is unavailable."; }
  });
  el<HTMLButtonElement>("review-report").addEventListener("click", () => {
    el<HTMLDetailsElement>("reports-panel").open = true;
    el<HTMLInputElement>("report-name").focus();
  });
  el<HTMLInputElement>("report-import").addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || controller || importing) return;
    try {
      if (file.size > REPORT_LIMIT_BYTES) throw new Error("Report exceeds 2 MB.");
      await openReport(file.text());
    } catch (error) { el<HTMLElement>("report-status").textContent = `Could not open report: ${error instanceof Error ? error.message : String(error)}`; }
    finally { input.value = ""; }
  });

  function populateSensors() {
    sensorSelect.replaceChildren();
    const selection = lockedEdgeId ? selectedCorridor(network, lockedEdgeId) : null;
    eligibleReadings = lockedEdgeId ? selection ? corridorReadings(network, readings, origin, selection) : [] : readings;
    const unique = new Map(eligibleReadings.map((row) => [row.id, row]));
    if (!unique.size) {
      const option = document.createElement("option"); option.value = ""; option.textContent = "No matched detector observations"; sensorSelect.append(option);
    }
    for (const row of unique.values()) {
      const option = document.createElement("option"); option.value = row.id; option.textContent = `${row.name} · ${row.id}`; sensorSelect.append(option);
    }
    refreshSelection();
  }

  function updateCandidateFields() {
    const setup = readSetup();
    const fixed = setup.candidateMode === "fixed";
    const disabled = importing || controller !== null || !modelCompatible;
    el<HTMLInputElement>("candidate-preference").disabled = disabled || !fixed;
    for (const id of ["candidate-min-green", "candidate-max-green", "candidate-passage"]) el<HTMLInputElement>(id).disabled = disabled || fixed;
    el<HTMLElement>("preference-field").hidden = !fixed;
    el<HTMLElement>("actuated-fields").hidden = fixed;
    el<HTMLElement>("baseline-description").textContent = el<HTMLSelectElement>("baseline-mode").value === "fixed" ? "Signals follow a regular cycle." : "Green time responds to traffic.";
    el<HTMLElement>("candidate-description").textContent = fixed ? "Signals follow a regular cycle." : "Green time responds to traffic.";
    const preset = el<HTMLSelectElement>("candidate-preset");
    if (preset.dataset.mode !== setup.candidateMode) {
      preset.replaceChildren();
      for (const item of timingPresets(setup.candidateMode)) {
        const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; preset.append(option);
      }
      const custom = document.createElement("option"); custom.value = "custom"; custom.textContent = "Custom timing"; custom.disabled = true; preset.append(custom);
      preset.dataset.mode = setup.candidateMode;
    }
    preset.value = matchingPreset(setup);
  }
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".config input, .config select").forEach((input) => {
    if (input.id === "candidate-preset") return;
    input.addEventListener("input", () => {
      invalidateComparison(true);
    });
  });
  el<HTMLSelectElement>("candidate-preset").addEventListener("change", () => {
    if (controller || importing || !modelCompatible) return;
    const setup = readSetup();
    const preset = timingPresets(setup.candidateMode).find((item) => item.id === el<HTMLSelectElement>("candidate-preset").value);
    if (!preset) return;
    writeSetup({ ...setup, ...preset });
    invalidateComparison(true);
  });
  el<HTMLButtonElement>("reset-setup").addEventListener("click", () => {
    if (controller || importing || !modelCompatible) return;
    writeSetup(DEFAULT_SETUP); invalidateComparison(true);
  });
  el<HTMLButtonElement>("restore-settings").addEventListener("click", () => {
    if (!exportData || controller || importing || !modelCompatible) return;
    writeSetup(setupFromPair(exportData.baseline.config, exportData.candidate.config));
    invalidateComparison(true);
    runButton.focus();
  });
  updateCandidateFields();

  async function boot() {
    try {
      const handoffToken = new URL(location.href).searchParams.get("handoff");
      const handoff = handoffToken ? readHandoff(handoffToken, lockedEdgeId ?? "") : null;
      transferredNetwork = handoff !== null;
      const [summary, history] = await Promise.all([
        handoff ? Promise.resolve(handoff) : fetch(siteUrl("map.osm"), { signal: AbortSignal.any([sourceLoadController.signal, AbortSignal.timeout(15_000)]) }).then(async (response) => {
          if (!response.ok) throw new Error(`Map: HTTP ${response.status}`);
          const xml = await response.text();
          if (restoredReport) return null;
          const summary = buildOsmNetwork(xml);
          applyOverrides(summary.network, loadOverrides());
          return summary;
        }),
        handoff ? Promise.resolve(null) : fetch(siteUrl("data/traffic-history.json"), { signal: AbortSignal.any([sourceLoadController.signal, AbortSignal.timeout(10_000)]) })
          .then(async (response) => response.ok ? await response.json() as unknown : null)
          .catch(() => null),
      ]);
      if (restoredReport || !summary) return;
      network = summary.network;
      origin = summary.origin;
      if (history) {
        const rows = history && typeof history === "object" ? (history as { readings?: unknown }).readings : null;
        readings = Array.isArray(rows) ? rows.slice(0, 3000).map(safeReading).filter((row): row is TrafficReading => row !== null) : [];
      }
      if (handoff) {
        const merged = new Map([...readings, ...handoff.readings].map((row) => [`${row.id}|${row.observedAt}`, row]));
        readings = [...merged.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).slice(-3000);
      }
      networkReady = true;
      sourceFailed = false;
      el<HTMLInputElement>("history-import").disabled = false;
      populateSensors();
      status.textContent = `Map ready · ${network.edges.size} directed roads · ${readings.length} measured detector records. ${readings.length ? "" : "Import a CSV or JSON history to replay observations."}`;
      status.dataset.state = "ready";
      updateAvailability();
    } catch (error) {
      if (restoredReport) return;
      sourceFailed = true;
      status.textContent = `Could not load scenario lab: ${String(error)}`;
      status.dataset.state = "error";
      const retry = document.createElement("button");
      retry.textContent = "Try again";
      retry.addEventListener("click", () => { status.textContent = "Loading study network…"; void boot(); });
      status.append(" ", retry);
      const map = document.createElement("a"); map.href = siteUrl("v03/").href; map.textContent = "Return to map"; status.append(" ", map);
      updateAvailability();
    }
  }

  refreshSavedReports();
  void boot();

  return { setActive(active: boolean) {
    if (!active) stopReplay();
    else { showReplay(); redrawCorridorMap(); refreshSavedReports(); }
  } };
}
