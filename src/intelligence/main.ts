import "./style.css";
import { LiveFeed, type LiveSnapshot } from "../data/live";
import type { ExperimentResultMsg } from "../sim/protocol";
import { qualityRows, heldoutStations, validateHoldout } from "./model";
import { calculateHospitalAccess, HOSPITALS, type AccessRow } from "./routing";

const dataBase = new URL("../data/", window.location.href).href;
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const format = (value: number | null | undefined, suffix = "") => value === null || value === undefined ? "—" : `${value.toLocaleString("en-GB")}${suffix}`;
const when = (value: string | null | undefined) => {
  if (!value) return "Not available";
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" }) : value;
};
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

interface Meta { districts: { name: string; x: number; y: number }[] }
interface Exposure { retrievedAt: string; source: string; method: string; exposedEdges: number[]; erasmusBridgeEdges: number[]; districts: { name: string; roadKm: number; floodModelRoadKm: number; exposurePct: number | null; sampledEdges: number }[] }
interface Cbs { retrievedAt: string | null; source: string; caveat: string; neighborhoods: { code: string; name: string; residents: number; age65Plus: number | null; households: number | null; lowIncomeHouseholdsPct: number | null }[] }
interface Ndw { stations: { edge: number; flow: number }[] }
const load = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${dataBase}${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
};
let latest: LiveSnapshot | null = null;
let meta: Meta | null = null;
let exposure: Exposure | null = null;
let cbs: Cbs | null = null;
let ndw: Ndw | null = null;
let lastTrial: { runAt: string; seed: number; clockMin: number; observedAt: string | null; results: ExperimentResultMsg[] } | null = null;
const feed = new LiveFeed(dataBase, (snapshot) => { latest = snapshot; renderSources(); renderConditions(); renderBridgeOptions(); });

