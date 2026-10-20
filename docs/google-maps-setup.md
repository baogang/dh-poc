# Google Maps location picker

The existing Chatbot and mobile chat both offer **Choose issue location**. Native information cards also offer it when requesting geographic coordinates, an address, street, district or municipality name. Selecting a point returns a draft. The user must still send the message or continue the information card; business submission keeps its existing review and approval.

## Configure an authorized browser key

Set these environment variables locally in `.env`, or on the existing Render service, then restart/redeploy:

```dotenv
GOOGLE_MAPS_BROWSER_KEY=<your browser-restricted key>
GOOGLE_MAPS_KEY_MODE=standard
GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID
GOOGLE_MAPS_GEOCODING_ENABLED=false
```

`DEMO_MAP_ID` supports development with advanced markers. An existing project map ID can be supplied instead. Do not commit a real key. The browser key is necessarily delivered to the authenticated browser through `/api/maps/config`; it is excluded from conversation state, user messages and model prompts. Never use a server-only key in this setting.

In Google Cloud, apply **Website** application restrictions to the key, allowing:

- `https://road-pothole-pi-poc.onrender.com/*`
- `http://127.0.0.1:8788/*` only if local testing is needed.

Apply API restrictions to **Maps JavaScript API**. Enable this API in the authorized project. Keep account billing, project quotas and usage under the account owner's control. This implementation does not create a project, accept terms or activate billing.

For optional address search and reverse geocoding with a standard key, also enable/restrict **Geocoding API**, then set `GOOGLE_MAPS_GEOCODING_ENABLED=true`. Requests occur only on **Search** or **Find address for pin**. Moving a pin does not automatically make geocoding requests; the map instance is reused while the page remains open.

Standard Maps usage can incur charges beyond the applicable free usage caps. Current official pricing lists 10,000 monthly free Dynamic Maps events and 10,000 monthly free Geocoding events. Free usage is account/SKU dependent; a budget alert does not enforce a spending cap. Set appropriate project quotas and verify actual account usage. See [Google pricing](https://developers.google.com/maps/billing-and-pricing/pricing) and [API security guidance](https://developers.google.com/maps/api-security-best-practices).

Google also documents a [Demo Key](https://developers.google.com/maps/documentation/javascript/demo-key) for prototypes, with no billing and a daily hard pause. The official acquisition page denied access from the current region on 2026-10-20, so no key was created. The user will configure an existing authorized key. Do not work around the provider's regional restriction. `GOOGLE_MAPS_KEY_MODE=demo` disables this integration's optional JS geocoding path.

## Location behavior

- No location is preselected. The map's initial Riyadh view is only a viewport, not a submitted location.
- **Use my current location** requests browser geolocation only after a click. Denied/unavailable location leaves map selection and manual coordinates usable. The user must confirm that the current position is the issue location.
- Selected coordinates are validated in the browser and again by the server, including valid zero coordinates. Only geographic facts and optional device accuracy are accepted.
- Parent/frame messages require the exact same origin, iframe window and per-instance channel. The Google script/CSP is isolated to the map frame; the main Chatbot keeps its existing CSP.
- No key, a failed map load or a failed address lookup leaves manual location entry usable. An empty form cannot submit the initial map center as if the user selected it.
- Address results are suggestions to verify. Moving from an automatically resolved location clears its old address. Late GPS/geocoder responses cannot overwrite newer choices.
- A location does not establish BALADY `MunicipalityID`, `SubMunicipalityID` or `Sub_SubMunicipalityID`. Municipality names can be matched against the existing documented directory; lower administrative identifiers still need an authorized resolver. A physical report that requires those missing identifiers remains blocked, with an explanation. The map does not invent prerequisites or bypass business approval.

## Verification status · 2026-10-20

341/341 active engineering tests passed in the final full run, including 17 new location/picker/HTTP/SDK-boundary tests. Source and credential checks passed. OpenAPI remains 36 operations. Browser tests used synthetic coordinates and the configured real model against the local CRM simulation. These are not government submissions.

Desktop opening, manual selection, draft preview, reopening, cancellation, explicit sending and shared mobile conversation were observed. The real model preserved the selected coordinates and honestly stopped a streetlight report at the existing unavailable administrative resolver. Mobile location-button presence was observed. The 390×844 map interaction/capture could not finish after the Chrome debugger disconnected.

After the disconnect, automated activation also failed on the previously working desktop controls and did not reach the temporary click probe. A fresh browser tab failed at `Page.enable`. This cannot establish whether the mobile picker itself works in a live browser; that check remains pending. Temporary probes were removed. The shared picker select/close/reopen logic and exact frame/origin/channel checks passed the added module tests.

Live Google rendering, real device-GPS success, real Google address search and restricted-key deployment remain **unverified until a usable key is configured**. SDK-boundary tests use stubs and do not claim real Google validation. Screenshots and test logs are in `docs/evaluation/assets/google-maps-20261020/`.
