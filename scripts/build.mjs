// Builds public/data/*.json from the raw government + OSM sources.
import fs from 'node:fs';

const out = (name, obj) => {
  fs.writeFileSync(`public/data/${name}`, JSON.stringify(obj));
  console.log(`  public/data/${name}  ${(fs.statSync(`public/data/${name}`).size / 1024).toFixed(0)} KB`);
};
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const r6 = n => Math.round(n * 1e6) / 1e6;

/* ---------------- 1. Smoking spots ---------------- */

const titleCase = s => s.toLowerCase()
  .replace(/\b[a-z]/g, c => c.toUpperCase())
  .replace(/\b(Mrt|Dsa|Nea|Hdb|Spc|Ntuc|Ion|Jem|Llp)\b/gi, m => m.toUpperCase())
  .replace(/\bPte\.? Ltd\.?\b/gi, 'Pte Ltd')
  .replace(/^(.+),\s*The$/i, 'The $1')   // the register writes "Tanglin Club, The"
  .trim();

const spots = [];

// NEA Designated Smoking Areas (official, Orchard Road No-Smoking Zone)
for (const f of read('raw/dsa_nea.geojson').features) {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  spots.push({
    id: 'nea-' + p.OBJECTID,
    lat: r6(lat), lng: r6(lng),
    name: titleCase(p.BUILDING_N || 'Designated Smoking Area'),
    where: p.DESCRIPTION || '',
    src: 'nea',
    photo: p.PHOTOURL || null,
    updated: p.FMEL_UPD_D ? `${p.FMEL_UPD_D.slice(0, 4)}-${p.FMEL_UPD_D.slice(4, 6)}-${p.FMEL_UPD_D.slice(6, 8)}` : null,
  });
}

// Changi Airport Group's own published list. CAG gives a location in words
// ("opposite Gate B10"), never a coordinate, so each pin sits on the terminal
// centroid with a small deterministic offset to keep the pins separable —
// approx:true, and the UI says so rather than implying GPS precision.
{
  const cag = read('raw/changi_dsa.json');
  const perTerminal = {};
  for (const a of cag.areas) {
    const base = cag.terminals[a.t];
    if (!base) continue;
    const i = (perTerminal[a.t] = (perTerminal[a.t] ?? -1) + 1);
    const angle = (i / 8) * Math.PI * 2;
    const R = 0.00026;    // ~29 m — well inside a terminal that is ~400 m across
    spots.push({
      id: `cag-${a.t}-${i}`,
      lat: r6(base.lat + R * Math.cos(angle)),
      lng: r6(base.lng + R * Math.sin(angle)),
      name: `Changi Airport ${a.t}`,
      where: `Level ${a.level} · ${a.where}`,
      src: 'cag',
      approx: true,
      airside: a.zone === 'transit',
      level: a.level,
      srcUrl: cag._source,
      updated: cag._captured,
    });
  }
}

// OpenStreetMap: two different things, kept apart because they mean different things.
//   amenity=smoking_area / smoking=designated  -> an actual smoking area  (src 'osm')
//   smoking=isolated|separated|outside|yes     -> a venue with a smoking corner (src 'venue')
const SMOKING_CORNER = { isolated: 'indoor smoking room', separated: 'separated smoking section', outside: 'outdoor smoking area', yes: 'smoking permitted' };

for (const e of read('raw/smoking_osm_wide.json').elements) {
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  if (lat == null || lng == null) continue;
  const t = e.tags || {};
  if (t.access === 'private') continue;                 // not usable by the public
  if (/changi airport/i.test(t.name || '')) continue;    // CAG's own list is better

  const isArea = t.amenity === 'smoking_area' || t.smoking === 'designated' || /smoking/i.test(t.name || '');
  const corner = SMOKING_CORNER[t.smoking];
  if (!isArea && !corner) continue;

  const bits = [];
  if (t.shelter === 'yes' || t.covered === 'yes') bits.push('sheltered');
  if (t.bench === 'yes') bits.push('has bench');
  if (t.bin === 'yes') bits.push('has ashtray');
  if (t.lit === 'yes') bits.push('lit at night');

  spots.push({
    id: `osm-${e.type}-${e.id}`,
    lat: r6(lat), lng: r6(lng),
    // OSM names are typed by people and already correctly cased — titleCase would
    // turn "McDonald's" into "Mcdonald'S". Only the ALL-CAPS registers need it.
    name: t.name ? t.name.trim() : 'Smoking area',
    where: isArea ? bits.join(' · ') : corner,
    src: isArea ? 'osm' : 'venue',
    venueKind: isArea ? null : (t.amenity || t.tourism || t.shop || t.leisure || null),
    hours: t.opening_hours || null,
    level: t.level ?? null,
    osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    updated: t.check_date || null,
  });
}

