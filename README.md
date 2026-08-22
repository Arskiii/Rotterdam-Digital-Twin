# SurveilTrack — Rotterdam Intelligence Platform

A browser-based city intelligence platform for **the whole of Rotterdam**: the real street
network, every mapped traffic light, a quarter-million buildings and a live agent-based
traffic simulation — wrapped in a dark tactical operations UI.

## What's inside

**Real city data** (OpenStreetMap, ODbL):

- ~5,100 km of roadway plus ~3,600 km of cycleways and footpaths across greater
  Rotterdam (Hoogvliet → Nesselande, Overschie → IJsselmonde, plus Schiedam and
  Capelle for network continuity and the full A4/A15/A16/A20 motorway ring)
- **4,349 traffic-signal heads — 4,331 bound to the multimodal network**, clustered
  into **472 signalized junctions** and standalone crossings, each running a
  fixed-time two-phase controller
- 264k building footprints extruded to sourced heights — **96.8% carry
  measured 3D BAG (BAG × AHN LiDAR) roof heights**, the rest OSM
  `height`/`building:levels` tags, `building:part` tower shafts as their own
  prisms, and published heights anchoring the named skyline towers
  (Zalmhaventoren 203 m, De Rotterdam, Maastoren, Delftse Poort, …) — plus 7k
  water polygons (the Maas, harbours, the Rotte, lakes) and rail/metro/tram
  lines
- **True roofscape at street zoom**: 216k slanted-roof buildings carry their
  real LoD2.2 roof geometry (3D BAG's LiDAR-reconstructed ridges, hips,
  gables and dormers), packed into 354 one-kilometer tiles (28 MB) that
  stream in around the camera and swap with the block model per tile;
  flat-roofed buildings keep their prisms, which are already the true shape

**Live multimodal simulation** (dedicated web worker):

- Cars, **bikes and pedestrians** on one graph with per-edge mode masks and
  per-mode reachable cores
- IDM car-following on per-lane FIFO queues (separate car and bike lanes);
  pedestrians free-flow and cross with the signals (walk when cars are held)
- A\* time-cost routing per mode; cars reroute around incidents
- **RET public transport**: trams and metros on their real OSM route relations,
  braking into stops, dwelling, and continuing (~280 vehicles on 39 routes).
  This is the *modelled* fleet — evenly spaced, not on the timetable — and it
  runs in SIMULATION mode. The real trams and metros are a live feed; see below.
- Signals: **vehicle-actuated by default** (Dutch-style gap-out green extension with
  demand detection at stop lines), plus a **green-wave program** — 61 corridors of
  same-street junctions with 45 km/h progression offsets — and fixed-time; signal
  faults, cycle-scale control
- Time-of-day demand curve (morning/evening peaks, 72× day compression)
- Per-district telemetry: tracks, mean speed, queues, congestion index
- **Target tracking**: click any car, bike, pedestrian, tram or metro to lock the
  camera on it — live speed + zone readout, a fading breadcrumb trail, and the name
  of the street it is on (10k-street name index); incidents appear as blinking map
  markers; hovering any road shows name · class · limit · district
- Day/night ambience follows the sim clock (dawn ≈ 06:00, dusk ≈ 21:30); the RET
  fleet thins to night service after midnight; observation drones patrol their zones
- **Flux replay**: the platform records the congestion picture every 10 s — scrub back
  through the last 40 minutes on a timeline and watch rush hour build and dissolve
- Real district boundaries (OSM admin polygons) with map labels

**Platform UI** (the SurveilTrack look):

- **UNIT MAP** — 3D city with drone observation units, unit detail card with live zone
  telemetry, City/District/Street camera scales, layer control (structures, roads,
  signals, vehicles, congestion flux, hydro, rail, labels)
- **Search** (`/`) — one index over every named thing on the map: ~10k street
  names from the graph, the 610 NDW sensor stations, every RET stop the live
  feed publishes, and the fifteen districts. Diacritic- and
  punctuation-insensitive, so `gravendijkwal` and `sgravendijkwal` both find
  `'s-Gravendijkwal`. Arrow keys move, ⏎ flies the camera there. A street is
  indexed on the most important way carrying its name, not the longest — Dutch
  streets carry a named cycleway alongside the carriageway, and length alone
  made the Coolsingel a cycleway.
