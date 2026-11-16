# unifi-api-test

Kleine, nur lesende Testoberfläche für die UniFi Site Manager API (`api.ui.com`).

Variablen (Railway): `UNIFI_API_KEY`, `TEST_TOKEN`. Ohne `TEST_TOKEN` antwortet die App auf alle `/api/*`-Aufrufe mit 401.
Endpunkte: `/health` (offen), `/` (Oberfläche), `/api/status|hosts|sites|devices|isp-metrics/5m|connector`.
