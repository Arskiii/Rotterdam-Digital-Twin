import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 512_000;
const MAX_OBSERVATION_AGE_MS = 20 * 60_000;

function equalToken(value, expected) {
  if (!expected || typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const a = Buffer.from(value.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateCitySnapshot(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isInteger(value.v) || value.v < 2 || value.v > 3 ||
      typeof value.t !== "string" || !Number.isFinite(Date.parse(value.t)) ||
      Date.parse(value.t) > now + 60_000 || now - Date.parse(value.t) > MAX_OBSERVATION_AGE_MS) {
    throw new Error("Invalid or stale city snapshot");
  }
  const limits = { traffic: 5000, bridges: 500, incidents: 500, vehicles: 10_000, departures: 1000, air: 1000 };
  if (value.traffic && (!Array.isArray(value.traffic.s) || value.traffic.s.length > limits.traffic)) throw new Error("Traffic limit");
  if (value.bridges && (!Array.isArray(value.bridges) || value.bridges.length > limits.bridges)) throw new Error("Bridge limit");
  if (value.incidents && (!Array.isArray(value.incidents) || value.incidents.length > limits.incidents)) throw new Error("Incident limit");
  if (value.vehicles && (!Array.isArray(value.vehicles.v) || value.vehicles.v.length > limits.vehicles)) throw new Error("Vehicle limit");
  if (value.departures && (!value.departures.dep || typeof value.departures.dep !== "object" || Object.keys(value.departures.dep).length > limits.departures)) throw new Error("Departure limit");
  if (value.air && (!Array.isArray(value.air.s) || value.air.s.length > limits.air)) throw new Error("Air limit");
  if (value.traffic && (typeof value.traffic.t !== "string" || !Number.isFinite(Date.parse(value.traffic.t)) ||
      !value.traffic.s.every((row) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite)))) throw new Error("Invalid traffic");
  if (value.bridges && !value.bridges.every((bridge) => typeof bridge.name === "string" && bridge.name.length <= 100 &&
      Array.isArray(bridge.edges) && bridge.edges.length <= 50 && bridge.edges.every((edge) => Number.isInteger(edge) && edge >= 0 && edge <= 250_000))) throw new Error("Invalid bridges");
  if (value.incidents && !value.incidents.every((incident) => Number.isFinite(incident.x) && Number.isFinite(incident.y) &&
      Number.isInteger(incident.kind) && incident.kind >= 0 && incident.kind <= 4 && typeof incident.name === "string" && incident.name.length <= 200)) throw new Error("Invalid incidents");
  if (value.vehicles && (typeof value.vehicles.t !== "string" || !Number.isFinite(Date.parse(value.vehicles.t)) ||
      !value.vehicles.v.every((row) => Array.isArray(row) && row.length === 9 && row.slice(0, 3).every(Number.isFinite)))) throw new Error("Invalid vehicles");
  if (value.water && (!Number.isFinite(value.water.cm) || typeof value.water.t !== "string" || !Number.isFinite(Date.parse(value.water.t)))) throw new Error("Invalid water");
  if (value.weather && (!Number.isFinite(value.weather.rain) || typeof value.weather.t !== "string" || !Number.isFinite(Date.parse(value.weather.t)))) throw new Error("Invalid weather");
  return value;
}

export function createObservationHandler({ token, readOrigin, storePath }) {
  if (!token || token.length < 32) throw new Error("OBSERVATION_INGEST_TOKEN must have at least 32 characters");
  if (!/^https:\/\/[^/]+$/.test(readOrigin)) throw new Error("Expected exact HTTPS read origin");
  if (!storePath) throw new Error("OBSERVATION_STORE_PATH is required");
  let latest = null;
  const ready = readFile(storePath, "utf8").then((raw) => {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.t === "string") latest = parsed;
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
