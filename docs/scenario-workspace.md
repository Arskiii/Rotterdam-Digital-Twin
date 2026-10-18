# Scenario workspace

Browser-based 3D exploration and traffic simulation of Rotterdam. The main page
retains the city-wide explorer and Intelligence platform. `/v03/` opens the
separate corridor traffic editor used by scenario studies.
`/lab/` compares signal strategies and `/grid/` provides a fictional 2×3 playground.

The explorer has a dedicated map viewport, responsive sidebar, source details,
and quick pause, speed, top-view, and reset-view controls. Simulation metrics are
explicitly distinguished from public observations. See [the platform review](platform-review.md)
for verified fixes, remaining model limits, and the proposed next priorities.
See the [performance review](performance-review.md) for worker-based scenario
calculations, rendering improvements, measured bundle sizes, and enforced build budgets.
The [corridor workflow review](corridor-workflow.md) covers map selection,
portable scenario reports, retained observation history, and their verification.

## What it does

- Six signalized intersections on a grid network.
- Cars enter from perimeter "stubs" via independent **Poisson processes** (you set total
  cars/hour; arrivals at each entry are exponential inter-arrivals). Routes end at an exit.
- Cars follow the **Intelligent Driver Model** (Treiber), so they decelerate behind leaders
  and at red lights.
- Choose fixed-time or vehicle-actuated signals. Fixed-time cycle settings and actuated
  green/gap settings can be tuned while the simulation runs.
- Live HUD: throughput, wait times, stops, delay ratio, queue, phase utilization, and demand met.
- The Rotterdam page includes a network editor. Changes are saved in your browser and can
  be exported or imported as JSON.
- The Rotterdam page can show fresh, read-only traffic light observations above the
  simulated lights when an authorized feed has been connected.
- The Rotterdam page also shows source-labelled public data layers: OSM building
  footprints and transit stops, Rotterdam's tree inventory, NDW measured traffic and
  roadworks, nearby Luchtmeetnet readings, and CBS citywide housing energy statistics.
- Official 3DBAG building heights and BAG construction years replace OSM building
  estimates where available. Rotterdam GIS layers show modelled water depth, noise,
  and access to cooling spaces.
- `/lab/` replays retained NDW detector observations and compares traffic-light
  settings with paired, repeatable model runs.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://127.0.0.1:5173/`) for the city-wide map, or append
`v03/` for corridor editing, `grid/` for the playground, or `lab/` for replay and scenarios. Drag to orbit, scroll to zoom, right-drag to pan. The
control panel on the right applies settings while the simulation runs. The development
server listens on localhost by default.

