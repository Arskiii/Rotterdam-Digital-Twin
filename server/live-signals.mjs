import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_AGE_MS = 15_000;
const MAX_BYTES = 128 * 1024;

function freshTime(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 2_000 && now - time <= MAX_AGE_MS;
}

export function validateSnapshot(value, now = Date.now(), graphSha256) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.source !== "string" || value.source.length < 1 || value.source.length > 100 ||
      typeof value.graphSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.graphSha256) ||
      (graphSha256 && value.graphSha256 !== graphSha256) ||
      !freshTime(value.updatedAt, now) || !Array.isArray(value.signals) || value.signals.length > 5000) {
    throw new Error("Invalid or stale snapshot");
  }
  const seen = new Set();
  for (const signal of value.signals) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal) ||
        !Number.isInteger(signal.signalIndex) || signal.signalIndex < 0 || signal.signalIndex > 20_000 ||
        !["red", "yellow", "green"].includes(signal.state) ||
        !freshTime(signal.observedAt, now) || seen.has(signal.signalIndex)) {
      throw new Error("Invalid or stale signal");
    }
    seen.add(signal.signalIndex);
  }
  return { source: value.source, graphSha256: value.graphSha256, updatedAt: value.updatedAt,
    signals: value.signals.map(({ signalIndex, state, observedAt }) => ({ signalIndex, state, observedAt })) };
}

function authorized(header, token) {
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createLiveSignalHandler({ token, graphSha256, publicRead = false, readOrigin = "" }) {
  if (!token || token.length < 32) throw new Error("LIVE_SIGNALS_INGEST_TOKEN must have at least 32 characters");
  if (typeof graphSha256 !== "string" || !/^[a-f0-9]{64}$/.test(graphSha256)) throw new Error("LIVE_SIGNALS_GRAPH_SHA256 must match the deployed graph");
  if (publicRead && !/^https:\/\/[^/]+$/.test(readOrigin)) throw new Error("Expected exact HTTPS read origin");
  let latest = null;
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const origin = request.headers.origin;
    if (publicRead && origin === readOrigin && request.method === "GET") {
      response.setHeader("Access-Control-Allow-Origin", readOrigin);
      response.setHeader("Vary", "Origin");
    }
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (request.url !== "/api/signals") return send(404, { error: "Not found" });
    if (request.method === "GET") {
      if (!publicRead || (origin && origin !== readOrigin)) return send(403, { error: "Read access disabled" });
      const now = Date.now();
      if (!latest || !freshTime(latest.updatedAt, now)) return send(503, { error: "No fresh observations" });
      return send(200, { ...latest, signals: latest.signals.filter((item) => freshTime(item.observedAt, now)) });
    }
    if (request.method !== "POST") return send(405, { error: "Method not allowed" });
    if (!authorized(request.headers.authorization, token)) return send(401, { error: "Unauthorized" });
    if (!request.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "Expected JSON" });
    if (Number(request.headers["content-length"]) > MAX_BYTES) return send(413, { error: "Payload too large" });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BYTES) return send(413, { error: "Payload too large" });
        chunks.push(chunk);
      }
      latest = validateSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")), Date.now(), graphSha256);
      return send(202, { accepted: latest.signals.length });
    } catch {
      return send(400, { error: "Invalid snapshot" });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const handler = createLiveSignalHandler({
    token: process.env.LIVE_SIGNALS_INGEST_TOKEN,
    graphSha256: process.env.LIVE_SIGNALS_GRAPH_SHA256,
    publicRead: process.env.LIVE_SIGNALS_PUBLIC_READ === "true",
    readOrigin: process.env.LIVE_SIGNALS_READ_ORIGIN ?? "",
  });
  const port = Number(process.env.LIVE_SIGNALS_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid LIVE_SIGNALS_PORT");
  createServer(handler).listen(port, process.env.LIVE_SIGNALS_HOST ?? "127.0.0.1");
}
