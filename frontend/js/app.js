/* global maplibregl, turf */
import * as api from './api.js';
import { computePotentiel, RULE_FIELDS } from './potentiel.js';
import * as store from './store.js';
import { grille, analyser } from './occupation.js';
import { noter, contraintesDe, compacite } from './score.js';
import { initProspection, CRIT_DEFAUT } from './prospection.js';
import { reglesGraphiques, fusionRegles } from './regles.js';
import { reglesParZone, plage } from './zones.js';
import * as permis from './permis.js';

// ---------- Utilitaires ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f0 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('fr-FR'));
const m2 = (n) => `${f0(n)} m²`;
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200); }
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copié dans le presse-papiers'); } catch { toast('Copie refusée par le navigateur'); } }
const refOf = (p) => (p ? `${p.code_insee} ${p.section} ${String(p.numero).padStart(4, '0')}` : '');
// Zones d'activités, d'équipements ou à urbaniser à long terme (2AU, AUs) : écartées des recherches de logement
const zoneHorsLogement = (z) => {
  const p = z.properties, lib = p.libelle || '', long = p.libelong || '', t = (p.typezone || '').toUpperCase();
  return t === 'AUS' || /^2AU/i.test(lib) || /activit|[ée]quipement|industri|commerc|portuaire|a[ée]roport/i.test(long) || /(^|-)(U?AE|UE|UX|UI|UY)\d*(-|$)/i.test(lib);
};
const zoneConstructible = (z) => {
  if (!z) return null;
  const t = (z.properties.typezone || '').toUpperCase();
  if (t.startsWith('U')) return true;
  if (t.startsWith('AU')) return true;
  if (t.startsWith('A') || t.startsWith('N')) return false;
  return null;
};
const scoreClass = (v) => `s${Math.min(4, Math.floor(v / 20))}`;

// ---------- Carte ----------
const wmts = (layer, style, fmt) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${encodeURIComponent(style)}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${encodeURIComponent(fmt)}`;
const wms = (layers) => `https://data.geopf.fr/wms-v/ows?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layers}&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`;
const empty = { type: 'FeatureCollection', features: [] };
const SCORE_COLORS = ['#c9cfd8', '#f2c46d', '#f29a4a', '#3f8f5f', '#1f6b45'];

const map = new maplibregl.Map({
  container: 'map',
  center: [2.45, 46.6], zoom: 5.4, maxZoom: 20, hash: true,
  style: {
    version: 8,
    sources: {
      plan: { type: 'raster', tiles: [wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'normal', 'image/png')], tileSize: 256, maxzoom: 19, attribution: '© IGN Géoplateforme' },
      ortho: { type: 'raster', tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'normal', 'image/jpeg')], tileSize: 256, maxzoom: 19, attribution: '© IGN Géoplateforme' },
      orthoHist: { type: 'raster', tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS2016-2020', 'normal', 'image/jpeg')], tileSize: 256, maxzoom: 18, attribution: '© IGN Géoplateforme' },
      noms: { type: 'raster', tiles: [wmts('GEOGRAPHICALNAMES.NAMES', 'normal', 'image/png')], tileSize: 256, maxzoom: 18, attribution: '© IGN Géoplateforme' },
      cadastre: { type: 'raster', tiles: [wmts('CADASTRALPARCELS.PARCELLAIRE_EXPRESS', 'PCI vecteur', 'image/png')], tileSize: 256, maxzoom: 19, attribution: 'Cadastre © DGFiP / IGN' },
      zonage: { type: 'raster', tiles: [wms('du')], tileSize: 256, attribution: "Géoportail de l'Urbanisme" },
      presc: { type: 'raster', tiles: [wms('prescription,info')], tileSize: 256 },
      sel: { type: 'geojson', data: empty },
      env: { type: 'geojson', data: empty },
      hits: { type: 'geojson', data: empty },
      bati: { type: 'geojson', data: empty },
      permis: { type: 'geojson', data: empty },
      vefa: { type: 'geojson', data: empty },
    },
    layers: [
      { id: 'plan', type: 'raster', source: 'plan' },
      { id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } },
      { id: 'orthoHist', type: 'raster', source: 'orthoHist', layout: { visibility: 'none' } },
      { id: 'zonage', type: 'raster', source: 'zonage', minzoom: 11, paint: { 'raster-opacity': 0.45 } },
      { id: 'presc', type: 'raster', source: 'presc', minzoom: 13, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } },
      { id: 'cadastre', type: 'raster', source: 'cadastre', minzoom: 15 },
      { id: 'noms', type: 'raster', source: 'noms', layout: { visibility: 'none' } },
      { id: 'hits-fill', type: 'fill', source: 'hits', paint: { 'fill-color': ['step', ['get', 'score'], SCORE_COLORS[0], 20, SCORE_COLORS[1], 40, SCORE_COLORS[2], 60, SCORE_COLORS[3], 80, SCORE_COLORS[4]], 'fill-opacity': 0.6 } },
      { id: 'hits-line', type: 'line', source: 'hits', paint: { 'line-color': '#18222d', 'line-width': 0.8, 'line-opacity': 0.6 } },
      { id: 'bati-fill', type: 'fill', source: 'bati', paint: { 'fill-color': '#7a4ec9', 'fill-opacity': 0.35 } },
      { id: 'sel-fill', type: 'fill', source: 'sel', paint: { 'fill-color': '#2347c5', 'fill-opacity': 0.12 } },
      { id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#2347c5', 'line-width': 3 } },
      { id: 'vefa-pt', type: 'circle', source: 'vefa', layout: { visibility: 'none' }, paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'ventes'], 1, 5, 30, 11, 150, 17], 'circle-color': '#8e3fb8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 0.85 } },
      { id: 'permis-pt', type: 'circle', source: 'permis', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'logements'], 2, 6, 50, 11, 200, 18], 'circle-color': ['match', ['get', 'etat'], 6, '#1f6b45', 5, '#e0661b', 2, '#2347c5', '#8a8f98'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 0.9 } },
      { id: 'env-line', type: 'line', source: 'env', paint: { 'line-color': '#e0661b', 'line-width': 2, 'line-dasharray': [2, 1.5] } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
map.on('click', (e) => { if (e.defaultPrevented || (map.getLayer('permis-pt') && map.queryRenderedFeatures(e.point, { layers: ['permis-pt', 'vefa-pt'] }).length)) return; selectAt(e.lngLat.lng, e.lngLat.lat); });

// Infobulle au survol des terrains de la prospection
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, className: 'tf-pop' });
map.on('mousemove', 'hits-fill', (e) => {
  map.getCanvas().style.cursor = 'pointer';
  const p = e.features[0].properties;
  popup.setLngLat(e.lngLat).setHTML(`<b>${esc(p.ref)}</b> · ${esc(p.zone)}<br>${esc(p.nature)} · ${m2(+p.surface)}<br>Note <b>${p.score}</b>/100${p.partiel === 'true' || p.partiel === true ? ' (partielle)' : ''}`).addTo(map);
});
map.on('mouseleave', 'hits-fill', () => { map.getCanvas().style.cursor = ''; popup.remove(); });

map.on('click', 'permis-pt', (e) => {
  e.preventDefault && e.preventDefault();
  const p = e.features[0].properties;
  new maplibregl.Popup({ offset: 10, className: 'tf-pop' }).setLngLat(e.lngLat).setHTML(`<b>${esc(p.demandeur || 'Demandeur non publié')}</b><br>${p.logements} logement(s) dont ${p.collectifs} collectif(s)${+p.sociaux ? `, ${p.sociaux} social(aux)` : ''}<br>${esc(p.etatLib)} · autorisé le ${esc(p.autorisation || '?')}<br><small>${esc(p.num)} · ${esc(p.adresse || '')}</small>`).addTo(map);
});
map.on('click', 'vefa-pt', (e) => {
  const p = e.features[0].properties;
  new maplibregl.Popup({ offset: 10, className: 'tf-pop' }).setLngLat(e.lngLat).setHTML(`<b>Ventes sur plan · ${esc(p.promoteur || 'programme')}</b><br>${p.ventes} vente(s) du ${esc(p.debut)} au ${esc(p.fin)}<br>${+p.m2Med ? `<b>${f0(+p.m2Med)} €/m²</b> (médiane de ${p.nM2} vente(s))<br>` : ''}${+p.prixMed ? `Prix médian ${f0(+p.prixMed)} €` : ''}<br><small>Parcelle ${esc(p.idu)} · DVF</small>`).addTo(map);
});
map.on('mouseenter', 'vefa-pt', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'vefa-pt', () => (map.getCanvas().style.cursor = ''));
map.on('mouseenter', 'permis-pt', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'permis-pt', () => (map.getCanvas().style.cursor = ''));
const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
// Fond : plan IGN ou satellite (photo aérienne IGN, récente ou ancienne), avec noms des rues et cadastre par-dessus
function appliquerFond() {
  const sat = $('#fond-ortho').checked;
  const recent = $('#orthoAn').value === 'ORTHOIMAGERY.ORTHOPHOTOS';
  vis('plan', !sat); vis('ortho', sat && recent); vis('orthoHist', sat && !recent); vis('noms', sat && $('#lay-noms').checked);
  $('#satOpts').hidden = !sat;
  // sur la photo, le zonage est allégé pour garder la lecture du terrain
  if (sat && +$('#zonageOpa').value === 45) { $('#zonageOpa').value = 25; map.setPaintProperty('zonage', 'raster-opacity', 0.25); }
  if (!sat && +$('#zonageOpa').value === 25) { $('#zonageOpa').value = 45; map.setPaintProperty('zonage', 'raster-opacity', 0.45); }
  try { localStorage.setItem('tf-fond', JSON.stringify({ sat, an: $('#orthoAn').value, noms: $('#lay-noms').checked })); } catch { /* stockage indisponible */ }
}
document.querySelectorAll('input[name=fond]').forEach((r) => r.addEventListener('change', appliquerFond));
$('#lay-noms').addEventListener('change', appliquerFond);
$('#orthoAn').addEventListener('change', (e) => {
  const v = e.target.value, vieux = v.includes('1950');
  if (v !== 'ORTHOIMAGERY.ORTHOPHOTOS') map.getSource('orthoHist').setTiles([wmts(v, vieux ? 'BDORTHOHISTORIQUE' : 'normal', vieux ? 'image/png' : 'image/jpeg')]);
  appliquerFond();
});
$('#zonageOpa').addEventListener('input', (e) => map.setPaintProperty('zonage', 'raster-opacity', +e.target.value / 100));
map.on('load', () => {
  let f = null; try { f = JSON.parse(localStorage.getItem('tf-fond') || 'null'); } catch { f = null; }
  if (!f) return;
  if (f.an) { $('#orthoAn').value = f.an; if (f.an !== 'ORTHOIMAGERY.ORTHOPHOTOS') $('#orthoAn').dispatchEvent(new Event('change')); }
  $('#lay-noms').checked = f.noms !== false;
  if (f.sat) { $('#fond-ortho').checked = true; appliquerFond(); }
});
$('#lay-permis').addEventListener('change', (e) => { vis('permis-pt', e.target.checked); if (e.target.checked && sel && sel.feature && !sel.loading) chargerProjets(selToken); try { localStorage.setItem('tf-lay-permis', e.target.checked ? '1' : '0'); } catch { /* */ } });
$('#lay-vefa').addEventListener('change', (e) => {
  vis('vefa-pt', e.target.checked);
  try { localStorage.setItem('tf-lay-vefa', e.target.checked ? '1' : '0'); } catch { /* */ }
  if (e.target.checked && sel && sel.feature && !sel.loading) chargerProjets(selToken);
});
try { if (localStorage.getItem('tf-lay-vefa') === '1') { $('#lay-vefa').checked = true; map.on('load', () => vis('vefa-pt', true)); } } catch { /* */ }
try { if (localStorage.getItem('tf-lay-permis') === '0') { $('#lay-permis').checked = false; map.on('load', () => vis('permis-pt', false)); } } catch { /* */ }
$('#lay-cadastre').addEventListener('change', (e) => vis('cadastre', e.target.checked));
$('#lay-zonage').addEventListener('change', (e) => vis('zonage', e.target.checked));
$('#lay-presc').addEventListener('change', (e) => vis('presc', e.target.checked));
$('#lay-hits').addEventListener('change', (e) => { vis('hits-fill', e.target.checked); vis('hits-line', e.target.checked); markers.forEach((m) => (m.getElement().hidden = !e.target.checked)); });

