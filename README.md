# Rotterdam Digital Twin

Live, browser-based 3D simulation of urban traffic. **v0.1** runs a fictional 2×3 grid of 6
intersections; later versions will load real Rotterdam street data.

## What it does today

- Six fixed-time signalized intersections on a grid network.
- Cars enter from perimeter "stubs" via independent **Poisson processes** (you set total
  cars/hour; arrivals at each entry are exponential inter-arrivals).
- Cars follow the **Intelligent Driver Model** (Treiber), so they decelerate behind leaders
  and at red lights.
- A single **"throughput ↔ wait"** slider tunes the controller. Move it left for shorter
  signal cycles (lower wait time, lower max throughput from startup loss); move it right for
  longer cycles (higher max throughput but worse worst-case wait).
- Live HUD: sim time, active / completed cars, rolling throughput (cars/min over the last
  60 s of sim time), average wait time per completed car, average queue length.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`). Drag to orbit, scroll to zoom,
right-drag to pan. The control panel on the right is live — every knob takes effect on the
next tick.

## Deploy

Pushes to `main` or the active development branch auto-deploy to **GitHub Pages** via the
workflow in `.github/workflows/deploy.yml`. To enable:

1. In the GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push. The site will appear at `https://<your-user>.github.io/Rotterdam-Digital-Twin/`.

GitHub Pages is free for public repositories.

## Architecture

```
src/
  sim/        # rendering-free simulation engine
    network.ts    # grid graph builder
    types.ts      # node / edge types
    trafficLight.ts # fixed-time two-phase controller
    vehicle.ts    # IDM car-following
    spawner.ts    # Poisson arrivals per entry
    metrics.ts    # rolling throughput / wait / queue
    world.ts      # ties it together, owns step()
  render/     # Three.js — reads sim state, never writes
    scene.ts        # camera, lights, ground
    network.ts      # roads + intersection pads
    lights.ts       # bulb spheres + poles
    vehicles.ts     # InstancedMesh of cars
  ui/
    controls.ts     # lil-gui panel
  main.ts     # entry point + render loop
```

The sim engine is intentionally decoupled from rendering so we can later swap the grid for
OSM-derived Rotterdam streets without touching the visuals.

## Roadmap

- v0.2 — actuated lights (green-extension on demand) compared head-to-head with fixed-time
- v0.3 — load a small Rotterdam neighborhood from OpenStreetMap
- v0.4 — multi-lane edges, turn lanes, pedestrian phases
- v0.5 — RL-trained controller, A/B vs. baseline
