import type { TrafficReading } from "../v03/scenario";

const MAX_RECORDS = 3000;
const MAX_BYTES = 1_000_000;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !DECIMAL.test(value.trim()))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metric(value: unknown): number | null | undefined {
  if (value === undefined || value === null || typeof value === "string" && value.trim() === "") return null;
  return number(value) ?? undefined;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(text)) return null;
  const wallTime = Date.parse(`${text.slice(0, 19)}Z`);
  const instant = Date.parse(text);
  if (!Number.isFinite(wallTime) || !Number.isFinite(instant) ||
      new Date(wallTime).toISOString().slice(0, 19) !== text.slice(0, 19)) return null;
  return new Date(instant).toISOString();
}

export function safeReading(value: unknown): TrafficReading | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim().slice(0, 100) : "";
  const lat = number(row.lat);
  const lon = number(row.lon);
  const observedAt = timestamp(row.observedAt);
  const speed = metric(row.speedKmh);
  const flow = metric(row.vehiclesPerHour);
  if (!id || id.length > 100 || !observedAt || lat === null || lon === null ||
      lat < 51.8 || lat > 52.1 || lon < 4.3 || lon > 4.7 ||
      speed === undefined || flow === undefined || speed === null && flow === null ||
      speed !== null && (speed < 0 || speed > 200) ||
      flow !== null && (flow < 0 || flow > 100_000)) return null;
  return { id, name: name || id, lat, lon, observedAt, speedKmh: speed, vehiclesPerHour: flow };
}

function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  let closedQuote = false;
  function field() {
    row.push(value.trim());
    value = "";
    closedQuote = false;
  }
  function finishRow() {
    field();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    if (rows.length > MAX_RECORDS + 1) throw new Error("Import supports at most 3,000 records.");
  }
  for (let i = 0; i < raw.length; i++) {
    const character = raw[i];
    if (quoted) {
      if (character === '"') {
        if (raw[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else value += character;
    } else if (character === ",") field();
    else if (character === "\n" || character === "\r") {
      finishRow();
      if (character === "\r" && raw[i + 1] === "\n") i++;
    } else if (character === '"' && !closedQuote && value.trim() === "") {
      quoted = true;
      value = "";
    } else if (character === '"' || closedQuote && character.trim() !== "") {
      throw new Error("CSV contains an invalid quoted field.");
    } else value += character;
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  if (value !== "" || row.length || closedQuote) finishRow();
  return rows;
}

export function parseImported(raw: string, filename: string): TrafficReading[] {
  if (raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
    throw new Error("File exceeds 1 MB.");
  }
  raw = raw.replace(/^\uFEFF/, "");
  let rows: unknown[];
  if (filename.toLowerCase().endsWith(".json")) {
    const parsed: unknown = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed :
      parsed && typeof parsed === "object" && Array.isArray((parsed as { readings?: unknown }).readings)
        ? (parsed as { readings: unknown[] }).readings : [];
  } else {
    const csv = parseCsv(raw);
    const header = csv.shift() ?? [];
    const required = ["id", "lat", "lon", "observedAt"];
    if (!required.every((field) => header.includes(field)) ||
        !header.includes("speedKmh") && !header.includes("vehiclesPerHour")) {
      throw new Error("CSV needs id, lat, lon, observedAt and at least one of speedKmh or vehiclesPerHour.");
    }
    if (new Set(header).size !== header.length) throw new Error("CSV contains duplicate column names.");
    rows = csv.map((values) => {
      if (values.length !== header.length) throw new Error("CSV row has a different number of fields than its header.");
      return Object.fromEntries(header.map((field, index) => [field, values[index]]));
    });
  }
  if (rows.length > MAX_RECORDS) throw new Error("Import supports at most 3,000 records.");
  const valid = rows.map(safeReading).filter((row): row is TrafficReading => row !== null);
  if (!valid.length || valid.length !== rows.length) throw new Error("Import contains invalid or missing observations.");
  return valid;
}