- **BRIEF** — mode-aware. In LIVE it leads with what was *measured* (stations
  reporting, mean sensor speed, measured congestion against posted limits, real
  incidents, transit in service); in SIMULATION with the model's own figures; in
  HISTORY with the archive record under the scrub head. Every panel carries a
  MEASURED or MODELLED chip, and a district with no reporting station is drawn
  as absent rather than as free-flowing.
- **SETUP** — fleet density, physics rate, signal cycle scale, time of day, incident
  injection, render scale. Every control is disabled outside SIMULATION,
  scenarios and the signal trial included, with one button back to it.
- **TRANSIT** (dock) — how the network is running, line by line: vehicles out,
  median running delay over that line's own reporting trips, its worst trip,
  and the sample behind both. The aggregate neither the map nor a departure
  board can give you. Three states, and only one of them is a claim about
  punctuality: **measured** (trips reported a delay), **running** (vehicles
  out, nothing reporting a delay yet) and **not reporting** (the timetable
  lists services and nothing is reporting at all). At 05:30 every rail line in
  the city is the last of those — a rollup that averaged the zeroes would have
  called that a perfect network. Defaults to the exceptions, because at rush
  hour sixty of the eighty-four lines are running to time and those are the
  rows nobody needs to read. Needs no simulation, so it works on a phone.
- Dock: unit list, transit health, live statistics, district performance table,
  coverage overview, message log
- **Keyboard**: `/` search · `1`/`2`/`3` mode · `L` layers · `?` the list ·
  `Esc` close or release. Focus is visible throughout, and
  `prefers-reduced-motion` turns camera flights into cuts.
- **Works offline.** A service worker holds the 27 MB of city binaries past the
  ten minutes GitHub Pages allows, so a second visit is instant and the map
  opens with no network at all. It never caches `live.json` (a measurement of
  now) or `meta.json` (the version signal, which is how it knows to drop a
  stale city). `?nosw=1` unregisters it and clears its caches.

**Three maps, one city** — a mode switch in the header decides what you are
looking at, because these are different questions and one map cannot answer
all three honestly:

- **LIVE** — only what was measured. Real transit vehicles, sensor-measured
  congestion, real incidents and bridge openings. It deliberately does *not*
  draw synthetic traffic: the NDW network gives flows at 610 stations, not
  vehicle positions, so cars nobody observed would be fiction.
- **SIMULATION** — the model, with the variables unlocked: fleet density,
  demand curve, signal program, injected incidents.
- **HISTORY** — the archive, scrubbed. Congestion over the last day, week or
  month with incident ticks, reading out the moment you land on. The bar says
  how much of the window the archive actually holds, and turns amber under two
  thirds of it: the record starts when the refresh loop started, and a 30-day
  chart drawn from two days of readings is flat and empty for most of its
  width — which reads as a quiet city rather than an absent record.

**Live city feeds** (refreshed every 2 minutes by `.github/workflows/deploy.yml`
onto the `live` branch; the app polls it and falls back to the committed
snapshot — the header chip shows the snapshot's real age, and once it goes
stale the app says so instead of presenting old traffic as current):

- **NDW live traffic** (opendata.ndw.nu, minutely): real flows for the 610
  matched stations re-feed the calibration loop continuously instead of a
  one-off snapshot, and the sensor-net layer colors each station by measured
  speed against its edge's limit — live congestion, green → amber → red
- **Live incidents** (NDW situation feed): real accidents, obstructions, jams
  and road closures inside the coverage area render as pulsing markers, and
  the matched edges slow down (accidents to 35% capacity) or sever (closures)
  in the sim, with event-log announcements naming the street
- **Bascule bridge openings** (NDW situation feed): a bridge open for shipping
  severs its car edges in the sim until it closes — traffic reroutes live
- **Real transit, with identity** (OVapi GTFS-RT): every tram, metro, bus and
  Waterbus ferry in the coverage area, carrying its line, trip, the stop it is
  working toward and whether it is berthed. Click one to follow it; the
  readout gives the age of its position fix rather than a speed, because
  OVapi publishes neither speed nor bearing for rail and inventing one would
  be a fabricated measurement. Heading comes from where a vehicle was actually
  observed to move.
- **Departure boards**: click any RET metro or tram station for what is
  coming, where it is going, in how many minutes and how late it is running.
  Scheduled time + live running delay, which is the arithmetic a platform
  display does; rows with no live position say SCHED rather than implying a
  measurement that does not exist. Grouped by parent station, so Beurs shows
  all five metro lines rather than one board per platform.
