# smokingarea.sg

Every **designated smoking area** and **licensed cigarette retailer** in Singapore, on one map —
plus the no-smoking zones that will cost you $200 if you get them wrong.

Static site. No backend, no build step, no API keys. Four JSON files and a `<script>` tag.

---

## What's on the map

| Layer | Count | Source | How good is it |
|---|---|---|---|
| **NEA designated areas** | 52 | NEA, via data.gov.sg | Authoritative and complete — but they only exist inside the Orchard Road No-Smoking Zone. Each carries NEA's own aerial photo of the painted yellow box. |
| **Changi Airport areas** | 32 | Changi Airport Group | CAG's published list, all four terminals, landside and airside. Given in words ("opposite Gate B10"), never coordinates — so pins sit on the terminal centroid and are flagged `approx`. |
| **Community areas** | 6 | OpenStreetMap contributors | Actual mapped smoking areas outside the two published lists. Thin. |
| **Venues with a smoking corner** | 61 | OpenStreetMap contributors | Hawker centres, coffee shops, bars and offices tagged `smoking=isolated\|separated\|outside`. The least reliable layer here — a lead, not a promise. |
| **Licensed retailers** | ~4,200 | HSA tobacco retail licence register, via data.gov.sg | Every outlet legally allowed to sell tobacco. Geocoded from the postal code in the licence address. No opening hours in the register. |
| **Orchard No-Smoking Zone** | 1 polygon | NEA | Smoking anywhere inside it, outside a yellow box, is an offence. |
| **Park / beach no-smoking areas** | 626 polygons | NParks | NParks-managed land only (see the caveat below). |

### The honest caveats

**There is no national register of smoking corners.** Outside Orchard and Changi, smoking areas at
coffee shops, offices and industrial estates are set up by the premises owner and published nowhere.
NEA and CAG are the only two operators in Singapore that publish a list at all. Everything else on
this map comes from OpenStreetMap contributors and is nowhere near complete.

**An empty map is not permission.** The park polygons are NParks' published boundaries, so land run
by someone else — Gardens by the Bay, Marina Barrage, Sentosa, HDB void decks — reads as blank
despite smoking being banned there too. The UI says this wherever it could mislead.

**Nothing here comes from Google.** Google's Maps Platform terms forbid storing Places content or
displaying it on a non-Google map, and this map is built on OneMap and OpenStreetMap. Every spot
instead links out to a live Google Maps search, where the reviews, photos and opening hours are.
That's a deliberate boundary, not an oversight — see `showDetail()` in `public/app.js`.

The fix for coverage is community mapping, not scraping: a spot added to OpenStreetMap as
`amenity=smoking_area` flows into this map on the next rebuild, and into every other map that uses
OSM. See "Adding a spot" below.

---

## Features

- **Nearest spot, ranked by walking distance** — live geolocation, or the map centre if you'd rather not share.
- **"Am I about to get fined?"** — point-in-polygon check on your actual position against every no-smoking zone, with the nearest legal alternative.
- **Buy cigarettes** — 4,200 licensed outlets, filterable by convenience store / supermarket / minimart / petrol station / coffee shop.
- NEA's own photo of each Orchard yellow box, so you know what you're looking for.
- Walking directions hand-off to Google Maps, shareable deep links (`/#nea-17603`).
- Light and dark, phone and desktop, keyboard and screen-reader accessible.

---

## Running it

```bash
npm run dev
```

Serves `public/` on <http://localhost:5178> via `scripts/serve.mjs` — plain `node`, no install,
no network. Any other static server works too; the site is just files.

Don't open `public/index.html` straight off disk: the app `fetch()`es `data/*.json`, and browsers
block that on `file://`, so you'd get the shell with an empty map.

## Rebuilding the data

```bash
npm run data
```

Which runs, in order:

```bash
node scripts/fetch.mjs     # pull raw NEA / NParks / HSA / OSM sources into raw/
node scripts/geocode.mjs   # postal code -> lat/lng: OSM in bulk, OneMap for the rest
node scripts/build.mjs     # emit public/data/*.json
```

**`raw/changi_dsa.json` is the one hand-maintained source.** Changi Airport Group publishes its
smoking areas as an HTML page with no API and no coordinates, so that file is a transcription,
stamped with `_source` and `_captured`. `fetch.mjs` does not touch it — re-check it against
[CAG's page](https://www.changiairport.com/en/at-changi/facilities-and-services-directory/smoking-areas.html)
a couple of times a year, or whenever a terminal reopens.

`scripts/geocode.mjs` caches to `raw/geocache.json` and **never writes a failure to the cache**, so
re-running it always picks up exactly what's left. OneMap throttles the public search endpoint
(HTTP 429, HTML body), so the script runs behind a global rate gate that widens itself on every 429.
Keep `raw/geocache.json` in version control and the cold start only ever happens once.

Sensible cadence: monthly. The HSA licence register turns over as licences lapse; NEA's DSA list
changes rarely.

---

## Adding a spot

Missing smoking area? Don't file it here — put it on OpenStreetMap, where it helps everyone:

1. Quick and anonymous: [drop a note](https://www.openstreetmap.org/note/new) on the spot.
2. Properly: add a node tagged `amenity=smoking_area`, plus `shelter`, `bench`, `bin`, `covered`,
   `lit`, `opening_hours` and `level` where you know them — the site renders all of those.

It lands here on the next `npm run data`.

---

## Deploying

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flikalight%2Fsmokingarea-sg)

There is no build step. `vercel.json` sets `framework: null` and `outputDirectory: public`, so the
folder is served as-is, and `.vercelignore` keeps `raw/` — ~16MB of build-time downloads the site
never touches — out of the upload.

From the CLI instead:

```bash
npx vercel login
npx vercel --prod --yes
```

- **Cloudflare Pages / Netlify** — build command empty, publish directory `public`.
  `netlify.toml` carries the same cache headers as `vercel.json`.

For the real `smokingarea.sg` domain you'll need a `.sg` registrar — SGNIC accredited ones include
Vodien, Exabytes and Namecheap. `.sg` has no local-presence requirement for individuals.

---

## Licence and attribution

The code here is MIT. **The data is not yours to relicense:**

- NEA, NParks and HSA datasets: [Singapore Open Data Licence](https://data.gov.sg/open-data-licence) — attribution required, and you must not imply government endorsement.
- OpenStreetMap: [ODbL](https://www.openstreetmap.org/copyright) — share-alike applies to derived data.
- OneMap basemap: © OneMap / Singapore Land Authority — attribution required, and the tiles are for
  display only.

All three attributions render in the map corner and the site footer. Leave them there.

This is an unofficial, community-run project with no affiliation to NEA, HSA, NParks or SLA.
**Tobacco is 21+ in Singapore, and e-cigarettes are illegal outright.**
