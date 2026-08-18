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
- 264k building footprints extruded to their mapped heights, 7k water polygons
  (the Maas, harbours, the Rotte, lakes), rail/metro/tram lines

**Live multimodal simulation** (dedicated web worker):

- Cars, **bikes and pedestrians** on one graph with per-edge mode masks and
  per-mode reachable cores
- IDM car-following on per-lane FIFO queues (separate car and bike lanes);
  pedestrians free-flow and cross with the signals (walk when cars are held)
- A\* time-cost routing per mode; cars reroute around incidents
- **RET public transport**: trams and metros on their real OSM route relations,
  braking into stops, dwelling, and continuing (~280 vehicles on 39 routes)
- Signals: **vehicle-actuated by default** (Dutch-style gap-out green extension with
  demand detection at stop lines; switchable to fixed-time), signal faults, cycle-scale control
- Time-of-day demand curve (morning/evening peaks, 72× day compression)
- Per-district telemetry: tracks, mean speed, queues, congestion index
- **Target tracking**: click any car, bike, pedestrian, tram or metro to lock the
  camera on it — live speed + zone readout, a fading breadcrumb trail, and the name
  of the street it is on (10k-street name index); incidents appear as blinking map
  markers; hovering any road shows name · class · limit · district
- Day/night ambience follows the sim clock (dawn ≈ 06:00, dusk ≈ 21:30)

**Platform UI** (the SurveilTrack look):

- **UNIT MAP** — 3D city with drone observation units, unit detail card with live zone
  telemetry, City/District/Street camera scales, layer control (structures, roads,
  signals, vehicles, congestion flux, hydro, rail, labels)
- **BRIEF** — city KPIs, flow chart, event feed, district posture
- **SETUP** — fleet density, physics rate, signal cycle scale, time of day, incident
  injection, render scale
- Dock: unit list, live statistics, district performance table, coverage overview,
  message log

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
npm run fetch-data   # tiled Overpass downloads → data/raw/ (~280 MB, resumable)
npm run build-data   # → public/data/*.bin + meta.json (~17 MB)
```

## Architecture

```
scripts/
  fetch-osm.mjs      tiled Overpass fetch (roads, signals, buildings, water, rail)
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