let markers = [];
function setHits(list) {
  markers.forEach((m) => m.remove()); markers = [];
  map.getSource('hits')?.setData({
    type: 'FeatureCollection',
    features: list.map((h) => ({ type: 'Feature', geometry: h.f.geometry, properties: { idu: h.f.properties.idu, ref: refOf(h.f.properties), zone: h.zone?.properties.libelle || '', nature: h.occ?.label || '', surface: h.occ?.S || +h.f.properties.contenance, score: h.s ? h.s.tot : 0, partiel: !!h.s?.partiel } })),
  });
  list.slice(0, 25).forEach((h, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `pin ${scoreClass(h.s ? h.s.tot : 0)}`;
    el.textContent = i + 1;
    el.setAttribute('aria-label', `Terrain ${i + 1} : ${refOf(h.f.properties)}, note ${h.s ? h.s.tot : '?'}`);
    el.addEventListener('click', (ev) => { ev.stopPropagation(); selectFeature(h.f, undefined, 'fiche'); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat(turf.pointOnFeature(h.f).geometry.coordinates).addTo(map));
  });
  $('#legend').hidden = !list.length;
  $('#lay-hits-wrap').hidden = !list.length;
}

// ---------- Navigation ----------
let tab = 'fiche';
function showTab(v) {
  tab = v;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.v === v)));
  ['fiche', 'pot', 'pro', 'crm'].forEach((x) => ($(`#v-${x}`).hidden = x !== v));
  if (v === 'fiche') renderFiche();
  if (v === 'pot') renderPot();
  if (v === 'pro') pro.render();
  if (v === 'crm') renderCrm();
  document.body.classList.toggle('wide', wide && (v === 'pro' || v === 'crm'));
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.v)));
let wide = false;
$('#btnWide').addEventListener('click', () => {
  wide = !wide;
  $('#btnWide').setAttribute('aria-pressed', String(wide));
  $('#btnWide').textContent = wide ? 'Réduire' : 'Agrandir';
  document.body.classList.toggle('wide', wide);
  setTimeout(() => map.resize(), 220);
});

// ---------- Sélection d'une parcelle ----------
let sel = null;
let selToken = 0;
let ficheTab = 'synthese';

async function selectAt(lng, lat) {
  const token = ++selToken;
  sel = { loading: true };
  if (tab !== 'pro' && tab !== 'crm') showTab('fiche'); else renderFiche();
  try {
    const f = await api.parcelleAt(lng, lat);
    if (token !== selToken) return;
    if (!f) { sel = null; renderFiche(); toast('Aucune parcelle à cet endroit'); return; }
    await selectFeature(f, token);
  } catch (e) { sel = { error: e.message }; renderFiche(); }
}

let selCtrl = null;
async function selectFeature(f, token = ++selToken, forceTab) {
  if (selCtrl) selCtrl.abort();
  selCtrl = new AbortController();
  const signal = selCtrl.signal;
  sel = { feature: f, loading: true };
  map.getSource('sel').setData(f);
  map.getSource('env').setData(empty);
  map.getSource('bati').setData(empty);
  map.getSource('permis').setData(empty);
  map.getSource('vefa').setData(empty);
  if (forceTab) showTab(forceTab);
  else if (tab !== 'pot' && tab !== 'pro' && tab !== 'crm') showTab('fiche');
  const pt = turf.pointOnFeature(f).geometry;
  const simple = turf.truncate(turf.simplify(f, { tolerance: 0.000005, highQuality: true }), { precision: 6 }).geometry;
  const insee = f.properties.code_insee;
  // Affichage progressif : la fiche apparaît dès que la zone et le bâti sont connus ;
  // document, prescriptions, servitudes, risques, parkings, équipements et friches complètent ensuite.
  // Le navigateur limite à 6 requêtes simultanées par serveur : les appels rapides (bâti, parkings) partent d'abord,
  // les appels au Géoportail de l'Urbanisme (parfois lents) ensuite, pour ne pas les bloquer.
  const frP = api.friches(insee);
  // Service cartographique du GPU : autre serveur qu'API Carto, sert de secours et donne les règles du plan graphique
  const duP = api.duAt(pt.coordinates[0], pt.coordinates[1], { signal }).catch(() => null);
  const risqP = api.risques(pt.coordinates[0], pt.coordinates[1]);
  let bati;
  try { bati = await api.batiments(simple); } catch { bati = null; }
  const occAtP = api.occupationAt(simple);
  const coreP = api.urbanismeAt(pt, api.CORE_LAYERS, { retries: 1, timeout: 10000, signal });
  const extraP = occAtP.then(() => api.urbanismeAt(pt, api.EXTRA_LAYERS, { retries: 1, timeout: 15000, signal }));
  if (token !== selToken) return;
  const urba = {};
  [...api.CORE_LAYERS, ...api.EXTRA_LAYERS].forEach((l) => (urba[l] = 'loading'));
  const zone = null, cc = null, partition = null, zLabel = '?';
  if (bati) {
    const batSurParcelle = bati.filter((b) => { try { return turf.booleanPointInPolygon(turf.pointOnFeature(b), f); } catch { return false; } });
    map.getSource('bati').setData({ type: 'FeatureCollection', features: batSurParcelle });
  }
  const analyse = (occAt, fr) => {
    if (!bati) return null;
    const frMap = new Map(); (fr || []).forEach((x) => x.idus.forEach((i) => frMap.set(i, x)));
    return analyser(f, { bat: grille(bati), park: occAt && occAt.parkings ? grille(occAt.parkings) : null, eq: occAt && occAt.equipements ? grille(occAt.equipements) : null }, frMap);
  };
  const occ = analyse(null, null);
  sel = {
    feature: f, urba, zone, cc, doc: null, partition, zLabel, key: store.ruleKey(partition, zLabel),
    bati: occ ? { n: occ.stats.n - occ.stats.legers, emprise: occ.stats.emprise, sdp: occ.stats.sdp, hmax: occ.stats.hMax } : null,
    occ, risques: undefined, pt, friches: undefined, occAtOk: false, occComplet: false, contraintes: null, commune: null, graph: null, viaWms: false,
  };
  const rerender = () => { if (token !== selToken) return; if (tab === 'fiche') renderFiche(); else if (tab === 'pot') renderPot(); };
  const appliquerGraph = () => {
    const ps = Array.isArray(sel.urba['prescription-surf']) ? sel.urba['prescription-surf'] : null;
    sel.graph = ps ? reglesGraphiques(ps) : null;
  };
  // API Carto en panne : zonage et prescriptions repris du service cartographique (même base GPU)
  const secours = (x, layers) => {
    if (!layers.every((l) => x[l] === null)) return Promise.resolve(x);
    return duP.then((d) => {
      if (!d) return x;
      const y = { ...x };
      layers.forEach((l) => { if (d[l]) y[l] = d[l]; });
      sel.viaWms = true;
      return y;
    });
  };
  coreP.then((x0) => secours(x0, ['zone-urba', 'secteur-cc'])).then((x) => {
    if (token !== selToken) return;
    Object.assign(sel.urba, x);
    sel.zone = (x['zone-urba'] || [])[0] || null;
    sel.cc = (x['secteur-cc'] || [])[0] || null;
    sel.partition = sel.zone?.properties.partition || sel.cc?.properties.partition || sel.partition || null;
    sel.zLabel = sel.zone?.properties.libelle || sel.cc?.properties.libelle || (x['zone-urba'] === null ? '?' : 'RNU');
    sel.key = store.ruleKey(sel.partition, sel.zLabel);
    rerender();
  });
  extraP.then((x0) => secours(x0, ['prescription-surf', 'prescription-lin', 'info-surf'])).then((x) => {
    if (token !== selToken) return;
    Object.assign(sel.urba, x);
    appliquerGraph();
    sel.doc = (x.document || [])[0] || null;
    if (!sel.partition && sel.doc) { sel.partition = sel.doc.properties.partition; if (sel.urba['zone-urba'] !== 'loading') sel.key = store.ruleKey(sel.partition, sel.zLabel); }
    const ps = Array.isArray(x['prescription-surf']) ? x['prescription-surf'] : null;
    sel.contraintes = ps ? contraintesDe(f, grille(ps.filter((p) => p.geometry)), sel.occ ? sel.occ.S : +f.properties.contenance) : null;
    rerender();
  });
  Promise.all([occAtP, frP]).then(([occAt, fr]) => {
    if (token !== selToken) return;
    sel.friches = fr; sel.occAtOk = !!(occAt.parkings && occAt.equipements); sel.occComplet = true;
    const o = analyse(occAt, fr); if (o) sel.occ = o;
    rerender();
  });
  risqP.then((r) => { if (token === selToken) { sel.risques = r; rerender(); } });
  api.communeByCode(insee).then((c) => { if (token === selToken) { sel.commune = c; if (tab === 'fiche' && ficheTab === 'commune') renderFiche(); } }).catch(() => {});
  if (tab === 'pot') renderPot(); else renderFiche();
  // constructions récentes et ventes neuves : chargées d'office si une des cases de la carte est cochée
  if ($('#lay-permis').checked || $('#lay-vefa').checked) setTimeout(() => { if (token === selToken) chargerProjets(token); }, 2500);
}

