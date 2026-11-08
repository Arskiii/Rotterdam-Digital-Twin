# Independent observation collection

The website stays on Vercel (and GitHub Pages). A dedicated Railway service
collects public observations continuously, independent of site traffic, builds,
and GitHub's delayed scheduled workflows. `deploy.yml` now only builds/deploys
the website. There is one scheduled writer for the new archive.

- Website: https://rotterdam-digital-twin.vercel.app/
- Collection status: https://collector-production-4f31.up.railway.app/archive/status
- Health probe: https://collector-production-4f31.up.railway.app/health
- Railway project: `f4ca3847-3e83-42a6-96e2-aedd8d0e2a1f`
- Production environment: `048e53ab-2ded-4972-a5a2-db1b89c568ab`
- Service: `c252d515-492c-4d3c-9869-cef3dbc22c25` (`collector`)
- Persistent volume: `3d873e76-3d72-42e6-9f6d-46b5417d3411`, mounted at `/data`

## Collection and storage

The Node 24 process collects independent upstreams together every 120 seconds,
with a 25-second deadline and a 30-second retry after a failed collection. Runs
never overlap. A five-minute stalled-loop watchdog exits the process; Railway
restarts it. The service uses one replica, `ALWAYS` restart, no sleeping, and a
`/ready` deployment check. `/health` separately fails when successful durable
collection is at least five minutes old. A successful deployment is not proof
that observations were saved.

SQLite WAL with full synchronous transactions commits coarse records, fine
records, raw observations, events and the success heartbeat together. The
five-minute slot is unique. A later poll can improve a slot without duplicating
it; missing/older feed sections cannot replace a newer observation. Old or
future-dated snapshot envelopes are rejected. At least current traffic or
transit is required to archive a snapshot.

Raw compressed snapshots remain for 48 hours, fine sensor records for 45 days,
and coarse district/environment records indefinitely. Version 2 of the binary
archive reserves explicit missing-value sentinels. Version 1 remains readable;
its historical zero-versus-missing ambiguity cannot be resolved retrospectively.
Source observation times remain in the persisted coarse metadata and raw data.

The service reads the former GitHub archive for pre-cutover history and merges
the cutover hour. GitHub is now a historical read source, not a scheduling or
write dependency. A GitHub outage cannot hide newly saved records. The website
also keeps its historical-source fallback when the collector is unreachable.
Uncollected historical periods are not fabricated or backdated.

## Other feeds

- Corridor traffic, water, air and disruptions refresh every five minutes.
- Reference geometry and slow public layers refresh hourly.
- The national GTFS timetable, route identities and stops refresh daily from
  their original public source, in an isolated staging directory. The new file
  must pass the 14-day coverage check before its complete bundle is atomically
  activated. A valid previous bundle survives refresh failures and restarts.
- Released CBS neighborhood figures are checked weekly; their statistical
  reference year is not changed to the retrieval year.
- Corridor history retains seven days, with a 10,000-reading/4 MB guard. Two
  five-minute detector feeds require 4,032 records for a full week.

The first startup seeds real previous public data and a valid transit bundle
from their former branches if necessary. Subsequent refreshes contact providers
directly. Persistent data is never replaced with the packaged seed on restart.
Maintenance completion/error timestamps appear in `/archive/status`.

## Website behavior

`collection.config.json` sets the public collector origin for both frontends
and the Vercel API. `/api/live` reuses the persisted snapshot; on collector
failure it still calls providers directly. The timetable is downloaded only
when this fallback needs it. The collector exposes public GET/HEAD endpoints,
no write API, and never serves its database files.

Intelligence displays the collector heartbeat and actual completed/missing
slots. History coverage counts five-minute records rather than the elapsed
span between two distant records. Its timeline leaves gaps and missing
measurements empty. Wider ranges explicitly label sampled-hour coverage.

## Deployment and recovery

Build with `collector/Dockerfile` from the repository root. The reviewed Railway
service settings are recorded in `collector/railway-service.json` (the
`ServiceInstanceUpdateInput` shape). They are saved on the service; this is not
the retired `railway.json` format. Keep the public domain and `/data` mount when
redeploying. Source deployments track `main` with collector-related watch paths.
Website-only changes do not restart collection.

Daily and weekly Railway volume backups are enabled. A manual backup named
`Verified collector cutover` was created after the restart test. Restoring a
volume backup is a separate operator action in Railway's Backups tab: inspect
the selected recovery point, restore it to this service/environment, then
verify stored counts and two subsequent collection times. A cloud backup
restore has not been exercised against production.

For an incident, inspect `/archive/status` and service logs first. Distinguish
upstream errors from disk-write failures and a stalled process. Preserve the
database and its WAL; do not delete the volume to fix an application failure.
Restart/redeploy the service with the same mount. After recovery, compare the
saved `startedAt`, existing slot counts, advancing `lastStoredAt`, and actual
hour files. Old gaps stay reported until genuine retained observations can
recover them.

## Verification for the November 7, 2026 cutover

Local validation: 198 Vitest tests, 107 Node tests and 19 Python tests passed,
plus TypeScript and the production build/bundle budgets. Regression cases cover
duplicate polls, partial providers, stale/future times, interrupted transactions,
restart persistence, gap counts, retention, the staged timetable, missing values,
historical fallback and bounded non-overlapping retries.

Hosted verification observed successive two-minute captures, independent
public-data/CBS/GTFS jobs, advancing five-minute records, and a controlled
restart that preserved `startedAt` and existing slots before saving newer data.
All completed slots in that observation window were present. This verifies the
cutover window, not a long-term availability guarantee.
