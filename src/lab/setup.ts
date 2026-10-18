import type { SignalMode } from "../sim/world";
import type { ScenarioConfig } from "../v03/scenario";

export type LabSetup = {
  demandPerHour: number;
  baselineMode: SignalMode;
  candidateMode: SignalMode;
  preference: number;
  minGreen: number;
  maxGreen: number;
  passageTime: number;
};

export const DEFAULT_SETUP: Readonly<LabSetup> = Object.freeze({
  demandPerHour: 1200, baselineMode: "fixed", candidateMode: "actuated",
  preference: .5, minGreen: 6, maxGreen: 30, passageTime: 2.5,
});

export class SetupValidationError extends Error {
  constructor(public readonly fieldId: string, message: string) { super(message); }
}

export function defaultScenarioConfig(mode: SignalMode, demandPerHour: number): ScenarioConfig {
  return { mode, demandPerHour, preference: .5, cycleMin: 40, cycleMax: 90,
    minGreen: 6, maxGreen: 30, passageTime: 2.5 };
}

function numberInRange(value: number, min: number, max: number, fieldId: string, label: string) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new SetupValidationError(fieldId, `${label} must be between ${min} and ${max}.`);
  }
  return value;
}

/** Inactive controls always use model defaults, as required by portable reports. */
export function scenarioPair(setup: LabSetup): [ScenarioConfig, ScenarioConfig] {
  for (const [mode, fieldId] of [[setup.baselineMode, "baseline-mode"], [setup.candidateMode, "candidate-mode"]] as const) {
    if (mode !== "fixed" && mode !== "actuated") throw new SetupValidationError(fieldId, "Choose a signal mode.");
  }
  const demand = numberInRange(setup.demandPerHour, 0, 4000, "scenario-demand", "Cars per hour");
  const baseline = defaultScenarioConfig(setup.baselineMode, demand);
  const candidate = defaultScenarioConfig(setup.candidateMode, demand);
  if (candidate.mode === "fixed") {
    candidate.preference = numberInRange(setup.preference, 0, 1, "candidate-preference", "Candidate cycle preference");
  } else {
    candidate.minGreen = numberInRange(setup.minGreen, 1, 15, "candidate-min-green", "Candidate minimum green in seconds");
    candidate.maxGreen = numberInRange(setup.maxGreen, 10, 60, "candidate-max-green", "Candidate maximum green in seconds");
    candidate.passageTime = numberInRange(setup.passageTime, .5, 5, "candidate-passage", "Candidate passage time in seconds");
    if (candidate.maxGreen < candidate.minGreen) throw new SetupValidationError("candidate-max-green", "Maximum green must be at least minimum green.");
  }
  return [baseline, candidate];
}

export function setupFromPair(baseline: ScenarioConfig, candidate: ScenarioConfig): LabSetup {
  return { demandPerHour: baseline.demandPerHour, baselineMode: baseline.mode, candidateMode: candidate.mode,
    preference: candidate.preference, minGreen: candidate.minGreen, maxGreen: candidate.maxGreen, passageTime: candidate.passageTime };
}

export function sameScenarioPair(a: readonly ScenarioConfig[], b: readonly ScenarioConfig[]): boolean {
  const keys: Array<keyof ScenarioConfig> = ["mode", "demandPerHour", "preference", "cycleMin", "cycleMax", "minGreen", "maxGreen", "passageTime"];
  return a.length === 2 && b.length === 2 && a.every((config, i) => keys.every((key) => config[key] === b[i][key]));
}

export function timingPresets(mode: SignalMode) {
  return mode === "fixed" ? [
    { id: "short", name: "Short cycle · 50 s", preference: .2, minGreen: 6, maxGreen: 30, passageTime: 2.5 },
    { id: "standard", name: "Standard cycle · 65 s", preference: .5, minGreen: 6, maxGreen: 30, passageTime: 2.5 },
    { id: "long", name: "Long cycle · 80 s", preference: .8, minGreen: 6, maxGreen: 30, passageTime: 2.5 },
  ] : [
    { id: "short", name: "Short greens · 4–20 s", preference: .5, minGreen: 4, maxGreen: 20, passageTime: 2 },
    { id: "standard", name: "Standard greens · 6–30 s", preference: .5, minGreen: 6, maxGreen: 30, passageTime: 2.5 },
    { id: "long", name: "Long greens · 8–45 s", preference: .5, minGreen: 8, maxGreen: 45, passageTime: 3 },
  ];
}

export function matchingPreset(setup: LabSetup): string {
  const keys: Array<keyof Pick<LabSetup, "preference" | "minGreen" | "maxGreen" | "passageTime">> = setup.candidateMode === "fixed"
    ? ["preference"] : ["minGreen", "maxGreen", "passageTime"];
  return timingPresets(setup.candidateMode).find((preset) => keys.every((key) => preset[key] === setup[key]))?.id ?? "custom";
}