Run the regression checks and production build with:

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run build
```

## Rotterdam data layers

The `/v03/` page distinguishes **simulation** from **observations**. Its layer panel
shows each source, observation or snapshot time, and geographic scope. Public data is
display-only; it does not change simulated vehicle demand, traffic-light states, or
model performance metrics.

| Layer | Source | Scope and cadence |
| --- | --- | --- |
| 3D buildings | [3DBAG LoD1.2](https://docs.3dbag.nl/nl/delivery/webservices/) and [PDOK BAG](https://api.pdok.nl/kadaster/bag/ogc/v2?f=html&lang=en) | This tile; 3DBAG's measured roof height above local ground is joined to BAG construction year where possible. OSM building footprints remain a fallback if this feed is unavailable. © 3DBAG door tudelft3d en 3DGI. |
| Transit stops | Bundled [OpenStreetMap](https://www.openstreetmap.org/copyright) extract | This tile; mapped stop locations, with no live departures. |
| Water depth, noise, cooling access | [Rotterdam DGO GIS](https://diensten.rotterdam.nl/arcgis/rest/services/SO_IBURO/DGO_data/MapServer) | This tile; modelled risk and accessibility, not current flood, noise, or temperature readings. The cooling surface samples source classes on a 28×20 grid. |
| Street trees | [Rotterdam tree inventory](https://diensten.rotterdam.nl/arcgis/rest/services/SB_Infra/Bomen/MapServer) | This tile; model height follows the inventory's height band when available. |
| Traffic speed and flow, planned disruptions | [NDW open data](https://opendata.ndw.nu/) | Sensor readings and active/upcoming records inside this tile. These are periodically refreshed snapshots, not a live stream. Old readings are hidden. |
| Air quality | [Luchtmeetnet station NL10418](https://www.luchtmeetnet.nl/meetpunten?component=NO2&station=NL10418) | Nearby station; preliminary NO₂, PM₂.₅ and PM₁₀ readings. Not a tile-wide estimate. |
| Water level | [Rijkswaterstaat water data](https://rijkswaterstaatdata.nl/waterdata/) | Nearby stations only when a valid recent reading exists. The current feed has no valid recent value for this area. |
| Housing energy | [CBS table 86333NED](https://www.cbs.nl/nl-nl/cijfers/detail/86333NED) | Rotterdam municipality annual averages; not neighborhood or building consumption. |

The static site reads `public/data/rotterdam-snapshot.json`. Refresh it locally with
`python3 scripts/update_public_data.py`; a separate scheduled Pages-workflow job refreshes and retains it. A later
site build restores the latest same-branch observation artifact. If a source is unavailable, the updater retains the previous
section and the page marks observations stale using their actual timestamps. The
public-data updater needs no API secrets. The collector reports a health warning if the traffic snapshot is over four hours old, detector observations
are over two hours old, or 3DBAG buildings are missing.
`python3 scripts/update_history.py` retains up to seven days of genuine NDW
snapshots. The Pages workflow restores the latest same-branch history artifact and
retains each refreshed file for 14 days, for subsequent site builds. Collector health warnings do not block the
city-wide map deployment; the editor and lab label old observations. Extended outages can still leave gaps; replay marks long
gaps rather than drawing a continuous observation line. The bundled snapshot also
ages between site deployments.

## Scenario lab and calibration limits

Open `/lab/` to replay one detector's retained speed and flow observations. You can
import a session-only JSON file with a `readings` array, or a simple CSV with columns
`id,name,lat,lon,observedAt,speedKmh,vehiclesPerHour` (up to 1 MB or 3,000 rows).
Choose a road section in the explorer, inspect its detector coverage and freshness,
then select **Test this section in the lab**. This transfers the exact edited road
network in the same browser session, avoiding another 8.3 MB map download. A direct
lab visit loads the bundled OSM tile and saved browser road edits. Sections without
matched observations allow model comparisons but cannot fit demand; missing road
IDs never silently switch to another corridor.

The pilot demand fit tests seven demand settings against speed from the nearest road
within 40 m. It leaves demand unchanged when the best model is more than 5 km/h from
the measured training speed. At least six distinct observation times enable a later
chronological holdout check. NDW does not expose direction for the two detectors in
this tile, so measured flow cannot be fairly compared with the model's two-direction
corridor flow. Current bundled history is short; an adequate history must accumulate
through scheduled collection or be imported. One corridor cannot establish citywide
calibration.

Scenario comparison runs each setting with the same three random seeds, a 60-second
warmup, and a 300-second measurement window. It shows means and run-to-run ranges for
throughput, travel, wait, queue, demand served, and matched-corridor estimates. The
export includes settings, browser network overrides, observation samples, and individual runs. These are model outcomes, not a
traffic forecast; use them for exploratory comparisons until route choice, detector
direction, and more corridors have been validated.

After a comparison, enter a report name and select **Save report**. Up to three
named reports persist in this browser; saving an existing name replaces it. Export
JSON for a portable copy, then use **Open report JSON** in another session. Reports
embed the road graph, selected observations, origin, signal settings, seeds, model
version, results and SHA-256 dataset fingerprints. Reopening restores those inputs;
a different model version permits viewing saved results but disables rerunning.
Saved reports can open even when the bundled map or a corridor handoff fails to load.
Storage failures leave earlier reports intact and show an error. These reports are
local browser files, with no account-based synchronization.

Live iVRI traffic-light states, real-time public-transport departures, and official
[KNMI weather feeds](https://developer.dataplatform.knmi.nl/edr-api) still require
provider access or credentials. No synthetic value is shown as an observation.

## Deploy

Pushes to `main` publish to **GitHub Pages**; the active development branch runs
the same build and checks without publishing. The schedule rebuilds the default
branch every 30 minutes. The workflow is in `.github/workflows/deploy.yml`. To enable:

1. In the GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push. The site will appear at `https://<your-user>.github.io/Rotterdam-Digital-Twin/`.

GitHub Pages is free for public repositories.

## Live traffic light observations

The Rotterdam page supports a separate observed-light overlay. The **lower bulb** and
all cars, phase logic, and metrics remain simulated; a **smaller upper bulb** appears
only for a mapped observation no older than 15 seconds. The HUD shows feed status,
source, mapped count, and update age. With no feed configured it says “Not configured”.

