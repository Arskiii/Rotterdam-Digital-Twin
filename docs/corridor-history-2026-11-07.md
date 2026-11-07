# Corridor history delivery

Intelligence and Scenario Lab previously loaded the September `public/data/traffic-history.json` embedded in the Vercel build. The collector was healthy, but its newer history was retained in GitHub Actions artifacts and only restored into later GitHub Pages builds. The browser also memoized observations for the entire session, and the Intelligence refresh button only refreshed city-wide feeds.

The existing `scenario-data` job now publishes its bounded seven-day history to the `corridor-data` branch after collection. Both hosts use the same public snapshot, independently of frontend deployments. The data branch disables Vercel deployments, serializes publishers, and uses a force-with-lease update with a collection-time rollback check. The existing artifact retention and collection schedule remain in place.

The shared browser feed checks once per minute while visible, on return/reconnect, and through Intelligence's refresh button. Requests coalesce; geometry remains cached. History is validated, future or malformed observations are rejected, and older responses cannot replace newer loaded observations. Outages retain the last valid data and display an availability message; the bundled history is a dated fallback. Freshness always uses measurement timestamps. The collection schedule can have gaps, which remain visible; polling the mirror does not imply a new NDW measurement every minute.

Scenario Lab starts with the latest loaded history. Later changes offer an explicit **Use latest observations** action, preserving completed/running comparisons until the user applies the update. Imported histories and saved reports retain their exact observation inputs. Detector selection and signal settings survive applying new observations.

Validation: 188 Vitest tests, 83 Node tests, and 15 Python tests passed. Type checking, workflow publication guards, production build, and bundle budgets passed (initial shell 63.5 kB; lazy map 797.2 kB / 800 kB). The existing Three.js chunk warning remains. Browser checks verified current Schiedamsedijk readings, shared Lab history, and comparison retention across Intelligence refresh and workspace navigation.

Bootstrap data was collected directly from the existing NDW DATEX collector on 7 November 2026, with latest measurements at 14:47 UTC. Inspect the published JSON's `coverage.lastObservedAt`, rather than its `generatedAt`, when verifying subsequent collector runs.