function renderSources() {
  const status = $("#snapshot-status");
  status.textContent = latest ? `Snapshot ${when(latest.t)} · delivery: ${feed.source === "service" ? "observation service" : feed.source === "branch" ? "GitHub live mirror" : "packaged fallback"}` : "No observation snapshot yet";
  const cards = $("#source-cards");
  cards.replaceChildren();
  for (const row of qualityRows(latest)) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `<h3>${escape(row.label)} <span class="pill ${row.status}">${row.status.toUpperCase()}</span></h3><dl><dt>Publisher</dt><dd>${escape(row.source)}</dd><dt>Observed</dt><dd>${escape(when(row.observedAt))}</dd><dt>Age</dt><dd>${row.ageMin === null ? "Unknown" : `${row.ageMin} min`}</dd><dt>Coverage</dt><dd>${format(row.count)} ${row.count === 1 ? "reading" : "readings"}</dd><dt>Reuse</dt><dd>${escape(row.licence)}</dd></dl><p>Uncertainty not quantified. ${escape(row.caveat)}</p>`;
    cards.append(card);
  }
}
function renderConditions() {
  const box = $("#conditions");
  const rows = qualityRows(latest);
  const recent = (id: string) => {
    const row = rows.find((item) => item.id === id);
    return row && (row.status === "current" || row.status === "late") ? ` · ${row.ageMin} min old` : null;
  };
  const conditions = [
    ["Reported open bridges", recent("bridges") ? `${latest?.bridges?.length ?? 0}${recent("bridges")}` : "No recent report"],
    ["Observed rain", recent("weather") && latest?.weather ? `${format(latest.weather.rain)} mm/h${recent("weather")}` : "No recent reading"],
    ["Boompjes river gauge", recent("water") && latest?.water ? `${format(latest.water.cm)} cm${recent("water")}` : "No recent reading"],
    ["Transit vehicle fixes", recent("transit") && latest?.vehicles ? `${latest.vehicles.v.length}${recent("transit")}` : "No recent fixes"],
  ];
  box.replaceChildren(...conditions.map(([label, value]) => {
    const item = document.createElement("div"); item.className = "condition";
    item.innerHTML = `<span>${escape(label)}</span><strong>${escape(value)}</strong>`;
    return item;
  }));
}
function renderBridgeOptions() {
  const select = $("#bridge-select") as HTMLSelectElement;
  const previous = select.value;
  select.replaceChildren(new Option("Erasmusbrug — hypothetical", "erasmus"));
  for (const [index, bridge] of (feed.fresh ? latest?.bridges ?? [] : []).entries()) select.add(new Option(`${bridge.name} — currently reported open`, `live:${index}`));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function table(headers: { text: string; numeric?: boolean }[], rows: (string | number | null)[][]): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "table-scroll";
  const table = document.createElement("table");
  const thead = table.createTHead(), tr = thead.insertRow();
  for (const heading of headers) {
    const th = document.createElement("th"); th.scope = "col"; th.textContent = heading.text;
    if (heading.numeric) th.className = "num"; tr.append(th);
  }
  const tbody = table.createTBody();
  for (const values of rows) {
    const row = tbody.insertRow();
    values.forEach((value, i) => {
      const cell = row.insertCell(); cell.textContent = value === null ? "—" : String(value);
      if (headers[i].numeric) cell.className = "num";
    });
  }
  wrap.append(table); return wrap;
}
function renderCbs() {
  const status = $("#cbs-status");
  const results = $("#neighborhood-results");
  if (!cbs || !cbs.neighborhoods.length) {
    status.textContent = "The CBS import is unavailable in this build. No neighborhood figures are inferred or substituted.";
    results.replaceChildren(); return;
  }
  const query = ($("#neighborhood-search") as HTMLInputElement).value.trim().toLocaleLowerCase();
  const rows = cbs.neighborhoods.filter((row) => `${row.name} ${row.code}`.toLocaleLowerCase().includes(query));
  const viaBuurtzicht = cbs.source.startsWith("https://buurtzicht.nl/");
  status.textContent = `${rows.length} of ${cbs.neighborhoods.length} Rotterdam neighborhoods · CBS KWB 2025${viaBuurtzicht ? " via BuurtZicht" : ""} · retrieved ${when(cbs.retrievedAt)}`;
  const hasIncome = cbs.neighborhoods.some((row) => row.lowIncomeHouseholdsPct != null);
  results.replaceChildren(table([
    { text: "Neighborhood" }, { text: "CBS code" }, { text: "Residents", numeric: true },
    { text: "Age 65+", numeric: true }, { text: "Households", numeric: true },
    ...(hasIncome ? [{ text: "Lower-income households", numeric: true }] : []),
  ], rows.map((row) => [row.name, row.code, format(row.residents), format(row.age65Plus), format(row.households), ...(hasIncome ? [format(row.lowIncomeHouseholdsPct, "%")] : [])])));
}
function renderExposure() {
  if (!exposure) return;
  $("#exposure-results").replaceChildren(table([
    { text: "Simulation district" }, { text: "Road sample", numeric: true },
    { text: "Modelled exposure", numeric: true }, { text: "Share", numeric: true },
  ], exposure.districts.map((row) => [row.name, `${format(row.roadKm)} km`, `${format(row.floodModelRoadKm)} km`, format(row.exposurePct, "%")])));
}

