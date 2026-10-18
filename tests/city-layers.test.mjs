import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { after, test } from "node:test";
import { Scene } from "three";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: { server: createHttpServer() } },
});
after(() => vite.close());
const { installCityLayers } = await vite.ssrLoadModule("/src/v03/cityLayers.ts");

class Element extends EventTarget {
  children = [];
  textContent = "";
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  get lastChild() { return this.children.at(-1); }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith(".") ? child.className === selector.slice(1) : child.tagName === selector) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const now = Date.parse("2026-09-27T12:00:00.000Z");
const point = { lat: 51.916, lon: 4.484 };
const iso = (offset) => new Date(now + offset).toISOString();
const summary = { buildings: [], transitStops: [], origin: point, bbox: { widthM: 800, heightM: 600 } };

function environment(t, baseURI = "https://example.org/Rotterdam-Digital-Twin/", root = "./") {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const elements = { "city-layer-toggles": new Element(), "city-data-cards": new Element() };
  const document = Object.assign(new EventTarget(), {
    baseURI,
    documentElement: { dataset: { root } },
    getElementById: (id) => elements[id],
    createElement: (tagName) => Object.assign(new Element(), { tagName }),
    createTextNode: (textContent) => Object.assign(new Element(), { textContent }),
  });
  for (const [name, value] of Object.entries({ document, window: {
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (id) => clearTimeout(id),
  } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  return {
    document,
    card: (title) => elements["city-data-cards"].children.find((card) => card.querySelector("strong").textContent.startsWith(title)),
    toggle: (label) => elements["city-layer-toggles"].children.find((row) => row.lastChild.textContent.startsWith(label)).querySelector("input"),
  };
}

test("observation groups expire at the oldest reading, and ended roadworks cannot be re-enabled", async (t) => {
  const ui = environment(t);
  const snapshot = {
    schemaVersion: 1,
    traffic: { retrievedAt: iso(0), readings: [1_000 - 90 * 60_000, 0].map((offset) => ({ ...point, name: "Detector", observedAt: iso(offset), speedKmh: 30, vehiclesPerHour: 200 })) },
    disruptions: { retrievedAt: iso(0), events: [4_000, 3600_000].map((offset) => ({ ...point, description: "Roadworks", startsAt: iso(-3600_000), endsAt: iso(offset) })) },
    air: { retrievedAt: iso(0), reading: { ...point, name: "Station", values: {
      NO2: { value: 10, observedAt: iso(2_000 - 4 * 3600_000) }, PM10: { value: 20, observedAt: iso(0) },
    } } },
    water: { retrievedAt: iso(0), readings: [3_000 - 3 * 3600_000, 0].map((offset) => ({ ...point, name: "Gauge", observedAt: iso(offset), cmNAP: 90 })) },
  };
  let requestedUrl;
  t.mock.method(globalThis, "fetch", async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => snapshot };
  });
  const scene = new Scene();
  await installCityLayers(scene, summary);
  assert.equal(requestedUrl, "https://example.org/Rotterdam-Digital-Twin/data/rotterdam-snapshot.json");
  for (const [label, title, groupIndex] of [
    ["Traffic sensors", "Measured traffic", 2], ["Air station", "Air quality", 4],
    ["Water gauges", "Water level", 5], ["Road disruptions", "Roadworks", 3],
  ]) {
    const toggle = ui.toggle(label);
    assert.equal(scene.children[groupIndex].visible, true);
    t.mock.timers.tick(1_000);
    assert.equal(scene.children[groupIndex].visible, false, `${label} expires at its earliest deadline`);
    assert.equal(toggle.disabled, true);
    assert.equal(toggle.checked, false);
    assert.match(ui.card(title).querySelector(".data-body").textContent, /no longer current/);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    assert.equal(scene.children[groupIndex].visible, false, `${label} stays hidden after an attempted reactivation`);
  }
  t.mock.timers.tick(24 * 3600_000);
  const roadworks = ui.toggle("Road disruptions");
  roadworks.checked = true;
  roadworks.dispatchEvent(new Event("change"));
  assert.equal(scene.children[3].visible, false, "expired layer stays hidden after every expiry timer has stopped");
});

test("visibility and toggle changes recheck freshness when background timers are delayed", async (t) => {
  const ui = environment(t, "https://example.org/Rotterdam-Digital-Twin/v03/", "../");
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), "https://example.org/Rotterdam-Digital-Twin/data/rotterdam-snapshot.json");
    return { ok: true, json: async () => ({ schemaVersion: 1, traffic: {
      retrievedAt: iso(0), readings: [{ ...point, name: "Detector", observedAt: iso(1_000 - 90 * 60_000) }],
    } }) };
  });
  const scene = new Scene();
  await installCityLayers(scene, summary);
  t.mock.timers.setTime(now + 2_000);
  const toggle = ui.toggle("Traffic sensors");
  toggle.checked = true;
  toggle.dispatchEvent(new Event("change"));
  assert.equal(scene.children[2].visible, false);
  ui.document.dispatchEvent(new Event("visibilitychange"));
  assert.match(ui.card("Measured traffic").querySelector(".data-body").textContent, /no longer current/);
});

test("an empty traffic layer is disabled instead of appearing to contain current observations", async (t) => {
  const ui = environment(t);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ schemaVersion: 1,
    traffic: { retrievedAt: iso(0), readings: [] } }) }));
  const scene = new Scene();
  await installCityLayers(scene, summary);
  const toggle = ui.toggle("Traffic sensors (0)");
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, true);
  assert.equal(scene.children[2].visible, false);
});

test("snapshot fetch times out and leaves base map layers available", async (t) => {
  const ui = environment(t);
  let signal;
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  }));
  const scene = new Scene();
  const pending = installCityLayers(scene, summary);
  t.mock.timers.tick(8_000);
  await pending;
  assert.equal(signal.aborted, true);
  assert.ok(ui.card("Public data unavailable"));
  assert.equal(scene.children.length, 2);
  assert.equal(ui.toggle("3D buildings").checked, true);
});
