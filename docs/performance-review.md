# Performance and reliability review — 18 October 2026

Follow-up: the first three priorities below are implemented in the
[corridor workflow review](corridor-workflow.md). Its additional inspector/report
features bring lab initial JavaScript to about 52 kB and map routes to about 651 kB,
within the budgets established here. The measurements below record this original
performance pass.

The most useful next product improvement is a connected corridor workflow: select a
road on the map, see its observations and coverage, then compare an intervention in
the lab with those inputs carried across. Sustained detector history and saved,
versioned scenario reports should follow. The model still needs validation before
its comparisons can support real traffic decisions.

## Changes

- The lab imports only the vector math needed to build its network. It no longer
  downloads the WebGL renderer, controls, and scene code shared by the two maps.
- Demand fits and paired comparisons run in a dedicated worker. One network clone
  and worker are reused across a batch. Cancellation terminates the calculation
  immediately, discards late messages, and releases controls; successful batches
  also release their worker. Worker calculations avoid main-thread timer yields.
- Roads, centre lines, and direction arrows use three instanced batches. Ray hits
  still resolve to individual corridors for road editing; rebuilt batches dispose
  their instance buffers.
- Cars occupy a dense instance buffer. Only active cars are drawn and uploaded;
  vehicle colours remain stable when completed trips leave the buffer. Replacing
  a full population no longer leaves replacement cars invisible for one frame.
- Completion timestamps are pruned during collection, including headless runs.
  Tail-wait sorting is cached until a new completion arrives, and out-of-range
  percentile requests cannot produce a nonfinite metric.
- Short signal approaches use the same clamped stop line in detection and physics,
  preventing stopped cars from being missed by actuated controllers.
- Signal poles sit outside the rightmost lane. Empty traffic layers are disabled
  instead of displaying a checked layer with no current observations.
- Every production build checks all initial script dependencies against budgets:
  100 kB for the lab, 750 kB for each map route, and 100 kB for the scenario worker.
  These are uncompressed JavaScript budgets; the check also reports gzip size.

## Measurements

These compare this checkout immediately before and after the review on the same
local machine. They are not mobile frame-rate or network-load measurements.

| Check | Before | After |
| --- | ---: | ---: |
| Lab initial JavaScript, including shared dependencies | 560.4 kB | 35.1 kB |
| Lab initial JavaScript, gzip | 147.9 kB | 13.4 kB |
| Scenario worker, loaded when calculations start | — | 21.5 kB |
| Grid road-network mesh objects | 104 | 33 |
| Car instance-buffer update benchmark, median of five batches of 2,000 updates with 35 cars | 5.70 ms | 2.76 ms |

The ten-minute grid run at 2,400 attempted vehicles/hour and seed 42 retained its
333 completed trips, 404 attempted arrivals, and 35 active cars. The CPU benchmark
is an isolated buffer-update check; it does not imply a doubling of browser FPS.
The map still needs a large Three.js renderer chunk, and Vite reports its existing
500 kB chunk warning. Map JavaScript remains around 634 kB including dependencies.

## Verification

- Regression coverage includes actual HTTP bridge requests, road ray picking,
  vehicle-buffer replacement and colours, short-road detection, bounded metrics,
  worker result parity with the same seeded simulation on a structured-cloned
  network, cancellation, worker reuse, and disposal.
- All 54 JavaScript regression checks and 12 Python data-pipeline checks passed.
  `npm run build` passed with TypeScript checking and bundle budgets, both with the
  default base URL and with `VITE_BASE=/Rotterdam-Digital-Twin/`.
- Browser verification covered the development and production maps, pause/reset/top
  controls, a complete worker-based paired comparison, cancellation with controls
  restored, and a complete demand fit that correctly rejected a poor calibration.
  The production playground rendered, and 390 × 844 layouts kept the map usable
  and the comparison table inside its horizontal scroll container. No browser
  warnings or errors were reported during these checks.

Commands: `npm test`, `python3 -m unittest discover -s tests -p 'test_*.py'`, and
`npm run build`. These changes are local and have not been deployed.

## Next improvements

1. Connect map corridor selection to the lab, including detector age, direction,
   geographic coverage, and explicit missing-data states.
2. Retain observations outside the deployment cache and expose feed health on the
   map and in the lab. The bundled readings are old in this local checkout, so
   the explorer correctly hides them; this review does not refresh public feeds.
3. Save named scenario baselines and reproducible reports with dataset and model
   versions, intervention settings, uncertainty, and observed-versus-modelled errors.
4. Measure frame times on a representative phone with all layers and high traffic.
   Use those results to set device-specific pixel and frame-time budgets and decide
   whether rendering resolution or further geometry batching should be next.