out('spots.json', spots);
const bySrc = {};
for (const s of spots) bySrc[s.src] = (bySrc[s.src] || 0) + 1;
const nOfficial = bySrc.nea || 0;
const nCommunity = bySrc.osm || 0;
console.log(`  -> ${nOfficial} NEA, ${bySrc.cag || 0} Changi, ${nCommunity} OSM areas, ${bySrc.venue || 0} venues with a smoking corner`);

/* ---------------- 2. No-smoking zones ---------------- */

// Ramer-Douglas-Peucker on lon/lat (tolerance in degrees; 1e-4 deg ~ 11 m)
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    const d = ex * ex + ey * ey;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (Math.sqrt(maxD) > tol) {
    return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
  }
  return [pts[0], pts[pts.length - 1]];
}
const r5 = n => Math.round(n * 1e5) / 1e5;
const cleanRing = (ring, tol) => simplify(ring.map(([x, y]) => [r6(x), r6(y)]), tol).map(([x, y]) => [r5(x), r5(y)]);

const zones = { type: 'FeatureCollection', features: [] };

for (const f of read('raw/nsz_orchard.geojson').features) {
  zones.features.push({
    type: 'Feature',
    properties: {
      kind: 'nsz',
      name: 'Orchard Road No-Smoking Zone',
      note: 'Smoking is an offence anywhere in this zone except inside a marked yellow-box DSA.',
    },
    geometry: { type: 'Polygon', coordinates: f.geometry.coordinates.map(r => cleanRing(r, 0.00002)) },
  });
}

let parkRings = 0;
for (const f of read('raw/nparks_nosmoking.geojson').features) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const kept = polys
    .map(poly => poly.map(r => cleanRing(r, 0.00008)).filter(r => r.length >= 4))
    .filter(poly => poly.length);
  if (!kept.length) continue;
  parkRings += kept.length;
  zones.features.push({
    type: 'Feature',
    properties: {
      kind: 'park',
      name: 'NParks no-smoking area',
      note: 'Smoking is prohibited in all public parks, gardens, beaches and reservoirs.',
    },
    geometry: { type: 'MultiPolygon', coordinates: kept },
  });
}
out('zones.json', zones);
console.log(`  -> 1 NSZ + ${parkRings} park polygons`);

/* ---------------- 3. Licensed tobacco retailers ---------------- */

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

const BRANDS = [
  [/\b7[\s-]?ELEVEN\b|\bSEVEN[\s-]?ELEVEN\b/, '7-Eleven', 'convenience'],
  [/\bCHEERS\b/, 'Cheers', 'convenience'],
  [/\bBUZZ\b/, 'Buzz', 'convenience'],
  [/\bFAIRPRICE\b|\bNTUC\b/, 'FairPrice', 'supermarket'],
  [/\bSHENG\s?SIONG\b/, 'Sheng Siong', 'supermarket'],
  [/\bCOLD\s?STORAGE\b/, 'Cold Storage', 'supermarket'],
  [/\bGIANT\b/, 'Giant', 'supermarket'],
  [/\bPRIME\s?SUPERMARKET\b/, 'Prime', 'supermarket'],
  [/\bSHELL\b/, 'Shell', 'petrol'],
  [/\bESSO\b/, 'Esso', 'petrol'],
  [/\bCALTEX\b/, 'Caltex', 'petrol'],
  [/\bSPC\b|\bSINGAPORE PETROLEUM\b/, 'SPC', 'petrol'],
];

