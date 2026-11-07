# Feed audit — 7 November 2026

The audit covered every live source, both publication paths, the historical archive, and the dated reference datasets used by Intelligence and the secondary city viewer. Observation timestamps are kept separate from download timestamps; old observations are never relabelled as current.

| Source | Evidence and correction |
| --- | --- |
| NDW road sensors | Current endpoint observed 610 stations at 16:47 UTC. Use actual detector measurement times; discard unknown, future and more than five-minute-old input rows. Preserve measured zero flow. |
| NDW bridges and incidents | Current situation publication at 16:50 UTC. Preserve that publication time separately from snapshot retrieval. Intelligence now shows incidents as their own source. Expired events clear from the map. |
| OVapi positions | Current endpoint observed 200 vehicles, oldest included fix 16:47:54 UTC. Validate the GTFS publication and each position timestamp. Preserve the interpolation clock separately from the oldest fix. |
| OVapi departures | 219 current station boards. Expire individual measured delays; a realtime outage falls back to explicitly scheduled services. Intelligence now includes departure-board provenance. |
| Transit references | Completed scheduled run 42379747041 verified 59,708 trips, 4,420 stops and calendars covering 4 November–12 December. A mirror outage retains cached identities only while their service date remains valid. |
| Rijkswaterstaat water | Found a provenance bug: the unqualified Boompjes request returned `ProcesType: verwachting` (forecast). The official catalog lists Boompjes as forecast-only. Switched both collectors to nearby Boerengat, requested `meting`, cm and NAP explicitly, and reject forecast or unsupported-unit series. Verified a measured value at 16:30 UTC. The secondary viewer's former WFS path returned no valid readings. |
| Buienradar weather | Rotterdam station observed at 16:30 UTC. Keep station time and expire the header and weather effects independently of the overall live envelope. |
| Luchtmeetnet air | All nine monitors returned measurements at 16:00 UTC. Hourly observations were incorrectly judged by a 20-minute road-feed threshold. Use a two-hour current window and four-hour expiry, with a five-minute shared warm-instance cache. Reject null values rather than converting them to zero. Local concurrent collection hit network deadlines; the isolated collector succeeded and failures now preserve their upstream cause. |
| Corridor and secondary city layers | The secondary viewer still used a September bundle even after the collector succeeded. Publish the city snapshot alongside corridor history and load that shared publication on either host, with a dated bundled fallback. |
| CBS neighborhood context | The successful main workflow retrieved 91 neighborhoods directly from CBS at 14:57 UTC, but only Pages received the new copy. Publish it with the shared data and check the annual workbook weekly. Dataset remains explicitly CBS 2025; retrieval date does not change its reference year. |
| Historical archive | Missing hours and this month's events were cached for the session. Recheck missing/recent hours and current-month events every five minutes; retain valid observations through server errors or malformed refreshes. Older completed hours remain cached. |
| Trees, buildings, energy, resilience | Successful collector artifact dated 14:57 UTC includes municipal trees, 3DBAG/BAG buildings, CBS 2025 energy totals and municipal GIS models. These remain labelled inventory, annual statistics or model output, not current measurements. |
| Flood exposure and model-validation report | Deliberately dated model/reference artifacts. Validation covers its stated historical interval; its date must not be replaced with today's collection time. |
| KNMI nowcast / restricted iVRI SPaT | Not configured; remain labelled unavailable. No synthetic readings added. |

## Delivery and expiry

The Vercel live endpoint collects on demand with its existing short cache and deadline. The GitHub live mirror and archive depend on scheduled Actions. Actual firings on this date were around 01:17, 07:14 and 14:03 UTC despite the five-minute cron expression; historical coverage can therefore have gaps. Refreshing a page cannot recover observations that were never archived. The primary live endpoint is independent of those scheduled runs.

Display/expiry windows in minutes: roads, positions, boards and active situations 9/20; river level 20/60; weather 30/60; hourly air 120/240. These are application freshness rules, not scientific quality guarantees. The oldest included measurement drives each grouped source age. Older provider responses cannot overwrite newer observations inside a newer delivery envelope.

## Verification

Regression coverage includes source timestamps, future/stale GTFS data, measured zero flow, forecast-versus-measured river levels, null air values, provider caching, expired service calendars, archive refresh/recovery, and published-data fallback. The production build also checks all existing UI, routing, scenario, worker, service-worker and deployment-guard tests plus JavaScript size budgets. The study map picker now loads separately, reducing the lazy map bundle from about 797 kB to 773 kB while keeping the initial shell under 100 kB.

Primary references: [Rijkswaterstaat Waterdata](https://rijkswaterstaatdata.nl/waterdata/), [Rijkswaterstaat process-type documentation](https://rijkswaterstaatdata.nl/projecten/waterwebservices-overschakeling/), [Luchtmeetnet API and update cadence](https://api-docs.luchtmeetnet.nl/). Supporting workflow: [validated daily transit references](https://github.com/Arskiii/Rotterdam-Digital-Twin/actions/runs/42379747041), [successful CBS and city collection](https://github.com/Arskiii/Rotterdam-Digital-Twin/actions/runs/42383998283).
