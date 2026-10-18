# Live iVRI signal access

The platform maps the public UDAP iVRI registry to its citywide road graph,
but registry positions do not contain current signal states. Actual SPaT/MAP
access, licensing, and a verified MAP-to-road-head mapping are still required.
The map never labels simulated phases as observed data.

## Access request

Contact the Talking Traffic/UDAP service operator, the
[NDW servicedesk](https://www.ndw.nu/service/contact), and Rotterdam's
open-data office. Ask for read-only SPaT and MAP covering Rotterdam, including
the 82 iVRI installations inside the platform's coverage area, and for:

1. A test feed and the current service interface specification.
2. The provider onboarding, certification, agreement, and any costs.
3. MAP intersection, lane, connection, and signal-group identifiers, plus a
   method to verify each group against the physical intersection.
4. Written permission to show current states in a public digital twin, with
   attribution and maximum permitted delay.

The [CROW UDAP interface specification](https://kennisbank.crow.nl/public/gastgebruiker/IVRI/iVRI_specificaties/16_IDD_UDAP-FI/113953)
describes the interface route. The [Monotch onboarding guide](https://monotch.freshdesk.com/support/solutions/articles/6000282921-technical-support-page-for-csp-isp-listener-integration-on-udap)
lists `info@talking-traffic.com` as the starting point for a CSP/ISP listener.
That guide is written for an emergency-vehicle use case, so ask whether the
same onboarding route covers public display of signal states. It requires an
organization name, named contact, email address, and phone number. NDW lists
`mail@servicedeskndw.nu` for data access questions. Rotterdam's open-data
office lists `datadiensten@rotterdam.nl` for dataset content questions; ask it
to route the city-owned iVRI asset and MAP mapping request to the traffic
signal owner. Do not put provider secrets in the browser bundle or repository.

The repo includes a draft in [udap-access-request.md](udap-access-request.md).
It needs the organization's name and a named contact before sending.

## Authorized adapter contract

`server/live-signals.mjs` accepts only a verified, already decoded mapping from
the provider's SPaT signal group to the platform's **signal head index**. A
cluster ID, intersection coordinate, or OSM traffic-light tag is not a head
index. For lanes in one group with different indications, map each head
separately or omit the ambiguous movement.

The adapter submits fresh UTC observations:

```json
{
  "source": "approved-provider-name",
  "graphSha256": "472eca4d8e547a2567471180a209ac8cea3eb8c75424e311e8daefd96c86b929",
  "updatedAt": "2026-09-25T12:00:00.000Z",
  "signals": [
    { "signalIndex": 123, "state": "green", "observedAt": "2026-09-25T12:00:00.000Z" }
  ]
}
```

Start the bridge with `LIVE_SIGNALS_INGEST_TOKEN` set to a random secret of at
least 32 characters and `LIVE_SIGNALS_GRAPH_SHA256` set to the deployed
`public/data/meta.json` graph hash. The bridge and browser reject a feed
mapped to a different graph. It binds to `127.0.0.1:8787` by default. Submit with
`Authorization: Bearer <token>` to `POST /api/signals`. The bridge rejects
duplicate heads and observations more than 15 seconds old.

Reads stay disabled. After the data owner permits public display, put the
bridge behind HTTPS, set `LIVE_SIGNALS_PUBLIC_READ=true` and set
`LIVE_SIGNALS_READ_ORIGIN` to the exact public site origin. In GitHub, set the
repository variable `LIVE_SIGNALS_URL` to that HTTPS `/api/signals` endpoint;
the build exposes this URL to the browser. Local builds can use an ignored
`.env.local` with `VITE_LIVE_SIGNALS_URL`. Never put a token in a `VITE_`
variable. The browser polls every 2.5 seconds and clears observations when
they exceed 15 seconds. The bridge holds only the latest snapshot in memory;
an operator adapter must reconnect and continue posting after restarts.
