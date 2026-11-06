// Prepare the study network once per build instead of parsing the full OSM city
// on every visit. Use the same adapter as the editor so routes and seeds agree.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { gzipSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { createServer } from "vite";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const vite = await createServer({ configFile: false, root: root.pathname,
  server: { middlewareMode: true, hmr: { server: createHttpServer() } } });
const previousParser = globalThis.DOMParser;
try {
  globalThis.DOMParser = DOMParser;
  const { buildOsmNetwork } = await vite.ssrLoadModule("/src/v03/osm.ts");
  const { packNetwork, unpackNetwork } = await vite.ssrLoadModule("/src/lab/networkSnapshot.ts");
  const xml = await readFile(new URL("public/map.osm", root), "utf8");
  const { network, origin } = buildOsmNetwork(xml);
  const snapshot = packNetwork(network);
  // Includes insertion order, lane turns, signal phases and all road references.
  const encodedNetwork = JSON.stringify(snapshot);
  assert.equal(JSON.stringify(packNetwork(unpackNetwork(JSON.parse(encodedNetwork)))), encodedNetwork);
  const json = JSON.stringify({ version: 1, sourceSha256: createHash("sha256").update(xml).digest("hex"), origin, network: snapshot });
  await mkdir(new URL(".generated/", root), { recursive: true });
  await writeFile(new URL(".generated/study-network.json", root), json);
  console.log(`Study network: ${network.nodes.size} nodes, ${network.edges.size} roads; ${(Buffer.byteLength(xml) / 1000).toFixed(1)} kB XML (${(gzipSync(xml).length / 1000).toFixed(1)} kB gzip) → ${(Buffer.byteLength(json) / 1000).toFixed(1)} kB JSON (${(gzipSync(json).length / 1000).toFixed(1)} kB gzip)`);
  if (process.argv.includes("--benchmark")) {
    const measure = (fn) => {
      const times = [];
      for (let i = 0; i < 5; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); }
      return times.sort((a, b) => a - b)[2].toFixed(2);
    };
    console.log(`Local Node median of 5: XML adapter ${measure(() => buildOsmNetwork(xml))} ms; JSON restore ${measure(() => unpackNetwork(JSON.parse(json).network))} ms. Not a browser FPS or page-load measurement.`);
  }
} finally {
  if (previousParser === undefined) delete globalThis.DOMParser;
  else globalThis.DOMParser = previousParser;
  await vite.close();
}
