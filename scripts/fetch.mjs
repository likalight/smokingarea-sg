// Pulls every raw source into raw/. Safe to re-run; each file is replaced only on success.
import fs from 'node:fs';

fs.mkdirSync('raw', { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- data.gov.sg: poll-download hands back a signed, short-lived S3 URL ---- */

const DATASETS = [
  ['d_d0fa8f07ef80ab23feaa3b870323bf27', 'dsa_nea.geojson', 'NEA Designated Smoking Areas'],
  ['d_491641889c8add4c7835721bd72aa84a', 'nsz_orchard.geojson', 'NEA No-Smoking Zones'],
  ['d_3c8343c1efaeb05d4d1dbcdd0f599077', 'nparks_nosmoking.geojson', 'NParks No-Smoking Locations'],
  ['d_c5822c4f3e210a3b0625e49b3faaac09', 'tobacco_retailers.csv', 'HSA Licensed Tobacco Retailers'],
];

async function pull(id, file, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await fetch(`https://api-open.data.gov.sg/v1/public/api/datasets/${id}/poll-download`)
      .then(r => r.json())
      .catch(() => null);

    if (meta?.data?.url) {
      const body = await fetch(meta.data.url).then(r => r.arrayBuffer());
      fs.writeFileSync(`raw/${file}`, Buffer.from(body));
      console.error(`  ${file}  ${(body.byteLength / 1024).toFixed(0)} KB  — ${label}`);
      return;
    }
    // code 24 = rate limited; the portal asks for a 10s pause
    await sleep(meta?.name === 'TOO_MANY_REQUESTS' ? 11000 : 2500);
  }
  throw new Error(`could not download ${id} (${label})`);
}

console.error('data.gov.sg:');
for (const [id, file, label] of DATASETS) {
  await pull(id, file, label);
  await sleep(11000);   // the portal allows ~5 calls/min
}

/* ---- OpenStreetMap: the community-mapped layer ----
   Deliberately wider than amenity=smoking_area. Contributors record the same real-world
   thing three different ways, and the narrow query finds barely 20 nodes island-wide:
     - amenity=smoking_area / smoking=designated  — an actual smoking area
     - a name containing "Smoking"                — tagged as a plain POI or area
     - smoking=isolated|separated|outside|yes     — a venue with a smoking corner
   build.mjs sorts these back into 'osm' areas and 'venue' corners. ---- */

const QUERY = `[out:json][timeout:180];
area["ISO3166-1"="SG"][admin_level=2]->.sg;
(
  node["amenity"="smoking_area"](area.sg);
  way["amenity"="smoking_area"](area.sg);
  node["name"~"[Ss]moking"](area.sg);
  way["name"~"[Ss]moking"](area.sg);
  node["smoking"~"^(yes|outside|separated|isolated|designated)$"](area.sg);
  way["smoking"~"^(yes|outside|separated|isolated|designated)$"](area.sg);
);
out center tags;`;

// Overpass answers 429/504 under load and rejects requests without a User-Agent (406).
async function overpass(query) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'smokingarea.sg data build (contact: via the site)',
      },
      body: new URLSearchParams({ data: query }),
    });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error('overpass HTTP ' + res.status);
    await sleep(15000 * (attempt + 1));
  }
}

console.error('overpass:');
const osmJson = await overpass(QUERY);
fs.writeFileSync('raw/smoking_osm_wide.json', JSON.stringify(osmJson));
console.error(`  smoking_osm_wide.json  ${osmJson.elements.length} elements`);

/* ---- OpenStreetMap: bulk postcode table, used to geocode the HSA licence register ----
   One query beats ~2,900 individual OneMap calls, and OneMap throttles the public search
   endpoint hard enough that the per-postcode route alone is not practical. ---- */

const POSTCODES = `[out:json][timeout:180];
area["ISO3166-1"="SG"][admin_level=2]->.sg;
(
  node["addr:postcode"](area.sg);
  way["addr:postcode"](area.sg);
);
out center tags;`;

const pc = await overpass(POSTCODES);
fs.writeFileSync('raw/osm_postcodes.json', JSON.stringify(pc));
console.error(`  osm_postcodes.json  ${pc.elements.length} elements`);

console.error('\nNow run: node scripts/geocode.mjs && node scripts/build.mjs');
