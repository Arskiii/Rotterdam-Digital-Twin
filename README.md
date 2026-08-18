# SurveilTrack — Rotterdam Intelligence Platform

A browser-based city intelligence platform for **the whole of Rotterdam**: the real street
network, every mapped traffic light, a quarter-million buildings and a live agent-based
traffic simulation — wrapped in a dark tactical operations UI.

## What's inside

**Real city data** (OpenStreetMap, ODbL):

- ~5,100 km of roadway across greater Rotterdam (Hoogvliet → Nesselande, Overschie →
  IJsselmonde, plus Schiedam and Capelle for network continuity and the full
  A4/A15/A16/A20 motorway ring)
- **4,349 traffic-signal heads** — 2,421 bound to the drivable network, clustered into
  **556 signalized junctions** and 28 standalone crossings, each running a fixed-time
  two-phase controller
- 264k building footprints extruded to their mapped heights, 7k water polygons
  (the Maas, harbours, the Rotte, lakes), rail/metro/tram lines

**Live traffic simulation** (dedicated web worker):

- Thousands of concurrent vehicles with IDM car-following on per-lane FIFO queues
- A\* time-cost routing over the strongly-connected core; reroutes around incidents
- Signals: green/amber/red phases per junction cluster, signal faults, cycle-scale control
- Time-of-day demand curve (morning/evening peaks, 72× day compression)
- Per-district telemetry: tracks, mean speed, queues, congestion index

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