// ---------- Règles (saisie / IA) ----------
let rbSeq = 0;
function rulesBlock(key, zoneLabel, onChange, ctx = {}) {
  const uid = `rb${++rbSeq}`;
  const saved = store.getRules(key);
  const wrap = document.createElement('div');
  const backend = store.settings().backend;
  const lines = saved ? RULE_FIELDS.map((fd) => {
    const v = saved[fd.k];
    const c = saved.citations && saved.citations[fd.k];
    const txt = v === null || v === undefined || v === '' ? 'Non renseigné' : fd.pct ? `${Math.round(v * 100)} %` : `${v} ${fd.unit}`;
    const st = v === null || v === undefined || v === '' ? 'no' : c && c.status === 'verifie' ? 'ok' : c ? 'ok' : 'wa';
    const pill = st === 'no' ? 'manquant' : c ? 'cité' : 'saisi';
    return `<div class="rule"><b>${esc(fd.label)}</b><span class="val">${esc(txt)} <span class="pill ${st}">${pill}</span></span>
      ${c && c.citation ? `<q>« ${esc(c.citation)} »</q><span class="src">${esc(c.article || '')}${c.page ? ' · p. ' + c.page : ''}${c.condition ? ' · condition : ' + esc(c.condition) : ''}</span>` : ''}</div>`;
  }).join('') : '';
  wrap.innerHTML = `
    <div class="label">Règles de la zone ${esc(zoneLabel)}</div>
    ${saved ? `<div class="rules">${lines}</div><p class="note">Source : ${saved.source === 'ia' ? 'extraction IA avec citations' : 'saisie manuelle'} · ${new Date(saved.savedAt).toLocaleDateString('fr-FR')}</p>` :
      `<p class="note">Aucune règle enregistrée pour cette zone. Saisissez-les une fois depuis le règlement : elles serviront pour toutes les parcelles de la zone.</p>`}
    <div class="actions">
      <button type="button" class="ghost" data-act="edit">${saved ? 'Modifier les règles' : 'Saisir les règles'}</button>
      ${backend ? '<button type="button" data-act="ia">Extraire avec l\'IA</button>' : ''}
    </div>
    <form class="form-grid" data-form hidden>
      ${RULE_FIELDS.map((fd) => `<label for="${uid}-${fd.k}">${esc(fd.label)}<input type="number" step="any" min="0" id="${uid}-${fd.k}" value="${saved && saved[fd.k] !== null && saved[fd.k] !== undefined ? (fd.pct ? +(saved[fd.k] * 100).toFixed(1) : saved[fd.k]) : ''}"></label>`).join('')}
      <div class="actions" style="grid-column:1/-1"><button type="submit">Enregistrer</button><button type="button" class="ghost" data-act="cancel">Annuler</button></div>
    </form>`;
  const form = $('[data-form]', wrap);
  wrap.querySelector('[data-act=edit]').onclick = () => (form.hidden = !form.hidden);
  wrap.querySelector('[data-act=cancel]').onclick = () => (form.hidden = true);
  form.onsubmit = (e) => {
    e.preventDefault();
    const rules = { source: 'manuel', citations: {} };
    RULE_FIELDS.forEach((fd) => { const v = $(`#${uid}-${fd.k}`, form).value; rules[fd.k] = v === '' ? null : fd.pct ? +v / 100 : +v; });
    store.saveRules(key, rules); toast('Règles enregistrées'); onChange && onChange();
  };
  const ia = wrap.querySelector('[data-act=ia]');
  if (ia) ia.onclick = async () => {
    ia.disabled = true; ia.textContent = 'Lecture du règlement…';
    try {
      const zone = ctx.zone || sel?.zone, partition = ctx.partition || sel?.partition;
      const url = api.reglementUrl(zone, partition);
      const res = await api.extractRules(backend, { partition, zone: zoneLabel, url });
      const rules = { source: 'ia', citations: {} };
      RULE_FIELDS.forEach((fd) => {
        const x = res.rules && res.rules[fd.k];
        rules[fd.k] = x && (x.status === 'extrait' || x.status === 'verifie') ? x.value : null;
        if (x && x.status !== 'non_trouve') rules.citations[fd.k] = x;
      });
      store.saveRules(key, rules); toast('Règles extraites et contrôlées'); onChange && onChange();
    } catch (e) { toast(e.message); ia.disabled = false; ia.textContent = "Extraire avec l'IA"; }
  };
  return wrap;
}

// ---------- Vue Parcelle (fiche à onglets) ----------
const FICHE_TABS = [['synthese', 'Synthèse'], ['urba', 'Urbanisme'], ['bati', 'Bâti et occupation'], ['contraintes', 'Contraintes'], ['projets', 'Constructions récentes'], ['commune', 'Commune']];

function potentielSel() {
  if (!sel || !sel.feature) return null;
  const rules = fusionRegles(store.getRules(sel.key), sel.graph).regles;
  return computePotentiel(sel.feature, rules, store.settings(), { contenance: sel.feature.properties.contenance, batiSdp: sel.bati?.sdp, constructible: zoneConstructible(sel.zone) });
}
function noteSel(pot) {
  if (!sel.occ) return null;
  const c = { ...CRIT_DEFAUT, ...(store.prospectionCrit() || {}) };
  return noter({ S: sel.occ.S, crit: { smin: c.smin || 0, smax: c.smax || 1e12, lmin: c.lmin || 1, lmax: c.lmax || 100000 }, occ: sel.occ, pot: pot && pot.ok ? pot : null, contraintes: sel.contraintes || [], compacite: compacite(sel.feature) });
}

