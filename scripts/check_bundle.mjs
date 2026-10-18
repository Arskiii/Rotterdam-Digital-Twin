import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const output = resolve("dist");
const manifest = JSON.parse(readFileSync(resolve(output, ".vite/manifest.json"), "utf8"));
const chunksByFile = new Map(Object.entries(manifest).map(([key, chunk]) => [chunk.file, key]));

function initialScripts(entry, files = new Set()) {
  const chunk = manifest[entry];
  if (!chunk) throw new Error(`Missing build entry: ${entry}`);
  if (files.has(chunk.file)) return files;
  files.add(chunk.file);
  for (const imported of chunk.imports ?? []) initialScripts(imported, files);
  return files;
}

// Count every shared dependency, not just the tiny entry chunk. Keep the analysis
// page independent of WebGL; workers are loaded on demand and checked separately.
for (const [entry, budget] of [["lab/index.html", 100_000], ["grid/index.html", 750_000], ["v03/index.html", 750_000]]) {
  // Identical map entry points may be emitted as shared chunks without an HTML
  // manifest key. Resolve the scripts actually emitted into each HTML document.
  const html = readFileSync(resolve(output, entry), "utf8");
  const files = new Set();
  for (const [, source] of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/g)) {
    const path = new URL(source, "https://build.invalid/").pathname;
    const file = [...chunksByFile.keys()].find((file) => path.endsWith(`/${file}`));
    if (!file) throw new Error(`Untracked JavaScript in ${entry}: ${source}`);
    initialScripts(chunksByFile.get(file), files);
  }
  if (!files.size) throw new Error(`No JavaScript emitted for ${entry}`);
  const scripts = [...files].map((file) => readFileSync(resolve(output, file)));
  const bytes = scripts.reduce((sum, script) => sum + script.length, 0);
  const compressed = scripts.reduce((sum, script) => sum + gzipSync(script).length, 0);
  console.log(`${entry}: ${(bytes / 1000).toFixed(1)} kB JavaScript (${(compressed / 1000).toFixed(1)} kB gzip); budget ${budget / 1000} kB`);
  if (bytes > budget) throw new Error(`${entry} exceeds its initial JavaScript budget by ${bytes - budget} bytes.`);
}

for (const asset of manifest["lab/index.html"].assets ?? []) {
  if (asset.endsWith(".js") && readFileSync(resolve(output, asset)).length > 100_000) {
    throw new Error(`Scenario worker exceeds its 100 kB JavaScript budget: ${asset}`);
  }
}
