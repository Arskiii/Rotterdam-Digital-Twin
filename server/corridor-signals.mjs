import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_AGE_MS = 15_000;
const MAX_BYTES = 64 * 1024;

function validTimestamp(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) &&
    time <= now + 2_000 && now - time <= MAX_AGE_MS;
}

export function validateSnapshot(value, now = Date.now()) {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      typeof value.source !== "string" || value.source.length < 1 || value.source.length > 100 ||
      !validTimestamp(value.updatedAt, now) || !Array.isArray(value.signals) || value.signals.length > 1000) {
    throw new Error("Invalid or stale snapshot");
  }
  const seen = new Set();
  for (const signal of value.signals) {
    if (typeof signal !== "object" || signal === null || Array.isArray(signal) ||
        typeof signal.edgeId !== "string" || signal.edgeId.length < 1 || signal.edgeId.length > 160 ||
        !["red", "yellow", "green"].includes(signal.state) ||
        !validTimestamp(signal.observedAt, now) || seen.has(signal.edgeId)) {
      throw new Error("Invalid or stale signal reading");
    }
    seen.add(signal.edgeId);
  }
  return {
    source: value.source,
    updatedAt: value.updatedAt,
    signals: value.signals.map(({ edgeId, state, observedAt }) => ({ edgeId, state, observedAt })),
  };
}

function authorized(header, token) {
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createLiveSignalHandler({ token, publicRead = false, readOrigin = "" }) {
  if (typeof token !== "string" || token.length < 32 || token.trim() !== token) {
    throw new Error("CORRIDOR_SIGNALS_INGEST_TOKEN must have at least 32 characters and no surrounding whitespace");
  }
  if (typeof publicRead !== "boolean") throw new Error("publicRead must be a boolean");
  if (publicRead) {
    let validOrigin = false;
    try {
      const parsed = new URL(readOrigin);
      validOrigin = ["http:", "https:"].includes(parsed.protocol) && parsed.origin === readOrigin;
    } catch { /* Invalid URLs are rejected below. */ }
    if (!validOrigin) throw new Error("CORRIDOR_SIGNALS_READ_ORIGIN must be an exact web origin for public reads");
  }
  let latest = null;
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const origin = request.headers.origin;
    if (publicRead) response.setHeader("Vary", "Origin");
    if (["GET", "OPTIONS"].includes(request.method) && origin === readOrigin && publicRead) {
      response.setHeader("Access-Control-Allow-Origin", readOrigin);
    }
    const send = (status, body) => {
      if (response.destroyed || response.writableEnded) return;
      // Close rejected, unread uploads after delivering the response. Draining an
      // unbounded request would let a client keep this connection occupied.
      if (!request.readableEnded) response.setHeader("Connection", "close");
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (request.url !== "/api/signals") return send(404, { error: "Not found" });
    if (request.method === "OPTIONS") {
      if (publicRead && origin === readOrigin && request.headers["access-control-request-method"] === "GET") {
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET" });
        return response.end();
      }
      return send(403, { error: "Forbidden" });
    }
    if (request.method === "GET") {
      if (!publicRead || (origin && origin !== readOrigin)) return send(403, { error: "Read access disabled" });
      if (!latest || !validTimestamp(latest.updatedAt, Date.now())) return send(503, { error: "No fresh observations" });
      return send(200, { ...latest, signals: latest.signals.filter((signal) => validTimestamp(signal.observedAt, Date.now())) });
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "GET, POST, OPTIONS");
      return send(405, { error: "Method not allowed" });
    }
    if (!authorized(request.headers.authorization, token)) return send(401, { error: "Unauthorized" });
    const mediaType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json" ||
        (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")) {
      return send(415, { error: "Expected uncompressed JSON" });
    }
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) return send(413, { error: "Payload too large" });
    try {
      const chunks = [];
      let size = 0;
      // The default async iterator destroys the HTTP socket on an early return,
      // which can discard the 413 response before the client receives it.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_BYTES) return send(413, { error: "Payload too large" });
        chunks.push(chunk);
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const incoming = validateSnapshot(JSON.parse(decoded));
      if (latest) {
        const previous = new Map(latest.signals.map((signal) => [signal.edgeId, signal]));
        if (Date.parse(incoming.updatedAt) < Date.parse(latest.updatedAt) || incoming.signals.some((signal) => {
          const earlier = previous.get(signal.edgeId);
          return earlier && Date.parse(signal.observedAt) < Date.parse(earlier.observedAt);
        })) return send(409, { error: "Observations are older than the current snapshot" });
      }
      latest = incoming;
      return send(202, { accepted: latest.signals.length });
    } catch {
      return send(400, { error: "Invalid snapshot" });
    }
  };
}

export function createLiveSignalServer(options) {
  const server = createServer({
    maxHeaderSize: 8 * 1024,
    headersTimeout: 5_000,
    requestTimeout: 10_000,
    connectionsCheckingInterval: 1_000,
    keepAliveTimeout: 5_000,
  }, createLiveSignalHandler(options));
  server.setTimeout(5_000);
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const token = process.env.CORRIDOR_SIGNALS_INGEST_TOKEN;
  const publicRead = process.env.CORRIDOR_SIGNALS_PUBLIC_READ === "true";
  const readOrigin = process.env.CORRIDOR_SIGNALS_READ_ORIGIN ?? "";
  const host = process.env.CORRIDOR_SIGNALS_HOST ?? "127.0.0.1";
  const port = Number(process.env.CORRIDOR_SIGNALS_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CORRIDOR_SIGNALS_PORT");
  createLiveSignalServer({ token, publicRead, readOrigin }).listen(port, host, () => {
    console.log(`Live signal bridge listening on ${host}:${port}`);
  });
}
