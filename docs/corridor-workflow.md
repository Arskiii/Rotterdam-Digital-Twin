# Corridor workflow — 18 October 2026

The explorer now connects a selected road section to its evidence and scenario
inputs. Selection works by clicking a road or using the accessible section list;
measured sections appear first. OSM street names are preserved through lane edits.
The highlight and detector association refer to one mapped segment, not an entire
street. Panning and multi-touch gestures do not select another section, and road
inspection is suspended while an editor tool is active.

The inspector shows source detector IDs, latest speed/flow, observation timestamps,
historical versus recent status, retained history coverage, long gaps and the NDW
fetch status. A successful source fetch does not make old observations recent.
Only a detector's nearest mapped section within 40 m is associated. Missing speed,
zero flow and zero speed keep their distinct meanings. Long gaps above 90 minutes
are labelled and break the replay chart line; no missing observations are invented.

**Test this section in the lab** transfers a compact road graph and observations
through session storage. It includes current session road edits and preserves graph
order, lane offsets, turn restrictions and signal phases. It avoids fetching and
parsing the original 8,323,374-byte map again. Handoffs expire after two hours; an
unavailable handoff requires reopening from the map, rather than substituting a
different graph. Missing road IDs disable comparisons. An existing section with
no matching detector allows comparison but disables demand fitting.

## Portable reports

A finished comparison can be saved under a name in browser storage or downloaded
as JSON. The report embeds its graph, projection origin, selected detector records,
settings, seeds, model version and results. It includes SHA-256 graph and observation
fingerprints, checked when reopening; these detect data changes, not source
authenticity. Graph and report imports have byte/count/geometry bounds and validate
references before restoring anything. Reports from a different model version remain
viewable but cannot run as the current model.

Up to three reports can be retained locally. Saving the same name replaces that
report; a full collection requires explicit deletion before a new name is saved.
Atomic storage writes preserve earlier reports on quota failure. Browser reports
are not synced between devices. JSON export/import provides portable copies.

The observed mean speed and absolute model speed gaps accompany the result table.
Detector direction remains unknown and comparisons are indicative. A deterministic
rerun demonstrates reproducibility; it does not validate the model against reality.

The Schiedamsedijk browser verification exported a 324,404-byte report, including all
756 directed roads, three observations from the selected detector and six runs.
Reloading and opening the named report, then rerunning it, produced the same result
table. Importing that JSON in a fresh production session also restored the same
table and verified its dataset fingerprints.
Opening a report does not depend on a successful bundled map or corridor handoff.
The report restores its own graph and cancels any pending source-map download.

## Scenario lab workspace

The lab shares the explorer's charcoal surfaces, mint accents and navigation.
A lightweight canvas previews the actual study network and selected section.
Observations and outcomes sit beside the scenario controls on desktop, and follow
the observe/configure/compare sequence on smaller screens. Optional tuning,
calibration, provenance and report tools expand in place.

Result highlights show candidate changes in trip time, waiting and throughput,
alongside the full mean/range table. Colours follow each metric's objective;
corridor speed and flow stay neutral. Missing values and rounded zero changes do
not imply improvement. Input errors appear beside the controls and focus the
invalid field. Comparison cancellation, replay controls and report restoration
remain available in the new workspace.

Candidate timing presets provide short, standard and long fixed cycles or actuated
green ranges. They change only candidate timing; demand and the baseline remain
as configured. Manual changes display as custom timing. Reset restores the initial
setup, and restored reports select the matching preset without changing their inputs.

Editing settings keeps the last completed comparison visible, labelled with its
tested demand and signal timings. A changed-settings notice offers to restore
those inputs. Saving and exporting require the form to match the tested inputs;
cancellation, validation failures and unsuccessful reruns retain the prior result.
Changing the detector or observation history clears results for the old selection.

The chart supports click/tap selection and mouse/pen dragging at actual observation
timestamps, including across long gaps. Scrubbing pauses replay; hidden pages also
pause it. Drag redraws are limited to one per animation frame. The slider provides
keyboard access. Sticky workflow links on smaller screens jump to and focus each
section, keeping its heading below the navigation. Missing roads and failed source
loading show unavailable states, with saved reports still accessible for recovery.

## Observation retention

The Pages workflow now restores the latest unexpired history artifact from the same
repository and branch. Fork artifacts and the current run are excluded. Refreshed
history is uploaded with 14-day artifact retention before subsequent deployment
health checks, so a later build failure does not discard collected observations.
The old cache is a migration fallback. Public replay still holds at most seven days
and 2,000 readings; this is bounded retention, not a permanent observation archive.
Extended feed/build outages can still leave gaps.

The merger now retains stopped traffic (0 km/h), writes atomically, reports observed
coverage and refuses to overwrite an invalid restored history file. Artifact
selection and merger failures are covered locally. The changed GitHub workflow has
not been executed remotely, and no production deployment was made.

The implementation follows GitHub's documented [artifact listing API](https://docs.github.com/en/rest/actions/artifacts),
[cross-run downloads](https://github.com/actions/download-artifact/tree/v4) and
[artifact retention setting](https://github.com/actions/upload-artifact/tree/v4).

## Verification

- All 66 JavaScript regression checks passed, including timing preset/settings equality,
  input validation, time-scaled chart selection, directional result summaries, portable-network simulation equality,
  malformed reports, fingerprints, nearest-section matching, storage quota failure,
  bounded handoffs and branch-specific artifact selection.
- All 15 Python pipeline checks passed, including stopped traffic, seven-day pruning, coverage,
  corrupted history protection and simulated atomic-replace failure.
- TypeScript and production bundle budgets with the default and repository-prefix
  base URLs. Lab initial JavaScript remains about 65 kB, below its 100 kB budget;
  map routes remain about 651 kB, below 750 kB. The existing Three.js chunk warning
  still applies.
- Desktop map-to-lab handoff, named save/reload/rerun, exported JSON import in a
  fresh production session, road clicking and sections with no observations.
  Missing-section links disable comparisons and recover through the detector list;
  a saved report also restores successfully after an invalid source handoff. At 390 × 844, the
  lab stays within the viewport and only the results table scrolls horizontally.
- Production-preview checks confirmed timing presets, default reset, chart scrubbing
  pausing replay, retained results after edits/cancellation/invalid input, and exact
  preset/result restoration after saving and reloading. Mobile workflow links focus
  each section at a 70 px offset, with no page overflow. Empty replay controls stay
  disabled after source loading fails. The normal comparison flow has no browser
  console warnings or errors.

Remaining priorities: sustained multi-corridor observation coverage and detector
direction, real-device frame-time measurements, and calibration/route validation.