async function scenario(event: Event) {
  event.preventDefault();
  const status = $("#scenario-status");
  if (!meta || !exposure) { status.textContent = "Road and model data are unavailable."; return; }
  status.textContent = "Calculating road access on the city graph…";
  const button = $("#scenario-form button") as HTMLButtonElement; button.disabled = true;
  try {
    const rain = Number(($("#rain-input") as HTMLInputElement).value);
    const flood = ($("#flood-input") as HTMLInputElement).checked;
    const bridgeValue = ($("#bridge-select") as HTMLSelectElement).value;
    const bridge = bridgeValue.startsWith("live:") ? latest?.bridges?.[Number(bridgeValue.slice(5))] : null;
    const graph = await fetch(`${dataBase}graph.bin`).then((response) => { if (!response.ok) throw new Error("Road graph unavailable"); return response.arrayBuffer(); });
    const closed = new Set<number>(flood ? exposure.exposedEdges : []);
    if (bridge) bridge.edges.forEach((edge) => closed.add(edge));
    else exposure.erasmusBridgeEdges.forEach((edge) => closed.add(edge));
    const wetSpeedFactor = 1 - Math.min(0.30, rain * 0.012);
    const access = calculateHospitalAccess(graph, meta.districts, closed, wetSpeedFactor);
    renderScenarioResult(access, { bridge: bridge?.name ?? "Erasmusbrug", rain, flood, closed: closed.size, wetSpeedFactor });
    status.textContent = `Calculated ${access.length} district-to-hospital estimates. Model assumptions and limits are shown below.`;
  } catch (error) { status.textContent = `Scenario could not run: ${error instanceof Error ? error.message : "unknown error"}`; }
  finally { button.disabled = false; }
}
function renderScenarioResult(rows: AccessRow[], assumptions: { bridge: string; rain: number; flood: boolean; closed: number; wetSpeedFactor: number }) {
  const container = $("#scenario-results");
  const summary = document.createElement("p");
  summary.className = "minor";
  summary.textContent = `${assumptions.bridge} closed; ${assumptions.rain} mm/h rain stress; wet-road speed factor ${assumptions.wetSpeedFactor.toFixed(2)}; ${assumptions.closed.toLocaleString()} road segments blocked${assumptions.flood ? " including sampled modelled water exposure" : ""}. Free-flow car routing to the nearest of ${HOSPITALS.length} sample hospitals; no congestion, ambulance priority, hospital capacity, transit delay or flood-depth forecast. A disconnected result means this graph scenario has no car route.`;
  const transit = document.createElement("p"); transit.className = "minor";
  const selected = (latest?.bridges ?? []).find((bridge) => bridge.name === assumptions.bridge);
  const [bx, by] = selected ? [selected.x, selected.y] : [446, -1254];
  const transitQuality = qualityRows(latest).find((row) => row.id === "transit");
  const recentTransit = transitQuality?.status === "current" || transitQuality?.status === "late";
  const nearby = recentTransit ? (latest?.vehicles?.v ?? []).filter(([x, y]) => (x - bx) ** 2 + (y - by) ** 2 < 1500 ** 2) : [];
  transit.textContent = recentTransit && latest?.vehicles
    ? `${nearby.length} observed transit vehicles were within 1.5 km of the selected bridge at the ${transitQuality?.ageMin}-minute-old fix. This is exposure context; delays and route changes are not forecast.`
    : "Current transit fixes are unavailable; no transit exposure count is shown.";
  container.replaceChildren(summary, transit, table([
    { text: "District" }, { text: "Baseline", numeric: true }, { text: "Stress test", numeric: true }, { text: "Change", numeric: true },
  ], rows.map((row) => [row.district, format(row.baseMin, " min"), format(row.stressMin, " min"), format(row.changeMin, " min")])));
}

