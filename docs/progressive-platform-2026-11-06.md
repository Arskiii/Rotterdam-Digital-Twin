# Progressive loading, recovery and shared corridor workflow

## Behavior

- The map paints after the base city is ready. Building downloads, building geometry and the simulation finish independently. Geometry is built in approximately 5 ms batches with a paint opportunity between batches. Startup controls are replayed in order once the simulation is ready.
- A short-lived worker fetches, verifies and parses city data. Typed-array backing stores are transferred once. The raw graph is transferred to the simulation without another 11 MB copy. Browsers that block workers retain a usable Live map with explicitly labelled local animation.
- Failed map initialization has a **Retry map** action that replaces only the map surface. Retained Lab and Intelligence controllers keep their inputs and results. Optional building failures have an independent retry. Returning to the tab or reconnecting refreshes observations; concurrent requests join one poll. A newer deployment offers a reload instead of silently discarding a hidden workspace.
- **Study corridors** on Unit Map offers a road list and map picking. **Inspect evidence** opens the same section in Intelligence; **Compare in Scenario Lab** carries its identity into Lab. URL navigation and browser history retain selection. Completed comparisons and restored report networks require an explicit **Use map selection** action before changing sections. Settings remain intact.

Corridor evidence uses the existing 756-road study network and its detector history. It does not imply citywide corridor coverage or current measurements. Sections without matched readings can compare model scenarios but cannot fit demand. Source timestamps and history gaps remain visible.

## Measurements

Local macOS/Chromium preview, 1280 × 720, no throttling. Baseline is merge commit `527fca9d` (PR #26). These are local observations, not production latency guarantees.

| Warm load, milliseconds from navigation | Before | After |
| --- | ---: | ---: |
| Map module starts | 146 | 97 |
| Base city parsed | 297 | 170 |
| First usable map frame | 626 | 345 |
| Building geometry ready | 513 | 495 |
| Simulation ready | 529 | 537 |

The key change is that the map no longer waits for buildings or simulation. An injected six-second delay confirmed the map and navigation were available while both were still starting. The first load of newly compiled assets varied more (an observed new-build map frame was 2,553 ms); warm results should not be generalized to a cold production visit. Frame-time and approximate browser-heap measurements vary with GPU warmup, other tabs and collection, so no steady-state FPS or whole-app memory reduction is claimed.

Pure-parser benchmark: nine runs per parser, explicit GC before each, median elapsed time and JavaScript heap delta before collection. It compares every scalar and typed-array element of the real bundled data against the baseline before measuring. Typed-array backing storage is outside this heap figure.

| Parser | Before time | After time | Before JS heap delta | After JS heap delta |
| --- | ---: | ---: | ---: | ---: |
| Roads | 7.00 ms | 4.28 ms | 12.46 MB | 1.09 MB |
| Rail | 0.45 ms | 0.42 ms | 1.00 MB | 0.34 MB |
| Buildings | 36.21 ms | 12.25 ms | 8.88 MB | 0.56 MB |

A repeat under concurrent test load measured roads 7.55 → 4.63 ms, buildings 39.70 → 19.97 ms and rail 0.27 → 0.50 ms. Heap deltas stayed close to the table. The small rail parser does not consistently become faster; the larger road and building parsers account for the useful savings.

Reproduce with `node --expose-gc scripts/benchmark-city-parsers.mjs 527fca9d72c347a6f79fb76c898b6601e9ca5505` from a checkout containing that commit. Add `?diagnostics=1` to the app for local startup stages, the first 900 active frame intervals, 30 seconds of long-task observations and an approximate JS-heap sample. Diagnostics send no telemetry.

Initial shell: 63.5 kB (100 kB budget). Lazy map: 794.5 kB (800 kB budget). Shared study JSON: 321.9 kB (500 kB budget). The corridor data is downloaded once for all three workspaces. No dependency or hosting migration is required.

## Validation

- Production build, TypeScript, bundle budgets, 178 Vitest tests, 83 Node tests and 15 Python data checks.
- Binary parity on all bundled roads, rails and buildings; signed coordinates, offsets, truncated data and trailing-data checks.
- Worker deadline, fallback, transfer ownership, cancellation, queued controls, reconnect/resume deduplication, retained fresh snapshots and build-update behavior.
- Corridor projection accounts for the two models' different origins and latitude scales. Only supported sections are pickable and detectors are associated with their nearest eligible section.
- Browser: Map → Intelligence → Lab, a completed three-seed comparison, retained selection/settings/results after tab switching, explicit replacement by an unmeasured section, recoverable graph HTTP 503, usable map during delayed details, building-only HTTP 503 and retry, and worker-blocked Live fallback.

The existing large Three.js bundle warning remains; the enforced total budgets pass.
