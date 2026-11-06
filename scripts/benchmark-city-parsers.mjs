import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const baseline = process.argv[2] ?? '527fca9d72c347a6f79fb76c898b6601e9ca5505';
if (!/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error('Pass a baseline Git commit SHA.');
if (!global.gc) throw new Error('Run with node --expose-gc scripts/benchmark-city-parsers.mjs');
const require = createRequire(root + '/package.json');
const ts = require('typescript');
async function parserModule(source) {
  source = source.replace(/import \{ fetchCityBuffer, fetchCityJson \} from "\.\/city-assets";/, '');
  source = source.replace(/(?<!export )function (parsePolylines|parseBuildings)\(/g, 'export function $1(');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}
// Only pure binary parsers run here; network helpers are deliberately removed.
const before = await parserModule(execFileSync('git', ['show', `${baseline}:src/data/loader.ts`], { cwd: root, encoding: 'utf8' }));
const after = await parserModule(fs.readFileSync(root + '/src/data/loader.ts', 'utf8'));
const specs = [['roads.bin', 'parsePolylines', 0x524d5452], ['rail.bin', 'parsePolylines', 0x4c4d5452], ['buildings.bin', 'parseBuildings']];
const results = [];
for (const [file, fn, magic] of specs) {
  const bytes = fs.readFileSync(root + '/public/data/' + file);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const oldValue = before[fn](buf, magic), newValue = after[fn](buf, magic);
  assert.deepEqual(newValue, oldValue, file + ' must retain every scalar and array element');
  const hash = createHash('sha256');
  function digest(value) {
    if (ArrayBuffer.isView(value)) {
      hash.update(value.constructor.name);
      hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) { hash.update(key); digest(child); }
    } else hash.update(JSON.stringify(value));
  }
  digest(newValue);
  const bench = (m) => {
    const times = [], heaps = [];
    for (let i = 0; i < 9; i++) {
      global.gc();
      const memory = process.memoryUsage().heapUsed, start = performance.now();
      const result = m[fn](buf, magic);
      times.push(performance.now() - start);
      heaps.push(process.memoryUsage().heapUsed - memory);
      assert.ok(result);
    }
    times.sort((a, b) => a - b); heaps.sort((a, b) => a - b);
    return { medianMs: +times[4].toFixed(2), medianHeapDeltaMB: +(heaps[4] / 1e6).toFixed(2) };
  };
  results.push({ file, sha256: hash.digest('hex'), before: bench(before), after: bench(after) });
}
console.log(JSON.stringify(results, null, 2));