- **Maas water level** (Rijkswaterstaat, Boompjes tide gauge): the river
  surface rides the real tide; **weather** (Buienradar Rotterdam): rain slows
  motorized traffic; **air quality** (Luchtmeetnet, 9 DCMR stations): NO₂/PM2.5
  as a toggleable station layer
- `npm run fetch-live` produces the snapshot on demand

**The archive** — every snapshot is folded into a history on the `archive`
branch by `scripts/archive-live.mjs`, so the platform can answer what the city
was doing last Tuesday at 08:20:

- `c/YYYY/MM/DD/HH.bin` — coarse: per district plus city scalars (weather,
  tide, incidents, transit count, air), one record per 5 minutes, ~1 KB an
  hour, kept indefinitely (~9 MB a year)
- `f/YYYY/MM/DD/HH.bin` — fine: every NDW station's flow and speed at the same
  cadence, ~22 KB an hour, pruned to a rolling 45-day window
- `e/YYYY-MM.json` — incidents and bridge openings, deduped
- Appends are idempotent, so a re-run over the same snapshot changes nothing

**Why the refresh job looks the way it does.** For most of this repo's life
the `schedule:` trigger never fired at all — zero `schedule` events in the run
history, and observed refresh gaps of up to five hours, so "every 5 minutes"
really meant "whenever someone pressed the button". It now fires reliably from
`deploy.yml`, and only from there: a second workflow added later with the same
cron never armed once. Two lessons are baked in as a result.

The job stays in `deploy.yml` because that is the file whose cron demonstrably
works in this repo. Moving it out stopped the refresh dead.

There is exactly one publisher of `live` and `archive`, and it writes a
`vercel.json` onto each. Both branches hold data, not an app, so Vercel's git
integration otherwise builds them on every push and fails — one failed
deployment every five minutes. When two workflows published `live` and only
one wrote the guard, each force-push replaced the other's tree and the
failures came back intermittently. Any future publisher of these branches must
write that file.

Within a run the job loops rather than fetching once and exiting, so the
snapshot stays current between sparse firings instead of ageing out.

The cadence is two minutes rather than one because
`raw.githubusercontent.com` serves the live branch with `cache-control:
max-age=300`, and a cache-busting query string does not get past it (verified
— `x-cache: HIT` either way, identical body). Five minutes is a hard floor on
how fresh this data can reach a browser, so publishing faster buys nothing
downstream and only doubles the load on NDW and OVapi, who serve these feeds
for free. The freshness chip is calibrated to that floor: a healthy feed reads
as a few minutes old, and only genuine outages show amber or red.

**Calibration & validation against official data:**

- **NDW real traffic counts** (opendata.ndw.nu): `npm run fetch-ndw` ingests the national
  loop-detector network — 1,687 live sites in the coverage area, grouped into 613
  stations matched onto our edges. The sim counts its own vehicles passing every
  station and reports live sim-vs-measured flow (normalized via the demand curve);
  SETUP → Auto-calibrate scales fleet density toward parity and reports the residual
  as a 1:N representation factor.
- **UDAP iVRI registry**: all 82 official smart-traffic-light installations in the
  coverage area match one of our signal clusters (Rotterdam 61/61 ≤ 75 m, median 28 m)
  — `node scripts/validate-signals.mjs`.
- **NWB road register** (PDOK): 94.3% of 70,367 official road segments (89% of km)
  covered — motorways 98.4% of km; the residual is ferries, rural dike tracks and
  bbox-edge clipping — `node scripts/validate-roads.mjs`.
- **Building heights**: footprints come from OSM's BAG import (the official
  Dutch buildings register), so geometry is register-accurate. Heights resolve
  through a source chain — measured **3D BAG** roof heights (TU Delft,
  BAG × AHN LiDAR, CC BY 4.0; **96.8% of all footprints** in the committed
  data; `npm run fetch-heights` + `npm run apply-heights` regenerates) → OSM
  `height` / `building:levels` tags and `building:part` shafts → published
  heights for 17 named towers (`scripts/landmark-heights.json`, verified
  against the skyline literature) → a deterministic 5–11 m low-rise estimate
  for the remaining unmatched fabric. Podium+tower pands whose area-weighted
  percentile reads the podium are verified against 3D BAG roof planes before
  taking the tower height, which also rejects crane/pylon returns in the point
  cloud. `npm run audit-buildings` reports the distribution and checks every
  named tower against its published height (currently 17/17 within ±7 m; 28
  prisms over 100 m vs ~27 such buildings in the literature).

