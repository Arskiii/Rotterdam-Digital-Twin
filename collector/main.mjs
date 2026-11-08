import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectLiveSnapshot } from '../scripts/fetch-live.mjs';
import { ArchiveStore } from './store.mjs';
import { createHandler } from './http.mjs';
import { startLoop } from './loop.mjs';
import { seedData, maintenanceJobs, persistentCatalog } from './maintenance.mjs';

const dir = resolve(process.env.ARCHIVE_DATA_DIR || '/data');
mkdirSync(dir, { recursive: true });
const stations = JSON.parse(readFileSync('public/data/ndw.json', 'utf8')).stations;
const store = new ArchiveStore(join(dir, 'archive.sqlite'), stations);
const catalog = persistentCatalog(dir);
const server = createServer(createHandler({ store, dataDir: dir }));
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Archive collector listening'));
const stops = [];
stops.push(startLoop(async () => {
  store.attempt(Date.now());
  const signal = AbortSignal.timeout(25_000);
  const transit = catalog(signal); transit.catch(() => {});
  try {
    const snapshot = await collectLiveSnapshot({ signal, transit });
    const written = store.save(snapshot);
    console.log(JSON.stringify({ event: 'collected', at: snapshot.t, written, coverage: store.status().coverage }));
  } catch (error) { store.fail(error, Date.now()); throw error; }
}));
// A stalled loop is a process failure; Railway's ALWAYS policy restarts it.
const watchdog = setInterval(() => {
  if (Date.now() - (store.get('lastAttemptAt') ?? 0) > 5 * 60_000) {
    console.error('Collection loop stalled'); process.exit(1);
  }
}, 30_000);
await seedData(dir);
const jobs = maintenanceJobs(store, dir);
stops.push(startLoop(jobs.publicData, { interval: 300_000, retry: 60_000 }));
stops.push(startLoop(jobs.transit, { interval: 3_600_000, retry: 15 * 60_000 }));
stops.push(startLoop(jobs.cbs, { interval: 86400_000, retry: 3_600_000 }));
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(watchdog);
  server.close();
  // SQLite commits are synchronous and atomic; do not delay a deployment for
  // the large daily GTFS refresh. Its staging files are safe to discard.
  const deadline = setTimeout(() => process.exit(0), 30_000);
  await Promise.all(stops.map(stop => stop()));
  store.close(); clearTimeout(deadline); process.exit(0);
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