// Most of the register is small independents with Chinese business names ("Heng Lai Heng
// Trading Enterprise") that say nothing about what the shop is. We match the signals that
// really are in the name and leave the rest as 'other' rather than inventing a category.
function classify(name) {
  const n = name.toUpperCase();
  for (const [re, brand, type] of BRANDS) if (re.test(n)) return { brand, type };

  const bare = n
    .replace(/\bPTE\.?\s*LTD\.?\b|\bPRIVATE\s+LIMITED\b|\bLIMITED\b|\bLLP\b/g, ' ')
    .replace(/\s*\(\s*S(INGAPORE)?\s*\)\s*/g, ' ');

  if (/DUTY[\s-]?FREE|CHANGI AIRPORT|\bAIRPORT\b/.test(bare)) return { brand: null, type: 'dutyfree' };

  if (/EATING HOUSE|COFFEE ?SHOP|KOPITIAM|KOPI TIAM|FOOD ?COURT|FOOD ?CENTRE|HAWKER|CANTEEN|KOUFU|RESTAURANT|CATERING|\bBAR\b|\bPUB\b|TAVERN|BISTRO|\bCAFE\b|COFFEE|\bBEER\b|LIQUOR|\bWINE\b|BEVERAGE|\bF ?& ?B\b|HOTEL|RESORT|CLUB\b/.test(bare)) {
    return { brand: null, type: 'foodbev' };
  }

  if (/SUPERMARKET|HYPERMART|HYPERMARKET|EMPORIUM|\bNTUC\b/.test(bare) && !/MINI/.test(bare)) {
    return { brand: null, type: 'supermarket' };
  }

  if (/MINI[\s-]?MART|MINI[\s-]?MARKET|MINIMART|SUPERMART|SUPER ?MINI|PROVISION|MARKETPLACE|\bMART\b|SUNDRY|\bKIOSK\b|CONFECTIONER|\bSTALL\b|\bSTORE\b|\bSHOP\b|\bCORNER\b|NEWSAGEN|NEWS ?STAND/.test(bare)) {
    return { brand: null, type: 'minimart' };
  }

  return { brand: null, type: 'other' };
}

const geo = read('raw/postal_latlng.json');
const rows = parseCsv(fs.readFileSync('raw/tobacco_retailers.csv', 'utf8')).slice(1).filter(r => r.length >= 3 && r[0]);
const shops = [];
const seen = new Set();
let noPostal = 0, noGeo = 0;

for (const [company, period, address] of rows) {
  const postal = (address.match(/SINGAPORE\s*\(?(\d{6})\)?/) || [])[1];
  if (!postal) { noPostal++; continue; }
  const g = geo[postal];
  if (!g) { noGeo++; continue; }

  // Strip a leading repeat of the company name and the trailing "SINGAPORE(xxxxxx)".
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let addr = address
    .replace(new RegExp('^' + escaped + ',?\\s*', 'i'), '')
    .replace(/,?\s*SINGAPORE\s*\(?\d{6}\)?\s*$/i, '')
    .replace(/\s*,\s*/g, ', ')
    .trim()
    .replace(/^,|,$/g, '')
    .trim();
  const unit = (addr.match(/#[\d\w-]+/) || [])[0] || null;

  const key = company + '|' + postal + '|' + (unit || '');
  if (seen.has(key)) continue;
  seen.add(key);

  const { brand, type } = classify(company);
  shops.push({
    id: 's' + shops.length,
    lat: r6(g.lat), lng: r6(g.lng),
    name: brand || titleCase(company),
    licensee: brand ? titleCase(company) : null,
    addr: (addr ? titleCase(addr) + ' ' : '') + 'S(' + postal + ')',
    bldg: g.bldg && g.bldg !== 'NIL' ? titleCase(g.bldg) : null,
    type,
    brand: brand || null,
    valid: period || null,
  });
}

out('shops.json', shops);
const byType = {};
for (const s of shops) byType[s.type] = (byType[s.type] || 0) + 1;
console.log(`  -> ${shops.length} outlets from ${rows.length} licence rows (no postal ${noPostal}, ungeocoded ${noGeo})`);
console.log('  -> ' + Object.entries(byType).sort((a, b) => b[1] - a[1]).map(x => x.join(' ')).join(', '));

fs.writeFileSync('public/data/meta.json', JSON.stringify({
  built: new Date().toISOString().slice(0, 10),
  counts: {
    official: nOfficial,
    changi: bySrc.cag || 0,
    community: nCommunity,
    venues: bySrc.venue || 0,
    shops: shops.length,
  },
}));
console.log('  public/data/meta.json');