function renderFiche() {
  const v = $('#v-fiche');
  if (!sel) { v.innerHTML = `<div class="empty-state"><h2>Commencez par la carte</h2><p class="empty">Recherchez une adresse, une commune ou une référence cadastrale, puis touchez une parcelle. Sa fiche d'analyse foncière s'affiche ici : urbanisme, bâti, contraintes, potentiel et note.</p></div>`; return; }
  if (sel.error) { v.innerHTML = `<h2>Données indisponibles</h2><p class="empty">${esc(sel.error)}. Réessayez dans un instant.</p>`; return; }
  if (sel.loading) { v.innerHTML = `<p class="ref">${esc(refOf(sel.feature?.properties))}</p><p class="empty">Interrogation du cadastre, du Géoportail de l'Urbanisme et de la BD TOPO…</p>`; return; }
  const p = sel.feature.properties;
  v.innerHTML = `
    <div class="fiche-head">
      <div><span class="ref">${esc(refOf(p))} · IDU ${esc(p.idu)}</span><h2>${esc(p.nom_com || '')}, section ${esc(p.section)} n° ${esc(p.numero)}</h2></div>
      <div class="actions"><button type="button" class="ghost" id="addCrm">Ajouter au suivi</button><button type="button" class="ghost" id="copyFiche">Copier la fiche</button><a class="btn-link" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${sel.pt.coordinates[1]},${sel.pt.coordinates[0]}" target="_blank" rel="noopener">Street View</a></div>
    </div>
    ${sel.urba['zone-urba'] === 'loading' ? '<p class="note">Zonage du PLU en cours de chargement…</p>' : ''}${sel.viaWms ? '<p class="note"><span class="pill wa">secours</span> API Carto (IGN) saturé : zonage et prescriptions lus sur le service cartographique du Géoportail de l\'Urbanisme, même source officielle.</p>' : ''}${sel.urba['zone-urba'] === null ? `<div class="warn">Le Géoportail de l'Urbanisme (IGN) ne répond pas pour le moment : zonage et règles indisponibles. Les autres informations restent valables. <button type="button" class="ghost" id="retryGpu">Réessayer</button></div>` : ''}
    <nav class="subtabs" role="tablist">${FICHE_TABS.map(([k, t]) => `<button type="button" role="tab" class="subtab" data-ft="${k}" aria-selected="${ficheTab === k}">${t}</button>`).join('')}</nav>
    <div id="ficheBody" class="fiche-body"></div>`;
  v.querySelectorAll('[data-ft]').forEach((b) => (b.onclick = () => { ficheTab = b.dataset.ft; renderFiche(); }));
  const rg = $('#retryGpu', v); if (rg) rg.onclick = () => selectFeature(sel.feature);
  $('#addCrm', v).onclick = () => {
    const pot = potentielSel(), s = noteSel(pot);
    const ok = store.addToCrm({ idu: p.idu, ref: refOf(p), commune: p.nom_com, zone: sel.zLabel, contenance: p.contenance, centre: sel.pt.coordinates, geometry: turf.truncate(sel.feature, { precision: 6 }).geometry, nature: sel.occ?.label || '', note: '', score: s ? s.tot : null });
    toast(ok ? 'Ajouté au suivi' : 'Déjà dans le suivi');
  };
  $('#copyFiche', v).onclick = () => copy(ficheText());
  const body = $('#ficheBody', v);
  ({ synthese: ficheSynthese, urba: ficheUrba, bati: ficheBati, contraintes: ficheContraintes, projets: ficheProjets, commune: ficheCommune }[ficheTab] || ficheSynthese)(body);
}

function ficheSynthese(body) {
  const p = sel.feature.properties, z = sel.zone?.properties;
  const pot = potentielSel(), s = noteSel(pot), constr = zoneConstructible(sel.zone);
  const occ = sel.occ;
  body.innerHTML = `
    <div class="kpis">
      <div><span>Surface</span><strong>${m2(p.contenance)}</strong></div>
      <div><span>Zone</span><strong>${sel.urba['zone-urba'] === 'loading' ? '…' : esc(sel.zLabel)}</strong></div>
      <div><span>Nature</span><strong class="small">${esc(occ ? occ.label : '—')}</strong></div>
      <div><span>Logements</span><strong>${pot && pot.ok ? `${pot.real}` : '?'}</strong></div>
    </div>
    ${s ? `<div class="score-card"><span class="score big ${scoreClass(s.tot)}">${s.tot}</span><div><b>Note de potentiel foncier</b>${s.partiel ? ' <span class="pill wa">partielle</span>' : ''}<p class="note">${s.partiel ? 'Règles de la zone à renseigner pour une note complète. ' : ''}Calculée avec vos derniers critères de prospection.</p></div></div>
      <div class="why">${s.parts.map((x) => `<div class="why-row"><span>${esc(x.label)}</span><span class="bar"><i style="width:${x.v === null ? 0 : Math.round((100 * x.v) / x.max)}%"></i></span><b>${x.v === null ? '—' : x.v}/${x.max}</b><small>${esc(x.why)}</small></div>`).join('')}</div>` : '<p class="note">Bâti indisponible : la note ne peut pas être calculée.</p>'}
    <dl class="kv">
      <dt>Zone</dt><dd>${z ? `<b>${esc(z.libelle)}</b> ${esc(z.libelong || '')} <span class="pill ${constr ? 'ok' : constr === false ? 'no' : 'wa'}">${esc(z.typezone || '')}</span>` : sel.urba['zone-urba'] === null ? '<span class="pill wa">service indisponible</span> <button type="button" class="ghost" id="retryUrba">Réessayer</button>' : '—'}</dd>
      <dt>Bâti</dt><dd>${occ ? `${occ.stats.n - occ.stats.legers} bâtiment(s), ${Math.round(occ.ces * 100)} % d'emprise${occ.stats.logements ? `, ${occ.stats.logements} logement(s)` : ''}` : 'Donnée indisponible'}</dd>
      <dt>Signaux</dt><dd>${occ && occ.flags.length ? occ.flags.map((x) => esc(x.t)).join(' · ') : 'Aucun'}</dd>
      <dt>Potentiel</dt><dd>${pot && pot.ok ? `${m2(pot.sdp)} de plancher, ${pot.lg} logements théoriques, ${pot.real} réalisables` : constr === false ? 'Zone A ou N : pas de logement' : sel.urba['prescription-surf'] === 'loading' ? 'Lecture des règles du PLU…' : 'Règles de la zone à renseigner (onglet Urbanisme)'}</dd>
    </dl>
    <div class="actions"><button type="button" id="goPot">Détail du potentiel</button></div>`;
  $('#goPot', body).onclick = () => showTab('pot');
  const retry = $('#retryUrba', body); if (retry) retry.onclick = () => selectFeature(sel.feature);
}

function ficheUrba(body) {
  const z = sel.zone?.properties, d = sel.doc?.properties;
  const [lng, lat] = sel.pt.coordinates;
  const arr = (k) => (Array.isArray(sel.urba[k]) ? sel.urba[k] : []);
  const pending = sel.urba['prescription-surf'] === 'loading';
  const prescF = [...arr('prescription-surf'), ...arr('prescription-lin')];
  // Prescriptions graphiques d'emprise (38), de hauteur (39) ou de pleine terre (43) : la valeur est sur un plan, pas dans le règlement écrit
  const planGraphique = prescF.filter((x) => ['38', '39', '43'].includes(String(x.properties.typepsc))).map((x) => x.properties.libelle);
  const oap = prescF.concat(arr('info-surf')).filter((x) => /OAP|orientation/i.test(x.properties.libelle || ''));
  const constr = zoneConstructible(sel.zone);
  const regl = api.reglementUrl(sel.zone, sel.partition);
  body.innerHTML = `
    <dl class="kv">
      <dt>Document</dt><dd>${d ? `${esc(d.du_type || 'Document')} · ${esc(d.grid_title || sel.partition || '')}${z && z.datappro ? ' · approuvé le ' + esc(String(z.datappro).replace(/^(\d{4})(\d{2})(\d{2})$/, '$3/$2/$1')) : ''}` : sel.cc ? 'Carte communale' : sel.urba.document === 'loading' ? (sel.partition ? `${esc(sel.partition)} <span class="note">(chargement…)</span>` : 'Chargement…') : sel.partition ? `Document ${esc(sel.partition)}` : sel.urba.document === null ? '<span class="pill wa">service indisponible</span>' : 'Aucun document au GPU (RNU possible)'}</dd>
      <dt>Zone</dt><dd>${z ? `<b>${esc(z.libelle)}</b> ${esc(z.libelong || '')} <span class="pill ${constr ? 'ok' : constr === false ? 'no' : 'wa'}">${esc(z.typezone || '')}</span>` : sel.cc ? esc(sel.cc.properties.libelle || 'Secteur de carte communale') : '—'}</dd>
      <dt>Destination</dt><dd>${z && z.destdomi ? esc(z.destdomi) : 'Non renseignée au GPU'}</dd>
      <dt>OAP</dt><dd>${pending ? 'Chargement…' : oap.length ? [...new Set(oap.map((x) => x.properties.libelle))].map(esc).join(' · ') : 'Aucune détectée'}</dd>
      <dt>Prescriptions</dt><dd>${pending ? 'Chargement…' : prescF.length ? [...new Set(prescF.map((x) => x.properties.libelle || x.properties.txt).filter(Boolean))].map(esc).join(' · ') : 'Aucune'}</dd>
    </dl>
    <div class="actions">
      ${regl ? `<a href="${esc(regl)}" target="_blank" rel="noopener">Règlement</a>` : ''}
      <a href="${api.gpuViewerUrl(lng, lat)}" target="_blank" rel="noopener">Géoportail de l'Urbanisme</a>
    </div>
    ${sel.graph && sel.graph.n ? `<div class="rules-plan"><div class="label">Règles du plan graphique à cette parcelle</div><ul class="list">${Object.values(sel.graph.sources).map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p class="note"><span class="pill ok">GPU</span> Valeurs publiées par la collectivité au Géoportail de l'Urbanisme. Elles remplacent, pour cette parcelle, la valeur saisie pour la zone dans le calcul du potentiel.</p></div>` : ''}
    ${planGraphique.length && !(sel.graph && sel.graph.n) ? `<p class="note"><span class="pill wa">plan graphique</span> ${[...new Set(planGraphique)].map(esc).join(', ')} : la valeur est fixée sur un plan du PLU, pas seulement dans le règlement écrit. Vérifiez-la sur le Géoportail de l'Urbanisme avant de saisir les règles.</p>` : ''}
    ${constr !== false && (z || sel.cc) ? reglesParcelleHtml() : ''}
    <div id="rulesSlot"></div>
    ${sel.partition ? `<div class="zones-sec"><div class="label">Toutes les zones du PLU</div><p class="note">Règles de constructibilité de chaque zone du document ${esc(sel.partition)} : valeurs du plan graphique, vos règles enregistrées, lien vers le règlement.</p><div id="zonesSlot"><button type="button" id="loadZones">Afficher le tableau des zones</button></div></div>` : ''}`;
  const lz = $('#loadZones', body); if (lz) lz.onclick = () => renderZones($('#zonesSlot', body), sel.partition, sel.zLabel);
  const slot = $('#rulesSlot', body);
  if (!z && !sel.cc && sel.zLabel === '?') slot.innerHTML = '<p class="note">Zone non déterminée : réessayez pour charger le zonage avant de saisir des règles.</p>';
  else if (constr !== false) slot.appendChild(rulesBlock(sel.key, sel.zLabel, renderFiche));
  else slot.innerHTML = '<p class="note">Zone agricole ou naturelle : pas de potentiel de logement.</p>';
}

// Règles applicables à la parcelle, champ par champ, avec leur origine
function reglesParcelleHtml() {
  const saved = store.getRules(sel.key);
  const fu = fusionRegles(saved, sel.graph);
  const rows = RULE_FIELDS.map((fd) => {
    const v = fu.regles[fd.k], o = fu.origine[fd.k];
    const val = v === null ? '—' : fd.pct ? `${Math.round(v * 100)} %` : `${String(v).replace('.', ',')} ${fd.unit}`;
    const src = o === 'plan' ? '<span class="pill ok">plan graphique</span>' : o === 'zone' ? `<span class="pill ${saved && saved.source === 'ia' ? 'ok' : 'wa'}">${saved && saved.source === 'ia' ? 'IA, cité' : 'saisi'}</span>` : '<span class="pill no">à renseigner</span>';
    return `<tr><td>${esc(fd.label.replace(/ \(.*\)$/, ''))}</td><td class="n"><b>${esc(val)}</b></td><td>${src}</td></tr>`;
  }).join('');
  const pend = sel.urba['prescription-surf'] === 'loading';
  return `<div><div class="label">Règles de constructibilité applicables à la parcelle</div>
    <div class="tw"><table class="rules-table"><tr><th>Règle</th><th class="n">Valeur</th><th>Origine</th></tr>${rows}</table></div>
    <p class="note">${pend ? 'Lecture du plan graphique en cours… ' : ''}Le plan graphique prime sur la valeur de zone. Les règles « à renseigner » se lisent dans le règlement écrit : saisissez-les ci-dessous une fois pour toute la zone.</p></div>`;
}

// Tableau des règles de toutes les zones d'un PLU
const zonesCache = new Map();
async function renderZones(slot, partition, zCourante) {
  slot.innerHTML = '<p class="note">Chargement du zonage et du plan graphique du PLU… (jusqu\'à une minute quand le service de l\'IGN est chargé)</p>';
  let data;
  try {
    if (!zonesCache.has(partition)) {
      zonesCache.set(partition, (async () => {
        const [zs, ps] = await Promise.all([api.gpuByPartition('zone-urba', partition), api.gpuByPartition('prescription-surf', partition).catch(() => null)]);
        return { liste: reglesParZone(zs, ps || []), prescOk: !!ps };
      })().catch((e) => { zonesCache.delete(partition); throw e; }));
    }
    data = await zonesCache.get(partition);
  } catch (e) {
    slot.innerHTML = `<div class="warn">Zonage du PLU indisponible : ${esc(e.message)}. <button type="button" class="ghost" id="zRetry">Réessayer</button></div>`;
    $('#zRetry', slot).onclick = () => renderZones(slot, partition, zCourante);
    return;
  }
  const vosRegles = (z) => {
    const r = store.getRules(store.ruleKey(partition, z.libelle));
    if (!r) return '';
    return RULE_FIELDS.filter((fd) => r[fd.k] !== null && r[fd.k] !== undefined).map((fd) => `${fd.k === 'ces' ? 'CES' : fd.k === 'h' ? 'H' : fd.k === 'pt' ? 'PT' : fd.k === 'recul' ? 'Recul' : fd.k === 'ret' ? 'Retrait' : 'Stat.'} ${fd.pct ? Math.round(r[fd.k] * 100) + ' %' : r[fd.k] + (fd.unit === 'pl.' ? '' : ' ' + fd.unit)}`).join(', ');
  };
  const haut = (z) => [plage(z.hEgout, 'm') && `${plage(z.hEgout, 'm')} à l'égout`, plage(z.hFaitage, 'm') && `${plage(z.hFaitage, 'm')} au faîtage`].filter(Boolean).join(', ');
  const dest = (z) => [z.destdomi && `dominante : ${z.destdomi}`, z.destoui && `autorisé : ${z.destoui}`, z.destcdt && `sous conditions : ${z.destcdt}`, z.destnon && `interdit : ${z.destnon}`].filter(Boolean).join(' · ');
  const draw = () => {
    const q = ($('#zFiltre', slot)?.value || '').trim().toUpperCase();
    const seulC = $('#zConstr', slot)?.checked ?? true;
    const L = data.liste.filter((z) => (!q || z.libelle.toUpperCase().includes(q) || z.libelong.toUpperCase().includes(q)) && (!seulC || !/^(A|N)$/i.test(z.typezone)));
    $('#zTable', slot).innerHTML = `<table class="res-table zones-table">
      <thead><tr><th>Zone</th><th>Type</th><th class="n">Emprise max</th><th class="n">Hauteur max</th><th class="n">Pleine terre</th><th>Vos règles</th><th></th></tr></thead>
      <tbody>${L.map((z, i) => `<tr class="${z.libelle === zCourante ? 'cur' : ''}">
        <td><b>${esc(z.libelle)}</b><br><small class="note">${esc(z.libelong)}${dest(z) ? '<br>' + esc(dest(z)) : ''}${z.oap ? `<br>${z.oap} secteur(s) d'OAP` : ''}</small></td>
        <td><span class="pill ${/^U|^AU/i.test(z.typezone) && !/AUS/i.test(z.typezone) ? 'ok' : 'no'}">${esc(z.typezone)}</span></td>
        <td class="n">${esc(plage(z.ces, '%') || '—')}</td><td class="n">${esc(haut(z) || '—')}</td><td class="n">${esc(plage(z.pt, '%') || '—')}</td>
        <td>${esc(vosRegles(z) || '—')}</td>
        <td><button type="button" class="ghost" data-z="${i}">Règles</button>${z.urlfic ? ` <a href="${esc(z.urlfic)}" target="_blank" rel="noopener">Règlement</a>` : ''}</td></tr>
        <tr class="zrow" hidden><td colspan="7" data-slot="${i}"></td></tr>`).join('')}</tbody></table>`;
    $('#zTable', slot).querySelectorAll('[data-z]').forEach((b) => (b.onclick = () => {
      const z = L[+b.dataset.z], tr = b.closest('tr').nextElementSibling, td = tr.firstElementChild;
      tr.hidden = !tr.hidden;
      if (!tr.hidden && !td.firstChild) td.appendChild(rulesBlock(store.ruleKey(partition, z.libelle), z.libelle, () => { draw(); if (sel) { if (tab === 'fiche') renderFiche(); } }, { zone: { properties: { urlfic: z.urlfic } }, partition }));
    }));
  };
  const nPlan = data.liste.filter((z) => z.ces.length || z.hEgout.length || z.hFaitage.length || z.pt.length).length;
  const idxC = await api.copiePlu(), dc = idxC && idxC.documents && idxC.documents[partition];
  slot.innerHTML = `
    <div class="res-head"><div class="field-row"><input type="search" id="zFiltre" placeholder="Filtrer : UR, UC, 1AU…" aria-label="Filtrer les zones"><label class="chk"><input type="checkbox" id="zConstr" checked> Zones U et AU seulement</label></div><button type="button" class="ghost" id="zCsv">Exporter en CSV</button></div>
    <p class="note">${dc ? `<span class="pill ok">copie du ${esc(dc.copie)}</span> ${esc(dc.nom || '')}, mis à jour au GPU le ${esc(String(dc.maj || '').slice(0, 10))} · ` : ''}${data.liste.length} zones · ${nPlan} avec des valeurs au plan graphique${data.prescOk ? '' : ' · <b>plan graphique non chargé (service IGN lent)</b> <button type="button" class="ghost" id="zRetryPlan">Réessayer</button>'}. Les colonnes Emprise, Hauteur et Pleine terre viennent du plan graphique publié au Géoportail de l'Urbanisme ; « — » signifie que la règle est uniquement dans le règlement écrit.</p>
    <div class="tw" id="zTable"></div>`;
  const rp = $('#zRetryPlan', slot); if (rp) rp.onclick = () => { zonesCache.delete(partition); renderZones(slot, partition, zCourante); };
  $('#zFiltre', slot).oninput = draw; $('#zConstr', slot).onchange = draw;
  $('#zCsv', slot).onclick = () => {
    const c = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const lignes = [['Zone', 'Type', 'Description', 'Emprise max (plan)', 'Hauteur max (plan)', 'Pleine terre min (plan)', "Secteurs d'OAP", 'Vos règles', 'Règlement'].join(';'),
      ...data.liste.map((z) => [z.libelle, z.typezone, z.libelong, plage(z.ces, '%'), haut(z), plage(z.pt, '%'), z.oap, vosRegles(z), z.urlfic].map(c).join(';'))];
    download(`regles-zones-${partition}.csv`, '﻿' + lignes.join('\n'), 'text/csv');
  };
  draw();
}

