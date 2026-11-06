import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CITY_FILES, cityAssetVersions } from "../scripts/city-asset-versions.mjs";

test("city versions follow file contents even when metadata counts stay identical", () => {
  const directory = mkdtempSync(join(tmpdir(), "rtm-city-versions-"));
  try {
    for (const name of CITY_FILES) writeFileSync(join(directory, name), name);
    mkdirSync(join(directory, "roofs"));
    writeFileSync(join(directory, "roofs/index.json"), "{}");
    writeFileSync(join(directory, "roofs/0_0.bin"), "roof");
    const before = cityAssetVersions(directory);
    assert.deepEqual(cityAssetVersions(directory), before);
    writeFileSync(join(directory, "buildings.bin"), "new heights, same counts");
    const after = cityAssetVersions(directory);
    assert.notEqual(after["buildings.bin"], before["buildings.bin"]);
    assert.notEqual(after["roofs/"], before["roofs/"]);
    assert.equal(after["meta.json"], before["meta.json"]);
    assert.equal(after["graph.bin"], before["graph.bin"]);
    writeFileSync(join(directory, "roofs/0_0.bin"), "changed roof geometry");
    assert.notEqual(cityAssetVersions(directory)["roofs/"], after["roofs/"]);
    for (const hash of Object.values(after)) assert.match(hash, /^[a-f0-9]{64}$/);
  } finally { rmSync(directory, { recursive: true }); }
});
