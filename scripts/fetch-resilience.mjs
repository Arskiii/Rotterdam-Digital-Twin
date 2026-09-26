// Download three styled, modelled resilience surfaces from Rotterdam's public GIS.
// Raster export keeps the full city affordable: the water and noise layers alone
// contain over 140,000 polygons. No live conditions are inferred from these maps.
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invPx, invPy, rdToWgs, wgsToRd, px, py } from "./lib-heights.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = resolve(root, "public/data/resilience");
const meta = JSON.parse(await readFile(resolve(root, "public/data/meta.json"), "utf8"));
const extent = meta.extent;
const rdCorners = [extent.minX, extent.maxX].flatMap((x) =>
  [extent.minY, extent.maxY].map((y) => wgsToRd(invPy(y), invPx(x))));
const roundDown = (value) => Math.floor((value - 500) / 1000) * 1000;
const roundUp = (value) => Math.ceil((value + 500) / 1000) * 1000;
const bbox = [
  roundDown(Math.min(...rdCorners.map((p) => p.x))),
  roundDown(Math.min(...rdCorners.map((p) => p.y))),
  roundUp(Math.max(...rdCorners.map((p) => p.x))),
  roundUp(Math.max(...rdCorners.map((p) => p.y))),
];
const width = 2048;
const height = Math.round(width * (bbox[3] - bbox[1]) / (bbox[2] - bbox[0]));
if (height > 4096) throw new Error("GIS export exceeds the service's image limit");
const source = "https://diensten.rotterdam.nl/arcgis/rest/services/SO_IBURO/DGO_data/MapServer";
const layers = [
  { id: "cooling", number: 3, label: "Distance to cool resting places at 38°C", legend: "75 · 150 · 300 · 700 m" },
  { id: "flood", number: 13, label: "Modelled water depth over 25 cm", legend: ">25 cm" },
  { id: "noise", number: 20, label: "Cumulative day and night noise exposure", legend: "54–56 · 56–60 · 60–65 · 65–70 · >70 dB" },
];
const corner = (x, y) => {
  const point = rdToWgs(x, y);
  return [Math.round(px(point.lon) * 100) / 100, Math.round(py(point.lat) * 100) / 100];
};

await mkdir(out, { recursive: true });
for (const layer of layers) {
  const query = new URLSearchParams({
    f: "image", bbox: bbox.join(","), bboxSR: "28992", imageSR: "28992",
    size: `${width},${height}`, format: "png32", transparent: "true",
    layers: `show:${layer.number}`,
  });
  const url = `${source}/export?${query}`;
  let png;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      png = Buffer.from(await response.arrayBuffer());
      if (png.length > 12_000_000 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
          png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
        throw new Error("Invalid GIS PNG response");
      }
      break;
    } catch (error) {
      if (attempt === 2) throw new Error(`${layer.id}: ${error}`);
      await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
    }
  }
  const target = resolve(out, `${layer.id}.png`);
  await writeFile(`${target}.tmp`, png);
  await rename(`${target}.tmp`, target);
  console.log(`${layer.id}: ${Math.round(png.length / 1024)} KiB`);
}

const metadata = {
  schemaVersion: 1,
  source,
  retrievedAt: new Date().toISOString(),
  modelledNotLive: true,
  image: { width, height, bboxRd: bbox,
    // Texture UVs: bottom-left, bottom-right, top-right, top-left.
    cornersLocal: [corner(bbox[0], bbox[1]), corner(bbox[2], bbox[1]),
      corner(bbox[2], bbox[3]), corner(bbox[0], bbox[3])] },
  layers: Object.fromEntries(layers.map((layer) => [layer.id, {
    name: layer.label, legend: layer.legend, sourceLayer: layer.number,
    image: `${layer.id}.png`,
  }])),
};
const target = resolve(out, "index.json");
await writeFile(`${target}.tmp`, JSON.stringify(metadata, null, 2) + "\n");
await rename(`${target}.tmp`, target);