function ficheBati(body) {
  const occ = sel.occ;
  if (!occ) { body.innerHTML = '<p class="empty">Bâtiments BD TOPO indisponibles pour le moment. Réessayez en rouvrant la parcelle.</p>'; return; }
  const st = occ.stats;
  const fr = occ.ctx.friche;
  body.innerHTML = `
    <div class="nature-card"><span class="pill ${occ.opp ? 'ok' : 'no'}">${occ.opp ? 'opportunité possible' : 'peu mutable'}</span><b>${esc(occ.label)}</b><p class="note">${esc(occ.raisons.join(' ; '))}</p></div>
    <dl class="kv">
      <dt>Emprise bâtie</dt><dd>${m2(st.emprise)} soit ${Math.round(occ.ces * 100)} % du terrain</dd>
      <dt>Plancher existant</dt><dd>≈ ${m2(st.sdp)} (emprise × étages)</dd>
      <dt>Logements</dt><dd>${st.logements}${st.logInconnus ? ` (+ ${st.logInconnus} bâtiment(s) résidentiel(s) sans nombre connu)` : ''}</dd>
      <dt>Hauteur max</dt><dd>${st.hMax ? `${f0(st.hMax)} m, ${st.etagesMax || '?'} étage(s)` : '—'}</dd>
      <dt>Bâti le plus récent</dt><dd>${st.anneeMax ? `apparu en ${st.anneeMax}` : 'Inconnu'}</dd>
      <dt>Parking</dt><dd>${!sel.occComplet ? 'Chargement…' : sel.occAtOk ? (occ.ctx.parkingPart ? `${Math.round(occ.ctx.parkingPart * 100)} % de la parcelle` : 'Aucun parking recensé') : 'Donnée indisponible'}</dd>
      <dt>Friche</dt><dd>${fr ? `${esc(fr.nom || fr.type)} · ${esc(fr.statut || '')} (Cartofriches)` : sel.friches === undefined ? 'Chargement…' : sel.friches === null ? 'Cartofriches indisponible' : 'Non recensée'}</dd>
      <dt>Équipement public</dt><dd>${occ.ctx.equipement ? esc(occ.ctx.equipement) : 'Non'}</dd>
    </dl>
    ${occ.flags.length ? `<div class="chips">${occ.flags.map((x) => `<span class="chip">${esc(x.t)}</span>`).join('')}</div>` : ''}
    ${st.liste.length ? `<div><div class="label">Bâtiments sur la parcelle (BD TOPO)</div><div class="tw"><table>
      <tr><th>Usage</th><th class="n">Au sol</th><th class="n">Logts</th><th class="n">Étages</th><th class="n">Haut.</th><th class="n">Année</th></tr>
      ${st.liste.sort((a, b) => b.aire - a.aire).map((b) => `<tr><td>${esc(b.usage)}${b.leger ? ' <small class="note">léger</small>' : ''}</td><td class="n">${m2(b.aire)}</td><td class="n">${b.logements ?? '—'}</td><td class="n">${b.etages ?? '—'}</td><td class="n">${b.hauteur ? f0(b.hauteur) + ' m' : '—'}</td><td class="n">${b.annee || '—'}</td></tr>`).join('')}
    </table></div><p class="note">Bâtiments en violet sur la carte. Vérifiez sur la photo aérienne (bouton « Photo ») : la BD TOPO peut avoir quelques mois de retard.</p></div>` : ''}`;
}

function ficheContraintes(body) {
  const arr = (k) => (Array.isArray(sel.urba[k]) ? sel.urba[k] : []);
  const pending = sel.urba['prescription-surf'] === 'loading';
  const sup = arr('assiette-sup-s').map((x) => `${x.properties.suptype || x.properties.typeass || ''} ${x.properties.nomass || x.properties.libelle || ''}`.trim()).filter(Boolean);
  const infos = arr('info-surf').map((x) => x.properties.libelle).filter(Boolean);
  const pot = potentielSel();
  body.innerHTML = `
    <div><div class="label">Prescriptions qui pèsent sur un projet</div>
      ${pending ? '<p class="note">Chargement…</p>' : sel.contraintes === null ? '<p class="note">Prescriptions indisponibles pour le moment.</p>' : sel.contraintes.length ? `<ul class="list">${sel.contraintes.map((c) => `<li><b>${esc(c.t)}</b> sur ${Math.round(c.part * 100)} % de la parcelle${c.libelle !== c.t ? ` <span class="note">(${esc(c.libelle)})</span>` : ''}</li>`).join('')}</ul>` : '<p class="note">Aucun EBC, emplacement réservé, élément protégé ni secteur d\'OAP sur une part significative de la parcelle.</p>'}</div>
    <dl class="kv">
      <dt>Servitudes</dt><dd>${pending ? 'Chargement…' : sup.length ? [...new Set(sup)].map(esc).join(' · ') : 'Aucune au GPU'}</dd>
      <dt>Informations</dt><dd>${pending ? 'Chargement…' : infos.length ? [...new Set(infos)].map(esc).join(' · ') : 'Aucune'}</dd>
      <dt>Risques (commune)</dt><dd>${sel.risques === undefined ? 'Chargement…' : sel.risques ? (sel.risques.length ? sel.risques.map(esc).join(' · ') : 'Aucun recensé') : 'Donnée indisponible'}</dd>
      <dt>Forme</dt><dd>${compacite(sel.feature) < 0.35 ? 'Étroite ou en lanière : implantation contrainte' : 'Compacte'}</dd>
    </dl>
    ${pot && pot.ok && pot.contraintes.length ? `<div><div class="label">Contraintes du calcul de potentiel</div><ul class="list">${pot.contraintes.map((c) => `<li>${esc(c.t)}</li>`).join('')}</ul></div>` : ''}`;
}

