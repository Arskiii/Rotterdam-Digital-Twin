import type { Network } from "../sim/types";
import type { CorridorMatch, ScenarioConfig, ScenarioResult } from "../v03/scenario";

export type ScenarioWorkerRequest =
  | { type: "initialize"; network: Network }
  | { type: "run"; config: ScenarioConfig; seed: number; corridor: CorridorMatch | null };

export type ScenarioWorkerResponse =
  | { type: "progress"; fraction: number }
  | { type: "complete"; result: ScenarioResult }
  | { type: "error"; message: string };
