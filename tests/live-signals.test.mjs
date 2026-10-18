import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createViteServer } from "vite";
import { createLiveSignalHandler, createLiveSignalServer, validateSnapshot } from "../server/live-signals.mjs";

const httpServer = createHttpServer();
const vite = await createViteServer({
  configFile: false,
  server: { middlewareMode: true, hmr: { server: httpServer } },
});
test.after(() => vite.close());
const { parseLiveSignalSnapshot, isLiveReadingFresh } = await vite.ssrLoadModule("/src/v03/liveSignals.ts");

function snapshot(now = Date.now()) {
  const timestamp = new Date(now).toISOString();
  return {
    source: "authorized test feed",
    updatedAt: timestamp,
    signals: [{ edgeId: "a->b", state: "green", observedAt: timestamp }],
  };
}

test("browser and bridge accept fresh readings and reject stale or malformed ones", () => {
  const now = Date.now();
  const fresh = snapshot(now);
  assert.equal(parseLiveSignalSnapshot(fresh, now).signals.get("a->b").state, "green");
  assert.equal(validateSnapshot(fresh, now).signals.length, 1);
  assert.equal(isLiveReadingFresh({ edgeId: "a->b", state: "green", observedAt: now - 16_000 }, now), false);
  assert.throws(() => parseLiveSignalSnapshot(snapshot(now - 16_000), now));
  assert.throws(() => validateSnapshot(snapshot(now - 16_000), now));
  assert.throws(() => validateSnapshot({ ...fresh, signals: [{ ...fresh.signals[0], state: "flashing" }] }, now));
  assert.throws(() => parseLiveSignalSnapshot({ ...fresh, signals: [null] }, now));
});

async function invoke(handler, method, { body, rawBody, authorization, origin, headers: extraHeaders = {}, url = "/api/signals" } = {}) {
  const request = Readable.from(rawBody ? [rawBody] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.url = url;
  request.method = method;
  request.headers = { authorization, origin, "content-type": "application/json", ...extraHeaders };
  const headers = {};
  const response = {
    status: 0,
    body: "",
    setHeader(name, value) { headers[name] = value; },
    writeHead(status, extra = {}) { this.status = status; Object.assign(headers, extra); },
    end(value = "") { this.body = value; },
  };
  await handler(request, response);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null, headers };
}

test("bridge requires an ingest token and explicit public-read permission", async () => {
  const token = "a".repeat(32);
  const privateHandler = createLiveSignalHandler({ token });
  assert.equal((await invoke(privateHandler, "POST", { body: snapshot() })).status, 401);
  assert.equal((await invoke(privateHandler, "POST", { body: snapshot(), authorization: `Bearer ${token}` })).status, 202);
  assert.equal((await invoke(privateHandler, "GET")).status, 403);

  const publicHandler = createLiveSignalHandler({ token, publicRead: true, readOrigin: "https://example.org" });
  await invoke(publicHandler, "POST", { body: snapshot(), authorization: `Bearer ${token}` });
  const allowed = await invoke(publicHandler, "GET", { origin: "https://example.org" });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], "https://example.org");
  assert.equal((await invoke(publicHandler, "GET", { origin: "https://other.org" })).status, 403);
});

test("browser and bridge reject duplicate edges and normalized invalid calendar dates", () => {
  const now = Date.parse("2026-03-02T00:00:00.000Z");
  const fresh = snapshot(now);
  const duplicate = { ...fresh, signals: [fresh.signals[0], { ...fresh.signals[0], state: "red" }] };
  const invalidDate = { ...fresh, updatedAt: "2026-02-30T00:00:00.000Z" };
  const invalidReading = { ...fresh, signals: [{ ...fresh.signals[0], observedAt: invalidDate.updatedAt }] };
  for (const value of [duplicate, invalidDate, invalidReading]) {
    assert.throws(() => validateSnapshot(value, now));
    assert.throws(() => parseLiveSignalSnapshot(value, now));
  }
});

test("bridge fails closed on invalid token and public-read configuration", () => {
  const token = "a".repeat(32);
  for (const invalid of [undefined, "a".repeat(31), " ".repeat(32), Array(32).fill("a")]) {
    assert.throws(() => createLiveSignalHandler({ token: invalid }));
  }
  assert.throws(() => createLiveSignalHandler({ token, publicRead: "false", readOrigin: "https://example.org" }));
  for (const readOrigin of ["*", "null", "https://user@example.org", "https://example.org?x", "https://example.org#x", "https://example.org/", "https://example.org\r\nx-test: injected"]) {
    assert.throws(() => createLiveSignalHandler({ token, publicRead: true, readOrigin }));
  }
  assert.doesNotThrow(() => createLiveSignalHandler({ token, publicRead: true, readOrigin: "http://localhost:8787" }));
});

