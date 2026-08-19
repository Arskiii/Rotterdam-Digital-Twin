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

**Live multimodal simulation** (dedicated web worker):

- Cars, **bikes and pedestrians** on one graph with per-edge mode masks and
  per-mode reachable cores
- IDM car-following on per-lane FIFO queues (separate car and bike lanes);
  pedestrians free-flow and cross with the signals (walk when cars are held)
- A\* time-cost routing per mode; cars reroute around incidents
- **RET public transport**: trams and metros on their real OSM route relations,
  braking into stops, dwelling, and continuing (~280 vehicles on 39 routes)
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
- **BRIEF** — city KPIs, flow chart, event feed, district posture
- **SETUP** — fleet density, physics rate, signal cycle scale, time of day, incident
  injection, render scale
- Dock: unit list, live statistics, district performance table, coverage overview,
  message log

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
```

Open `http://localhost:5173`. Left-drag pans, right-drag orbits, scroll zooms toward the
cursor. Everything in the UI is live.

## Rebuild the city data

Processed binaries in `public/data/` are committed. To regenerate from OpenStreetMap:

```bash
npm run fetch-data      # tiled Overpass downloads → data/raw/ (~280 MB, resumable)
npm run fetch-heights   # 3D BAG measured heights → data/heights-3dbag.json (optional)
npm run build-data      # → public/data/*.bin + meta.json (~17 MB)
```

To upgrade heights on the committed binaries without a full rebuild:
`npm run fetch-heights && npm run apply-heights` (patches
`public/data/buildings.bin` in place), then `npm run audit-buildings`.

## Architecture

```
scripts/
  fetch-osm.mjs      tiled Overpass fetch (roads, signals, buildings + parts, water, rail)
  fetch-heights.mjs  3D BAG WFS fetch → measured roof heights per building
  apply-heights.mjs  patch heights into buildings.bin without a rebuild
  audit-buildings.mjs  height distribution + landmark verification report
  lib-heights.mjs    shared projection/RD conversion, matching, landmark logic
  build-data.mjs     projection, graph build, signal clustering, SCC, triangulation,
                     quantized binary packing
src/
  data/loader.ts     binary parsers (shared by main thread + worker)
  sim/worker.ts      traffic engine: signals, IDM, A*, demand, incidents, metrics
  sim/protocol.ts    typed worker messages
  render/scene.ts    camera, MapControls, scale presets, fog
  render/city.ts     road ribbons + line overlay, water shader, building extrusion
  render/dynamic.ts  signal points, instanced vehicles, congestion lines
  render/drone.ts    wireframe drone viewer (unit card)
  ui/chrome.ts       DOM chrome (header, rail, cards, dock, boot)
  ui/app.ts          application controller: pages, units, telemetry, events
  main.ts            boot sequence
```

Deploys to GitHub Pages via `.github/workflows/deploy.yml` (pushes to `main`).

Map data © OpenStreetMap contributors, ODbL.
