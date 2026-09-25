# Rotterdam signal-data requests

These requests cover data still missing from the platform. The public NDW,
OVapi, 3DBAG and Rotterdam GIS feeds already used by the app do not require
duplicate access requests. Do not publish a real contact's phone number or
provider credentials in this repository.

## Talking Traffic / UDAP — onboarding

Send the prepared [UDAP request](udap-access-request.md) to
`info@talking-traffic.com` with the sender's organization, named contact,
email address and phone number. [Monotch's onboarding instructions](https://monotch.freshdesk.com/support/solutions/articles/6000282921-technical-support-page-for-csp-isp-listener-integration-on-udap)
say this starts a test-access ticket. Ask explicitly whether this route covers
read-only SPaT/MAP for public signal-state display; the linked guide describes
an emergency-vehicle listener and does not grant this use case by itself.

## NDW — data and permission route

Send to `mail@servicedeskndw.nu` ([official contact](https://www.ndw.nu/service/contact)).

**Subject:** Rotterdam Digital Twin — toegang tot actuele iVRI SPaT/MAP-data

Geachte NDW Servicedesk,

Voor het openbare Rotterdam Digital Twin-project
(https://github.com/Arskiii/Rotterdam-Digital-Twin) zoeken wij alleen-lezen
toegang tot actuele iVRI SPaT/MAP-data in Rotterdam. Het platform gebruikt al
open NDW-telpunten en incidentdata. Verkeerslichtstanden worden nu uitsluitend
gesimuleerd; wij willen echte standen afzonderlijk en met bronvermelding tonen.
Wij willen geen verkeerslichten aansturen.

Kunt u aangeven welke dienst of partner de actuele SPaT/MAP-feed verstrekt,
welke testtoegang en overeenkomst nodig zijn, en wie toestemming kan geven
voor openbare weergave? Zijn voor Rotterdam ook historische fasegegevens,
signaalgroepidentifiers en topology/MAP-bestanden beschikbaar voor validatie?
Graag vernemen wij eventuele kosten, gebruiksvoorwaarden, bewaartermijnen
en de juiste contactpersoon.

Met vriendelijke groet,

[naam, organisatie en antwoordadres]

## Gemeente Rotterdam — asset mapping and publication rights

Send to `datadiensten@rotterdam.nl` ([official dataset contact](https://data.rotterdam.nl/terms/privacy-policy/))
and ask for routing to the city traffic-signal asset owner.

**Subject:** Rotterdam Digital Twin — verzoek om iVRI-koppeling en datagebruiksvoorwaarden

Geachte afdeling Datadiensten,

Voor het openbare Rotterdam Digital Twin-project
(https://github.com/Arskiii/Rotterdam-Digital-Twin) willen wij gemeten
verkeerslichtstanden duidelijk gescheiden van onze verkeerssimulatie tonen.
Wij vragen u dit verzoek door te sturen naar de beheerder van Rotterdamse
verkeersregelinstallaties en verkeersdata.

Is een actuele inventaris beschikbaar van gemeentelijke iVRI's met stabiele
asset- en kruispuntidentifiers, geografische locaties en de koppeling tussen
MAP-signaalgroepen, rijstroken en fysieke signaalhoofden? Welke gegevens zijn
openbaar of via een overeenkomst te verkrijgen? Mogen actuele standen die via
een toegestane UDAP-koppeling worden ontvangen publiek worden getoond, en
welke vertraging, bronvermelding of bewaartermijn geldt dan? Als deze data
elders worden beheerd, ontvangen wij graag de juiste contactpersoon.

Met vriendelijke groet,

[naam, organisatie en antwoordadres]
