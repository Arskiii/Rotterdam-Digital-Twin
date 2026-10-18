# Platform review — 27 September 2026

The next product step is a clear corridor decision workflow: select a place, understand
the evidence, compare an intervention, and save a reproducible explanation of the
tradeoffs. The existing map, public sources, editor, and scenario engine provide a
useful foundation. More layers alone will not establish decision quality.

## Implemented in this review

### Experience

- Rotterdam is the main entry point. The old map URL `/v03/` remains available;
  the fictional grid is now `/grid/` and is labelled Playground.
- Shared navigation connects the city explorer, scenario lab, and playground.
- A dedicated map viewport and scrolling sidebar eliminate overlapping panels.
  Mobile layouts keep the map above a separate scrollable information panel.
- Pause/resume, simulation speed, top view, and reset view are directly accessible.
- Brighter scene lighting and resolution-aware canvases improve legibility.
  Arrow keys pan only while the map has focus, preserving keyboard form editing.
- Detailed metrics, source information, settings, and road editing can be expanded
  when needed. Closing road editing leaves edit mode.
- The map can retry failed startup. Missing observation history no longer prevents
  the scenario lab from loading its map and accepting an import.

### Verified correctness fixes

- Corrected right-hand lane placement and rightmost-first lane ordering.
- Removed false braking when a leader changes road segments; vehicles look ahead
  across short segments and respect downstream queues and simultaneous merges.
- Prevented crossing red stop lines while allowing vehicles already beyond them
  to clear the junction.
- Paired scenarios now receive the same seeded attempted demand even when entry
  congestion differs. Corridor measurements include completed trips and all
  segments traversed in a step.
- Lane edits retain speed limits, signal approaches, and unchanged turn restrictions.
  Disconnect/reconnect/one-way edits retain their intended precedence.
- Storage failures leave session edits usable and report that exporting is needed.
- Observation imports support quoted CSV and enforce byte and record limits
  consistently. They reject invalid types, impossible/ambiguous dates, and empty
  measurements; genuine zero-speed observations remain valid.
- Equivalent timestamp offsets are deduplicated and sorted chronologically.
  Replay plots use elapsed time for their horizontal scale.
- Replay restarts after changing detectors. Pending imports and running comparisons
  lock conflicting controls. Only active controller settings are validated.
- Changed settings or detectors invalidate old comparisons and exports. Cancelling
  during the final computation yield cannot publish results or apply a demand fit.
- Exported comparisons include network overrides, selected observation samples,
  configuration, seeds, and individual results.
- Mutable map counters update after edits. “Demand admitted” describes entry
  acceptance accurately; it is not a completed-trip percentage.

### Security and data integrity

- Hardened ingest configuration, JSON content type, UTF-8 decoding, calendar dates,
  duplicate signal IDs, request size, HTTP headers, and request timeouts.
- Corrected read preflight CORS and prevented older observations overwriting newer
  accepted readings. Invalid uploads leave the last accepted snapshot intact.
- Rejected uploads close their connections without discarding the error response.
- Observation groups expire at their oldest displayed reading, and roadwork groups
  expire at their earliest event end. Expired toggles cannot restore stale data.
  This is conservative: some still-fresh records can disappear with the group.
- Future-dated measurements no longer pass deployment freshness checks.
- Added a pull-request workflow for regression checks, builds, and high/critical
  dependency advisory checks, using read-only repository permissions.

The bridge remains an authenticated ingestion service with explicitly enabled public
reads. CORS is not reader authentication. A deployed bridge still needs HTTPS and
reverse-proxy connection/rate limits. Browser variables must never contain provider
secrets. Header guidance follows the [OWASP REST security guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).

## Validation

- 43 JavaScript regression tests passed, including actual HTTP oversized-header,
  oversized-body, rejected-upload, and subsequent valid-ingest checks.
- 12 Python data-pipeline tests passed.
- Type checking and the production build passed. The existing large shared JavaScript
  chunk warning remains; bundle splitting is still a performance opportunity.
- The dependency audit reported zero known vulnerabilities at review time.
- Both signal modes completed a ten-minute, 2,400 vehicles/hour stress check without
  nonfinite state or same-lane overlap; both received 404 attempted arrivals for seed 42.
- Browser checks covered desktop and 390 × 844 mobile layouts, map controls,
  navigation, full paired comparison, cancellation, replay restart, malformed and
  valid imports, and invalidation of stale results. No browser errors were reported.
- The production build was checked under `/Rotterdam-Digital-Twin/`, including the
  main map, legacy map URL, and scenario lab.
- Public snapshots were refreshed and freshness checks passed. CBS energy refresh
  failed with a TLS connection error, so its previous annual snapshot was retained.
  History currently contains only six detector records across three timestamps.

These checks establish the behavior covered by this review. They are not a guarantee
that all defects or security issues have been found. Changes are local and have not
been deployed.

## Next priorities

| Priority | Product change | Completion criterion |
| --- | --- | --- |
| 1 | Select a corridor directly on the map; show its detectors, direction, age, and coverage, then open it in the lab. | A user can reach an evidence-backed comparison without knowing detector IDs or editor internals. |
| 2 | Establish a calibrated pilot corridor using sustained observations, measured direction, origin–destination demand, and intersection conflict/yield behavior. | Publish training and later holdout errors for speed, flow, queue, and travel time, with known gaps. Three timestamps are not enough. |
| 3 | Add named scenario baselines, pinned dataset/model versions, and saved/shareable decision reports. | Another session reproduces the comparison from its saved inputs and sees tradeoffs, uncertainty, and assumptions together. |
| 4 | Separate slow geographic refreshes from fast traffic updates; keep durable history and surface feed health. | Deploys do not depend on every external source being reachable, and expired data never appears current. |
| 5 | Set explicit mobile frame-time and load-size budgets; split rendering code from analysis-only routes. | Measure a representative phone and desktop before and after changes, including worst-case traffic and active layers. |

Start with one complete, validated corridor workflow. Broader geography, more live
integrations, and additional urban themes can then reuse that evidence and reporting
structure.