The browser reads JSON from `VITE_CORRIDOR_SIGNALS_URL`. Put the full URL in an ignored
`.env.local` file, then rebuild the site. Never put provider credentials in a `VITE_`
variable: these values are included in the public browser bundle. For GitHub Pages,
set the repository variable `CORRIDOR_SIGNALS_URL` to the HTTPS bridge URL; the deploy
workflow passes it to the build.

`server/corridor-signals.mjs` is a minimal Node bridge for an authorized upstream adapter.
It accepts already decoded and **map-matched** observations via authenticated
`POST /api/signals` and serves fresh readings via `GET /api/signals`. Start it with a
random secret of at least 32 characters in `CORRIDOR_SIGNALS_INGEST_TOKEN`. It binds to
`127.0.0.1:8788` by default; place it behind HTTPS for a deployed site. Reads are
disabled by default. After permission to display the provider data publicly is
confirmed, set `CORRIDOR_SIGNALS_PUBLIC_READ=true` and
`CORRIDOR_SIGNALS_READ_ORIGIN=https://<your-user>.github.io` (the exact site origin).
Set `CORRIDOR_SIGNALS_HOST` and `CORRIDOR_SIGNALS_PORT` if your deployment requires them.
Run the bridge with `npm run start:corridor-signals`.

The adapter posts this JSON shape, using actual UTC observation times:

```json
{
  "source": "approved-provider-name",
  "updatedAt": "2026-09-24T12:00:00.000Z",
  "signals": [
    { "edgeId": "osm-inbound-edge-id", "state": "red", "observedAt": "2026-09-24T12:00:00.000Z" }
  ]
}
```

`edgeId` must identify the matching inbound edge in this app's OSM network. A provider's
SPaT signal group ID is **not** an OSM edge ID. An upstream connector must obtain the
authorized SPaT and MAP feeds, match each signal group to an inbound edge, and verify
the mapping against the real intersection before posting. This repo contains no UDAP
credentials or provider connector because access and interface details depend on the
approved data agreement. If turn lanes on one inbound edge have different signal
states, omit that edge until it can be represented per lane. An OSM signal tag alone
does not provide live state.

For access, request read-only SPaT and MAP data covering the bundled OSM area
(`51.914256–51.919576° N, 4.480512–4.492979° E`) from [NDW](https://www.ndw.nu/service/contact).
Ask about iVRI/UDAP service-provider onboarding, certification or research-partner
options, coverage, test credentials, and permission to display current states on a
public digital twin. [CROW's UDAP interface specification](https://kennisbank.crow.nl/public/gastgebruiker/IVRI/iVRI_specificaties/16_IDD_UDAP-FI/113953)
defines the SPaT/MAP route; [its test process](https://www.crow.nl/Onderwerpen/landelijke-mobiliteitsstandaarden/landelijke-ivri-standaarden/testbed-en-testproces/)
describes certification requirements. These permissions and credentials must be
obtained from the data owner; the integration does not confer access by itself.
[Monotch's UDAP listener onboarding guide](https://monotch.freshdesk.com/support/solutions/articles/6000282921-technical-support-page-for-csp-isp-listener-integration-on-udap)
also gives a participation route via `info@talking-traffic.com`; it asks for an
organization, named contact, email address, and phone number. That guide is for an
emergency-vehicle listener use case, so confirm the SPaT/MAP permissions separately.

## Architecture

```
src/
  sim/        # rendering-free simulation engine
    network.ts    # grid graph builder
    types.ts      # node / edge types
    trafficLight.ts # fixed-time and actuated controllers
    vehicle.ts    # IDM car-following
    spawner.ts    # Poisson arrivals per entry
    metrics.ts    # throughput / wait / queue and fairness metrics
    world.ts      # ties it together, owns step()
  render/     # Three.js — reads sim state, never writes
    scene.ts        # camera, lights, ground
    network.ts      # roads + intersection pads
    lights.ts       # bulb spheres + poles
    vehicles.ts     # InstancedMesh of cars
  ui/
    controls.ts     # lil-gui panel
  v03/        # OSM adapter and browser network editor
  main.ts     # grid entry point + render loop
```

The sim engine is decoupled from rendering. `src/v03/osm.ts` converts the included OSM
extract into the same network model; `src/v03/editor.ts` and `overrides.ts` apply local edits.

## Model limits

This is a traffic simulation, not a calibrated model of Rotterdam. The OSM adapter uses
simple signal phases and route selection, and does not model pedestrians or real-time
traffic observations in its simulation logic. Live observations, when connected, are
display only. Editor imports are limited to 1 MB and validated before applying.
