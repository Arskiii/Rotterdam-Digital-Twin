import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const scope = "https://example.test/twin/";
const version = "a".repeat(64);
const key = (request) => typeof request === "string" ? request : request.url;

function harness({ openError = false, matchError = false, putError = false, writeGate = Promise.resolve() } = {}) {
  const listeners = new Map();
  const storage = new Map();
  const calls = [];
  let network = async () => new Response("fresh");
  let claimed = false;
  const caches = {
    async keys() { return [...storage.keys()]; },
    async delete(name) { return storage.delete(name); },
    async open(name) {
      if (openError) throw new Error("Storage denied");
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        async match(request) {
          if (matchError) throw new Error("Storage read failed");
          return entries.get(key(request))?.clone();
        },
        async put(request, response) {
          await writeGate;
          if (putError) throw new Error("Quota exceeded");
          entries.set(key(request), response);
        },
      };
    },
  };
  vm.runInNewContext(source, {
    self: {
      registration: { scope },
      skipWaiting: async () => {},
      clients: { claim: async () => { claimed = true; } },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
    caches, URL,
    fetch: async (request, options) => { calls.push({ request, options }); return network(request); },
  });
  return {
    calls, storage, caches,
    get claimed() { return claimed; },
    set network(value) { network = value; },
    request(path, options = {}) {
      let response;
      const lifetimes = [];
      listeners.get("fetch")({
        request: { url: new URL(path, scope).href, method: "GET", mode: "cors", cache: "default", ...options },
        respondWith: (value) => { response = value; },
        waitUntil: (value) => lifetimes.push(value),
      });
      return { response, done: Promise.all(lifetimes) };
    },
    async activate() { let done; listeners.get("activate")({ waitUntil: (value) => { done = value; } }); await done; },
  };
}

test("unchanged city files reuse their cache; changed content gets a new download", async () => {
  const sw = harness();
  const path = `data/buildings.bin?v=${version}`;
  let request = sw.request(path);
  assert.equal(await (await request.response).text(), "fresh");
  await request.done;
  request = sw.request(path);
  assert.equal(await (await request.response).text(), "fresh");
  await request.done;
  assert.equal(sw.calls.length, 1);
  request = sw.request(`data/buildings.bin?v=${"b".repeat(64)}`);
  await request.done;
  assert.equal(sw.calls.length, 2);
});

test("all mutable datasets and legacy unversioned binaries revalidate on repeat visits", async () => {
  for (const path of ["traffic-history.json", "cbs-neighborhoods.json", "model-validation.json", "ndw.json", "resilience/flood.json", "graph.bin", "meta.json"]) {
    const sw = harness();
    await sw.request(`data/${path}`).done;
    sw.network = async () => new Response("updated");
    const request = sw.request(`data/${path}`);
    assert.equal(await (await request.response).text(), "updated");
    await request.done;
    assert.equal(sw.calls.length, 2);
    assert.equal(sw.calls[1].options.cache, "no-cache");
  }
});

test("offline reload and temporary server failure use the last successful document", async () => {
  const sw = harness();
  await sw.request("?page=lab", { mode: "navigate" }).done;
  for (const network of [async () => { throw new Error("Offline"); }, async () => new Response("Unavailable", { status: 503 })]) {
    sw.network = network;
    const request = sw.request("?page=lab", { mode: "navigate", cache: "reload" });
    assert.equal(await (await request.response).text(), "fresh");
    await request.done;
  }
  sw.network = async () => new Response("Missing", { status: 404 });
  assert.equal((await sw.request("?page=lab", { mode: "navigate" }).response).status, 404);
});

test("cache permission, read and quota failures never lose a valid download", async () => {
  for (const options of [{ openError: true }, { matchError: true }, { putError: true }]) {
    const sw = harness(options);
    for (const path of [`data/graph.bin?v=${version}`, "data/ndw.json"]) {
      const request = sw.request(path);
      assert.equal(await (await request.response).text(), "fresh");
      await request.done;
    }
  }
});

test("cache writes extend the event lifetime without blocking the network response", async () => {
  let release;
  const sw = harness({ writeGate: new Promise((resolve) => { release = resolve; }) });
  const request = sw.request(`data/graph.bin?v=${version}`);
  assert.equal(await (await request.response).text(), "fresh");
  let persisted = false;
  void request.done.then(() => { persisted = true; });
  await Promise.resolve();
  assert.equal(persisted, false);
  release();
  await request.done;
  assert.equal(persisted, true);
});

test("live/API, cross-origin, out-of-scope and explicit fresh requests bypass the cache", () => {
  const sw = harness();
  for (const path of ["api/live", "data/live/live.json", "https://other.test/data/meta.json", "/other/assets/app.js"]) {
    assert.equal(sw.request(path).response, undefined);
  }
  for (const cache of ["no-cache", "no-store", "reload"]) assert.equal(sw.request("data/meta.json", { cache }).response, undefined);
  assert.equal(sw.request("data/meta.json", { method: "POST" }).response, undefined);
  assert.equal(sw.calls.length, 0);
});

test("failed, partial and private responses never become cache hits", async () => {
  for (const response of [new Response("error", { status: 500 }), new Response("partial", { status: 206 }), new Response("private", { headers: { "Cache-Control": "private, no-store" } })]) {
    const sw = harness();
    sw.network = async () => response.clone();
    const path = `data/graph.bin?v=${version}`;
    await sw.request(path).done;
    await sw.request(path).done;
    assert.equal(sw.calls.length, 2);
  }
});

test("activation removes only obsolete app caches and still claims clients when storage is denied", async () => {
  const sw = harness();
  for (const name of ["rtm-data-v1", "rtm-data-v2", "rtm-app-v1", "another-app", "rtm-user-notes"]) sw.storage.set(name, new Map());
  await sw.activate();
  assert.deepEqual([...sw.storage.keys()], ["rtm-data-v2", "rtm-app-v1", "another-app", "rtm-user-notes"]);
  assert.equal(sw.claimed, true);
  sw.caches.keys = async () => { throw new Error("Storage denied"); };
  await sw.activate();
  assert.equal(sw.claimed, true);
});
