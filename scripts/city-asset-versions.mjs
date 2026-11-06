import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CITY_FILES = ["meta.json", "roads.bin", "graph.bin", "water.bin", "rail.bin", "buildings.bin", "transit.bin", "districts.bin"];

// Content, rather than counts in meta.json, also catches height-only rebuilds.
export function cityAssetVersions(directory) {
  const versions = Object.fromEntries(CITY_FILES.map((name) => [
    name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex"),
  ]));
  const roofs = createHash("sha256").update(versions["buildings.bin"]);
  for (const name of readdirSync(join(directory, "roofs")).sort()) {
    roofs.update(name).update("\0").update(readFileSync(join(directory, "roofs", name)));
  }
  // A single directory version keeps hundreds of tile hashes out of the bundle.
  versions["roofs/"] = roofs.digest("hex");
  return versions;
}
