import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 512_000;
const MAX_OBSERVATION_AGE_MS = 20 * 60_000;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" && value.length <= limit;
const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const time = (value, now) => validDate(value) && Date.parse(value) <= now + 60_000;
const point = (value) => Number.isFinite(value?.x) && Number.isFinite(value?.y);

function equalToken(value, expected) {
  if (!expected || typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const a = Buffer.from(value.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateCitySnapshot(value, now = Date.now()) {
  if (!record(value) ||
      !Number.isInteger(value.v) || value.v < 2 || value.v > 3 ||
      !time(value.t, now) || now - Date.parse(value.t) > MAX_OBSERVATION_AGE_MS ||
      !["traffic", "bridges", "incidents", "vehicles", "departures", "water", "weather", "air"].some((key) => Object.hasOwn(value, key))) {
    throw new Error("Invalid or stale city snapshot");
  }
  const limits = { traffic: 5000, bridges: 500, incidents: 500, vehicles: 10_000, departures: 1000, air: 1000 };
  if ("traffic" in value && (!record(value.traffic) || !time(value.traffic.t, now) ||
      !Number.isFinite(value.traffic.todMin) || !Array.isArray(value.traffic.s) || value.traffic.s.length > limits.traffic ||
      !value.traffic.s.every((row) => Array.isArray(row) && row.length === 3 &&
        Number.isInteger(row[0]) && row[0] >= 0 && Number.isFinite(row[1]) && row[1] >= 0 && Number.isFinite(row[2]) && row[2] >= 0))) throw new Error("Invalid traffic");
  if ("bridges" in value && (!Array.isArray(value.bridges) || value.bridges.length > limits.bridges ||
      !value.bridges.every((bridge) => record(bridge) && text(bridge.name, 100) && point(bridge) && validDate(bridge.until) &&
        Array.isArray(bridge.edges) && bridge.edges.length <= 50 && bridge.edges.every((edge) => Number.isInteger(edge) && edge >= 0 && edge <= 250_000)))) throw new Error("Invalid bridges");
  if ("incidents" in value && (!Array.isArray(value.incidents) || value.incidents.length > limits.incidents ||
      !value.incidents.every((incident) => record(incident) && point(incident) &&
        Number.isInteger(incident.kind) && incident.kind >= 0 && incident.kind <= 4 &&
        Number.isInteger(incident.edge) && incident.edge >= -1 && incident.edge <= 250_000 &&
        text(incident.name, 200) && validDate(incident.until)))) throw new Error("Invalid incidents");
  if ("vehicles" in value && (!record(value.vehicles) || !time(value.vehicles.t, now) ||
      !Array.isArray(value.vehicles.v) || value.vehicles.v.length > limits.vehicles ||
      !value.vehicles.v.every((row) => Array.isArray(row) && row.length === 9 &&
        row.slice(0, 3).every(Number.isFinite) && text(row[3], 40) && text(row[4], 120) &&
        Number.isFinite(row[5]) && Number.isFinite(row[6]) && text(row[7], 120) && Number.isFinite(row[8])) ||
      (value.vehicles.plan !== undefined && (!record(value.vehicles.plan) || Object.keys(value.vehicles.plan).length > limits.vehicles ||
        !Object.entries(value.vehicles.plan).every(([id, points]) => id.length <= 120 && Array.isArray(points) && points.length <= 100 &&
          points.every((point) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite))))))) throw new Error("Invalid vehicles");
  if ("departures" in value && (!record(value.departures) || !time(value.departures.t, now) ||
      !record(value.departures.stops) || !record(value.departures.dep) ||
      Object.keys(value.departures.stops).length > limits.departures || Object.keys(value.departures.dep).length > limits.departures ||
      !Object.entries(value.departures.stops).every(([id, stop]) => id.length <= 120 && Array.isArray(stop) && stop.length === 3 &&
        text(stop[0], 150) && Number.isFinite(stop[1]) && Number.isFinite(stop[2])) ||
      !Object.entries(value.departures.dep).every(([id, rows]) => id.length <= 120 && Array.isArray(rows) && rows.length <= 100 &&
        rows.every((row) => Array.isArray(row) && row.length === 7 && text(row[0], 40) && Number.isFinite(row[1]) &&
          text(row[2], 150) && Number.isFinite(row[3]) && Number.isFinite(row[4]) && Number.isFinite(row[5]) && text(row[6], 120))))) throw new Error("Invalid departures");
  if ("air" in value && (!record(value.air) || !time(value.air.t, now) || !Array.isArray(value.air.s) || value.air.s.length > limits.air ||
      !value.air.s.every((row) => Array.isArray(row) && row.length === 5 && Number.isFinite(row[0]) && Number.isFinite(row[1]) &&
        (row[2] === null || Number.isFinite(row[2])) && (row[3] === null || Number.isFinite(row[3])) && text(row[4], 100)))) throw new Error("Invalid air");
  if ("water" in value && (!record(value.water) || !text(value.water.station, 100) || !Number.isFinite(value.water.cm) ||
      !Number.isFinite(value.water.trend) || !time(value.water.t, now))) throw new Error("Invalid water");
  if ("weather" in value && (!record(value.weather) || !time(value.weather.t, now) || !Number.isFinite(value.weather.rain) ||
      !["temp", "wind", "dir", "gust"].every((key) => value.weather[key] === null || Number.isFinite(value.weather[key])) ||
      !text(value.weather.desc, 100))) throw new Error("Invalid weather");
  return value;
}

export function createObservationHandler({ token, readOrigin, storePath }) {
  if (!token || token.length < 32) throw new Error("OBSERVATION_INGEST_TOKEN must have at least 32 characters");
  if (!/^https:\/\/[^/]+$/.test(readOrigin)) throw new Error("Expected exact HTTPS read origin");
  if (!storePath) throw new Error("OBSERVATION_STORE_PATH is required");
  let latest = null;
  const ready = readFile(storePath, "utf8").then((raw) => {
    latest = validateCitySnapshot(JSON.parse(raw));
  }).catch(() => {});
  let writing = Promise.resolve();

  return async (request, response) => {
    await ready;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const origin = request.headers.origin;
    if (origin === readOrigin && request.method === "GET") {
      response.setHeader("Access-Control-Allow-Origin", readOrigin);
      response.setHeader("Vary", "Origin");
    }
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/api/health" && request.method === "GET") {
      return send(200, { service: "observations", latestAt: latest?.t ?? null,
        ageSeconds: latest ? Math.round((Date.now() - Date.parse(latest.t)) / 1000) : null });
    }
    if (request.url !== "/api/live" && request.url !== "/api/v1/observations") return send(404, { error: "Not found" });
    if (request.method === "GET") {
      if (origin && origin !== readOrigin) return send(403, { error: "Origin not allowed" });
      if (!latest || Date.now() - Date.parse(latest.t) > MAX_OBSERVATION_AGE_MS) return send(503, { error: "No current snapshot" });
      if (request.url === "/api/live") return send(200, latest);
      return send(200, { observedAt: latest.t, observations: [
        { id: "ndw-traffic", observedAt: latest.traffic?.t ?? null, count: latest.traffic?.s?.length ?? 0 },
        { id: "ndw-bridges", observedAt: latest.t, count: latest.bridges?.length ?? 0 },
        { id: "ovapi-vehicles", observedAt: latest.vehicles?.t ?? null, count: latest.vehicles?.v?.length ?? 0 },
        { id: "rws-water", observedAt: latest.water?.t ?? null, count: latest.water ? 1 : 0 },
        { id: "weather", observedAt: latest.weather?.t ?? null, count: latest.weather ? 1 : 0 },
      ] });
    }
    if (request.method !== "POST" || request.url !== "/api/live") return send(405, { error: "Method not allowed" });
    if (!equalToken(request.headers.authorization, token)) return send(401, { error: "Unauthorized" });
    if (!request.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "Expected JSON" });
    if (Number(request.headers["content-length"]) > MAX_BYTES) return send(413, { error: "Payload too large" });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return send(413, { error: "Payload too large" });
        chunks.push(chunk);
      }
      const candidate = validateCitySnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      writing = writing.catch(() => {}).then(async () => {
        // Recheck inside the write queue: concurrent requests must not let an
        // older payload overwrite a newer one that was accepted meanwhile.
        if (latest && Date.parse(candidate.t) < Date.parse(latest.t)) return false;
        const temporary = `${storePath}.tmp`;
        await writeFile(temporary, JSON.stringify(candidate), { mode: 0o600 });
        await rename(temporary, storePath);
        latest = candidate;
        return true;
      });
      if (!await writing) return send(409, { error: "Older than current snapshot" });
      return send(202, { acceptedAt: candidate.t });
    } catch {
      return send(400, { error: "Invalid snapshot or storage unavailable" });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const handler = createObservationHandler({
    token: process.env.OBSERVATION_INGEST_TOKEN,
    readOrigin: process.env.OBSERVATION_READ_ORIGIN ?? "",
    storePath: process.env.OBSERVATION_STORE_PATH,
  });
  const port = Number(process.env.OBSERVATION_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid OBSERVATION_PORT");
  createServer(handler).listen(port, process.env.OBSERVATION_HOST ?? "127.0.0.1");
}