async function runArm(program: ExperimentResultMsg["program"], seed: number, stations: { edge: number; flow: number }[], clockMin: number): Promise<ExperimentResultMsg> {
  const graph = await fetch(`${dataBase}graph.bin`).then((response) => { if (!response.ok) throw new Error("Road graph unavailable"); return response.arrayBuffer(); });
  const worker = new Worker(new URL("../sim/worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { worker.terminate(); reject(new Error(`${program} run exceeded three minutes`)); }, 180_000);
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === "experimentProgress") $("#trial-status").textContent = `${program}: ${message.stage} ${Math.round(100 * message.doneSec / message.totalSec)}%`;
      if (message?.type === "experimentResult") { clearTimeout(timeout); worker.terminate(); resolve(message as ExperimentResultMsg); }
    };
    worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message || "Simulation worker failed")); };
    worker.postMessage({ type: "init", graphBuffer: graph, districtCount: meta!.districts.length,
      districts: meta!.districts, experiment: { seed, program, clockMin, density: 1200, warmupSec: 45, measureSec: 120, stations } }, [graph]);
  });
}
async function trial() {
  const button = $("#trial-run") as HTMLButtonElement;
  const status = $("#trial-status");
  if (!meta) { status.textContent = "Road metadata unavailable."; return; }
  const seed = Number(($("#trial-seed") as HTMLInputElement).value);
  if (!Number.isInteger(seed) || seed < 1 || seed > 2147483647) { status.textContent = "Enter a random seed between 1 and 2,147,483,647."; return; }
  button.disabled = true; ($("#trial-export") as HTMLButtonElement).disabled = true;
  const clockMin = latest?.traffic?.todMin ?? 8 * 60 + 12;
  const freshTraffic = latest?.traffic && Date.now() - Date.parse(latest.traffic.t) < 20 * 60_000 ? latest.traffic : null;
  const stations = freshTraffic && ndw ? heldoutStations(freshTraffic.s.map(([index, flow]) => ({ edge: ndw!.stations[index]?.edge ?? -1, flow }))) : [];
  try {
    const results: ExperimentResultMsg[] = [];
    for (const program of ["actuated", "coordinated", "fixed"] as const) {
      status.textContent = `Preparing ${program} run…`;
      results.push(await runArm(program, seed, stations, clockMin));
    }
    lastTrial = { runAt: new Date().toISOString(), seed, clockMin, observedAt: freshTraffic?.t ?? null, results };
    const tableRows = results.map((result) => {
      const check = validateHoldout(result);
      return [result.program, format(result.metrics.throughputMin, "/min"), format(result.metrics.avgSpeedKmh, " km/h"), format(result.metrics.avgWaitSec, " s"), format(result.metrics.queued), format(check.matched), format(check.wmapePct, "%")];
    });
    const intro = document.createElement("p"); intro.className = "minor";
    intro.textContent = `${freshTraffic ? `Held-out NDW observation: ${when(freshTraffic.t)}. ${stations.length} matched sensors.` : "No fresh NDW traffic was available, so observed error is not reported."} Same seed ${seed}, 45 s common actuated warmup, 120 s measurement per program, 1,200 target cars at peak. WMAPE is absolute station-flow error divided by observed flow; it does not establish causation or safety.`;
    $("#trial-results").replaceChildren(intro, table([
      { text: "Signals" }, { text: "Completed", numeric: true }, { text: "Speed", numeric: true }, { text: "Wait", numeric: true }, { text: "Queued", numeric: true }, { text: "Held-out sensors", numeric: true }, { text: "Flow error", numeric: true },
    ], tableRows));
    const errors = results.map((result) => validateHoldout(result).wmapePct).filter((value): value is number => value !== null);
    status.textContent = errors.length && Math.min(...errors) > 30
      ? `Comparison complete. Held-out flow error is ${Math.min(...errors)}–${Math.max(...errors)}%; this model is not validated for operational decisions. Download the raw results.`
      : "Comparison complete. Download the configuration and raw station results to reproduce or review it.";
    ($("#trial-export") as HTMLButtonElement).disabled = false;
  } catch (error) { status.textContent = `Comparison could not finish: ${error instanceof Error ? error.message : "unknown error"}`; }
  finally { button.disabled = false; }
}
function exportTrial() {
  if (!lastTrial) return;
  const blob = new Blob([JSON.stringify({ ...lastTrial, method: "same fixed seed and actuated warmup for all arms; held-out NDW stations selected by stable edge hash; 1,200 peak density; short one-seed run", limitations: "Experimental. No parameter fitting, transit validation or authorized iVRI observations. Station flows may aggregate multiple lanes; results are not operational forecasts." }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "rotterdam-model-check.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

$("#rain-input").addEventListener("input", () => { $("#rain-output").textContent = ($("#rain-input") as HTMLInputElement).value; });
$("#scenario-form").addEventListener("submit", (event) => void scenario(event));
$("#neighborhood-search").addEventListener("input", renderCbs);
$("#trial-run").addEventListener("click", () => void trial());
$("#trial-export").addEventListener("click", exportTrial);
renderSources(); renderConditions();
void Promise.allSettled([load<Meta>("meta.json"), load<Exposure>("exposure.json"), load<Cbs>("cbs-neighborhoods.json"), load<Ndw>("ndw.json")]).then((results) => {
  if (results[0].status === "fulfilled") meta = results[0].value;
  if (results[1].status === "fulfilled") exposure = results[1].value;
  if (results[2].status === "fulfilled") cbs = results[2].value;
  if (results[3].status === "fulfilled") ndw = results[3].value;
  renderCbs(); renderExposure();
});
