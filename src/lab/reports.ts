import { packNetwork, unpackNetwork, fingerprint, isRecord, validId, type NetworkSnapshot } from "./networkSnapshot";
import { safeReading } from "./imports";
import { validOrigin } from "./handoff";
import { corridorReadings, selectedCorridor } from "../v03/corridors";
import type { ScenarioConfig, ScenarioResult, TrafficReading } from "../v03/scenario";

// Bump whenever model physics, importer semantics or measurement windows change.
export const MODEL_VERSION = "rotterdam-traffic-2026-10-18.1";
const MODEL_CAVEAT = "Simulation estimates are indicative, not observed traffic or a citywide forecast. Detector direction is unknown. Reproducibility does not establish calibration.";
export const REPORT_LIMIT_BYTES = 2_000_000;
const STORE = "rotterdam-scenario-reports-v1";
const MAX_SAVED = 3;
export interface ScenarioReport {
  schemaVersion: 1;
  modelVersion: string;
  caveat: string;
  name: string;
  createdAt: string;
  network: NetworkSnapshot;
  networkHash: string;
  observationsHash: string;
  origin: { lat: number; lon: number };
  corridorEdgeId: string | null;
  observedDetector: string | null;
  observations: TrafficReading[];
  warmupSeconds: 60;
  measurementSeconds: 300;
  seeds: number[];
  baseline: { config: ScenarioConfig; runs: ScenarioResult[] };
  candidate: { config: ScenarioConfig; runs: ScenarioResult[] };
}

export async function sealReport(input: Omit<ScenarioReport, "schemaVersion" | "modelVersion" | "caveat" | "createdAt" | "networkHash" | "observationsHash">): Promise<ScenarioReport> {
  return { ...input, schemaVersion: 1, modelVersion: MODEL_VERSION, caveat: MODEL_CAVEAT, createdAt: new Date().toISOString(),
    networkHash: await fingerprint(input.network), observationsHash: await fingerprint(input.observations) };
}
function fail(): never { throw new Error("Invalid scenario report. Export a complete report from the scenario lab."); }
function number(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fail();
}
function config(value: unknown): ScenarioConfig {
  if (!isRecord(value) || (value.mode !== "fixed" && value.mode !== "actuated")) return fail();
  const out = { mode: value.mode, demandPerHour: number(value.demandPerHour, 0, 4000), preference: number(value.preference, 0, 1),
    cycleMin: number(value.cycleMin, 10, 300), cycleMax: number(value.cycleMax, 10, 300),
    minGreen: number(value.minGreen, 1, 15), maxGreen: number(value.maxGreen, 10, 60), passageTime: number(value.passageTime, 0.5, 5) };
  if (out.cycleMax < out.cycleMin || out.maxGreen < out.minGreen) return fail();
  // These settings are currently fixed in the UI and must survive a reopen exactly.
  if (out.cycleMin !== 40 || out.cycleMax !== 90) return fail();
  return out as ScenarioConfig;
}
function results(value: unknown, count: number): ScenarioResult[] {
  if (!Array.isArray(value) || value.length !== count) return fail();
  return value.map((row) => {
    if (!isRecord(row)) return fail();
    const nullable = (v: unknown) => v === null ? null : number(v, 0, 1e9);
    const completed = number(row.completed, 0, 1e6);
    if (!Number.isInteger(completed)) return fail();
    return { completed, travelTimeSec: nullable(row.travelTimeSec), waitSec: nullable(row.waitSec),
      throughputPerHour: number(row.throughputPerHour, 0, 1e7), demandMet: number(row.demandMet, 0, 1),
      avgQueue: number(row.avgQueue, 0, 1200), corridorFlowPerHour: number(row.corridorFlowPerHour, 0, 1e7),
      corridorSpeedKmh: nullable(row.corridorSpeedKmh) };
  });
}