## Run locally

```bash
npm install
npm run dev
npm test        # vitest: binary parsers, snapshot migrations, archive
                # patterns, the search matcher, the format helpers
```

`npm run build` runs the workflow guards, `tsc --noEmit`, the test suite and
then Vite, so CI cannot publish a build whose parsers or migrations have
drifted.

Open `http://localhost:5173`. Left-drag pans, right-drag orbits, scroll zooms toward the
cursor. Everything in the UI is live. The layout is responsive: on phones the
console collapses to a full-bleed map with compact chrome, and the canvas takes
standard touch gestures (one-finger pan, two-finger pinch/rotate).

## Rebuild the city data

Processed binaries in `public/data/` are committed. To regenerate from OpenStreetMap:

```bash
npm run fetch-data      # tiled Overpass downloads → data/raw/ (~280 MB, resumable)
npm run fetch-heights   # 3D BAG measured heights → data/heights-3dbag.json (optional)
npm run build-data      # → public/data/*.bin + meta.json (~17 MB)
npm run fetch-roofs     # 3D BAG LoD2.2 roof geometry → public/data/roofs/ (28 MB;
                        #   downloads ~600 MB of CityJSON, cached + resumable)
npm run fetch-stops     # RET stop names/coords → data/gtfs-stops.json (byte-range
                        #   reads, ~1.5 MB of a 215 MB zip)
npm run fetch-timetable # RET metro/tram schedule → data/ret-timetable.bin (3.3 MB;
                        #   streams 1 GB of stop_times, filtered on the fly).
                        #   Rerun when RET republishes — a few times a year.
```

To upgrade heights on the committed binaries without a full rebuild:
`npm run fetch-heights && npm run apply-heights` (patches
`public/data/buildings.bin` in place), then `npm run audit-buildings`.

## Architecture

```
scripts/
  fetch-osm.mjs      tiled Overpass fetch (roads, signals, buildings + parts, water, rail)
  fetch-heights.mjs  3D BAG WFS fetch → measured roof heights per building
  fetch-lod2.mjs     3D BAG CityJSON fetch → true LoD2.2 roof tiles (public/data/roofs/)
  fetch-live.mjs     live snapshot: NDW traffic + bridges, OVapi GTFS-RT vehicles
                     and departure boards, RWS water, Buienradar weather,
                     Luchtmeetnet air → public/data/live/live.json
  fetch-gtfs-stops.mjs      stop names/coords via byte-range reads into the
                            215 MB national GTFS → data/gtfs-stops.json
  fetch-gtfs-timetable.mjs  RET metro/tram schedule, streaming 1 GB of
                            stop_times → data/ret-timetable.bin (3.3 MB)
  archive-live.mjs   folds each snapshot into the two-tier history archive
  apply-heights.mjs  patch heights into buildings.bin without a rebuild
  audit-buildings.mjs  height distribution + landmark verification report
  lib-heights.mjs    shared projection/RD conversion, matching, landmark logic
  build-data.mjs     projection, graph build, signal clustering, SCC, triangulation,
                     quantized binary packing
src/
  data/loader.ts     binary parsers (shared by main thread + worker)
  data/live.ts       live snapshot polling, freshness and staleness gating
  data/archive.ts    historical archive reader for the history scrubber
  sim/worker.ts      traffic engine: signals, IDM, A*, demand, incidents, metrics
  sim/protocol.ts    typed worker messages
  render/scene.ts    camera, MapControls, scale presets, fog
  render/city.ts     road ribbons + line overlay, water shader, building extrusion
  render/dynamic.ts  signal points, instanced vehicles, congestion lines
  render/drone.ts    wireframe drone viewer (unit card)
  ui/chrome.ts       DOM chrome (header, rail, cards, dock, boot)
  ui/app.ts          application controller: pages, units, telemetry, events
  ui/search.ts       the place index and its matcher (pure, no DOM)
  data/transit-health.ts  per-line rollup of the live fleet and boards (pure)
  data/sw-register.ts  service-worker registration, data fingerprint, ?nosw=1
  main.ts            boot sequence
public/
  sw.js              offline cache: the city binaries and the app shell
```

Tests sit beside what they cover (`*.test.ts`) and run without a DOM.

Deploys to GitHub Pages via `.github/workflows/deploy.yml` (pushes to `main`).

Map data © OpenStreetMap contributors, ODbL.
