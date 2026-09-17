// Sanity checks on the built data. Run after `npm run data` — a bad rebuild here means
// someone standing in Orchard Road gets told they're fine.
import fs from 'node:fs';

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const spots = read('public/data/spots.json');
const shops = read('public/data/shops.json');
const zones = read('public/data/zones.json');

let failed = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) failed++;
};

/* ---- shape ---- */
console.log('\nstructure');
ok(spots.length >= 60, 'at least 60 smoking spots', `${spots.length}`);
ok(spots.filter(s => s.src === 'nea').length === 52, 'exactly 52 NEA designated areas',
   `${spots.filter(s => s.src === 'nea').length}`);
ok(shops.length >= 3000, 'at least 3,000 licensed retailers', `${shops.length}`);
ok(spots.filter(s => s.src === 'cag').length === 32, 'exactly 32 Changi Airport areas',
   `${spots.filter(s => s.src === 'cag').length}`);
ok(spots.filter(s => s.src === 'venue').length >= 50, 'at least 50 venues with a smoking corner',
   `${spots.filter(s => s.src === 'venue').length}`);
// Changi pins are terminal centroids + a small offset; they must still land on the airport.
const cagStray = spots.filter(s => s.src === 'cag' && (s.lat < 1.32 || s.lat > 1.38 || s.lng < 103.97 || s.lng > 104.01));
ok(cagStray.length === 0, 'every Changi pin is on airport land', `${cagStray.length} stray`);
ok(spots.filter(s => s.src === 'cag').every(s => s.approx), 'Changi pins are all flagged approximate');
ok(spots.filter(s => s.src === 'venue').every(s => s.osmUrl), 'every venue links back to OSM');
ok(zones.features.some(f => f.properties.kind === 'nsz'), 'Orchard No-Smoking Zone present');

const SG = p => p.lat > 1.13 && p.lat < 1.52 && p.lng > 103.55 && p.lng < 104.14;
ok(spots.every(SG), 'every spot is inside Singapore');
ok(shops.every(SG), 'every shop is inside Singapore');
ok(spots.every(s => s.name && s.id), 'every spot has an id and a name');
ok(new Set(shops.map(s => s.id)).size === shops.length, 'shop ids are unique');
ok(spots.filter(s => s.src === 'nea').every(s => s.photo), 'every NEA area carries its photo');

/* ---- zone geometry: the part that has consequences ---- */
function inRing(pt, ring) {
  const [x, y] = pt;
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const inPoly = (pt, poly) => inRing(pt, poly[0]) && !poly.slice(1).some(h => inRing(pt, h));
function zoneAt(lat, lng) {
  const pt = [lng, lat];
  for (const f of zones.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    if (polys.some(p => inPoly(pt, p))) return f.properties.kind;
  }
  return null;
}

console.log('\nno-smoking zone detection');
const CASES = [
  ['ION Orchard', 1.30390, 103.83170, 'nsz'],
  ['Ngee Ann City', 1.30280, 103.83480, 'nsz'],
  ['Somerset MRT', 1.30030, 103.83900, 'nsz'],
  ['Botanic Gardens', 1.31380, 103.81590, 'park'],
  ['East Coast Park', 1.30100, 103.91200, 'park'],
  ['Bishan-AMK Park', 1.36230, 103.84680, 'park'],
  ['Labrador Park', 1.26620, 103.80230, 'park'],
  ['Jurong East MRT', 1.33330, 103.74220, null],
  ['Raffles Place', 1.28400, 103.85150, null],
  ['Woodlands Causeway', 1.44500, 103.76900, null],
];
for (const [name, lat, lng, want] of CASES) {
  const got = zoneAt(lat, lng);
  ok(got === want, name.padEnd(20), `expected ${want}, got ${got}`);
}

// Every NEA designated area must fall inside the Orchard zone — that is the whole point
// of them, and it is the strongest end-to-end check that the two datasets still agree.
const nea = spots.filter(s => s.src === 'nea');
const outside = nea.filter(s => zoneAt(s.lat, s.lng) !== 'nsz');
console.log('\ncross-dataset agreement');
ok(outside.length === 0, 'all 52 NEA areas sit inside the Orchard zone',
   outside.length ? outside.map(s => s.name).join(', ') : `${nea.length}/${nea.length}`);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