// ---------- Constructions récentes (permis de logements Sitadel) ----------
const PROJ_DEF = { depuis: 2018, min: 5, rayon: 0, annules: false, tri: 'dist', statut: 'tous' };
const STATUTS_PROJ = { tous: () => true, encours: (p) => p.etat === 2 || p.etat === 5, termines: (p) => p.etat === 6 };
let projOpts = { ...PROJ_DEF };
try { projOpts = { ...PROJ_DEF, ...JSON.parse(localStorage.getItem('tf-projets') || '{}') }; } catch { /* stockage indisponible */ }
function ficheProjets(body) {
  const insee = sel.feature.properties.code_insee;
  chargerProjets(selToken);
  if (sel.permis === 'loading') { body.innerHTML = '<p class="note">Recherche des permis de construire de logements de la commune (base Sitadel)…</p>'; return; }
  if (sel.permis.erreur) { body.innerHTML = `<div class="warn">Base des permis indisponible : ${esc(sel.permis.erreur)}. <button type="button" class="ghost" id="projRetry">Réessayer</button></div>`; $('#projRetry', body).onclick = () => { sel.permis = undefined; renderFiche(); }; return; }
  const o = projOpts, an = (p) => +(String(p.autorisation || p.depot || '').slice(0, 4)) || 0;
  let L = sel.permis.filter((p) => an(p) >= o.depuis && p.logements >= o.min && (o.annules || p.etat !== 4) && (STATUTS_PROJ[o.statut] || STATUTS_PROJ.tous)(p) && (!o.rayon || (p.dist !== null && p.dist !== undefined && p.dist <= o.rayon)));
  const tri = { dist: (a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9), date: (a, b) => String(b.autorisation).localeCompare(String(a.autorisation)), lgt: (a, b) => b.logements - a.logements }[o.tri];
  L = L.slice().sort(tri);
  const S = permis.synthese(L);
  dessinerPermis(L);
  // comparaison avec la parcelle étudiée
  const pot = potentielSel(), Sp = +sel.feature.properties.contenance || 0;
  const dPot = pot && pot.ok && Sp ? (pot.real * 10000) / Sp : null;
  const f1 = (n) => (n === null || n === undefined ? '—' : (Math.round(n * 10) / 10).toLocaleString('fr-FR'));
  const etatPill = (p) => `<span class="pill ${p.etat === 6 ? 'ok' : p.etat === 5 ? 'wa' : p.etat === 4 ? 'no' : ''}">${esc(p.etatLib)}</span>`;
  const promoLien = (x) => x.siren ? `<a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${encodeURIComponent(x.siren)}" target="_blank" rel="noopener">${esc(x.nom)}</a>` : esc(x.nom);
  body.innerHTML = `
    <form class="proj-filtres" id="projF">
      <label>Depuis <select id="pjDepuis">${[2013, 2016, 2018, 2020, 2022, 2024].map((y) => `<option ${o.depuis === y ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <label>Taille <select id="pjMin"><option value="2" ${o.min === 2 ? 'selected' : ''}>2 logements et plus</option><option value="5" ${o.min === 5 ? 'selected' : ''}>5 et plus</option><option value="20" ${o.min === 20 ? 'selected' : ''}>20 et plus</option></select></label>
      <label>Autour <select id="pjRayon"><option value="0" ${!o.rayon ? 'selected' : ''}>Toute la commune</option><option value="500" ${o.rayon === 500 ? 'selected' : ''}>500 m</option><option value="1000" ${o.rayon === 1000 ? 'selected' : ''}>1 km</option><option value="2000" ${o.rayon === 2000 ? 'selected' : ''}>2 km</option></select></label>
      <label>Statut <select id="pjStatut"><option value="tous" ${o.statut === 'tous' ? 'selected' : ''}>Tous</option><option value="encours" ${o.statut === 'encours' ? 'selected' : ''}>En cours (autorisés, en chantier)</option><option value="termines" ${o.statut === 'termines' ? 'selected' : ''}>Terminés</option></select></label>
      <label>Tri <select id="pjTri"><option value="dist" ${o.tri === 'dist' ? 'selected' : ''}>Plus proches</option><option value="date" ${o.tri === 'date' ? 'selected' : ''}>Plus récents</option><option value="lgt" ${o.tri === 'lgt' ? 'selected' : ''}>Plus gros</option></select></label>
      <label class="chk"><input type="checkbox" id="pjAnn" ${o.annules ? 'checked' : ''}> Permis annulés</label>
      <label class="chk"><input type="checkbox" id="pjCarte" ${$('#lay-permis').checked ? 'checked' : ''}> Afficher sur la carte</label>
    </form>
    ${sel.permisLoc < 1 ? `<p class="note" id="projLoc">Localisation des opérations sur la carte…</p>` : ''}
    <div class="kpis">
      <div><span>Opérations</span><strong>${S.ops}</strong></div>
      <div><span>Logements</span><strong>${f0(S.logements)}</strong></div>
      <div><span>Dont collectifs</span><strong>${f0(S.collectifs)}</strong></div>
      <div><span>Dont sociaux</span><strong>${S.logements ? Math.round((100 * S.sociaux) / S.logements) + ' %' : '—'}</strong></div>
    </div>
    <p class="note">${S.termines} terminée(s), ${S.chantiers} en chantier, ${S.autorises} autorisée(s) non commencée(s)${S.annules ? `, ${S.annules} annulée(s)` : ''}. Source : permis de construire Sitadel (SDES), mis à jour chaque mois.</p>
    <div class="compare"><div class="label">Comparatif avec votre parcelle (opérations de 5 logements collectifs ou plus)</div>
      <table><tr><th></th><th class="n">Votre parcelle</th><th class="n">Opérations voisines (médiane)</th></tr>
        <tr><td>Densité</td><td class="n">${dPot ? f0(dPot) + ' logts/ha' : '—'}</td><td class="n">${S.densiteMed ? f0(S.densiteMed) + ' logts/ha' : '—'}</td></tr>
        <tr><td>Logements par opération</td><td class="n">${pot && pot.ok ? pot.real : '—'}</td><td class="n">${f0(S.lgtMed)}</td></tr>
        <tr><td>Niveaux</td><td class="n">${pot && pot.ok ? pot.niv : '—'}</td><td class="n">${f1(S.nivMed)}</td></tr>
        ${Array.isArray(sel.ventes) && permis.prixParAnnee(sel.ventes).length ? `<tr><td>Prix du neuf (dernière année)</td><td class="n">—</td><td class="n">${f0(permis.prixParAnnee(sel.ventes).slice(-1)[0].m2)} €/m² <small class="note">(${permis.prixParAnnee(sel.ventes).slice(-1)[0].n} vente(s) avec surface)</small></td></tr>` : ''}
        <tr><td>Surface habitable moyenne</td><td class="n">${f0(store.settings().sMoy)} m² (hypothèse)</td><td class="n">${S.shabMed ? f0(S.shabMed) + ' m²' : '—'}</td></tr>
      </table>
      <p class="note">${dPot && S.densiteMed ? (dPot > 1.3 * S.densiteMed ? 'Votre hypothèse est plus dense que ce qui s\'est construit : à justifier auprès de la commune.' : dPot < 0.7 * S.densiteMed ? 'Les opérations voisines sont plus denses : un programme plus important est peut-être acceptable.' : 'Votre hypothèse est cohérente avec les opérations voisines.') : 'Renseignez les règles de la zone pour comparer.'}</p></div>
    ${S.promoteurs.length ? `<div><div class="label">Qui construit (demandeurs des permis)</div><div class="tw"><table>
      <tr><th>Demandeur</th><th class="n">Opérations</th><th class="n">Logements</th><th class="n">Collectifs</th><th class="n">Sociaux</th><th>Dernier permis</th></tr>
      ${S.promoteurs.slice(0, 15).map((x) => `<tr><td>${promoLien(x)}</td><td class="n">${x.ops}</td><td class="n">${x.logements}</td><td class="n">${x.collectifs}</td><td class="n">${x.sociaux}</td><td>${esc(x.derniere)}</td></tr>`).join('')}
    </table></div><p class="note">Le nom n'est publié que pour les sociétés. Une SCCV ou une SCI porte souvent une seule opération d'un promoteur : la fiche entreprise donne ses dirigeants.</p></div>` : ''}
    ${vefaHtml()}
    <div class="res-head"><div class="label">Opérations (${L.length})</div>${L.length ? '<button type="button" class="ghost" id="projCsv">Exporter en CSV</button>' : ''}</div>
    ${L.length ? `<div class="tw"><table class="res-table">
      <tr><th>Demandeur</th><th class="n">Logts</th><th class="n">Coll.</th><th class="n">Soc.</th><th class="n">Terrain</th><th class="n">Densité</th><th class="n">Niv.</th><th>État</th><th>Autorisé</th><th class="n">Distance</th></tr>
      ${L.slice(0, 200).map((p, i) => `<tr data-pj="${i}" class="${p.centre ? 'clic' : ''}"><td>${p.siren ? promoLien({ nom: p.demandeur, siren: p.siren }) : '<span class="note">non publié</span>'}<br><small class="note">${esc(p.adresse || '')} ${p.parcelles[0] ? '· ' + esc(p.parcelles[0].section + ' ' + p.parcelles[0].numero) : ''}</small></td>
        <td class="n">${p.logements}</td><td class="n">${p.collectifs}</td><td class="n">${p.sociaux}</td><td class="n">${p.terrain ? m2(p.terrain) : '—'}</td><td class="n">${permis.densite(p) ? f0(permis.densite(p)) : '—'}</td><td class="n">${p.niveaux || '—'}</td>
        <td>${etatPill(p)}</td><td>${esc(p.autorisation || '')}</td><td class="n">${p.dist !== null && p.dist !== undefined ? (p.dist < 1000 ? f0(p.dist) + ' m' : f1(p.dist / 1000) + ' km') : '—'}</td></tr>`).join('')}
    </table></div><p class="note">Points sur la carte : vert terminé, orange en chantier, bleu autorisé. Touchez une ligne pour centrer la carte sur l'opération.</p>` : '<p class="empty">Aucune opération avec ces critères.</p>'}`;
  const F = $('#projF', body);
  $('#pjCarte', F).onchange = (e) => { e.stopPropagation(); $('#lay-permis').checked = e.target.checked; $('#lay-permis').dispatchEvent(new Event('change')); };
  F.onchange = (e) => {
    if (e.target.id === 'pjCarte') return;
    projOpts = { depuis: +$('#pjDepuis', F).value, min: +$('#pjMin', F).value, rayon: +$('#pjRayon', F).value, tri: $('#pjTri', F).value, statut: $('#pjStatut', F).value, annules: $('#pjAnn', F).checked };
    try { localStorage.setItem('tf-projets', JSON.stringify(projOpts)); } catch { /* stockage indisponible */ }
    renderFiche();
  };
  dessinerVefa();
  const GV = (sel.programmes || []).slice().sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
  body.querySelectorAll('tr[data-vf]').forEach((tr) => (tr.onclick = (ev) => { if (ev.target.closest('a')) return; const g = GV[+tr.dataset.vf]; if (g && g.centre) map.flyTo({ center: g.centre, zoom: 17 }); }));
  body.querySelectorAll('tr[data-pj]').forEach((tr) => (tr.onclick = (ev) => { if (ev.target.closest('a')) return; const p = L[+tr.dataset.pj]; if (p.centre) map.flyTo({ center: p.centre, zoom: 17 }); }));
  const csv = $('#projCsv', body);
  if (csv) csv.onclick = () => {
    const c = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const rows = [['Numéro', 'Demandeur', 'SIREN', 'Adresse', 'Parcelle', 'Logements', 'Collectifs', 'Individuels', 'Sociaux', 'Terrain (m²)', 'Surface habitable créée (m²)', 'Niveaux', 'Densité (logts/ha)', 'État', 'Autorisation', 'Ouverture chantier', 'Achèvement', 'Distance (m)'].join(';'),
      ...L.map((p) => [p.num, p.demandeur, p.siren, p.adresse, p.parcelles[0] ? p.parcelles[0].section + ' ' + p.parcelles[0].numero : '', p.logements, p.collectifs, p.individuels, p.sociaux, p.terrain, p.shab, p.niveaux, permis.densite(p) ? Math.round(permis.densite(p)) : '', p.etatLib, p.autorisation, p.chantier, p.achevement, p.dist ? Math.round(p.dist) : ''].map(c).join(';'))];
    download(`constructions-${insee}.csv`, '﻿' + rows.join('\n'), 'text/csv');
  };
}
// Chargement des permis (Sitadel) et des ventes sur plan (DVF) de la commune, puis localisation des opérations
function chargerProjets(token) {
  if (!sel || !sel.feature) return;
  const insee = sel.feature.properties.code_insee;
  const refresh = () => { if (token !== selToken) return; if (tab === 'fiche' && ficheTab === 'projets') renderFiche(); else { dessinerPermis(); dessinerVefa(); } };
  if (sel.permis === undefined) {
    sel.permis = 'loading';
    api.permisLogements(insee, { minLogements: 2 }).then(async (l) => {
      if (token !== selToken) return;
      sel.permis = l; sel.permisLoc = 0;
      refresh();
      const cibles = l.filter((p) => p.logements >= 5 || (p.autorisation || '') >= '2018').sort((a, b) => b.logements - a.logements).slice(0, 120);
      await permis.localiser(cibles, { onProgress: (d, n) => { if (token === selToken) { sel.permisLoc = d / n; const st = $('#projLoc'); if (st) st.textContent = `Localisation des opérations sur la carte : ${d} / ${n}`; } } });
      if (token !== selToken) return;
      permis.distances(l, sel.pt.coordinates); sel.permisLoc = 1;
      if (Array.isArray(sel.ventes)) sel.programmes = programmesSel();
      refresh();
    }).catch((e) => { if (token === selToken) { sel.permis = { erreur: e.message }; refresh(); } });
  }
  if (sel.ventes === undefined) {
    sel.ventes = 'loading';
    api.ventesNeuves(insee, { depuis: 2020 }).then((v) => {
      if (token !== selToken) return;
      sel.ventes = v;
      sel.programmes = programmesSel();
      refresh();
    }).catch((e) => { if (token === selToken) { sel.ventes = { erreur: e.message }; refresh(); } });
  }
}
function programmesSel() {
  const G = permis.programmesVefa(sel.ventes, Array.isArray(sel.permis) ? sel.permis : []);
  for (const g of G) g.dist = g.centre ? turf.distance(sel.pt.coordinates, g.centre, { units: 'meters' }) : null;
  return G;
}
function dessinerVefa() {
  const L = Array.isArray(sel?.programmes) ? sel.programmes : [];
  map.getSource('vefa').setData({ type: 'FeatureCollection', features: L.filter((g) => g.centre).map((g) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: g.centre }, properties: { idu: g.idu, ventes: g.ventes, debut: g.debut, fin: g.fin, m2Med: g.m2Med || 0, nM2: g.nM2, prixMed: g.prixMed || 0, promoteur: g.promoteur || '' } })) });
}
function vefaHtml() {
  if (sel.ventes === 'loading' || sel.ventes === undefined) return '<p class="note">Chargement des ventes de logements neufs (DVF)…</p>';
  if (sel.ventes.erreur) return `<p class="note">Ventes DVF indisponibles pour le moment (${esc(sel.ventes.erreur)}).</p>`;
  const ans = permis.prixParAnnee(sel.ventes), G = (sel.programmes || []).slice().sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
  const promoLien = (g) => g.siren ? `<a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${encodeURIComponent(g.siren)}" target="_blank" rel="noopener">${esc(g.promoteur)}</a>` : '<span class="note">—</span>';
  return `<div class="vefa-sec"><div class="label">Ventes de logements neufs sur plan (VEFA) depuis 2020</div>
    <p class="note">${sel.ventes.length} vente(s) en ${G.length} programme(s). Prix réels enregistrés par les notaires (DVF), publiés avec quelques mois de décalage. La surface n'est souvent pas publiée pour les ventes sur plan : le prix au m² ne porte que sur les ventes où elle l'est. ${$('#lay-vefa').checked ? 'Points violets sur la carte.' : 'Cochez « Ventes neuves (prix) » sur la carte pour les voir.'}</p>
    ${ans.length ? `<div class="tw"><table><tr><th>Année</th>${ans.map((a) => `<th class="n">${a.an}</th>`).join('')}</tr><tr><td>Prix médian du neuf</td>${ans.map((a) => `<td class="n"><b>${f0(a.m2)} €/m²</b><br><small class="note">${a.n} vente(s)</small></td>`).join('')}</tr></table></div>` : '<p class="note">Aucune vente avec surface publiée : prix au m² non calculable.</p>'}
    ${G.length ? `<div class="tw"><table class="res-table"><tr><th>Programme (parcelle)</th><th>Promoteur (permis)</th><th class="n">Ventes</th><th class="n">€/m²</th><th>Période</th><th class="n">Distance</th></tr>
      ${G.slice(0, 40).map((g, i) => `<tr data-vf="${i}" class="clic"><td>${esc(g.idu.slice(8))}</td><td>${promoLien(g)}</td><td class="n">${g.ventes}</td><td class="n">${g.m2Med ? f0(g.m2Med) : '—'}</td><td>${esc(g.debut)} → ${esc(g.fin)}</td><td class="n">${g.dist !== null && g.dist !== undefined ? (g.dist < 1000 ? f0(g.dist) + ' m' : (Math.round(g.dist / 100) / 10).toLocaleString('fr-FR') + ' km') : '—'}</td></tr>`).join('')}
    </table></div>` : ''}</div>`;
}
function dessinerPermis(list) {
  const L = list || (Array.isArray(sel?.permis) ? sel.permis.filter((p) => p.etat !== 4 && p.logements >= projOpts.min) : []);
  map.getSource('permis').setData({ type: 'FeatureCollection', features: L.filter((p) => p.centre).map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p.centre }, properties: { num: p.num, demandeur: p.demandeur, logements: p.logements, collectifs: p.collectifs, sociaux: p.sociaux, etat: p.etat, etatLib: p.etatLib, autorisation: p.autorisation, adresse: p.adresse } })) });
}