export async function parseReport(raw: string): Promise<ScenarioReport> {
  if (new TextEncoder().encode(raw).length > REPORT_LIMIT_BYTES) throw new Error("Report exceeds 2 MB.");
  const v: unknown = JSON.parse(raw);
  if (!isRecord(v) || v.schemaVersion !== 1 || typeof v.modelVersion !== "string" || v.modelVersion.length > 100 ||
      typeof v.name !== "string" || !v.name.trim() || v.name.length > 80 ||
      typeof v.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(v.createdAt) || !Number.isFinite(Date.parse(v.createdAt)) ||
      !validOrigin(v.origin) || (v.corridorEdgeId !== null && !validId(v.corridorEdgeId)) ||
      (v.observedDetector !== null && !validId(v.observedDetector)) || v.warmupSeconds !== 60 || v.measurementSeconds !== 300 ||
      !Array.isArray(v.seeds) || v.seeds.length !== 3 || !v.seeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) ||
      new Set(v.seeds).size !== v.seeds.length || !Array.isArray(v.observations) || v.observations.length > 3000 ||
      !isRecord(v.baseline) || !isRecord(v.candidate)) return fail();
  const restored = unpackNetwork(v.network);
  const network = packNetwork(restored);
  if (v.corridorEdgeId && !selectedCorridor(restored, v.corridorEdgeId)) return fail();
  const observations = v.observations.map(safeReading);
  if (observations.some((row) => !row) || (v.observedDetector ? !observations.length || observations.some((row) => row?.id !== v.observedDetector) : observations.length)) return fail();
  if (v.corridorEdgeId && corridorReadings(restored, observations as TrafficReading[], v.origin,
      selectedCorridor(restored, v.corridorEdgeId)!).length !== observations.length) return fail();
  if (await fingerprint(network) !== v.networkHash || await fingerprint(observations) !== v.observationsHash) {
    throw new Error("Report data fingerprint does not match. The saved network or observations have changed.");
  }
  const baseline = { config: config(v.baseline.config), runs: results(v.baseline.runs, v.seeds.length) };
  const candidate = { config: config(v.candidate.config), runs: results(v.candidate.runs, v.seeds.length) };
  if (baseline.config.demandPerHour !== candidate.config.demandPerHour || baseline.config.preference !== 0.5 ||
      baseline.config.minGreen !== 6 || baseline.config.maxGreen !== 30 || baseline.config.passageTime !== 2.5) return fail();
  if (candidate.config.mode === "fixed" ? candidate.config.minGreen !== 6 || candidate.config.maxGreen !== 30 || candidate.config.passageTime !== 2.5
    : candidate.config.preference !== 0.5) return fail();
  return { schemaVersion: 1, modelVersion: v.modelVersion, caveat: MODEL_CAVEAT, name: v.name.trim(), createdAt: v.createdAt,
    network, networkHash: v.networkHash as string, observationsHash: v.observationsHash as string,
    origin: v.origin, corridorEdgeId: v.corridorEdgeId, observedDetector: v.observedDetector,
    observations: observations as TrafficReading[], seeds: v.seeds, warmupSeconds: 60, measurementSeconds: 300, baseline, candidate };
}

export function readSavedReports(): Array<{ name: string; createdAt: string; raw: string }> {
  const raw = localStorage.getItem(STORE);
  if (!raw) return [];
  if (raw.length > 3_000_000) throw new Error("Saved report collection is too large. Export reports before clearing site storage.");
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > MAX_SAVED || !values.every((row) => isRecord(row) &&
      typeof row.name === "string" && row.name.length <= 80 && typeof row.createdAt === "string" && typeof row.raw === "string" &&
      row.raw.length <= REPORT_LIMIT_BYTES)) throw new Error("Saved report collection is invalid.");
  return values as Array<{ name: string; createdAt: string; raw: string }>;
}

export function saveReport(report: ScenarioReport): void {
  const previous = readSavedReports();
  const raw = JSON.stringify(report);
  if (new TextEncoder().encode(raw).length > REPORT_LIMIT_BYTES) throw new Error("Report exceeds 2 MB. Download the JSON instead.");
  const next = previous.filter((row) => row.name !== report.name);
  if (next.length >= MAX_SAVED) throw new Error("Three reports are already saved. Delete one before saving another.");
  next.unshift({ name: report.name, createdAt: report.createdAt, raw });
  const json = JSON.stringify(next);
  if (json.length > 3_000_000) throw new Error("Saved reports exceed browser capacity. Download the JSON instead.");
  // setItem is atomic; storage failure leaves existing reports intact.
  localStorage.setItem(STORE, json);
}

export function deleteReport(name: string): void {
  localStorage.setItem(STORE, JSON.stringify(readSavedReports().filter((row) => row.name !== name)));
}
