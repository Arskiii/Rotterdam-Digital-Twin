import { packNetwork, unpackNetwork, isRecord, validId } from "./networkSnapshot";
import { safeReading } from "./imports";
import type { Network } from "../sim/types";
import type { TrafficReading } from "../v03/scenario";
import { selectedCorridor } from "../v03/corridors";

const KEY = "rotterdam-corridor-handoff-v1";
export function validOrigin(value: unknown): value is { lat: number; lon: number } {
  return isRecord(value) && typeof value.lat === "number" && typeof value.lon === "number" &&
    Number.isFinite(value.lat) && Number.isFinite(value.lon) &&
    value.lat >= 51.8 && value.lat <= 52.1 && value.lon >= 4.3 && value.lon <= 4.7;
}

export function stageHandoff(network: Network, origin: { lat: number; lon: number }, edgeId: string, readings: TrafficReading[]): string {
  const token = crypto.randomUUID();
  const json = JSON.stringify({ token, createdAt: Date.now(), edgeId, origin, network: packNetwork(network), readings });
  if (json.length > 2_000_000) throw new Error("This edited network is too large to transfer.");
  try { sessionStorage.setItem(KEY, json); }
  catch { throw new Error("Browser storage is unavailable. Allow site storage to carry this exact road network into the lab."); }
  return token;
}

export function readHandoff(token: string, edgeId: string) {
  let raw: string | null;
  try { raw = sessionStorage.getItem(KEY); }
  catch { throw new Error("Browser storage is unavailable; reopen this corridor from the map."); }
  if (!raw || raw.length > 2_000_000) throw new Error("Corridor handoff is unavailable; reopen it from the map.");
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || data.token !== token || !validId(data.edgeId) || data.edgeId !== edgeId ||
      !validOrigin(data.origin) || typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt) ||
      Date.now() - data.createdAt > 2 * 60 * 60_000 || data.createdAt > Date.now() + 120_000 ||
      !Array.isArray(data.readings) || data.readings.length > 3000) throw new Error("Corridor handoff is invalid or expired; reopen it from the map.");
  const network = unpackNetwork(data.network);
  if (!selectedCorridor(network, edgeId)) throw new Error("The selected road is missing from the transferred network.");
  const readings = data.readings.map(safeReading);
  if (readings.some((row) => row === null)) throw new Error("Invalid observations in corridor handoff.");
  return { network, origin: data.origin, readings: readings as TrafficReading[] };
}
