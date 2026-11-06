# Platform performance — 6 November 2026

The shared shell prewarms Scenario Lab on every visit. Previously that fetched
8.3 MB of OSM XML and parsed the entire map on the main thread, including scenery
that the lab does not use. The build now runs the existing OSM adapter once and
publishes only the study network and its origin as fingerprinted JSON. Browser
road edits and transferred corridors still apply to that same network.

| Study network | Before | After |
| --- | ---: | ---: |
| Uncompressed download | 8,323.4 kB | 321.9 kB |
| Gzip | 738.5 kB | 51.4 kB |
| Nodes / directed roads | 928 / 756 | 928 / 756 |
| Local Node preparation, median of five | 453.21 ms | 2.40 ms |

This removes 96.1% of the decoded study download and 93.0% of its gzip bytes.
The preparation benchmark uses Node 22 and xmldom for the old XML path, versus
JSON parsing and network restoration for the new path. It is an isolated CPU
comparison, not a browser FPS or overall page-load measurement. Reproduce it with
`node scripts/build-lab-network.mjs --benchmark`.

The city renderer now reuses viewport dimensions when projecting labels and
markers. It no longer interleaves two layout reads with every marker transform;
100 projections now require zero layout reads, versus 200 previously. A resize
observer refreshes dimensions, including after resizing a hidden map workspace.

The interactive city simulation and map panels suspend while the browser tab is
hidden. Returning resumes the user's mode and pause choice and resynchronizes the
Live clock. Hidden Intelligence cards retain incoming data and render it when
shown. Repeated section navigation no longer redraws the lab or reparses saved
reports. Explicit scenario experiments continue independently of the map worker.

Verification: 150 Vitest tests, 74 Node tests and 15 Python tests; TypeScript;
production build and bundle budgets. Regression coverage compares complete seeded
simulation results for the original and restored city study network, checks label
projection across resizes, and exercises hidden/visible simulation policy. The
fingerprinted network has a new 500 kB build budget. The shell remains 57.9 kB of
JavaScript and the lazy map 758.7 kB, within their existing budgets.

Local production-browser checks completed a three-seed paired comparison, switched
between all workspaces with results retained, confirmed Setup selects Simulation,
checked moving activity, and resized the map while it was hidden. No console
warnings or errors were reported. The existing Three.js chunk-size warning remains.