test("bridge preflight authorizes only reads from the configured origin", async () => {
  const handler = createLiveSignalHandler({ token: "a".repeat(32), publicRead: true, readOrigin: "https://example.org" });
  const allowed = await invoke(handler, "OPTIONS", {
    origin: "https://example.org", headers: { "access-control-request-method": "GET" },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], "https://example.org");
  assert.equal(allowed.headers["Access-Control-Allow-Methods"], "GET");
  assert.equal(allowed.headers.Vary, "Origin");
  assert.equal((await invoke(handler, "OPTIONS", {
    origin: "https://other.org", headers: { "access-control-request-method": "GET" },
  })).status, 403);
  assert.equal((await invoke(handler, "OPTIONS", {
    origin: "https://example.org", headers: { "access-control-request-method": "POST" },
  })).status, 403);
});

test("bridge rejects invalid ingest payloads without replacing good observations", async () => {
  const token = "a".repeat(32);
  const authorization = `Bearer ${token}`;
  const handler = createLiveSignalHandler({ token, publicRead: true, readOrigin: "https://example.org" });
  const body = snapshot();
  assert.equal((await invoke(handler, "POST", { body, authorization, headers: { "content-type": "Application/JSON; charset=utf-8" } })).status, 202);
  for (const badAuthorization of [undefined, `Bearer ${"b".repeat(32)}`, "Bearer short", `Basic ${token}`]) {
    assert.equal((await invoke(handler, "POST", { body, authorization: badAuthorization })).status, 401);
  }
  for (const headers of [{ "content-type": "application/jsonp" }, { "content-type": "text/plain" }, { "content-encoding": "gzip" }]) {
    assert.equal((await invoke(handler, "POST", { body, authorization, headers })).status, 415);
  }
  assert.equal((await invoke(handler, "POST", { rawBody: Buffer.from("{"), authorization })).status, 400);
  const badUtf8 = Buffer.concat([
    Buffer.from('{"source":"'), Buffer.from([0xc3, 0x28]),
    Buffer.from(`","updatedAt":"${body.updatedAt}","signals":[]}`),
  ]);
  assert.equal((await invoke(handler, "POST", { rawBody: badUtf8, authorization })).status, 400);
  assert.equal((await invoke(handler, "POST", { body, authorization, headers: { "content-length": String(64 * 1024 + 1) } })).status, 413);
  assert.equal((await invoke(handler, "POST", { rawBody: Buffer.alloc(64 * 1024 + 1, " "), authorization })).status, 413);
  assert.deepEqual((await invoke(handler, "GET")).body, body);
});

test("delayed snapshots and signal readings cannot roll the current state back", async () => {
  const token = "a".repeat(32);
  const handler = createLiveSignalHandler({ token, publicRead: true, readOrigin: "https://example.org" });
  const authorization = `Bearer ${token}`;
  const now = Date.now();
  const latest = snapshot(now);
  assert.equal((await invoke(handler, "POST", { body: latest, authorization })).status, 202);
  assert.equal((await invoke(handler, "POST", { body: snapshot(now - 1_000), authorization })).status, 409);
  const olderSignal = { ...snapshot(now + 1), signals: snapshot(now - 1_000).signals };
  assert.equal((await invoke(handler, "POST", { body: olderSignal, authorization })).status, 409);
  assert.deepEqual((await invoke(handler, "GET")).body, latest);
  assert.equal((await invoke(handler, "POST", { body: latest, authorization })).status, 202, "identical delivery retries remain accepted");
});

test("real HTTP server returns bounded-upload errors and remains available", async (t) => {
  const token = "a".repeat(32);
  const server = createLiveSignalServer({ token, publicRead: true, readOrigin: "https://example.org" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  function request({ headers = {}, chunks = [], end = true } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/signals", method: "POST", headers }, (res) => {
        const parts = [];
        res.on("data", (chunk) => parts.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() });
        });
      });
      req.on("error", reject);
      req.setTimeout(3_000, () => req.destroy(new Error("Test request timed out")));
      for (const chunk of chunks) req.write(chunk);
      if (end) req.end();
      else req.flushHeaders();
    });
  }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const oversized = await request({ headers, chunks: [Buffer.alloc(32 * 1024), Buffer.alloc(32 * 1024 + 1)], end: false });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.connection, "close");
  assert.deepEqual(JSON.parse(oversized.body), { error: "Payload too large" });
  const unauthorized = await request({ headers: { "content-length": "1000000" }, end: false });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.connection, "close");
  assert.equal((await request({ headers: { ...headers, "x-extra": "a".repeat(9 * 1024) } })).status, 431);
  assert.equal((await request({ headers, chunks: [JSON.stringify(snapshot())] })).status, 202);
});