function ficheCommune(body) {
  const p = sel.feature.properties, c = sel.commune;
  const [lng, lat] = sel.pt.coordinates;
  const fr = sel.friches;
  body.innerHTML = `
    <dl class="kv">
      <dt>Commune</dt><dd>${esc(p.nom_com)} (${esc(p.code_insee)})</dd>
      <dt>Population</dt><dd>${c && c.population ? `${f0(c.population)} habitants (Insee)` : 'Chargement…'}</dd>
      <dt>Document d'urbanisme</dt><dd>${esc(sel.doc?.properties.du_type || '')} ${esc(sel.doc?.properties.grid_title || sel.partition || 'non trouvé')}</dd>
      <dt>Friches recensées</dt><dd>${fr === undefined ? 'Chargement…' : fr === null ? 'Cartofriches indisponible' : fr && fr.length ? fr.map((x) => `${esc(x.nom || x.type)} <span class="note">(${esc(x.statut || '')}, ${m2(x.surface)})</span>`).join('<br>') : 'Aucune'}</dd>
      <dt>Risques</dt><dd>${sel.risques === undefined ? 'Chargement…' : sel.risques ? (sel.risques.length ? sel.risques.map(esc).join(' · ') : 'Aucun recensé') : 'Donnée indisponible'}</dd>
    </dl>
    <div class="actions">
      <a href="https://explore.data.gouv.fr/fr/immobilier?onglet=carte&filtre=tous&lat=${lat}&lng=${lng}&zoom=15" target="_blank" rel="noopener">Ventes DVF autour</a>
      <a href="https://cartofriches.cerema.fr/cartofriches/" target="_blank" rel="noopener">Cartofriches</a>
    </div>
    <div class="todo"><b>Taux SRU et PLH : source à brancher</b><p class="note">Ces indicateurs ne sont pas encore affichés : ils demandent une source nationale à intégrer (inventaire SRU publié par le ministère, documents PLH des intercommunalités). Rien n'est affiché tant que la donnée n'est pas réelle.</p></div>`;
}

function ficheText() {
  const p = sel.feature.properties, rules = store.getRules(sel.key);
  const pot = potentielSel(), s = noteSel(pot);
  return [
    `Parcelle ${refOf(p)} — ${p.nom_com}`, `Contenance : ${m2(p.contenance)}`,
    `Zone : ${sel.zLabel} ${sel.zone?.properties.libelong || ''}`,
    `Nature du foncier : ${sel.occ ? sel.occ.label + ' (' + sel.occ.raisons.join(' ; ') + ')' : 'inconnue'}`,
    ...(sel.graph && sel.graph.n ? ['Plan graphique du PLU : ' + Object.values(sel.graph.sources).join(' ; ')] : []),
    ...(rules ? RULE_FIELDS.map((fd) => `- ${fd.label} : ${rules[fd.k] ?? 'non renseigné'}${rules.citations?.[fd.k]?.article ? ' (' + rules.citations[fd.k].article + ', p. ' + rules.citations[fd.k].page + ')' : ''}`) : ['Règles : non saisies']),
    pot && pot.ok ? `Potentiel : emprise ${m2(pot.E)}, SDP ${m2(pot.sdp)}, ${pot.lg} logements théoriques, ${pot.real} réalisables` : `Potentiel : ${pot ? pot.raison : 'non calculé'}`,
    s ? `Note de potentiel foncier : ${s.tot}/100${s.partiel ? ' (partielle)' : ''} — ${s.parts.map((x) => `${x.label} ${x.v ?? '-'}/${x.max}`).join(', ')}` : '',
    'Estimation indicative — ne remplace ni un certificat d’urbanisme ni une étude de faisabilité.',
  ].filter(Boolean).join('\n');
}

// ---------- Vue Potentiel ----------
function renderPot() {
  const v = $('#v-pot');
  if (!sel || !sel.feature || sel.loading) { v.innerHTML = '<p class="empty">Sélectionnez une parcelle sur la carte.</p>'; return; }
  const p = sel.feature.properties, hyp = store.settings();
  const pot = potentielSel();
  map.getSource('env').setData(pot.ok && pot.envFeat ? pot.envFeat : empty);
  if (!pot.ok) {
    v.innerHTML = `<span class="ref">${esc(refOf(p))} · zone ${esc(sel.zLabel)}</span><h2>Potentiel non calculable</h2><p>${esc(pot.raison)}.</p><div id="rulesSlot"></div>`;
    if (zoneConstructible(sel.zone) !== false) $('#rulesSlot', v).appendChild(rulesBlock(sel.key, sel.zLabel, renderPot));
    return;
  }
  v.innerHTML = `
    <div><span class="ref">${esc(refOf(p))} · zone ${esc(sel.zLabel)} · ${m2(pot.S)}</span><h2 style="font-size:19px;margin-top:2px">Potentiel constructible</h2></div>
    <div class="big">
      <div><strong>${m2(pot.E)}</strong><span>emprise maximale</span></div>
      <div><strong>${m2(pot.sdp)}</strong><span>surface de plancher</span></div>
      <div><strong>${pot.lg} → ${pot.real}</strong><span>logements théorique → réalisable</span></div>
    </div>
    ${(() => { const fu = fusionRegles(store.getRules(sel.key), sel.graph); const L = RULE_FIELDS.filter((fd) => fu.origine[fd.k]).map((fd) => { const v = fu.regles[fd.k]; return `${esc(fd.label.replace(/ \(.*\)$/, ''))} ${fd.pct ? Math.round(v * 100) + ' %' : v + ' ' + fd.unit} <span class="pill ${fu.origine[fd.k] === 'plan' ? 'ok' : 'wa'}">${fu.origine[fd.k] === 'plan' ? 'plan graphique' : 'zone'}</span>`; }); return L.length ? `<p class="note">Règles utilisées : ${L.join(' · ')}</p>` : ''; })()}
    <div><div class="label">Plafonds d'emprise — le plus bas s'applique</div>
      <table><tr><th>Plafond</th><th class="n">Surface</th></tr>
      ${pot.caps.map((c) => `<tr class="${c === pot.lim ? 'limit' : ''}"><td>${esc(c.n)}${c === pot.lim ? ' · limitant' : ''}</td><td class="n">${m2(c.v)}</td></tr>`).join('')}</table>
      <p class="note">Enveloppe tracée en orange : retrait de ${f0(pot.r.ret ?? 0)} m sur toutes les limites${pot.r.recul > (pot.r.ret ?? 0) ? `, recul de ${pot.r.recul} m sur voie estimé` : ''}. ${pot.niv} niveau(x) pour ${pot.r.h ?? '?'} m à ${hyp.hEt} m par étage.</p></div>
    <div><div class="label">Scénarios</div><table><tr><th>Scénario</th><th class="n">Niveaux</th><th class="n">SDP</th><th class="n">Logements</th></tr>
      ${pot.sc.map((s) => `<tr><td>${esc(s.n)}</td><td class="n">${s.niv}</td><td class="n">${s.sdp === null ? '—' : m2(s.sdp)}</td><td class="n">${s.lg}</td></tr>`).join('')}</table></div>
    ${sel.occ && sel.occ.stats.sdp ? `<p class="note">Bâti existant ≈ ${m2(sel.occ.stats.sdp)} de plancher, soit ${Math.round((100 * sel.occ.stats.sdp) / Math.max(1, pot.sdp))} % du potentiel : ${sel.occ.stats.sdp > 0.5 * pot.sdp ? 'gain limité.' : 'démolition-reconstruction ou densification à étudier.'}</p>` : ''}
    <div><div class="label">Contraintes</div>${pot.contraintes.length ? `<ul style="margin:0;padding-left:18px">${pot.contraintes.map((c) => `<li>${esc(c.t)}${c.d ? ` (−${Math.round(c.d * 100)} %)` : ''}</li>`).join('')}</ul>` : '<p class="note">Aucune contrainte détectée automatiquement.</p>'}
      ${pot.missing.length ? `<p class="note">Règles non renseignées : ${pot.missing.map(esc).join(', ')}.</p>` : ''}</div>
    <p class="note">Estimation indicative. Hypothèses modifiables dans Réglages. Ne remplace ni un certificat d'urbanisme ni une étude de faisabilité.</p>`;
}

