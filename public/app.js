/* smokingarea.sg — find the nearest legal spot in Singapore */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const SG_CENTRE = [1.3521, 103.8198];

  const state = {
    spots: [],
    shops: [],
    zones: null,
    me: null,            // {lat,lng,acc} from geolocation
    ref: SG_CENTRE,      // what distances are measured from
    refIsMe: false,
    layers: { smoke: true, venue: true, shop: false, zone: true },
    shopTypes: new Set(),
    query: '',
    selected: null,
    rows: [],
  };

  /* ---------------- map ---------------- */

  const map = L.map('map', {
    center: SG_CENTRE,
    zoom: 12,
    zoomControl: false,
    maxBounds: [[1.13, 103.55], [1.52, 104.14]],
    maxBoundsViscosity: 0.7,
    preferCanvas: true,
  });

  const TILES = {
    dark: 'https://www.onemap.gov.sg/maps/tiles/Night/{z}/{x}/{y}.png',
    light: 'https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png',
  };
  const ATTR = '&copy; <a href="https://www.onemap.gov.sg/">OneMap</a> / SLA &middot; ' +
    'Data: NEA, NParks, HSA via <a href="https://data.gov.sg/">data.gov.sg</a> &middot; ' +
    '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';

  // detectRetina pulls one zoom level deeper on 2x screens and draws it at half size —
  // without it OneMap's 256px rasters are visibly soft on exactly the phones this is for.
  let tileLayer = L.tileLayer(TILES.dark, {
    minZoom: 11,
    maxZoom: 19,
    maxNativeZoom: 19,
    detectRetina: true,
    attribution: ATTR,
  }).addTo(map);

  const canvas = L.canvas({ padding: 0.3 });
  const zoneLayer = L.layerGroup().addTo(map);
  const shopLayer = L.layerGroup();
  const spotLayer = L.layerGroup().addTo(map);
  const venueLayer = L.layerGroup().addTo(map);
  let meMarker = null, meCircle = null;

  /* ---------------- geometry helpers ---------------- */

  const distM = (a, b) => {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    const la1 = a[0] * rad, la2 = b[0] * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const fmtDist = m => m < 950
    ? `${Math.round(m / 10) * 10} <small>m</small>`
    : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} <small>km</small>`;

  const fmtWalk = m => {
    const mins = Math.round(m / 80);       // ~4.8 km/h
    if (mins < 1) return 'under a min';
    if (mins < 60) return `${mins} min walk`;
    return `${(mins / 60).toFixed(1)} h walk`;
  };

  // ray casting against a single linear ring, [lng,lat] pairs
  function inRing(pt, ring) {
    const [x, y] = pt;
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  const inPolygon = (pt, poly) => inRing(pt, poly[0]) && !poly.slice(1).some(h => inRing(pt, h));

  // returns the matching zone feature's properties, or null
  function zoneAt(lat, lng) {
    if (!state.zones) return null;
    const pt = [lng, lat];
    for (const f of state.zones.features) {
      const g = f.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      if (polys.some(p => inPolygon(pt, p))) return f.properties;
    }
    return null;
  }

  /* ---------------- icons ---------------- */

  const ICONS = {
    nea: '<svg viewBox="0 0 24 24"><rect x="3" y="14" width="13" height="6" rx="1.5"/><path d="M17.5 14v6M20.5 14v6M15 10c0-2.5 2.5-2.5 2.5-5"/></svg>',
    osm: '<svg viewBox="0 0 24 24"><rect x="3" y="14" width="13" height="6" rx="1.5"/><path d="M17.5 14v6M20.5 14v6M15 10c0-2.5 2.5-2.5 2.5-5"/></svg>',
    cag: '<svg viewBox="0 0 24 24"><path d="M2.5 12.5 21 5l-4.5 15-4-6.5Z"/><path d="M12.5 13.5 9 21l-1.5-5.5"/></svg>',
    venue: '<svg viewBox="0 0 24 24"><path d="M4 10h16v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5Z"/><path d="M3 10l1.4-4.2A1 1 0 0 1 5.4 5h13.2a1 1 0 0 1 1 .8L21 10"/><path d="M9.5 2.5c0 1.6-1.5 1.6-1.5 3M14.5 2.5c0 1.6-1.5 1.6-1.5 3"/></svg>',
    convenience: '<svg viewBox="0 0 24 24"><path d="M4 9h16l-1.2 10.5a1.5 1.5 0 0 1-1.5 1.5H6.7a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M8.5 9V6.5a3.5 3.5 0 0 1 7 0V9"/></svg>',
    supermarket: '<svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6"/><circle cx="9.5" cy="20" r="1.2"/><circle cx="17.5" cy="20" r="1.2"/></svg>',
    petrol: '<svg viewBox="0 0 24 24"><path d="M4 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16M3 21h11M6 9h5"/><path d="M16 12h2.5a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 0 1.5 1.5v0A1.5 1.5 0 0 0 23 17V9l-3-3"/></svg>',
    foodbev: '<svg viewBox="0 0 24 24"><path d="M5 3v7a3 3 0 0 0 6 0V3M8 10v11M15 21V3c2.5 1 4 3.5 4 7s-1.5 4-4 4"/></svg>',
    minimart: '<svg viewBox="0 0 24 24"><path d="M4 9h16v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5Z"/><path d="M3 9l1.6-5.2A1 1 0 0 1 5.6 3h12.8a1 1 0 0 1 1 .8L21 9"/></svg>',
    dutyfree: '<svg viewBox="0 0 24 24"><path d="M2 12l20-7-7 20-3-8Z"/></svg>',
    other: '<svg viewBox="0 0 24 24"><path d="M4 9h16v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5Z"/><path d="M3 9l1.6-5.2A1 1 0 0 1 5.6 3h12.8a1 1 0 0 1 1 .8L21 9"/></svg>',
  };

  // How each source is badged, and how much it should be trusted.
  const SRC = {
    nea:   { tag: 'NEA official',   cls: 'official',  kicker: 'NEA Designated Smoking Area' },
    cag:   { tag: 'Changi official', cls: 'official', kicker: 'Changi Airport designated smoking area' },
    osm:   { tag: 'Community',      cls: 'community', kicker: 'Community-mapped spot' },
    venue: { tag: 'Smoking corner', cls: 'venue',     kicker: 'Venue with a smoking corner' },
  };

  const TYPE_LABEL = {
    convenience: 'Convenience store',
    supermarket: 'Supermarket',
    petrol: 'Petrol station',
    foodbev: 'Coffee shop / bar',
    minimart: 'Minimart / provision shop',
    dutyfree: 'Duty free',
    other: 'Provision shop / other',
  };

  /* ---------------- data load ---------------- */

  async function boot() {
    const [spots, shops, zones, meta] = await Promise.all([
      fetch('data/spots.json').then(r => r.json()),
      fetch('data/shops.json').then(r => r.json()).catch(() => []),
      fetch('data/zones.json').then(r => r.json()),
      fetch('data/meta.json').then(r => r.json()).catch(() => null),
    ]);
    state.spots = spots;
    state.shops = shops;
    state.zones = zones;

    $('cSmoke').textContent = spots.filter(s => s.src !== 'venue').length;
    $('cVenue').textContent = spots.filter(s => s.src === 'venue').length;
    $('cShop').textContent = shops.length.toLocaleString();
    if (meta) $('built').textContent = `Data rebuilt ${meta.built}.`;

    drawZones();
    drawSpots();
    drawShops();
    buildSubchips();
    render();
    locate(true);
  }

  function drawZones() {
    L.geoJSON(state.zones, {
      renderer: canvas,
      style: f => f.properties.kind === 'nsz'
        ? { color: '#ff7a3d', weight: 2, opacity: .95, fillColor: '#ff7a3d', fillOpacity: .07, dashArray: '7 5' }
        : { color: '#ff5566', weight: 1, opacity: .5, fillColor: '#ff5566', fillOpacity: .13 },
    }).addTo(zoneLayer);
  }

  function drawSpots() {
    for (const s of state.spots) {
      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="pin pin-${s.src}" data-id="${s.id}"></div>`,
          iconSize: [15, 15],
          iconAnchor: [7.5, 7.5],
        }),
        riseOnHover: true,
        keyboard: false,
      });
      m.on('click', () => select(s.id));
      m.addTo(s.src === 'venue' ? venueLayer : spotLayer);
    }
  }

  function drawShops() {
    for (const s of state.shops) {
      const c = L.circleMarker([s.lat, s.lng], {
        renderer: canvas,
        radius: 4,
        weight: 1.4,
        color: '#0a0b0e',
        fillColor: '#2fd39c',
        fillOpacity: .92,
      });
      c.on('click', () => select(s.id));
      c.addTo(shopLayer);
    }
  }

  function buildSubchips() {
    const counts = {};
    for (const s of state.shops) counts[s.type] = (counts[s.type] || 0) + 1;
    const order = ['convenience', 'supermarket', 'minimart', 'petrol', 'foodbev', 'dutyfree', 'other'];
    $('subchips').innerHTML = order.filter(t => counts[t]).map(t =>
      `<button class="subchip" data-type="${t}">${TYPE_LABEL[t]} <span style="opacity:.6">${counts[t]}</span></button>`
    ).join('');
  }

  /* ---------------- list ---------------- */

  const norm = s => (s || '').toLowerCase();

  function collect() {
    const q = norm(state.query);
    const rows = [];

    for (const s of state.spots) {
      const wanted = s.src === 'venue' ? state.layers.venue : state.layers.smoke;
      if (!wanted) continue;
      if (q && !(norm(s.name) + ' ' + norm(s.where)).includes(q)) continue;
      rows.push({ kind: 'spot', d: s, dist: distM(state.ref, [s.lat, s.lng]) });
    }
    if (state.layers.shop) {
      const wanted = state.shopTypes;
      for (const s of state.shops) {
        if (wanted.size && !wanted.has(s.type)) continue;
        if (q && !(norm(s.name) + ' ' + norm(s.addr) + ' ' + norm(s.bldg) + ' ' + norm(s.licensee)).includes(q)) continue;
        rows.push({ kind: 'shop', d: s, dist: distM(state.ref, [s.lat, s.lng]) });
      }
    }
    rows.sort((a, b) => a.dist - b.dist);
    return rows;
  }

  function render() {
    const rows = state.rows = collect();
    const list = $('list');
    const hero = $('hero');

    // hero = nearest actual smoking area; a venue's unverified smoking corner
    // isn't a confident enough answer to headline with.
    const near = rows.find(r => r.kind === 'spot' && r.d.src !== 'venue')
              || rows.find(r => r.kind === 'spot');
    if (near) {
      const s = near.d;
      hero.hidden = false;
      hero.dataset.id = s.id;
      hero.innerHTML =
        `<div class="hero-label">${state.refIsMe ? 'Nearest smoking area' : 'Nearest to map centre'}</div>
         <div class="hero-name">${esc(s.name)}</div>
         <div class="hero-sub">${esc(s.where || (s.src === 'nea' ? 'Designated Smoking Area' : 'Community-mapped spot'))}</div>
         <div class="hero-dist">${fmtDist(near.dist)} <small>· ${fmtWalk(near.dist)}</small></div>`;
    } else {
      hero.hidden = true;
    }

    const shown = rows.slice(0, 60);
    list.innerHTML = shown.map(r => r.kind === 'spot' ? rowSpot(r) : rowShop(r)).join('');

    const empty = $('empty');
    if (!rows.length) {
      empty.hidden = false;
      const c = map.getCenter();
      const g = `https://www.google.com/maps/search/${encodeURIComponent((state.query || 'smoking area') + ' singapore')}/@${c.lat.toFixed(5)},${c.lng.toFixed(5)},16z`;
      empty.innerHTML = state.query
        ? `<b>Nothing matches “${esc(state.query)}”</b>Try a mall, a block number or an MRT station.
           <a class="d-glink" style="justify-content:center;margin-top:14px" href="${g}" target="_blank" rel="noopener">Try “${esc(state.query)}” on Google Maps
           <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg></a>`
        : `<b>Nothing to show</b>Turn on a layer above.`;
    } else {
      empty.hidden = true;
    }

    if (rows.length > shown.length) {
      list.insertAdjacentHTML('beforeend',
        `<li class="empty" style="padding:16px 6px">+ ${(rows.length - shown.length).toLocaleString()} more — zoom in or search to narrow it down.</li>`);
    }
  }

  function rowSpot(r) {
    const s = r.d;
    const meta = SRC[s.src] || SRC.osm;
    return `<li class="row ${state.selected === s.id ? 'is-sel' : ''}" data-id="${s.id}" tabindex="0" role="button">
      <div class="row-ico ${s.src}">${ICONS[s.src] || ICONS.osm}</div>
      <div class="row-main">
        <div class="row-name">${esc(s.name)}</div>
        <div class="row-sub">${esc(s.where || meta.kicker)}</div>
        <div class="row-tags">
          <span class="tag ${meta.cls}">${meta.tag}</span>
          ${s.airside ? '<span class="tag">After immigration</span>' : ''}
          ${s.approx ? '<span class="tag">Approx. pin</span>' : ''}
          ${s.hours ? `<span class="tag">${esc(s.hours)}</span>` : ''}
        </div>
      </div>
      <div class="row-dist">${fmtDist(r.dist)}<small>${fmtWalk(r.dist)}</small></div>
    </li>`;
  }

  function rowShop(r) {
    const s = r.d;
    return `<li class="row ${state.selected === s.id ? 'is-sel' : ''}" data-id="${s.id}" tabindex="0" role="button">
      <div class="row-ico shop">${ICONS[s.type] || ICONS.other}</div>
      <div class="row-main">
        <div class="row-name">${esc(s.name)}</div>
        <div class="row-sub">${esc(s.addr)}</div>
        <div class="row-tags"><span class="tag">${TYPE_LABEL[s.type] || 'Retailer'}</span></div>
      </div>
      <div class="row-dist">${fmtDist(r.dist)}<small>${fmtWalk(r.dist)}</small></div>
    </li>`;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- selection + detail ---------------- */

  function find(id) {
    return state.spots.find(s => s.id === id) || state.shops.find(s => s.id === id);
  }

  function select(id, fly = true) {
    const d = find(id);
    if (!d) return;
    state.selected = id;

    document.querySelectorAll('.pin.is-sel').forEach(el => el.classList.remove('is-sel'));
    const pin = document.querySelector(`.pin[data-id="${CSS.escape(id)}"]`);
    if (pin) pin.classList.add('is-sel');

    if (fly) map.flyTo([d.lat, d.lng], Math.max(map.getZoom(), 17), { duration: .55 });
    showDetail(d);
    render();
  }

  function showDetail(d) {
    const isShop = 'addr' in d;
    const zone = zoneAt(d.lat, d.lng);
    const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}&travelmode=walking`;

    let html;
    if (isShop) {
      html = `<div class="d-kicker shop">${TYPE_LABEL[d.type] || 'Licensed retailer'}</div>
        <div class="d-name">${esc(d.name)}</div>
        <div class="d-where">${esc(d.addr)}</div>
        <dl class="d-meta">
          ${d.bldg ? `<div><dt>Building</dt><dd>${esc(d.bldg)}</dd></div>` : ''}
          ${d.licensee ? `<div><dt>Licensee</dt><dd>${esc(d.licensee)}</dd></div>` : ''}
          ${d.valid ? `<div><dt>Licence</dt><dd>Valid ${esc(d.valid)}</dd></div>` : ''}
          <div><dt>Source</dt><dd>HSA tobacco retail licence register</dd></div>
        </dl>
        <div class="d-warn">Holding a licence isn't a guarantee they're open, still trading, or stocking your brand. You must be 21 or older — bring ID.</div>`;
    } else {
      const meta = SRC[d.src] || SRC.osm;
      const sourceLine = {
        nea: 'NEA, via data.gov.sg',
        cag: `<a href="${esc(d.srcUrl || '#')}" target="_blank" rel="noopener" style="color:var(--ember)">Changi Airport Group</a>`,
        osm: `<a href="${esc(d.osmUrl)}" target="_blank" rel="noopener" style="color:var(--sky)">OpenStreetMap contributor</a>`,
        venue: `<a href="${esc(d.osmUrl)}" target="_blank" rel="noopener" style="color:var(--violet)">OpenStreetMap contributor</a>`,
      }[d.src];

      html = `<div class="d-kicker ${d.src}">${meta.kicker}</div>
        <div class="d-name">${esc(d.name)}</div>
        <div class="d-where">${esc(d.where || meta.kicker)}</div>
        ${d.src === 'nea' && d.photo ? `<img class="d-photo" src="${esc(d.photo)}" alt="NEA photo of the smoking area at ${esc(d.name)}" loading="lazy" onerror="this.remove()">` : ''}
        <dl class="d-meta">
          ${d.venueKind ? `<div><dt>Venue</dt><dd>${esc(d.venueKind.replace(/_/g, ' '))}</dd></div>` : ''}
          ${d.airside != null ? `<div><dt>Access</dt><dd>${d.airside ? 'Transit area — after immigration' : 'Public area — before immigration'}</dd></div>` : ''}
          ${d.hours ? `<div><dt>Hours</dt><dd>${esc(d.hours)}</dd></div>` : ''}
          ${d.level != null ? `<div><dt>Level</dt><dd>${esc(d.level)}</dd></div>` : ''}
          ${d.updated ? `<div><dt>${d.src === 'cag' ? 'Captured' : 'Verified'}</dt><dd>${esc(d.updated)}</dd></div>` : ''}
          <div><dt>Source</dt><dd>${sourceLine}</dd></div>
        </dl>`;

      if (d.src === 'nea') {
        html += `<div class="d-warn d-warn-ember">Stay <b>inside the painted yellow box</b>. One step outside it, anywhere in the Orchard zone, is a S$200 fine.</div>`;
      } else if (d.src === 'cag') {
        html += `<div class="d-warn d-warn-ember">The pin marks <b>the terminal, not the spot</b> — Changi publishes these in words, not coordinates. Go by the description above and the signs once you're inside.</div>`;
      } else if (d.src === 'venue') {
        html += `<div class="d-warn d-warn-violet">An OpenStreetMap contributor recorded a smoking corner here — <b>nobody has verified it recently</b>. Ask the staff before you light up.</div>`;
      } else if (zone) {
        html += `<div class="d-warn">Heads up: this sits inside a <b>${esc(zone.name)}</b>. Double-check the signs on the ground before lighting up.</div>`;
      }
    }

    // Google's terms don't allow their Places data to be stored or drawn on a
    // non-Google map, so we hand the viewer straight to Google live instead.
    const gsearch = `https://www.google.com/maps/search/${encodeURIComponent(isShop ? d.name : 'smoking area')}/@${d.lat},${d.lng},18z`;

    html += `<div class="d-actions">
        <a class="btn btn-primary" href="${gmaps}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
          Directions
        </a>
        <button class="btn" id="shareBtn">
          <svg viewBox="0 0 24 24"><path d="M8.6 13.5 15.4 17M15.4 7 8.6 10.5"/><circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/></svg>
          Share
        </button>
      </div>
      <a class="d-glink" href="${gsearch}" target="_blank" rel="noopener">
        See what people say about this spot on Google Maps
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>
      </a>`;

    $('detailBody').innerHTML = html;
    $('detail').hidden = false;

    $('shareBtn').onclick = async () => {
      const url = `${location.origin}${location.pathname}#${d.id}`;
      const text = `${d.name} — ${isShop ? 'sells cigarettes' : 'smoking area'} · smokingarea.sg`;
      try {
        if (navigator.share) await navigator.share({ title: 'smokingarea.sg', text, url });
        else { await navigator.clipboard.writeText(url); $('shareBtn').lastChild.textContent = ' Copied!'; }
      } catch { /* user dismissed */ }
    };
  }

  function closeDetail() {
    $('detail').hidden = true;
    state.selected = null;
    document.querySelectorAll('.pin.is-sel').forEach(el => el.classList.remove('is-sel'));
    render();
  }

  /* ---------------- geolocation ---------------- */

  let watchId = null;

  function locate(silent = false) {
    if (!navigator.geolocation) {
      if (!silent) banner('warn', 'Your browser will not share a location.');
      return;
    }
    const btn = $('locateBtn');
    btn.classList.add('is-busy');

    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
      pos => {
        btn.classList.remove('is-busy');
        btn.classList.add('is-on');
        const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
        const first = !state.me;
        state.me = { lat, lng, acc };
        state.ref = [lat, lng];
        state.refIsMe = true;

        if (!meMarker) {
          meMarker = L.marker([lat, lng], {
            icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
            interactive: false,
            zIndexOffset: 1000,
          }).addTo(map);
          meCircle = L.circle([lat, lng], { radius: acc, renderer: canvas, color: '#3b82f6', weight: 1, opacity: .35, fillOpacity: .07 }).addTo(map);
        } else {
          meMarker.setLatLng([lat, lng]);
          meCircle.setLatLng([lat, lng]).setRadius(acc);
        }
        if (first) map.flyTo([lat, lng], 16, { duration: 1 });
        checkZone();
        render();
      },
      err => {
        btn.classList.remove('is-busy');
        if (!silent) {
          banner('warn', err.code === 1
            ? 'Location blocked. Turn it on in your browser settings, or just pan the map — distances follow the centre.'
            : 'Could not get a fix. Distances are measured from the map centre instead.');
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 }
    );
  }

  function checkZone() {
    if (!state.me) return;
    const z = zoneAt(state.me.lat, state.me.lng);
    if (z) {
      const nearest = state.spots
        .map(s => ({ s, d: distM([state.me.lat, state.me.lng], [s.lat, s.lng]) }))
        .sort((a, b) => a.d - b.d)[0];
      banner('warn',
        `<b>You're inside the ${esc(z.name)}.</b> ${esc(z.note)}` +
        (nearest && nearest.d < 1500 ? ` Nearest legal spot: <b>${esc(nearest.s.name)}</b>, ${Math.round(nearest.d)} m away.` : ''));
    } else {
      // The park layer is NParks-managed land only. Gardens by the Bay, Marina Barrage,
      // Sentosa and similar are run by other bodies, ban smoking just the same, and are
      // absent from the dataset — so "no match" must never read as "you're fine".
      banner('ok', `<b>No mapped no-smoking zone here</b> — but that only covers Orchard and NParks land. ` +
        `Gardens by the Bay, Sentosa, Marina Barrage and every sheltered or indoor space ban it too. Read the signs.`);
    }
  }

  function banner(kind, html) {
    const b = $('banner');
    b.hidden = false;
    b.className = 'banner ' + kind;
    const ico = kind === 'warn'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 3 1.8 20.5h20.4Z"/><path d="M12 10v4M12 17v.5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12.5 9.5 18 20 7"/></svg>';
    b.innerHTML = ico + '<div>' + html + '</div>';
  }

  /* ---------------- interaction wiring ---------------- */

  $('locateBtn').onclick = () => {
    if (state.me) {
      map.flyTo([state.me.lat, state.me.lng], 17, { duration: .7 });
      checkZone();
    } else locate(false);
  };

  document.querySelectorAll('.chip').forEach(chip => {
    chip.onclick = () => {
      const k = chip.dataset.layer;
      state.layers[k] = !state.layers[k];
      chip.classList.toggle('is-on', state.layers[k]);
      chip.setAttribute('aria-selected', String(state.layers[k]));

      if (k === 'smoke') state.layers.smoke ? spotLayer.addTo(map) : map.removeLayer(spotLayer);
      if (k === 'venue') state.layers.venue ? venueLayer.addTo(map) : map.removeLayer(venueLayer);
      if (k === 'zone') state.layers.zone ? zoneLayer.addTo(map) : map.removeLayer(zoneLayer);
      if (k === 'shop') {
        state.layers.shop ? shopLayer.addTo(map) : map.removeLayer(shopLayer);
        $('subchips').hidden = !state.layers.shop;
      }
      render();
    };
  });

  $('subchips').onclick = e => {
    const b = e.target.closest('.subchip');
    if (!b) return;
    const t = b.dataset.type;
    state.shopTypes.has(t) ? state.shopTypes.delete(t) : state.shopTypes.add(t);
    b.classList.toggle('is-on', state.shopTypes.has(t));
    render();
  };

  let searchTimer;
  $('search').oninput = e => {
    state.query = e.target.value.trim();
    $('clearBtn').hidden = !state.query;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 130);
  };
  $('clearBtn').onclick = () => {
    $('search').value = '';
    state.query = '';
    $('clearBtn').hidden = true;
    render();
  };
  $('search').onfocus = () => { if (document.body.dataset.snap === 'peek') snap('full'); };

  $('list').onclick = e => {
    const li = e.target.closest('.row');
    if (li) select(li.dataset.id);
  };
  $('list').onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = e.target.closest('.row');
    if (!li) return;
    e.preventDefault();
    select(li.dataset.id);
  };
  $('hero').onclick = () => { if ($('hero').dataset.id) select($('hero').dataset.id); };
  $('detailClose').onclick = closeDetail;

  $('aboutBtn').onclick = () => { $('about').hidden = false; };
  $('aboutClose').onclick = () => { $('about').hidden = true; };
  $('about').onclick = e => { if (e.target === $('about')) $('about').hidden = true; };
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('about').hidden) $('about').hidden = true;
    else if (!$('detail').hidden) closeDetail();
  });

  // theme
  const applyTheme = t => {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#0a0b0e' : '#f4f2ee';
    tileLayer.setUrl(TILES[t]);
    localStorage.setItem('sa-theme', t);
  };
  try {
    const saved = localStorage.getItem('sa-theme');
    if (saved) applyTheme(saved);
    else if (matchMedia('(prefers-color-scheme: light)').matches) applyTheme('light');
  } catch { /* storage blocked */ }
  $('themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

  // distances follow the map when we have no fix of our own
  let moveTimer;
  map.on('moveend', () => {
    if (state.refIsMe) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const c = map.getCenter();
      state.ref = [c.lat, c.lng];
      render();
    }, 200);
  });

  /* ---------------- bottom sheet drag ---------------- */

  const SNAPS = ['peek', 'half', 'full'];
  const snap = s => { document.body.dataset.snap = s; setTimeout(() => map.invalidateSize({ pan: false }), 320); };
  snap(innerWidth >= 880 ? 'full' : 'half');

  const sheet = $('sheet');
  let drag = null;

  $('grabber').addEventListener('pointerdown', e => {
    if (innerWidth >= 880) return;
    drag = { y: e.clientY, h: sheet.getBoundingClientRect().height };
    sheet.classList.add('dragging');
    $('grabber').setPointerCapture(e.pointerId);
  });
  $('grabber').addEventListener('pointermove', e => {
    if (!drag) return;
    const h = Math.min(innerHeight * .92, Math.max(120, drag.h + (drag.y - e.clientY)));
    sheet.style.height = h + 'px';
    $('locateBtn').style.bottom = (h + 16) + 'px';
  });
  const endDrag = () => {
    if (!drag) return;
    const h = sheet.getBoundingClientRect().height;
    sheet.classList.remove('dragging');
    sheet.style.height = '';
    $('locateBtn').style.bottom = '';
    const targets = { peek: 186, half: innerHeight * .56, full: innerHeight * .92 };
    snap(SNAPS.reduce((best, s) => Math.abs(targets[s] - h) < Math.abs(targets[best] - h) ? s : best, 'half'));
    drag = null;
  };
  $('grabber').addEventListener('pointerup', endDrag);
  $('grabber').addEventListener('pointercancel', endDrag);
  $('grabber').addEventListener('click', () => {
    if (innerWidth >= 880) return;
    const i = SNAPS.indexOf(document.body.dataset.snap);
    snap(SNAPS[(i + 1) % SNAPS.length]);
  });

  addEventListener('resize', () => snap(innerWidth >= 880 ? 'full' : document.body.dataset.snap));

  boot().then(() => {
    const id = location.hash.slice(1);
    if (id) setTimeout(() => select(decodeURIComponent(id)), 400);
  }).catch(err => {
    console.error(err);
    $('empty').hidden = false;
    $('empty').innerHTML = '<b>Could not load the map data</b>Check your connection and refresh.';
  });
})();
