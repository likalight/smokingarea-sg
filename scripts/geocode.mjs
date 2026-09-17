// Resolves every postal code in the HSA licence register to a lat/lng.
//
// Two sources, in this order:
//   1. OpenStreetMap  — one bulk Overpass query gives ~26k Singapore postcodes with no rate limit.
//      This covers roughly 70% of the register and sits within 25 m of OneMap on average.
//   2. OneMap search  — asked only for the remainder. The public endpoint is throttled hard
//      (HTTP 429 with an HTML body even at 100 req/min), so this pass is deliberately patient:
//      one request at a time, and a 429 only ever backs off the *current* request.
//
// Failures are never written to the cache, so re-running always resumes on what is left.
import fs from 'node:fs';

const CACHE = 'raw/geocache.json';      // OneMap answers only; OSM is re-derived each run
const OUT = 'raw/postal_latlng.json';   // merged table consumed by build.mjs
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---- what we need ---- */

const rows = parseCsv(fs.readFileSync('raw/tobacco_retailers.csv', 'utf8')).slice(1).filter(r => r.length >= 3 && r[0]);
const need = [...new Set(rows.map(r => (r[2].match(/SINGAPORE\s*\(?(\d{6})\)?/) || [])[1]).filter(Boolean))];

/* ---- source 1: OpenStreetMap bulk table ---- */

const table = {};
if (fs.existsSync('raw/osm_postcodes.json')) {
  const elements = JSON.parse(fs.readFileSync('raw/osm_postcodes.json', 'utf8')).elements || [];
  for (const el of elements) {
    const p = String(el.tags?.['addr:postcode'] ?? '').trim();
    if (!/^\d{6}$/.test(p) || table[p]) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    table[p] = {
      lat, lng,
      // NOT el.tags.name: that is whatever POI happens to sit at this postcode, so a
      // 7-Eleven sharing a block with a FairPrice would inherit "FairPrice Finest".
      // Only addr:housename is actually a building name.
      bldg: el.tags['addr:housename'] || null,
      road: el.tags['addr:street'] || null,
      blk: el.tags['addr:housenumber'] || null,
      src: 'osm',
    };
  }
}
const fromOsm = need.filter(p => table[p]).length;

/* ---- source 2: cached OneMap answers ---- */

let cache = {};
if (fs.existsSync(CACHE)) {
  // drop anything an earlier run cached as a miss so it gets another chance
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE, 'utf8')))) if (v) cache[k] = v;
}
for (const [p, v] of Object.entries(cache)) if (!table[p]) table[p] = { ...v, src: 'onemap' };

const todo = need.filter(p => !table[p]);
console.error(`register needs ${need.length} postal codes`);
console.error(`  ${fromOsm} from OpenStreetMap, ${Object.keys(cache).length} cached from OneMap`);
console.error(`  ${todo.length} left to look up\n`);

/* ---- the patient OneMap pass ---- */

const GAP = 700;                 // ~85 req/min, and still not always enough
let hits = 0, misses = 0, throttles = 0, gaveUp = 0;

async function lookup(p) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(
        `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${p}&returnGeom=Y&getAddrDetails=Y&pageNum=1`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) },
      );
      if (res.status === 429) {
        throttles++;
        await sleep(2500 + attempt * 1500);   // back off this request only
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const j = await res.json();
      const hit = (j.results || []).find(x => x.POSTAL === p) || (j.results || [])[0];
      if (hit?.LATITUDE) {
        cache[p] = { lat: +hit.LATITUDE, lng: +hit.LONGITUDE, bldg: hit.BUILDING, road: hit.ROAD_NAME, blk: hit.BLK_NO };
        table[p] = { ...cache[p], src: 'onemap' };
        hits++;
      } else {
        misses++;   // OneMap answered and knows nothing here
      }
      return;
    } catch {
      await sleep(900 * (attempt + 1));
    }
  }
  gaveUp++;   // leave it out of the cache; a later run retries it
}

const save = () => {
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  fs.writeFileSync(OUT, JSON.stringify(table));
};

save();   // the OSM table alone is already usable, so let build.mjs run against it right away

for (let i = 0; i < todo.length; i++) {
  await lookup(todo[i]);
  await sleep(GAP);
  if ((i + 1) % 50 === 0) {
    save();
    const pct = ((i + 1) / todo.length * 100).toFixed(0);
    console.error(`  ${i + 1}/${todo.length} (${pct}%)  hits=${hits} miss=${misses} 429s=${throttles} gaveup=${gaveUp}`);
  }
}

save();
const got = need.filter(p => table[p]).length;
console.error(`\nDONE  hits=${hits} miss=${misses} 429s=${throttles} gaveup=${gaveUp}`);
console.error(`resolved ${got}/${need.length} postal codes (${(got / need.length * 100).toFixed(1)}%)`);
if (gaveUp) console.error(`re-run this script to retry the ${gaveUp} that hit the throttle wall.`);