// ---------- Prospection ----------
const pro = initProspection({
  map, setHits, selectFeature, rulesBlock, toast, download, esc, f0, m2, refOf, zoneConstructible, zoneHorsLogement,
  onResults: () => { if (!wide && window.innerWidth > 1100) $('#btnWide').click(); },
});

// ---------- Tableau de bord et suivi ----------
function letter(item) {
  return `Madame, Monsieur,

Nous nous permettons de vous contacter au sujet de votre terrain situé sur la commune de ${item.commune}, cadastré section ${item.ref.split(' ')[1]} n° ${item.ref.split(' ')[2]}, d'une contenance de ${f0(item.contenance)} m².

[Votre société] étudie des projets de logements sur ce secteur. Votre terrain pourrait s'y prêter et nous serions heureux d'échanger avec vous, sans engagement, sur vos intentions le concernant.

Vous pouvez nous joindre au [téléphone] ou à [adresse e-mail].

Vos coordonnées proviennent de [source de la donnée]. Conformément au RGPD, vous pouvez vous opposer à tout nouveau contact en nous l'indiquant par simple retour.

Veuillez agréer, Madame, Monsieur, l'expression de nos salutations distinguées.

[Nom, fonction]`;
}
function renderCrm() {
  const v = $('#v-crm'), list = store.crmList(), hist = store.historique();
  const today = new Date().toISOString().slice(0, 10);
  const dues = list.filter((x) => x.relance && x.relance <= today && x.statut < 5);
  const actifs = list.filter((x) => x.statut >= 1 && x.statut <= 5).length;
  const communes = new Set([...hist.map((h) => h.code), ...list.map((x) => x.commune)]).size;
  v.innerHTML = `
    <div><h2>Tableau de bord</h2><p class="note">Enregistré sur cet appareil. Exportez régulièrement pour sauvegarder ou partager.</p></div>
    <div class="kpis">
      <div><span>Opportunités suivies</span><strong>${list.length}</strong></div>
      <div><span>En cours</span><strong>${actifs}</strong></div>
      <div><span>Relances dues</span><strong class="${dues.length ? 'warn-t' : ''}">${dues.length}</strong></div>
      <div><span>Communes prospectées</span><strong>${communes}</strong></div>
    </div>
    <div class="pipeline">${store.STATUTS.map((s, i) => { const n = list.filter((x) => x.statut === i).length; return `<div class="${n ? '' : 'zero'}"><strong>${n}</strong><span>${esc(s)}</span></div>`; }).join('')}</div>
    ${dues.length ? `<div><div class="label">Relances à faire</div><ul class="list">${dues.map((x) => `<li><b>${esc(x.ref)}</b> · ${esc(x.commune)} · prévue le ${new Date(x.relance).toLocaleDateString('fr-FR')}</li>`).join('')}</ul></div>` : ''}
    <div><div class="label">Dernières prospections</div>${hist.length ? `<div class="tw"><table><tr><th>Date</th><th>Commune</th><th class="n">Parcelles</th><th class="n">Retenues</th><th>Meilleur terrain</th></tr>
      ${hist.slice(0, 8).map((h) => `<tr><td>${new Date(h.date).toLocaleDateString('fr-FR')}</td><td>${esc(h.commune)}</td><td class="n">${f0(h.total)}</td><td class="n">${f0(h.retenus)}</td><td>${h.top && h.top[0] ? `${esc(h.top[0].ref)} <span class="score ${scoreClass(h.top[0].score)}">${h.top[0].score}</span>` : '—'}</td></tr>`).join('')}</table></div>` : '<p class="note">Aucune prospection lancée pour l\'instant.</p>'}</div>
    <div><div class="label">Opportunités</div>${list.length ? '' : '<p class="empty">Aucune opportunité. Ajoutez-en depuis une fiche parcelle.</p>'}
    <div class="crm">${list.map((x, i) => `<div class="row">
      <span><b>${esc(x.ref)}</b> · ${esc(x.commune)} · ${esc(x.zone)} · ${m2(x.contenance)}${x.nature ? ` · ${esc(x.nature)}` : ''}${x.score !== null && x.score !== undefined ? ` <span class="score ${scoreClass(x.score)}">${x.score}</span>` : ''}${x.relance && x.relance <= today ? ' <span class="pill wa">relance due</span>' : ''}</span>
      <select id="c-st-${i}" data-i="${i}" data-f="statut" aria-label="Statut">${store.STATUTS.map((s, j) => `<option value="${j}" ${j === x.statut ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label class="full note" for="c-rel-${i}">Prochaine relance <input type="date" id="c-rel-${i}" data-i="${i}" data-f="relance" value="${esc(x.relance)}"></label>
      <textarea class="full" id="c-note-${i}" data-i="${i}" data-f="note" rows="2" placeholder="Notes : propriétaire, échanges, prix évoqué…">${esc(x.note)}</textarea>
      <div class="full actions"><button type="button" class="ghost" data-go="${i}">Voir</button><button type="button" class="ghost" data-letter="${i}">Préparer un courrier</button><button type="button" class="ghost" data-del="${i}">Retirer</button></div>
    </div>`).join('')}</div></div>
    ${list.length ? '<div class="actions"><button type="button" class="ghost" id="crmCsv">Exporter CSV</button><button type="button" class="ghost" id="crmGeo">Exporter GeoJSON</button></div>' : ''}
    <div id="letterSlot"></div>`;
  v.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => {
    const l = store.crmList(), i = +el.dataset.i; l[i][el.dataset.f] = el.dataset.f === 'statut' ? +el.value : el.value; store.saveCrm(l);
    if (el.dataset.f !== 'note') renderCrm();
  }));
  v.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => { const x = list[+b.dataset.go]; map.flyTo({ center: x.centre, zoom: 18 }); selectAt(x.centre[0], x.centre[1]); }));
  v.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { const l = store.crmList(); l.splice(+b.dataset.del, 1); store.saveCrm(l); renderCrm(); }));
  v.querySelectorAll('[data-letter]').forEach((b) => (b.onclick = () => {
    const slot = $('#letterSlot', v); const txt = letter(list[+b.dataset.letter]);
    slot.innerHTML = `<div class="label">Courrier de prospection — à relire et compléter avant envoi</div><textarea id="letterTxt" rows="14">${esc(txt)}</textarea><div class="actions"><button type="button" id="letterCopy">Copier</button></div>`;
    $('#letterCopy', slot).onclick = () => copy($('#letterTxt', slot).value);
    slot.scrollIntoView({ behavior: 'smooth' });
  }));
  const csv = $('#crmCsv', v); if (csv) csv.onclick = () => {
    const head = 'reference;idu;commune;zone;contenance_m2;nature;note_potentiel;statut;prochaine_relance;notes';
    const rows = list.map((x) => [x.ref, x.idu, x.commune, x.zone, x.contenance, x.nature || '', x.score ?? '', store.STATUTS[x.statut], x.relance, `"${(x.note || '').replace(/"/g, '""')}"`].join(';'));
    download('suivi-foncier.csv', '﻿' + [head, ...rows].join('\n'), 'text/csv;charset=utf-8');
  };
  const geo = $('#crmGeo', v); if (geo) geo.onclick = () => download('suivi-foncier.geojson', JSON.stringify({ type: 'FeatureCollection', features: list.map((x) => ({ type: 'Feature', geometry: x.geometry, properties: { ...x, geometry: undefined, statut: store.STATUTS[x.statut] } })) }), 'application/geo+json');
}

// ---------- Recherche ----------
const q = $('#q'), sug = $('#suggest');
let sugT, sugItems = [];
q.addEventListener('input', () => { clearTimeout(sugT); sugT = setTimeout(suggest, 250); });
q.addEventListener('keydown', (e) => { if (e.key === 'Escape') sug.hidden = true; });
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) sug.hidden = true; });
async function suggest() {
  const t = q.value.trim(); if (t.length < 3 || /^\d{5}\s+\w{1,2}\s+\d+$/.test(t)) { sug.hidden = true; return; }
  const [c, a] = await Promise.allSettled([api.searchCommunes(t), api.searchAddress(t)]);
  sugItems = [
    ...(c.status === 'fulfilled' ? c.value.slice(0, 3).map((x) => ({ kind: 'commune', label: x.nom, sub: `${x.codeDepartement} · ${x.code}`, data: x })) : []),
    ...(a.status === 'fulfilled' ? a.value.slice(0, 5).map((x) => ({ kind: 'adresse', label: x.properties.label, sub: x.properties.type === 'municipality' ? 'commune' : 'adresse', data: x })) : []),
  ];
  sug.innerHTML = sugItems.map((s, i) => `<li data-i="${i}">${esc(s.label)}<small>${esc(s.sub)}</small></li>`).join('');
  sug.hidden = !sugItems.length;
  sug.querySelectorAll('li').forEach((li) => (li.onclick = () => pick(sugItems[+li.dataset.i])));
}
function pick(s) {
  sug.hidden = true; q.value = s.label;
  if (s.kind === 'commune') { pro.setCommune(s.data); map.flyTo({ center: s.data.centre.coordinates, zoom: 14 }); toast(`${s.data.nom} : touchez une parcelle, ou lancez une prospection`); }
  else { const [lng, lat] = s.data.geometry.coordinates; map.flyTo({ center: [lng, lat], zoom: 18 }); selectAt(lng, lat); }
}
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = q.value.trim();
  const m = t.match(/^(\d[\dAB]\d{3})\s+([A-Z0-9]{1,2})\s+(\d{1,4})$/i);
  if (m) {
    try {
      const f = await api.parcelleByRef(m[1], m[2].toUpperCase().padStart(2, '0'), m[3]);
      if (!f) return toast('Parcelle introuvable');
      map.fitBounds(turf.bbox(f), { padding: 80, maxZoom: 18 }); selectFeature(f);
    } catch (err) { toast(err.message); }
    return;
  }
  if (sugItems[0]) pick(sugItems[0]); else { await suggest(); if (sugItems[0]) pick(sugItems[0]); }
});

// ---------- Réglages ----------
const dlg = $('#settings');
$('#btnSettings').onclick = () => {
  const s = store.settings();
  $('#set-backend').value = s.backend; $('#set-het').value = s.hEt; $('#set-k').value = s.k; $('#set-smoy').value = s.sMoy; $('#set-lot').value = s.sLot;
  dlg.showModal();
};
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  store.saveSettings({ backend: $('#set-backend').value.trim(), hEt: +$('#set-het').value || 3, k: +$('#set-k').value || 0.8, sMoy: +$('#set-smoy').value || 65, sLot: +$('#set-lot').value || 400 });
  toast('Réglages enregistrés'); showTab(tab);
});

// Légende des notes
$('#legend').innerHTML = `<b>Note</b>${['0-19', '20-39', '40-59', '60-79', '80-100'].map((t, i) => `<span><i style="background:${SCORE_COLORS[i]}"></i>${t}</span>`).join('')}`;

showTab('fiche');

// Diagnostic (console du navigateur) : état courant de l'application
window.tfDebug = () => ({ tab, ficheTab, selToken, sel });
