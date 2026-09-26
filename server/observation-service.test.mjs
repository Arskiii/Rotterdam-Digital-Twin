import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservationHandler, validateCitySnapshot } from "./observation-service.mjs";

const now = Date.parse("2026-09-26T12:00:00Z");
const snapshot = { v: 3, t: "2026-09-26T11:59:30Z", traffic: { t: "2026-09-26T11:59:00Z", todMin: 719, s: [[0, 600, 40]] }, bridges: [] };

describe("observation receiver", () => {
  it("rejects old, future, malformed and unbounded observations", () => {
    expect(validateCitySnapshot(snapshot, now)).toEqual(snapshot);
    expect(() => validateCitySnapshot({ ...snapshot, t: "2026-09-26T11:00:00Z" }, now)).toThrow();
    expect(() => validateCitySnapshot({ ...snapshot, t: "2026-09-26T12:05:00Z" }, now)).toThrow();
    expect(() => validateCitySnapshot({ ...snapshot, traffic: { ...snapshot.traffic, s: [[0, "bad", 40]] } }, now)).toThrow();
    expect(() => validateCitySnapshot({ ...snapshot, bridges: [{ name: "x", edges: [-1] }] }, now)).toThrow();
    expect(() => validateCitySnapshot({ ...snapshot, traffic: { ...snapshot.traffic, s: Array(5001).fill([0, 1, 2]) } }, now)).toThrow();
  });
  it("requires a strong secret and exact public site origin", () => {
    expect(() => createObservationHandler({ token: "short", readOrigin: "https://example.org", storePath: "/tmp/a" })).toThrow();
    expect(() => createObservationHandler({ token: "x".repeat(32), readOrigin: "*", storePath: "/tmp/a" })).toThrow();
  });
  it("accepts authenticated writes, persists them, and serves fresh no-store reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observations-"));
    const path = join(directory, "latest.json");
    const token = "x".repeat(32);
    const handler = createObservationHandler({ token, readOrigin: "https://example.org", storePath: path });
    const send = async (method, url, headers = {}, body = null) => {
      const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      Object.assign(request, { method, url, headers });
      const response = {
        headers: {}, status: 0, body: "",
        setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
        writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
        end(value) { this.body = value; },
      };
      await handler(request, response);
      return response;
    };
    const current = { ...snapshot, t: new Date().toISOString(), traffic: { ...snapshot.traffic, t: new Date().toISOString() } };
    try {
      const unauthorized = await send("POST", "/api/live", { "content-type": "application/json" }, current);
      expect(unauthorized.status).toBe(401);
      const accepted = await send("POST", "/api/live", { "content-type": "application/json", authorization: `Bearer ${token}` }, current);
      expect(accepted.status).toBe(202);
      const read = await send("GET", "/api/live", { origin: "https://example.org" });
      expect(read.status).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.headers["access-control-allow-origin"]).toBe("https://example.org");
      expect(JSON.parse(read.body).t).toBe(current.t);
      expect((await send("GET", "/api/live", { origin: "https://other.org" })).status).toBe(403);
      const summary = JSON.parse((await send("GET", "/api/v1/observations")).body);
      expect(summary.observations.find((row) => row.id === "ndw-traffic").count).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
