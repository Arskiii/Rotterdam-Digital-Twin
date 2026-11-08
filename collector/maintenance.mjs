import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, copyFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodeTransitCatalog } from '../server/transit-catalog.mjs';
import { serviceDateNum } from '../scripts/fetch-live.mjs';

export function run(program, args, { env, timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(timeout), killSignal: 'SIGKILL' });
    let tail = '';
    const output = data => { tail = (tail + data).slice(-2000); console.log(String(data).trim()); };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${program} exited ${code}: ${tail.slice(-300)}`)));
  });
}
export async function seedData(dir) {
  await mkdir(dir, { recursive: true });
  // Migrate real retained observations once. Never replace a persistent copy on restart.
  for (const name of ['traffic-history.json', 'rotterdam-snapshot.json', 'cbs-neighborhoods.json']) {
    try { await stat(join(dir, name)); continue; } catch { /* initial volume */ }
    try {
      const response = await fetch(`https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/corridor-data/${name}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > 4_000_000) throw new Error('Seed file too large');
      JSON.parse(body);
      await writeFile(join(dir, name), body);
    } catch { await copyFile(resolve('public/data', name), join(dir, name)); }
  }
}
export function maintenanceJobs(store, dir) {
  const env = { PUBLIC_DATA_DIR: dir };
  const mark = (key, value) => store.set('maintenance', { ...(store.get('maintenance') ?? {}), [key]: value });
  const tracked = (key, interval, task) => async () => {
    const old = store.get('maintenance')?.[key];
    if (old?.version === 1 && old.lastSuccessAt && Date.now() - old.lastSuccessAt < interval) return;
    const startedAt = Date.now();
    mark(key, { ...old, startedAt, running: true });
    try {
      await task();
      mark(key, { version: 1, startedAt, lastSuccessAt: Date.now(), running: false });
    } catch (error) {
      mark(key, { ...old, startedAt, running: false, error: String(error.message).slice(0, 300) });
      throw error;
    }
  };
  return {
    publicData: tracked('publicData', 4 * 60_000, async () => {
      const full = Date.now() - (store.get('lastFullPublicAt') ?? 0) > 3_600_000;
      await run('python3', ['scripts/update_public_data.py', ...(full ? [] : ['--dynamic-only'])], { env });
      await run('python3', ['scripts/update_history.py'], { env });
      const snap = JSON.parse(await readFile(join(dir, 'rotterdam-snapshot.json'), 'utf8'));
      const latest = Math.max(...(snap.traffic?.readings ?? []).map(r => Date.parse(r.observedAt)));
      if (!(Date.now() - latest < 10 * 60_000)) throw new Error('No current corridor observations');
      if (full) store.set('lastFullPublicAt', Date.now());
    }),
    cbs: tracked('cbs', 7 * 86400_000, () => run('python3', ['scripts/fetch-cbs-neighborhoods.py'], { env })),
    transit: tracked('transit', 86400_000, async () => {
      const staging = join(dir, 'transit-staging');
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging);
      const transitEnv = { TRANSIT_DATA_DIR: staging };
      for (const script of ['fetch-gtfs-routes', 'fetch-gtfs-stops', 'fetch-gtfs-timetable', 'check-timetable']) {
        await run(process.execPath, [`scripts/${script}.mjs`, ...(script === 'check-timetable' ? ['--days', '14'] : [])], { env: transitEnv, timeout: 20 * 60_000 });
      }
      const output = join(staging, 'transit.json.gz');
      await run(process.execPath, ['scripts/pack-transit.mjs', output], { env: transitEnv });
      decodeTransitCatalog(await readFile(output));
      // Only a complete validated bundle is visible to live collection.
      await rename(output, join(dir, 'transit.json.gz'));
      await rm(staging, { recursive: true, force: true });
    }),
  };
}
export function persistentCatalog(dir) {
  const file = join(dir, 'transit.json.gz');
  let value, modified = 0;
  return async signal => {
    let info;
    try { info = await stat(file); }
    catch {
      // A one-time migration seed, independent daily refresh takes over above.
      const response = await fetch('https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/transit-data/transit.json.gz', { signal });
      if (!response.ok) throw new Error(`Transit seed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      decodeTransitCatalog(bytes);
      await writeFile(file + '.tmp', bytes); await rename(file + '.tmp', file);
      info = await stat(file);
    }
    if (!value || info.mtimeMs !== modified) { value = decodeTransitCatalog(await readFile(file)); modified = info.mtimeMs; }
    const day = serviceDateNum(new Date());
    if (!value.timetable.trips.some(t => value.timetable.dateSets[t.dates]?.has(day))) throw new Error('Stored transit calendar expired');
    return value;
  };
}
