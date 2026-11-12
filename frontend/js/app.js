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
import * as fais from './faisabilite.js';
import { initAssistant, cleIA } from './assistant.js';
import * as lecture from './lecture.js';

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
  // destinations publiées par la collectivité (standard CNIG) : habitation interdite / autorisée
  const non = `${p.destnon || ''}`, oui = `${p.destoui || ''} ${p.destcdt || ''} ${p.destdomi || ''}`;
  if (/habitation|logement/i.test(non)) return true;
  if (t === 'AUS' || /^2AU/i.test(lib)) return true;
  // zone d'activités ou d'équipements (même « mixte ») sauf si l'habitat est cité
  if (/zone d.activit|activit[ée]s? [ée]conomi|industri|portuaire|a[ée]roport|[ée]quipement|cimeti/i.test(long) && !/habita|logement|r[ée]sidenti/i.test(long)) return true;
  // zone d'habitat ou mixte d'après son intitulé : le logement y est autorisé
  if (/habita|logement|r[ée]sidenti|mixte|centralit|centre[- ]?(ville|bourg)|faubourg|pavillon|lotissement/i.test(long) || /habitation|logement/i.test(oui)) return false;
  return /activit|[ée]quipement|industri|commerc|portuaire|a[ée]roport|parcs?\b|jardins|cimeti|sports?\b|loisirs/i.test(long) || /(^|-)(U?AE|UE|UX|UI|UY)\d*(-|$)/i.test(lib);
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
const SCORE_COLORS = ['#8b96a0', '#b98a2c', '#c96f2a', '#2b8a6b', '#0f6e5a'];

// Carte : si l'ordinateur ne peut pas l'afficher (WebGL désactivé : PC d'entreprise, bureau à distance, vieux pilote),
// le reste du site (recherche, fiches, prospection, faisabilité, suivi) continue de fonctionner sans elle.
let carteOk = true;
function carteIndisponible(raison) {
  carteOk = false;
  const el = document.getElementById('map');
  if (el) el.innerHTML = `<div class="map-off"><b>La carte ne peut pas s'afficher sur cet appareil.</b><span>${raison === 'lib' ? "Le réseau bloque le chargement de la carte (unpkg.com)." : "L'affichage 3D du navigateur (WebGL) est désactivé, ce qui arrive sur les PC d'entreprise ou en bureau à distance."} Recherche, fiches, prospection, faisabilité et suivi fonctionnent quand même. Pour avoir la carte, essayez un autre navigateur (Chrome, Edge, Firefox) ou activez l'accélération matérielle dans ses paramètres.</span></div>`;
  const stub = new Proxy(function () {}, {
    get: (t, k) => ({
      getSource: () => ({ setData() {} }), getLayer: () => null, getCanvas: () => ({ style: {} }), getZoom: () => 14,
      getBounds: () => null, queryRenderedFeatures: () => [], getCenter: () => ({ lng: 2.45, lat: 46.6 }), getStyle: () => ({ layers: [] }),
    }[k] || (() => stub)),
    apply: () => stub,
  });
  return stub;
}
const map = (() => {
  if (typeof maplibregl === 'undefined') return carteIndisponible('lib');
  try {
    return new maplibregl.Map({
  container: 'map',
  center: [2.45, 46.6], zoom: 5.4, maxZoom: 20, hash: true,
  style: {
    version: 8,
    sources: {
      plan: { type: 'raster', tiles: [wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'normal', 'image/png')], tileSize: 256, maxzoom: 19, attribution: '© IGN Géoplateforme' },
      ortho: { type: 'raster', tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'normal', 'image/jpeg')], tileSize: 256, maxzoom: 19, attribution: '© IGN Géoplateforme' },
      // photos aériennes récentes de l'IGN, publiées secteur par secteur (vides ailleurs) : de la plus ancienne à la plus récente
      r2024: { type: 'raster', tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS2024', 'normal', 'image/jpeg')], tileSize: 256, minzoom: 6, maxzoom: 19, attribution: '© IGN Géoplateforme' },
      rpac25: { type: 'raster', tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS.ORTHO-ASP_PAC2025', 'normal', 'image/jpeg')], tileSize: 256, maxzoom: 18, attribution: '© IGN / ASP' },
      rexp25: { type: 'raster', tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS.ORTHO-EXPRESS.2025', 'normal', 'image/jpeg')], tileSize: 256, maxzoom: 19, attribution: '© IGN Géoplateforme' },
      rpac26: { type: 'raster', tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS.ORTHO-ASP_PAC2026', 'normal', 'image/jpeg')], tileSize: 256, maxzoom: 18, attribution: '© IGN / ASP' },
      rexp26: { type: 'raster', tiles: [wmts('ORTHOIMAGERY.ORTHOPHOTOS.RVB-EXPRESS.2026', 'normal', 'image/jpeg')], tileSize: 256, maxzoom: 19, attribution: '© IGN Géoplateforme' },
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
      bat: { type: 'geojson', data: empty },
      bati3d: { type: 'geojson', data: empty },
    },
    layers: [
      { id: 'plan', type: 'raster', source: 'plan' },
      { id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } },
      { id: 'orthoHist', type: 'raster', source: 'orthoHist', layout: { visibility: 'none' } },
      ...['r2024', 'rpac25', 'rexp25', 'rpac26', 'rexp26'].map((id) => ({ id, type: 'raster', source: id, layout: { visibility: 'none' } })),
      { id: 'zonage', type: 'raster', source: 'zonage', minzoom: 11, paint: { 'raster-opacity': 0.45 } },
      { id: 'presc', type: 'raster', source: 'presc', minzoom: 13, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } },
      { id: 'cadastre', type: 'raster', source: 'cadastre', minzoom: 15 },
      { id: 'noms', type: 'raster', source: 'noms', layout: { visibility: 'none' } },
      { id: 'hits-fill', type: 'fill', source: 'hits', paint: { 'fill-color': ['step', ['get', 'score'], SCORE_COLORS[0], 20, SCORE_COLORS[1], 40, SCORE_COLORS[2], 60, SCORE_COLORS[3], 80, SCORE_COLORS[4]], 'fill-opacity': 0.6 } },
      { id: 'hits-line', type: 'line', source: 'hits', paint: { 'line-color': '#18222d', 'line-width': 0.8, 'line-opacity': 0.6 } },
      { id: 'bati-fill', type: 'fill', source: 'bati', paint: { 'fill-color': '#6b47b8', 'fill-opacity': 0.4 } },
      { id: 'sel-fill', type: 'fill', source: 'sel', paint: { 'fill-color': '#1560d4', 'fill-opacity': 0.14 } },
      { id: 'sel-halo', type: 'line', source: 'sel', paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.85 } },
      { id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#1560d4', 'line-width': 3 } },
      { id: 'vefa-pt', type: 'circle', source: 'vefa', layout: { visibility: 'none' }, paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'ventes'], 1, 5, 30, 11, 150, 17], 'circle-color': '#8e3fb8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 0.85 } },
      { id: 'permis-pt', type: 'circle', source: 'permis', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'logements'], 2, 6, 50, 11, 200, 18], 'circle-color': ['match', ['get', 'etat'], 6, '#1f6b45', 5, '#e0661b', 2, '#2347c5', '#8a8f98'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 0.9 } },
      { id: 'bati3d', type: 'fill-extrusion', source: 'bati3d', layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': '#c9cfd6', 'fill-extrusion-height': ['coalesce', ['get', 'hauteur'], 6], 'fill-extrusion-opacity': 0.85 } },
      { id: 'bat-fill', type: 'fill', source: 'bat', paint: { 'fill-color': '#f2b705', 'fill-opacity': 0.7 } },
      { id: 'bat-line', type: 'line', source: 'bat', paint: { 'line-color': '#17263b', 'line-width': 2.5 } },
      { id: 'bat-3d', type: 'fill-extrusion', source: 'bat', layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': '#f2b705', 'fill-extrusion-height': ['get', 'hauteur'], 'fill-extrusion-opacity': 0.95 } },
      { id: 'env-line', type: 'line', source: 'env', paint: { 'line-color': '#e0661b', 'line-width': 2, 'line-dasharray': [2, 1.5] } },
    ],
  },
});
  } catch (e) { return carteIndisponible('webgl'); }
})();
if (carteOk) {
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
}
map.on('click', (e) => { if (e.defaultPrevented || (map.getLayer('permis-pt') && map.queryRenderedFeatures(e.point, { layers: ['permis-pt', 'vefa-pt', 'bat-fill'] }).length)) return; selectAt(e.lngLat.lng, e.lngLat.lat); });

// Infobulle au survol des terrains de la prospection
const popup = carteOk ? new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, className: 'tf-pop' }) : null;
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
  const an = $('#orthoAn').value;
  // « la plus récente » : photo officielle dessous, puis les couches 2024 à 2026 par-dessus là où elles existent
  const RECENTES = { recent: ['r2024', 'rpac25', 'rexp25', 'rpac26', 'rexp26'], 2026: ['rpac26', 'rexp26'], 2025: ['rpac25', 'rexp25'] };
  const couches = RECENTES[an] || [];
  const base = an === 'ORTHOIMAGERY.ORTHOPHOTOS' || couches.length;
  vis('plan', !sat); vis('ortho', sat && base); vis('orthoHist', sat && !base);
  ['r2024', 'rpac25', 'rexp25', 'rpac26', 'rexp26'].forEach((id) => vis(id, sat && couches.includes(id))); vis('noms', sat && $('#lay-noms').checked);
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
  if (v.startsWith('ORTHOIMAGERY.ORTHOPHOTOS') && v !== 'ORTHOIMAGERY.ORTHOPHOTOS') map.getSource('orthoHist').setTiles([wmts(v, vieux ? 'BDORTHOHISTORIQUE' : 'normal', vieux ? 'image/png' : 'image/jpeg')]);
  appliquerFond();
});
$('#zonageOpa').addEventListener('input', (e) => map.setPaintProperty('zonage', 'raster-opacity', +e.target.value / 100));
map.on('load', () => {
  let f = null; try { f = JSON.parse(localStorage.getItem('tf-fond') || 'null'); } catch { f = null; }
  if (!f) return;
  if (f.an) { $('#orthoAn').value = f.an; $('#orthoAn').dispatchEvent(new Event('change')); }
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
  $('#legend').hidden = !list.length;
  if (!carteOk) return;
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
function showTab(v, { garderMode = false } = {}) {
  tab = v;
  if (estMobile() && !garderMode) modeMobile(v);
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
  if (tab !== 'pro' && tab !== 'crm') showTab('fiche', { garderMode: estMobile() && document.body.dataset.m === 'carte' }); else renderFiche();
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
  map.getSource('bat').setData(empty); map.getSource('bati3d').setData(empty);
  if (forceTab) showTab(forceTab);
  else if (tab !== 'pot' && tab !== 'pro' && tab !== 'crm') showTab('fiche', { garderMode: estMobile() && document.body.dataset.m === 'carte' });
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
  const rerender = () => { if (token !== selToken) return; if (tab === 'fiche') renderFiche(); else if (tab === 'pot') renderPot(); majPeek(); };
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
    // plusieurs documents au même endroit (ancien PLU communal encore publié et PLUi) : le plus récemment approuvé s'applique
    const zs = (x['zone-urba'] || []).slice().sort((a, b) => String(b.properties.datappro || '').localeCompare(String(a.properties.datappro || '')) || (/PSMV/.test(a.properties.partition || '') - /PSMV/.test(b.properties.partition || '')));
    sel.zone = zs[0] || null;
    sel.cc = (x['secteur-cc'] || [])[0] || null;
    sel.partition = sel.zone?.properties.partition || sel.cc?.properties.partition || sel.partition || null;
    sel.zLabel = sel.zone?.properties.libelle || sel.cc?.properties.libelle || (x['zone-urba'] === null ? '?' : 'RNU');
    sel.key = store.ruleKey(sel.partition, sel.zLabel);
    rerender();
    // règles lues par l'IA côté serveur pour ce PLU (sans clé sur cet appareil)
    lecture.reglesCopie(sel.partition).then((n) => { if (n && token === selToken) rerender(); });
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
    autoLecture();
  });
  Promise.all([occAtP, frP]).then(([occAt, fr]) => {
    if (token !== selToken) return;
    sel.friches = fr; sel.occAtOk = !!(occAt.parkings && occAt.equipements); sel.occComplet = true;
    const o = analyse(occAt, fr); if (o) sel.occ = o;
    rerender();
  });
  risqP.then((r) => { if (token === selToken) { sel.risques = r; rerender(); } });
  api.adresseParcelle(f).then((a) => { if (token === selToken && a) { sel.adresse = a; const el = $('#ficheAdr'); if (el) el.innerHTML = adrHtml(); } });
  api.communeByCode(insee).then((c) => { if (token === selToken) { sel.commune = c; if (tab === 'fiche' && ficheTab === 'commune') renderFiche(); } }).catch(() => {});
  if (tab === 'pot') renderPot(); else renderFiche();
  majPeek();
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
      ${backend ? '<button type="button" data-act="ia">Extraire avec l\'IA</button>' : `<button type="button" data-act="gem">${saved && /ia/.test(saved.source || '') ? 'Relire le règlement avec l\'IA' : 'Lire le règlement avec l\'IA'}</button>`}
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
  const gem = wrap.querySelector('[data-act=gem]');
  if (gem) gem.onclick = async () => {
    if (!cleIA()) { assistant.ecranCle(); return; }
    const zone = ctx.zone || sel?.zone, partition = ctx.partition || sel?.partition;
    if (!zone || !partition) { toast('Zone du PLU inconnue'); return; }
    gem.disabled = true;
    try {
      const { trouve } = await lecture.lireZone({ key, zone, partition, onEtape: (t) => (gem.textContent = t.length > 48 ? t.slice(0, 46) + '…' : t) });
      toast(trouve ? `Zone ${zoneLabel} : ${trouve} règle(s) lue(s)` : `Zone ${zoneLabel} : règles non trouvées dans le règlement`);
      onChange && onChange();
    } catch (e) { toast(e.message); gem.disabled = false; gem.textContent = "Lire le règlement avec l'IA"; }
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
  return computePotentiel(sel.feature, rules, store.settings(), { contenance: sel.feature.properties.contenance, batiSdp: sel.bati?.sdp, constructible: zoneConstructible(sel.zone), facade: sel.fais && sel.fais.idu === sel.feature.properties.idu && sel.fais.surRue ? sel.fais.fac.a : null });
}
function noteSel(pot) {
  if (!sel.occ) return null;
  const c = { ...CRIT_DEFAUT, ...(store.prospectionCrit() || {}) };
  return noter({ S: sel.occ.S, crit: { smin: c.smin || 0, smax: c.smax || 1e12, lmin: c.lmin || 1, lmax: c.lmax || 100000 }, occ: sel.occ, pot: pot && pot.ok ? pot : null, contraintes: sel.contraintes || [], compacite: compacite(sel.feature) });
}

function renderFiche() {
  const v = $('#v-fiche');
  if (!sel) {
    v.innerHTML = `<div class="empty-state">
      <h2>Trouver du foncier constructible</h2>
      <ol class="steps">
        <li><span><b>Cherchez</b> une adresse, une commune ou une parcelle (ex. « 45302 AY 209 ») dans la barre du haut.</span></li>
        <li><span><b>Touchez une parcelle</b> sur la carte : sa fiche s'ouvre ici avec la zone du PLU, les règles, le bâti et le nombre de logements possibles.</span></li>
        <li><span><b>Ou prospectez une commune entière</b> : le site trie les terrains où le PLU permet du logement collectif, seuls ou en remembrement.</span></li>
      </ol>
      <div class="actions"><button type="button" id="goPro">Prospecter une commune</button></div>
    </div>`;
    $('#goPro', v).onclick = () => showTab('pro');
    return;
  }
  if (sel.error) { v.innerHTML = `<h2>Données indisponibles</h2><p class="empty">${esc(sel.error)}. Réessayez dans un instant.</p>`; return; }
  if (sel.loading) { v.innerHTML = `<p class="ref">${esc(refOf(sel.feature?.properties))}</p><p class="empty">Interrogation du cadastre, du Géoportail de l'Urbanisme et de la BD TOPO…</p>`; return; }
  const p = sel.feature.properties;
  v.innerHTML = `
    <div class="fiche-head">
      <div><span class="ref">${esc(refOf(p))} · IDU ${esc(p.idu)}</span><h2>${esc(p.nom_com || '')}, section ${esc(p.section)} n° ${esc(p.numero)}</h2><p class="adr" id="ficheAdr">${adrHtml()}</p></div>
      <div class="actions"><button type="button" class="ghost" id="addCrm">Ajouter au suivi</button><button type="button" class="ghost" id="copyFiche">Copier la fiche</button><a class="btn-link" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${sel.pt.coordinates[1]},${sel.pt.coordinates[0]}" target="_blank" rel="noopener">Street View</a></div>
    </div>
    ${sel.urba['zone-urba'] === 'loading' ? '<p class="note">Zonage du PLU en cours de chargement…</p>' : ''}${sel.viaWms ? '<p class="note"><span class="pill wa">secours</span> API Carto (IGN) saturé : zonage et prescriptions lus sur le service cartographique du Géoportail de l\'Urbanisme, même source officielle.</p>' : ''}${sel.urba['zone-urba'] === null ? `<div class="warn">Le Géoportail de l'Urbanisme (IGN) ne répond pas pour le moment : zonage et règles indisponibles. Les autres informations restent valables. <button type="button" class="ghost" id="retryGpu">Réessayer</button></div>` : ''}
    <nav class="subtabs" role="tablist">${FICHE_TABS.map(([k, t]) => `<button type="button" role="tab" class="subtab" data-ft="${k}" aria-selected="${ficheTab === k}">${t}</button>`).join('')}</nav>
    <div id="ficheBody" class="fiche-body"></div>`;
  v.querySelectorAll('[data-ft]').forEach((b) => (b.onclick = () => { ficheTab = b.dataset.ft; renderFiche(); }));
  const rg = $('#retryGpu', v); if (rg) rg.onclick = () => selectFeature(sel.feature);
  $('#addCrm', v).onclick = () => {
    const pot = potentielSel(), s = noteSel(pot);
    const ok = store.addToCrm({ idu: p.idu, ref: refOf(p), commune: p.nom_com, adresse: sel.adresse?.label || p.adresse || '', zone: sel.zLabel, contenance: p.contenance, centre: sel.pt.coordinates, geometry: turf.truncate(sel.feature, { precision: 6 }).geometry, nature: sel.occ?.label || '', note: '', score: s ? s.tot : null });
    toast(ok ? 'Ajouté au suivi' : 'Déjà dans le suivi');
  };
  $('#copyFiche', v).onclick = () => copy(ficheText());
  const body = $('#ficheBody', v);
  ({ synthese: ficheSynthese, urba: ficheUrba, bati: ficheBati, contraintes: ficheContraintes, projets: ficheProjets, commune: ficheCommune }[ficheTab] || ficheSynthese)(body);
}

function adrHtml() {
  const a = sel && sel.adresse;
  if (!a) return '<span class="note">Adresse…</span>';
  const prec = { parcelle: 'adresse rattachée à la parcelle (Base Adresse Nationale)', dans: 'adresse située sur la parcelle', limite: 'adresse en limite de la parcelle', voisine: `pas d'adresse sur la parcelle : adresse voisine, à ${a.distance} m de sa limite` }[a.precision] || '';
  return `${esc(a.label)} <span class="note">· ${esc(prec)}</span>`;
}

function ficheSynthese(body) {
  const p = sel.feature.properties, z = sel.zone?.properties;
  const pot = potentielSel(), s = noteSel(pot), constr = zoneConstructible(sel.zone);
  const occ = sel.occ;
  const mb = Array.isArray(p.membres) ? p.membres : null;
  body.innerHTML = `
    ${mb ? `<div class="remb"><span class="pill wa">remembrement</span> <b>${mb.length} parcelles voisines réunies</b>, propriétaires probablement différents à contacter un par un :
      <ul class="list">${mb.map((m) => `<li><span><b>${esc(m.ref)}</b> · ${m2(m.S)} · ${esc(m.nature)}${m.adresse ? ' · ' + esc(m.adresse) : ''}</span></li>`).join('')}</ul>
      <p class="note">Le potentiel ci-dessous est calculé sur le terrain réuni (${m2(p.contenance)}), avec les règles du PLU de la zone.</p></div>` : ''}
    <div class="kpis">
      <div><span>Surface</span><strong>${m2(p.contenance)}</strong></div>
      <div><span>Zone</span><strong>${sel.urba['zone-urba'] === 'loading' ? '…' : esc(sel.zLabel)}</strong></div>
      <div><span>Nature</span><strong class="small">${esc(occ ? occ.label : '—')}</strong></div>
      <div><span>Logements (SDP/${store.settings().sMoy})</span><strong>${pot && pot.ok ? `${pot.real}` : '?'}</strong></div>
    </div>
    ${s ? `<div class="score-card"><span class="score big ${scoreClass(s.tot)}">${s.tot}</span><div><b>Note de potentiel foncier</b>${s.partiel ? ' <span class="pill wa">partielle</span>' : ''}<p class="note">${s.partiel ? 'Règles de la zone à renseigner pour une note complète. ' : ''}Calculée avec vos derniers critères de prospection.</p></div></div>
      <div class="why">${s.parts.map((x) => `<div class="why-row"><span>${esc(x.label)}</span><span class="bar"><i style="width:${x.v === null ? 0 : Math.round((100 * x.v) / x.max)}%"></i></span><b>${x.v === null ? '—' : x.v}/${x.max}</b><small>${esc(x.why)}</small></div>`).join('')}</div>` : '<p class="note">Bâti indisponible : la note ne peut pas être calculée.</p>'}
    <dl class="kv">
      <dt>Zone</dt><dd>${z ? `<b>${esc(z.libelle)}</b> ${esc(z.libelong || '')} <span class="pill ${constr ? 'ok' : constr === false ? 'no' : 'wa'}">${esc(z.typezone || '')}</span>` : sel.urba['zone-urba'] === null ? '<span class="pill wa">service indisponible</span> <button type="button" class="ghost" id="retryUrba">Réessayer</button>' : '—'}</dd>
      <dt>Bâti</dt><dd>${occ ? `${occ.stats.n - occ.stats.legers} bâtiment(s), ${Math.round(occ.ces * 100)} % d'emprise${occ.stats.logements ? `, ${occ.stats.logements} logement(s)` : ''}` : 'Donnée indisponible'}</dd>
      <dt>Signaux</dt><dd>${occ && occ.flags.length ? occ.flags.map((x) => esc(x.t)).join(' · ') : 'Aucun'}</dd>
      <dt>Potentiel</dt><dd>${pot && pot.ok ? `${m2(pot.sdp)} de plancher ÷ ${store.settings().sMoy} m² = ${pot.real} logements` : constr === false ? 'Zone A ou N : pas de logement' : sel.urba['prescription-surf'] === 'loading' ? 'Lecture des règles du PLU…' : 'Règles de la zone à renseigner (onglet Urbanisme)'}</dd>
    </dl>
    <div class="actions"><button type="button" id="goPot">Faisabilité et esquisse</button></div>`;
  $('#goPot', body).onclick = () => showTab('pot');
  const retry = $('#retryUrba', body); if (retry) retry.onclick = () => selectFeature(sel.feature);
}

function ficheUrba(body) {
  const z = sel.zone?.properties, d = sel.doc?.properties;
  const [lng, lat] = sel.pt.coordinates;
  const arr = (k) => (Array.isArray(sel.urba[k]) ? sel.urba[k] : []);
  const pending = sel.urba['prescription-surf'] === 'loading';
  const prescF = [...arr('prescription-surf'), ...arr('prescription-lin')];
  const oap = prescF.concat(arr('info-surf')).filter((x) => /OAP|orientation/i.test(x.properties.libelle || ''));
  const constr = zoneConstructible(sel.zone);
  const regl = api.reglementUrl(sel.zone, sel.partition);
  const hyp = store.settings();
  const fu = fusionRegles(store.getRules(sel.key), sel.graph);
  const r = fu.regles, pot = potentielSel();
  const S = +sel.feature.properties.contenance || 0;
  const logementOk = sel.zone ? constr === true && !zoneHorsLogement(sel.zone) : null;
  // repères tirés des permis récents de la commune (chargés en arrière-plan)
  if (sel.permis === undefined) chargerProjets(selToken);
  const ops = Array.isArray(sel.permis) ? sel.permis.filter((p) => p.etat !== 4 && p.collectifs >= 5 && (p.autorisation || '') >= '2015') : null;
  const med = (a) => { const t = a.filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y); return t.length ? t[t.length >> 1] : null; };
  const opsZone = ops && sel.zone ? ops.filter((p) => p.centre && (() => { try { return turf.booleanPointInPolygon(turf.point(p.centre), sel.zone); } catch { return false; } })()) : [];
  const ref = opsZone.length >= 3 ? { l: opsZone, ou: `dans la zone ${sel.zLabel}` } : ops && ops.length >= 3 ? { l: ops, ou: 'dans la commune' } : null;
  const fmtR = (k, v) => (v === null || v === undefined ? null : k === 'ces' || k === 'pt' ? `${Math.round(v * 100)} %` : `${String(v).replace('.', ',')} m`);
  const lu = store.getRules(sel.key), cit = (k) => lu && lu.citations && lu.citations[k] && lu.citations[k].status !== 'non_trouve' ? lu.citations[k] : null;
  const src = (k) => (fu.origine[k] === 'plan' ? '<span class="pill ok">plan graphique</span>'
    : fu.origine[k] === 'zone' ? (cit(k) ? `<span class="pill wa" title="${esc(cit(k).citation || '')}">lu par l'IA${cit(k).page ? ', p. ' + cit(k).page : ''}</span>` : '<span class="pill wa">vos règles</span>') : '');
  const manque = ['ces', 'h', 'recul', 'ret', 'pt', 'stat'].some((k) => r[k] === null);
  const lecturePossible = logementOk !== false && sel.zone && sel.partition && manque;
  const iaEtat = sel.iaLecture && sel.iaLecture.key === sel.key ? sel.iaLecture : null;
  const verdict = !sel.zone && !sel.cc ? (sel.urba['zone-urba'] === 'loading' ? ['', 'Lecture du PLU…'] : ['wa', 'Zone non déterminée'])
    : sel.cc ? ['wa', 'Carte communale : constructible dans les secteurs délimités']
    : logementOk ? ['ok', 'Logement autorisé par le PLU']
    : constr === false ? ['no', 'Zone agricole ou naturelle : pas de logement']
    : ['no', "Zone d'activités, d'équipements ou d'urbanisation future : logement non prévu"];
  body.innerHTML = `
    <div class="synth">
      <div class="synth-head"><span class="pill ${verdict[0]}">${esc(verdict[1])}</span></div>
      <h3>${z ? `Zone ${esc(z.libelle)}` : sel.cc ? esc(sel.cc.properties.libelle || 'Carte communale') : 'Zone —'}</h3>
      <p class="note">${z ? esc(z.libelong || '') : ''}${d ? ` · ${esc(d.du_type || '')} ${esc(d.grid_title || '')}` : sel.partition ? ` · ${esc(sel.partition)}` : ''}${z && z.destdomi ? ` · destination dominante : ${esc(z.destdomi)}` : ''}</p>
      <div class="kpis">
        <div><span>Emprise au sol max</span><strong>${fmtR('ces', r.ces) || '—'}</strong>${src('ces')}</div>
        <div><span>Hauteur max</span><strong>${r.h !== null ? `${fmtR('h', r.h)} · R+${Math.max(0, Math.floor(r.h / hyp.hEt) - 1)}` : '—'}</strong>${src('h')}</div>
        <div><span>Pleine terre min</span><strong>${fmtR('pt', r.pt) || '—'}</strong>${src('pt')}</div>
        <div><span>OAP</span><strong class="small">${pending ? '…' : oap.length ? 'Oui' : 'Non'}</strong></div>
      </div>
      ${pot && pot.ok ? `<div class="synth-pot"><b>${f0(pot.E)} m²</b> d'emprise × ${pot.niv} niveau(x) × ${hyp.k} = <b>${f0(pot.sdp)} m² de plancher</b> ÷ ${hyp.sMoy} m² = <b>${pot.real} logements</b> sur ${m2(S)}</div>`
        : logementOk ? `<p class="note">Potentiel non calculable : ni le plan graphique ni vos règles ne donnent l'emprise ou la hauteur de cette zone. ${ref ? 'Les repères ci-dessous donnent un ordre de grandeur.' : ''}</p>` : ''}
    </div>
    ${ref ? `<div class="synth-ref"><div class="label">Ce qui s'est construit récemment ${esc(ref.ou)}</div>
      <p class="note">${ref.l.length} opérations de 5 logements collectifs ou plus autorisées depuis 2015 (permis de construire) : hauteur médiane <b>${med(ref.l.map((p) => p.niveaux)) ? 'R+' + (med(ref.l.map((p) => p.niveaux)) - 1) : '—'}</b>, densité médiane <b>${med(ref.l.map((p) => permis.densite(p))) ? f0(med(ref.l.map((p) => permis.densite(p)))) + ' logements/ha' : '—'}</b>, soit environ <b>${med(ref.l.map((p) => permis.densite(p))) ? Math.floor((S * med(ref.l.map((p) => permis.densite(p)))) / 10000) : '—'} logements</b> à cette densité sur la parcelle.</p></div>`
      : sel.permis === 'loading' ? '<p class="note">Recherche des opérations récentes de la commune…</p>' : ''}
    <dl class="kv">
      <dt>Recul sur voie</dt><dd>${r.recul !== null ? fmtR('recul', r.recul) + ' ' + src('recul') + condHtml(cit('recul')) : '<span class="note">non trouvé dans le règlement</span>'}</dd>
      <dt>Retrait limites</dt><dd>${r.ret !== null ? fmtR('ret', r.ret) + ' ' + src('ret') + condHtml(cit('ret')) : '<span class="note">non trouvé dans le règlement</span>'}</dd>
      <dt>Stationnement</dt><dd>${r.stat !== null ? `${String(r.stat).replace('.', ',')} place(s) / logement ${src('stat')}${condHtml(cit('stat'))}` : '<span class="note">non trouvé dans le règlement</span>'}</dd>
      <dt>OAP</dt><dd>${pending ? 'Chargement…' : oap.length ? [...new Set(oap.map((x) => x.properties.libelle))].map(esc).join(' · ') : 'Aucune'}</dd>
      <dt>Prescriptions</dt><dd>${pending ? 'Chargement…' : prescF.length ? [...new Set(prescF.map((x) => x.properties.libelle || x.properties.txt).filter(Boolean))].map(esc).join(' · ') : 'Aucune'}</dd>
    </dl>
    ${iaEtat && iaEtat.etat === 'cours' ? `<div class="synth-pot ia-lit" id="iaLit"><b>Lecture du règlement de la zone ${esc(sel.zLabel)} par l'IA…</b><br><span class="note" id="iaLitEtape">${esc(iaEtat.etape || '')}</span></div>` : ''}
    ${iaEtat && iaEtat.etat === 'erreur' ? `<div class="warn">Lecture automatique du règlement impossible : ${esc(iaEtat.message)}. <button type="button" class="ghost" id="iaRelire">Réessayer</button></div>` : ''}
    ${lu && /ia/.test(lu.source || '') ? `<p class="note">Règles lues par l'IA dans le règlement écrit${lu.document ? ` (<a href="${esc(lu.document)}" target="_blank" rel="noopener">PDF</a>)` : ''} : à vérifier avant engagement.${lu.zoneTrouvee === false ? ' Le chapitre de la zone n\'a pas été trouvé avec certitude.' : ''}${lu.remarque ? ' ' + esc(lu.remarque) : ''} <button type="button" class="btn-link" id="iaRelire2">Relire</button></p>` : ''}
    ${lecturePossible && !cleIA() && !lecture.dejaLue(sel.key) ? `<div class="warn plu-box"><b>Le site peut lire le règlement de la zone ${esc(sel.zLabel)} pour vous.</b> Ajoutez votre clé Gemini gratuite pour remplir automatiquement emprise, hauteur, recul, retrait, pleine terre et stationnement. <button type="button" id="iaCleZone">Ajouter ma clé</button></div>` : ''}
    ${!iaEtat && !(lecturePossible && !cleIA() && !lecture.dejaLue(sel.key)) && logementOk !== false && (r.ces === null || r.h === null || r.recul === null || r.ret === null || r.stat === null) ? `<div class="warn plu-box"><b>${lecture.dejaLue(sel.key) ? `Règles de la zone ${esc(sel.zLabel)} non trouvées par l'IA dans le règlement.` : `Règles de la zone ${esc(sel.zLabel)} à lire dans le règlement du PLU.`}</b> ${lecture.dejaLue(sel.key) ? 'Ouvrez le règlement ci-dessous pour les compléter.' : r.ces === null && r.h === null ? "Le PLU de la commune ne publie pas l'emprise ni la hauteur sous forme de données." : 'Recul, retrait et stationnement ne sont publiés que dans le règlement écrit.'} Ouvrez-le ci-dessous, chapitre de la zone ${esc(sel.zLabel)}.</div>` : ''}
    <div class="pieces"><div class="label">Documents du PLU</div><div id="piecesSlot"><div class="actions">
      ${regl ? `<a class="btn-link" href="${esc(regl)}" target="_blank" rel="noopener">Règlement de la zone</a>` : ''}
      <a class="btn-link" href="${api.gpuViewerUrl(lng, lat)}" target="_blank" rel="noopener">Géoportail de l'Urbanisme</a></div>
      <p class="note">Recherche des pièces du PLU…</p></div></div>
    <details class="rules-edit"><summary>Compléter ou corriger les règles de la zone ${esc(sel.zLabel)}</summary><div id="rulesSlot"></div></details>
    ${sel.partition ? `<div class="zones-sec"><div class="label">Toutes les zones du PLU</div><p class="note">Règles de constructibilité de chaque zone du document ${esc(sel.partition)}.</p><div id="zonesSlot"><button type="button" class="ghost" id="loadZones">Afficher le tableau des zones</button></div></div>` : ''}`;
  const lz = $('#loadZones', body); if (lz) lz.onclick = () => renderZones($('#zonesSlot', body), sel.partition, sel.zLabel);
  const slot = $('#rulesSlot', body);
  if (!z && !sel.cc && sel.zLabel === '?') slot.innerHTML = '<p class="note">Zone non déterminée : réessayez pour charger le zonage avant de saisir des règles.</p>';
  else if (constr !== false) slot.appendChild(rulesBlock(sel.key, sel.zLabel, renderFiche));
  else slot.innerHTML = '<p class="note">Zone agricole ou naturelle : pas de potentiel de logement.</p>';
  if (sel.partition) afficherPieces($('#piecesSlot', body), sel.partition, regl, lng, lat);
  // Lecture automatique du règlement écrit par l'IA : une fois par zone, dès qu'une règle manque
  const relire = () => lireReglementSel(true);
  ['#iaRelire', '#iaRelire2'].forEach((id) => { const b = $(id, body); if (b) b.onclick = relire; });
  const kz = $('#iaCleZone', body); if (kz) kz.onclick = () => assistant.ecranCle();
  if (lecturePossible && cleIA() && !lecture.dejaLue(sel.key) && !iaEtat && sel.urba['prescription-surf'] !== 'loading') lireReglementSel(false);
}

/** Règles manquantes pour la parcelle sélectionnée : lecture du règlement par l'IA si la clé est enregistrée. */
function autoLecture() {
  if (!sel || !sel.zone || !sel.partition || sel.iaLecture || !cleIA() || lecture.dejaLue(sel.key)) return;
  if (zoneConstructible(sel.zone) !== true || zoneHorsLogement(sel.zone)) return;
  const fu = fusionRegles(store.getRules(sel.key), sel.graph);
  if (['ces', 'h', 'recul', 'ret', 'pt', 'stat'].some((k) => fu.regles[k] === null)) lireReglementSel(false);
}
const condHtml = (c) => (c && (c.article || c.condition) ? ` <span class="note">${esc([c.article, c.condition].filter(Boolean).join(' · '))}</span>` : '');
/** Lance la lecture du règlement de la zone de la parcelle sélectionnée, puis réaffiche fiche, faisabilité et résumé. */
function lireReglementSel(force) {
  if (!sel || !sel.zone || !sel.partition) return;
  if (!force && lecture.dejaLue(sel.key)) return;
  const s0 = sel, key = sel.key;
  s0.iaLecture = { key, etat: 'cours', etape: '' };
  const maj = (fin) => { if (sel !== s0) return; if (fin && sel.fais) sel.fais = null; if (tab === 'fiche') renderFiche(); else if (tab === 'pot') renderPot(); majPeek(); };
  maj(false);
  lecture.lireZone({
    key, zone: sel.zone, partition: sel.partition, commune: sel.feature.properties.nom_com, force,
    onEtape: (t) => { s0.iaLecture.etape = t; const e = document.getElementById('iaLitEtape'); if (e && sel === s0) e.textContent = t; },
  }).then(({ trouve }) => {
    s0.iaLecture = null;
    toast(trouve ? `Zone ${s0.zLabel} : ${trouve} règle(s) lue(s) dans le règlement` : `Zone ${s0.zLabel} : règles non trouvées dans le règlement`);
    maj(true);
  }).catch((e) => { s0.iaLecture = { key, etat: 'erreur', message: e.message }; maj(false); });
}

// Liens directs vers les pièces du PLU : règlement de la zone, plan de zonage, OAP, archive complète
async function afficherPieces(slot, partition, regl, lng, lat) {
  const token = selToken, zl = sel.zLabel;
  let d = null;
  try { d = await api.piecesPlu(partition); } catch { d = null; }
  if (token !== selToken || !slot.isConnected) return;
  const lien = (url, t, cls = 'btn-link') => `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener">${esc(t)}</a>`;
  const gpuLien = lien(api.gpuViewerUrl(lng, lat), "Voir sur le Géoportail de l'Urbanisme");
  if (!d) { slot.innerHTML = `<div class="actions">${regl ? lien(regl, `Règlement de la zone ${zl}`) : ''}${gpuLien}</div><p class="note">Liste des pièces indisponible pour le moment.</p>`; return; }
  const F = d.fichiers;
  const reglEcrit = F.filter((x) => /r[eè]glement/i.test(x.nom + ' ' + x.rubrique) && !/graphique|prescription|zonage|plan/i.test(x.nom)).sort((a, b) => a.nom.length - b.nom.length)[0];
  const plan = F.filter((x) => /graphique|zonage|plan_?de_?zonage/i.test(x.nom));
  const oap = F.filter((x) => /orientation|oap/i.test(x.nom + ' ' + x.rubrique));
  const urlRegl = regl && !/download-by-partition/.test(regl) ? regl : reglEcrit ? reglEcrit.url : null;
  const rubriques = {};
  F.forEach((x) => { const k = x.rubrique || 'Autres pièces'; (rubriques[k] = rubriques[k] || []).push(x); });
  slot.innerHTML = `
    <div class="actions">
      ${urlRegl ? lien(`${urlRegl}#search=${encodeURIComponent(zl)}`, `Règlement écrit (zone ${zl})`, 'btn-link prim') : ''}
      ${plan.slice(0, 2).map((x) => lien(x.url, plan.length > 1 ? `Plan de zonage : ${x.titre}` : 'Plan de zonage')).join('')}
      ${lien(d.zip, 'Tout le PLU (zip, très volumineux)')}
    </div>
    ${oap.length ? `<div class="actions">${oap.slice(0, 6).map((x) => lien(x.url, `OAP : ${x.titre}`)).join('')}</div>` : ''}
    <p class="note">${esc(d.type || 'PLU')} en vigueur ${esc(d.nom || '')}${d.maj ? `, mis à jour le ${esc(String(d.maj).slice(0, 10))}` : ''}. ${F.length} pièces publiées. ${lien(d.fiche, 'Fiche du document', '')} · ${gpuLien.replace('class="btn-link"', '')}</p>
    ${F.length ? `<details class="rules-edit"><summary>Toutes les pièces du PLU (${F.length})</summary>${Object.entries(rubriques).map(([k, l]) => `<div class="label">${esc(k)}</div><ul class="list">${l.map((x) => `<li>${lien(x.url, x.titre, '')} <span class="note">${esc(x.nom)}</span></li>`).join('')}</ul>`).join('')}</details>` : ''}`;
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
      ${pending ? '<p class="note">Chargement…</p>' : sel.contraintes === null ? '<p class="note">Prescriptions indisponibles pour le moment.</p>' : sel.contraintes.length ? `<ul class="list">${sel.contraintes.map((c) => `<li><span><b>${esc(c.t)}</b> sur ${Math.round(c.part * 100)} % de la parcelle${c.libelle !== c.t ? ` <span class="note">(${esc(c.libelle)})</span>` : ''}</span></li>`).join('')}</ul>` : '<p class="note">Aucun EBC, emplacement réservé, élément protégé ni secteur d\'OAP sur une part significative de la parcelle.</p>'}</div>
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
  body.querySelectorAll('tr[data-vf]').forEach((tr) => (tr.onclick = (ev) => { if (ev.target.closest('a')) return; const g = GV[+tr.dataset.vf]; if (g && g.centre) { map.flyTo({ center: g.centre, zoom: 17 }); voirCarte(); } }));
  body.querySelectorAll('tr[data-pj]').forEach((tr) => (tr.onclick = (ev) => { if (ev.target.closest('a')) return; const p = L[+tr.dataset.pj]; if (p.centre) { map.flyTo({ center: p.centre, zoom: 17 }); voirCarte(); } }));
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
  const refresh = () => { if (token !== selToken) return; if (tab === 'fiche' && ficheTab === 'projets') renderFiche(); else { dessinerPermis(); dessinerVefa(); if (tab === 'fiche' && ficheTab === 'urba') renderFiche(); } };
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
    `Parcelle ${refOf(p)} — ${p.nom_com}`, ...(sel.adresse ? [`Adresse : ${sel.adresse.label}`] : []), `Contenance : ${m2(p.contenance)}`,
    `Zone : ${sel.zLabel} ${sel.zone?.properties.libelong || ''}`,
    `Nature du foncier : ${sel.occ ? sel.occ.label + ' (' + sel.occ.raisons.join(' ; ') + ')' : 'inconnue'}`,
    ...(sel.graph && sel.graph.n ? ['Plan graphique du PLU : ' + Object.values(sel.graph.sources).join(' ; ')] : []),
    ...(rules ? RULE_FIELDS.map((fd) => `- ${fd.label} : ${rules[fd.k] ?? 'non renseigné'}${rules.citations?.[fd.k]?.article ? ' (' + rules.citations[fd.k].article + ', p. ' + rules.citations[fd.k].page + ')' : ''}`) : ['Règles : non saisies']),
    pot && pot.ok ? `Potentiel : emprise ${m2(pot.E)}, SDP ${m2(pot.sdp)}, soit ${pot.real} logements (SDP / ${store.settings().sMoy})` : `Potentiel : ${pot ? pot.raison : 'non calculé'}`,
    s ? `Note de potentiel foncier : ${s.tot}/100${s.partiel ? ' (partielle)' : ''} — ${s.parts.map((x) => `${x.label} ${x.v ?? '-'}/${x.max}`).join(', ')}` : '',
    'Estimation indicative — ne remplace ni un certificat d’urbanisme ni une étude de faisabilité.',
  ].filter(Boolean).join('\n');
}

// ---------- Vue Potentiel ----------
function renderPotSimple(v) {
  if (!sel || !sel.feature || sel.loading) { v.innerHTML = '<p class="empty">Sélectionnez une parcelle sur la carte.</p>'; return; }
  const p = sel.feature.properties, hyp = store.settings();
  const pot = potentielSel();
  map.getSource('env').setData(pot.ok && pot.envFeat ? pot.envFeat : empty);
  if (!pot.ok) {
    v.innerHTML = `<span class="ref">${esc(refOf(p))} · zone ${esc(sel.zLabel)}</span><h2>Potentiel non calculable</h2><p>${esc(pot.raison)}.</p><div id="rulesSlot"></div>`;
    if (zoneConstructible(sel.zone) !== false) $('#rulesSlot', v).appendChild(rulesBlock(sel.key, sel.zLabel, () => { if (sel) sel.fais = null; renderPot(); }));
    return;
  }
  v.innerHTML = `
    <div><span class="ref">${esc(refOf(p))} · zone ${esc(sel.zLabel)} · ${m2(pot.S)}</span><h2 style="font-size:19px;margin-top:2px">Potentiel constructible</h2></div>
    <div class="big">
      <div><strong>${m2(pot.E)}</strong><span>emprise maximale</span></div>
      <div><strong>${m2(pot.sdp)}</strong><span>surface de plancher</span></div>
      <div><strong>${pot.real}</strong><span>logements (SDP ÷ ${hyp.sMoy} m²)</span></div>
    </div>
    ${(() => { const fu = fusionRegles(store.getRules(sel.key), sel.graph); const L = RULE_FIELDS.filter((fd) => fu.origine[fd.k]).map((fd) => { const v = fu.regles[fd.k]; return `${esc(fd.label.replace(/ \(.*\)$/, ''))} ${fd.pct ? Math.round(v * 100) + ' %' : v + ' ' + fd.unit} <span class="pill ${fu.origine[fd.k] === 'plan' ? 'ok' : 'wa'}">${fu.origine[fd.k] === 'plan' ? 'plan graphique' : 'zone'}</span>`; }); return L.length ? `<p class="note">Règles utilisées : ${L.join(' · ')}</p>` : ''; })()}
    <div><div class="label">Plafonds d'emprise — le plus bas s'applique</div>
      <table><tr><th>Plafond</th><th class="n">Surface</th></tr>
      ${pot.caps.map((c) => `<tr class="${c === pot.lim ? 'limit' : ''}"><td>${esc(c.n)}${c === pot.lim ? ' · limitant' : ''}</td><td class="n">${m2(c.v)}</td></tr>`).join('')}</table>
      <p class="note">Enveloppe tracée en orange : retrait de ${f0(pot.r.ret ?? 0)} m sur toutes les limites${pot.r.recul > (pot.r.ret ?? 0) ? `, recul de ${pot.r.recul} m sur voie estimé` : ''}. ${pot.niv} niveau(x) pour ${pot.r.h ?? '?'} m à ${hyp.hEt} m par étage.</p></div>
    <div><div class="label">Scénarios</div><table><tr><th>Scénario</th><th class="n">Niveaux</th><th class="n">SDP</th><th class="n">Logements</th></tr>
      ${pot.sc.map((s) => `<tr><td>${esc(s.n)}</td><td class="n">${s.niv}</td><td class="n">${s.sdp === null ? '—' : m2(s.sdp)}</td><td class="n">${s.lg}</td></tr>`).join('')}</table></div>
    ${sel.occ && sel.occ.stats.sdp ? `<p class="note">Bâti existant ≈ ${m2(sel.occ.stats.sdp)} de plancher, soit ${Math.round((100 * sel.occ.stats.sdp) / Math.max(1, pot.sdp))} % du potentiel : ${sel.occ.stats.sdp > 0.5 * pot.sdp ? 'gain limité.' : 'démolition-reconstruction ou densification à étudier.'}</p>` : ''}
    <div><div class="label">Contraintes</div>${pot.contraintes.length ? `<ul style="margin:0;padding-left:18px">${pot.contraintes.map((c) => `<li>${esc(c.t)}</li>`).join('')}</ul><p class="note">Points de vigilance pour la faisabilité : ils ne réduisent pas le nombre de logements, calculé simplement SDP ÷ ${hyp.sMoy} m².</p>` : '<p class="note">Aucune contrainte détectée automatiquement.</p>'}
      ${pot.missing.length ? `<p class="note">Règles non renseignées : ${pot.missing.map(esc).join(', ')}.</p>` : ''}</div>
    <p class="note">Estimation indicative. Hypothèses modifiables dans Réglages. Ne remplace ni un certificat d'urbanisme ni une étude de faisabilité.</p>`;
}

// ---------- Téléphone : carte plein écran, barre d'onglets en bas, fiche résumée sur la carte ----------
function estMobile() { return window.matchMedia('(max-width: 760px)').matches; }
function modeMobile(m) {
  document.body.dataset.m = m;
  document.querySelectorAll('#mnav [data-m]').forEach((b) => (b.getAttribute('data-m') === m ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (m === 'carte') { setTimeout(() => map.resize(), 50); majPeek(); }
}
function voirCarte() { if (estMobile()) modeMobile('carte'); }
window.tfVoirCarte = voirCarte;
document.querySelectorAll('#mnav [data-m]').forEach((b) => (b.onclick = () => {
  const m = b.dataset.m;
  if (m === 'carte') modeMobile('carte'); else showTab(m);
}));
$('#mLayersBtn').onclick = () => {
  const l = $('#layers'), open = !l.classList.contains('open');
  l.classList.toggle('open', open); $('#mLayersBtn').setAttribute('aria-expanded', String(open));
};
function majPeek() {
  const pk = $('#peek');
  if (!estMobile() || !sel || !sel.feature || document.body.dataset.m !== 'carte') { pk.hidden = true; return; }
  const p = sel.feature.properties;
  if (sel.loading) { pk.hidden = false; pk.innerHTML = `<div class="peek-ref">${esc(refOf(p))}</div><p class="note">Analyse de la parcelle…</p>`; return; }
  const pot = potentielSel(), s = noteSel(pot);
  pk.hidden = false;
  pk.innerHTML = `
    <div class="peek-top">${s ? `<span class="score ${scoreClass(s.tot)}">${s.tot}</span>` : ''}<div><div class="peek-ref">${esc(refOf(p))} · ${esc(sel.zLabel)}</div><div class="note">${esc(sel.adresse ? sel.adresse.label : p.nom_com || '')}</div></div><button type="button" class="ghost peek-x" aria-label="Fermer">×</button></div>
    <div class="peek-kpis"><span><b>${m2(p.contenance)}</b> terrain</span><span><b>${pot && pot.ok ? pot.real : '?'}</b> logements</span><span><b>${esc(sel.occ ? sel.occ.label : '—')}</b></span></div>
    <div class="actions"><button type="button" data-go="fiche">Fiche</button><button type="button" class="ghost" data-go="pot">Faisabilité</button><button type="button" class="ghost" data-go="crm-add">Suivre</button></div>`;
  pk.querySelector('.peek-x').onclick = () => (pk.hidden = true);
  pk.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => {
    if (b.dataset.go === 'crm-add') { const ok = store.addToCrm({ idu: p.idu, ref: refOf(p), commune: p.nom_com, adresse: sel.adresse?.label || '', zone: sel.zLabel, contenance: p.contenance, centre: sel.pt.coordinates, geometry: turf.truncate(sel.feature, { precision: 6 }).geometry, nature: sel.occ?.label || '', note: '', score: s ? s.tot : null }); toast(ok ? 'Ajouté au suivi' : 'Déjà dans le suivi'); return; }
    showTab(b.dataset.go);
  }));
}
if (estMobile()) modeMobile('carte');
window.matchMedia('(max-width: 760px)').addEventListener('change', (e) => { if (e.matches) modeMobile(tab === 'fiche' ? 'carte' : tab); else { delete document.body.dataset.m; $('#peek').hidden = true; setTimeout(() => map.resize(), 50); } });

// ---------- Faisabilité : esquisse, 3D et bilan ----------
const LIGNES = [
  ['Terrain'],
  ['S', 'Surface de la parcelle', 'm²', 'in'],
  ['inc', 'Espaces inconstructibles (EBC, emplacements réservés…)', 'm²', 'in'],
  ['Sc', 'Surface constructible de la parcelle', 'm²', 'out'],
  ['ces', 'Emprise au sol autorisée', '%', 'in'],
  ['empMax', "Surface de l'emprise au sol maximale", 'm²', 'out'],
  ['Implantation (esquisse)'],
  ['a', 'Linéaire de façade exploitable (a)', 'm', 'in'],
  ['b', 'Retrait sur limites séparatives (b)', 'm', 'in'],
  ['c', 'Longueur du bâtiment (c = a − 2b)', 'm', 'out'],
  ['d', 'Profondeur du bâtiment (d)', 'm', 'in'],
  ['recul', 'Recul sur voie', 'm', 'in'],
  ['decal', 'Décalage latéral', 'm', 'range', -30, 30],
  ['avance', 'Avancée vers le fond', 'm', 'range', -10, 40],
  ['rot', 'Rotation', '°', 'range', -45, 45],
  ['empCalc', 'Emprise dessinée', 'm²', 'out'],
  ['emp', "Surface de l'emprise au sol retenue", 'm²', 'out', null, null, true],
  ['Niveaux'],
  ['niv', 'Nombre maximum de niveaux', 'niveaux', 'in'],
  ['NIVEAUX'],
  ['brute', 'Surface brute', 'm²', 'out'],
  ['Surfaces et logements'],
  ['ratioBrut', 'Ratio surface de plancher / surface brute', '%', 'in'],
  ['sdp', 'Surface de plancher', 'm²', 'out', null, null, true],
  ['ratioHab', 'Ratio surface habitable / surface de plancher', '%', 'in'],
  ['shab', 'Surface habitable', 'm²', 'out'],
  ['taille', "Taille moyenne d'un logement (SDP)", 'm²', 'in'],
  ['lgt', 'Nombre de logements', 'logements', 'out', null, null, true],
  ['social', 'Part obligatoire de logements sociaux', '%', 'in'],
  ['seuilSocial', 'Seuil de mixité sociale (SDP)', 'm²', 'in'],
  ['sociaux', 'Dont logements sociaux', 'logements', 'out'],
  ['Stationnement'],
  ['placesLgt', 'Places exigées par logement', 'places', 'in'],
  ['places', 'Nombre de places exigées', 'places', 'out', null, null, true],
  ['placeSurf', "Surface d'une place en surface", 'm²', 'in'],
  ['surfBox', 'Espace libre pour stationner en surface', 'm²', 'out'],
  ['placesSurf', 'Places constructibles en surface', 'places', 'out'],
  ['ptSsol', 'Pleine terre (non constructible en sous-sol)', '%', 'in'],
  ['parNivSsol', 'Surface constructible par niveau de sous-sol', 'm²', 'out'],
  ['placeSsol', "Surface d'une place en sous-sol", 'm²', 'in'],
  ['maxParNiv', 'Places par niveau de sous-sol', 'places', 'out'],
  ['nivSsol', 'Niveaux de sous-sol nécessaires', 'niveaux', 'out', null, null, true],
];
const fmt1 = (x) => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toLocaleString('fr-FR') : '—');

async function initFais(token) {
  const f = sel.feature, p = f.properties, hyp = store.settings();
  sel.fais = { idu: p.idu, chargement: true, vue3d: false };
  let voisines = [], autour = [];
  try {
    const zone = turf.buffer(f, 3, { units: 'meters' });
    const large = turf.bboxPolygon(turf.bbox(turf.buffer(f, 70, { units: 'meters' })));
    [voisines, autour] = await Promise.all([
      api.parcellesAutour(turf.truncate(zone, { precision: 6 }).geometry).catch(() => []),
      api.batiments(turf.truncate(large, { precision: 6 }).geometry).then((x) => x || []),
    ]);
  } catch { /* voisines inconnues : plus long côté */ }
  if (token !== selToken) return;
  voisines = voisines.filter((v) => v.properties.idu !== p.idu && !String(p.idu).includes(v.properties.idu));
  const fac = fais.facade(f, voisines);
  const fu = fusionRegles(store.getRules(sel.key), sel.graph);
  const S = +p.contenance || turf.area(f);
  const inc = (sel.contraintes || []).filter((c) => c.k === 'ebc' || c.k === 'er').reduce((a, c) => a + c.part * S, 0);
  const v = fais.valeursInitiales({ S, regles: fu.regles, hyp, fac, inconstructible: inc });
  const autourFc = autour.filter((b) => !turf.booleanPointInPolygon(turf.pointOnFeature(b), f)).map((b) => ({ type: 'Feature', geometry: b.geometry, properties: { hauteur: +b.properties.hauteur || (+b.properties.nombre_d_etages || 1) * 3 } }));
  sel.fais = { idu: p.idu, fac, v, v0: { ...v }, vue3d: false, autour: autourFc, origine: fu.origine, surRue: fac.surRue };
  renderPot();
}

function dessinerFais() {
  const F = sel.fais, v = F.v, hyp = store.settings();
  const c = Math.max(0, v.a - 2 * v.b);
  const es = fais.esquisse(sel.feature, F.fac, { c, d: v.d, recul: v.recul, decal: v.decal, avance: v.avance, rot: v.rot, ret: v.b });
  F.es = es;
  const pct = v.niveaux && v.niveaux.length ? v.niveaux : fais.niveauxPct(v.niv);
  const h = pct.reduce((a, x) => a + x / 100, 0) * hyp.hEt;
  map.getSource('bat').setData(es.bat ? { type: 'FeatureCollection', features: [{ ...es.bat, properties: { hauteur: Math.max(3, h) } }] } : empty);
  map.getSource('bati3d').setData({ type: 'FeatureCollection', features: F.autour || [] });
  map.getSource('env').setData(es.env && v.b > 0 ? es.env : empty);
  return es.emprise;
}

function majFais(root) {
  const F = sel.fais; if (!F || !F.v) return;
  const emprise = dessinerFais();
  const B = fais.bilan(F.v, emprise);
  root.querySelectorAll('[data-out]').forEach((el) => { const k = el.dataset.out; el.textContent = k === 'c' ? fmt1(B.c) : f0(B[k]); });
  root.querySelectorAll('[data-pct]').forEach((el) => { const i = +el.dataset.pct; el.textContent = `soit ${f0((B.emp * (B.pct[i] || 0)) / 100)} m²`; });
  root.querySelectorAll('[data-rv]').forEach((el) => { el.textContent = `${F.v[el.dataset.rv]}`; });
  const kp = $('#faisKpis', root);
  if (kp) kp.innerHTML = `<div><span>Emprise</span><strong>${m2(B.emp)}</strong></div><div><span>Surface de plancher</span><strong>${m2(B.sdp)}</strong></div><div><span>Logements</span><strong>${B.lgt}</strong></div><div><span>Places</span><strong>${B.places}</strong></div>`;
  F.B = B;
}

function vue3d(on) {
  const F = sel.fais; F.vue3d = on;
  if (on) voirCarte();
  vis('bat-3d', on); vis('bati3d', on); vis('bat-fill', !on);
  const c = turf.centroid(sel.feature).geometry.coordinates;
  map.easeTo(on ? { center: c, zoom: Math.max(map.getZoom(), 18), pitch: 60, bearing: (F.fac.cap + 200) % 360, duration: 900 } : { pitch: 0, bearing: 0, duration: 700 });
}

function renderPot() {
  const v = $('#v-pot');
  if (!sel || !sel.feature || sel.loading) { v.innerHTML = '<p class="empty">Sélectionnez une parcelle sur la carte : la faisabilité se calcule et le bâtiment se dessine ici.</p>'; return; }
  const p = sel.feature.properties;
  if (zoneConstructible(sel.zone) === false) { v.innerHTML = `<h2>Faisabilité</h2><p class="empty">Zone ${esc(sel.zLabel)} agricole ou naturelle : pas de logement possible.</p>`; return; }
  if (!sel.fais || sel.fais.idu !== p.idu) { initFais(selToken); v.innerHTML = '<p class="note">Recherche de la façade sur rue et des bâtiments voisins…</p>'; return; }
  if (!sel.fais.v) { v.innerHTML = '<p class="note">Recherche de la façade sur rue et des bâtiments voisins…</p>'; return; }
  const F = sel.fais, val = F.v, pct = val.niveaux && val.niveaux.length ? val.niveaux : fais.niveauxPct(val.niv);
  const orig = (k) => ({ ces: 'ces', niv: 'h', b: 'ret', recul: 'recul', placesLgt: 'stat', ptSsol: 'pt' }[k]);
  const pillO = (k) => { const o = F.origine[orig(k)]; return o === 'plan' ? '<span class="pill ok">PLU</span>' : o === 'zone' ? '<span class="pill wa">vos règles</span>' : ''; };
  const ligne = ([k, label, unit, type, min, max, fort]) => {
    if (!label) {
      if (k === 'NIVEAUX') return pct.map((x, i) => `<tr><td class="ind">Niveau ${i + 1}${i === 0 ? ' (rez-de-chaussée)' : ''}</td><td><input type="number" step="5" min="0" max="100" data-niv="${i}" value="${x}"> %</td><td class="n" data-pct="${i}"></td></tr>`).join('');
      return `<tr class="sec"><th colspan="3">${esc(k)}</th></tr>`;
    }
    if (type === 'in') return `<tr><td>${esc(label)} ${pillO(k)}</td><td><input type="number" step="any" data-k="${k}" value="${val[k]}"> ${esc(unit)}</td><td class="n"></td></tr>`;
    if (type === 'range') return `<tr><td>${esc(label)}</td><td class="rg"><input type="range" min="${min}" max="${max}" step="0.5" data-k="${k}" value="${val[k]}"> <span data-rv="${k}">${val[k]}</span> ${esc(unit)}</td><td class="n"></td></tr>`;
    return `<tr class="${fort ? 'fort' : ''}"><td>${esc(label)}</td><td></td><td class="n"><b data-out="${k}"></b> ${esc(unit)}</td></tr>`;
  };
  v.innerHTML = `
    <div class="fiche-head"><div><span class="ref">${esc(refOf(p))} · zone ${esc(sel.zLabel)}</span><h2>Faisabilité</h2></div>
      <div class="actions"><button type="button" id="fais3d">${F.vue3d ? 'Vue 2D' : 'Voir en 3D'}</button><button type="button" class="ghost" id="faisReset">Réinitialiser</button></div></div>
    <div class="kpis" id="faisKpis"></div>
    ${sel.iaLecture && sel.iaLecture.etat === 'cours' ? `<p class="synth-pot"><b>Lecture du règlement de la zone ${esc(sel.zLabel)} par l'IA…</b> Les valeurs se mettront à jour.</p>` : ''}
    <p class="note">Le bâtiment est dessiné en jaune sur la carte, à partir de la façade ${F.surRue ? 'sur rue' : '(la plus longue, rue non détectée)'} de ${fmt1(F.fac.a)} m. Faites-le glisser sur la carte pour le déplacer, ou modifiez les valeurs ci-dessous : tout se recalcule. Les valeurs marquées <span class="pill ok">PLU</span> viennent du PLU de la commune.</p>
    <div class="tw"><table class="fais-table"><tbody>${LIGNES.map(ligne).join('')}</tbody></table></div>
    <details class="rules-edit"><summary>Calcul réglementaire simplifié et règles de la zone</summary><div id="potSimple"></div></details>
    <p class="note">Esquisse indicative : à confirmer avec le règlement complet (implantation, prospects, stationnement) et un architecte.</p>`;
  const root = v;
  root.querySelectorAll('input[data-k]').forEach((i) => i.addEventListener('input', () => {
    const x = parseFloat(i.value); if (!Number.isFinite(x)) return;
    F.v[i.dataset.k] = x;
    if (i.dataset.k === 'niv') { F.v.niveaux = null; renderPot(); return; }
    majFais(root);
  }));
  root.querySelectorAll('input[data-niv]').forEach((i) => i.addEventListener('input', () => {
    const l = (F.v.niveaux && F.v.niveaux.length ? F.v.niveaux : fais.niveauxPct(F.v.niv)).slice();
    l[+i.dataset.niv] = parseFloat(i.value) || 0; F.v.niveaux = l; majFais(root);
  }));
  $('#fais3d', v).onclick = () => { vue3d(!F.vue3d); $('#fais3d', v).textContent = F.vue3d ? 'Vue 2D' : 'Voir en 3D'; };
  $('#faisReset', v).onclick = () => { F.v = { ...F.v0 }; renderPot(); };
  renderPotSimple($('#potSimple', v));
  majFais(root);
}
// Glisser l'esquisse sur la carte : le déplacement est converti en décalage latéral et en avancée
let dragBat = null;
map.on('mousedown', 'bat-fill', (e) => {
  if (!sel || !sel.fais || !sel.fais.v) return;
  e.preventDefault(); map.dragPan.disable();
  dragBat = { start: [e.lngLat.lng, e.lngLat.lat], decal: sel.fais.v.decal, avance: sel.fais.v.avance };
  map.getCanvas().style.cursor = 'grabbing';
});
map.on('mousemove', (e) => {
  if (!dragBat || !sel || !sel.fais) return;
  const F = sel.fais, cur = [e.lngLat.lng, e.lngLat.lat];
  const dist = turf.distance(dragBat.start, cur, { units: 'meters' }), cap = turf.bearing(dragBat.start, cur);
  const ang = ((cap - F.fac.cap) * Math.PI) / 180;
  const mid = turf.midpoint(F.fac.p1, F.fac.p2), dedans = turf.booleanPointInPolygon(turf.destination(mid, 2, F.fac.cap + 90, { units: 'meters' }), sel.feature) ? 1 : -1;
  F.v.decal = Math.round((dragBat.decal + dist * Math.cos(ang)) * 2) / 2;
  F.v.avance = Math.round((dragBat.avance + dedans * dist * Math.sin(ang)) * 2) / 2;
  const root = $('#v-pot');
  ['decal', 'avance'].forEach((k) => { const i = root.querySelector(`input[data-k="${k}"]`); if (i) i.value = F.v[k]; });
  majFais(root);
});
map.on('mouseup', () => { if (dragBat) { dragBat = null; map.dragPan.enable(); map.getCanvas().style.cursor = ''; } });
map.on('mouseenter', 'bat-fill', () => { if (!dragBat) map.getCanvas().style.cursor = 'grab'; });
map.on('mouseleave', 'bat-fill', () => { if (!dragBat) map.getCanvas().style.cursor = ''; });

// ---------- Prospection ----------
const pro = initProspection({
  map, setHits, selectFeature, rulesBlock, toast, download, esc, f0, m2, refOf, zoneConstructible, zoneHorsLogement,
  onResults: () => { if (!wide && window.innerWidth > 1100) $('#btnWide').click(); },
});

// ---------- Tableau de bord et suivi ----------
function letter(item) {
  return `Madame, Monsieur,

Nous nous permettons de vous contacter au sujet de votre terrain situé ${item.adresse ? item.adresse.split(' / ')[0] + ', ' : 'sur la commune de ' + item.commune + ', '}cadastré section ${item.ref.split(' ')[1]} n° ${item.ref.split(' ')[2]}, d'une contenance de ${f0(item.contenance)} m².

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
    ${dues.length ? `<div><div class="label">Relances à faire</div><ul class="list">${dues.map((x) => `<li><span><b>${esc(x.ref)}</b> · ${esc(x.commune)} · prévue le ${new Date(x.relance).toLocaleDateString('fr-FR')}</span></li>`).join('')}</ul></div>` : ''}
    <div><div class="label">Dernières prospections</div>${hist.length ? `<div class="tw"><table><tr><th>Date</th><th>Commune</th><th class="n">Parcelles</th><th class="n">Retenues</th><th>Meilleur terrain</th></tr>
      ${hist.slice(0, 8).map((h) => `<tr><td>${new Date(h.date).toLocaleDateString('fr-FR')}</td><td>${esc(h.commune)}</td><td class="n">${f0(h.total)}</td><td class="n">${f0(h.retenus)}</td><td>${h.top && h.top[0] ? `${esc(h.top[0].ref)} <span class="score ${scoreClass(h.top[0].score)}">${h.top[0].score}</span>` : '—'}</td></tr>`).join('')}</table></div>` : '<p class="note">Aucune prospection lancée pour l\'instant.</p>'}</div>
    <div><div class="label">Opportunités</div>${list.length ? '' : '<p class="empty">Aucune opportunité. Ajoutez-en depuis une fiche parcelle.</p>'}
    <div class="crm">${list.map((x, i) => `<div class="row">
      <span><b>${esc(x.ref)}</b>${x.adresse ? ` · ${esc(x.adresse.split(' / ')[0])}` : ''} · ${esc(x.commune)} · ${esc(x.zone)} · ${m2(x.contenance)}${x.nature ? ` · ${esc(x.nature)}` : ''}${x.score !== null && x.score !== undefined ? ` <span class="score ${scoreClass(x.score)}">${x.score}</span>` : ''}${x.relance && x.relance <= today ? ' <span class="pill wa">relance due</span>' : ''}</span>
      <select id="c-st-${i}" data-i="${i}" data-f="statut" aria-label="Statut">${store.STATUTS.map((s, j) => `<option value="${j}" ${j === x.statut ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label class="full note" for="c-rel-${i}">Prochaine relance <input type="date" id="c-rel-${i}" data-i="${i}" data-f="relance" value="${esc(x.relance)}"></label>
      <textarea class="full" id="c-note-${i}" data-i="${i}" data-f="note" rows="2" placeholder="Notes : propriétaire, échanges, prix évoqué…">${esc(x.note)}</textarea>
      <div class="full actions"><button type="button" class="ghost" data-go="${i}">Voir</button><button type="button" class="ghost" data-letter="${i}">Préparer un courrier</button><button type="button" class="ghost" data-del="${i}">Retirer</button></div>
    </div>`).join('')}</div></div>
    ${list.length ? '<div class="actions"><button type="button" class="ghost" id="crmCsv">Exporter CSV</button><button type="button" class="ghost" id="crmGeo">Exporter GeoJSON</button></div>' : ''}
    <div class="backup"><div class="label">Sauvegarde de vos données</div>
      <p class="note">Le suivi, les règles saisies et les réglages sont enregistrés dans ce navigateur. Sauvegardez-les pour les retrouver sur un autre ordinateur ou à une nouvelle adresse du site.</p>
      <div class="actions"><button type="button" class="ghost" id="bkSave">Sauvegarder mes données</button><button type="button" class="ghost" id="bkLoad">Restaurer une sauvegarde</button><input type="file" id="bkFile" accept="application/json,.json" hidden></div></div>
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
  $('#bkSave', v).onclick = () => download(`fonciscope-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(store.sauvegarde()), 'application/json');
  $('#bkLoad', v).onclick = () => $('#bkFile', v).click();
  $('#bkFile', v).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = store.restaurer(JSON.parse(await f.text())); toast(`Sauvegarde restaurée : ${r.suivi} terrain(s) suivi(s), règles de ${r.regles} zone(s)`); renderCrm(); }
    catch (err) { toast(err.message || 'Fichier illisible'); }
  };
  const csv = $('#crmCsv', v); if (csv) csv.onclick = () => {
    const head = 'reference;idu;adresse;commune;zone;contenance_m2;nature;note_potentiel;statut;prochaine_relance;notes';
    const rows = list.map((x) => [x.ref, x.idu, `"${(x.adresse || '').replace(/"/g, "'")}"`, x.commune, x.zone, x.contenance, x.nature || '', x.score ?? '', store.STATUTS[x.statut], x.relance, `"${(x.note || '').replace(/"/g, '""')}"`].join(';'));
    download('suivi-foncier.csv', '﻿' + [head, ...rows].join('\n'), 'text/csv;charset=utf-8');
  };
  const geo = $('#crmGeo', v); if (geo) geo.onclick = () => download('suivi-foncier.geojson', JSON.stringify({ type: 'FeatureCollection', features: list.map((x) => ({ type: 'Feature', geometry: x.geometry, properties: { ...x, geometry: undefined, statut: store.STATUTS[x.statut] } })) }), 'application/geo+json');
}

/** Commune choisie : toutes les zones d'habitat de son PLU sont lues d'un coup par l'IA (si la clé est enregistrée). */
async function lireCommune(com) {
  if (!cleIA()) return;
  let partition = null, libs = null;
  try { const z = await pro.zonesListe(com.code); partition = z.document_urbanisme; libs = z.zones.filter((x) => x.logement_autorise).map((x) => x.code); } catch { partition = null; }
  if (!partition || !libs || !libs.length) return;
  try {
    const r = await lecture.lireDocument({ partition, libs, commune: com.nom, onEtape: (t) => toast(`${com.nom} : ${t}`) });
    if (r.lues) toast(`${com.nom} : règles lues pour ${r.avecRegles} zone(s) sur ${r.lues}${r.restantes ? `, ${r.restantes} restante(s)` : ''}`);
    if (sel && sel.partition === partition) { if (tab === 'fiche') renderFiche(); else if (tab === 'pot') renderPot(); majPeek(); }
  } catch (e) { toast(`${com.nom} : lecture du règlement impossible (${e.message})`); }
}
window.tfLireCommune = lireCommune;

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
  if (s.kind === 'commune') { pro.setCommune(s.data); map.flyTo({ center: s.data.centre.coordinates, zoom: 14 }); toast(`${s.data.nom} : touchez une parcelle, ou lancez une prospection`); lireCommune(s.data); }
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
  store.saveSettings({ backend: $('#set-backend').value.trim(), hEt: +$('#set-het').value || 3, k: +$('#set-k').value || 0.8, sMoy: +$('#set-smoy').value || 60, ratio60: true, sLot: +$('#set-lot').value || 400 });
  toast('Réglages enregistrés'); showTab(tab);
});

// Légende des notes
$('#legend').innerHTML = `<b>Note</b>${['0-19', '20-39', '40-59', '60-79', '80-100'].map((t, i) => `<span><i style="background:${SCORE_COLORS[i]}"></i>${t}</span>`).join('')}`;

// ---------- Assistant IA : actions du site qu'il peut lancer ----------
const attendre = async (cond, ms = 25000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await new Promise((ok) => setTimeout(ok, 300)); } return true; };
const arrondi = (x, n = 0) => (Number.isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : null);
const selPrete = () => sel && sel.feature && !sel.loading && sel.urba && sel.urba['zone-urba'] !== 'loading' && sel.urba['prescription-surf'] !== 'loading';

/** Trouve et sélectionne la parcelle demandée (référence, rang dans la prospection, adresse), sinon garde la parcelle sélectionnée. */
async function iaParcelle(a, vue) {
  if (a.rang) {
    const h = pro.terrain(+a.rang);
    if (!h) throw new Error(pro.results ? `Pas de terrain n° ${a.rang} dans la dernière prospection` : 'Aucune prospection lancée');
    map.fitBounds(turf.bbox(h.f), { padding: 80, maxZoom: 18 });
    selectFeature(h.f, undefined, vue);
  } else if (a.reference) {
    const m = String(a.reference).toUpperCase().match(/(?:(\d[\dAB]\d{3})\s*)?([A-Z0-9]{1,2})\s*0*(\d{1,4})\b/);
    if (!m) throw new Error(`Référence cadastrale illisible : ${a.reference}`);
    let insee = m[1];
    if (!insee && a.commune) { const c = String(a.commune).match(/\b\d[\dAB]\d{3}\b/); insee = c ? c[0] : (await api.searchCommunes(a.commune))[0]?.code; }
    if (!insee && sel && sel.feature) insee = sel.feature.properties.code_insee;
    if (!insee && pro.results) insee = pro.results.com.code;
    if (!insee) throw new Error('Indiquez la commune de la parcelle');
    const f = await api.parcelleByRef(insee, m[2].padStart(2, '0'), m[3]);
    if (!f) throw new Error(`Parcelle ${insee} ${m[2]} ${m[3]} introuvable au cadastre`);
    map.fitBounds(turf.bbox(f), { padding: 80, maxZoom: 18 });
    selectFeature(f, undefined, vue);
  } else if (a.adresse) {
    const r = (await api.searchAddress(a.adresse))[0];
    if (!r) throw new Error(`Adresse introuvable : ${a.adresse}`);
    const [lng, lat] = r.geometry.coordinates;
    map.flyTo({ center: [lng, lat], zoom: 18 });
    await selectAt(lng, lat);
    if (vue) showTab(vue);
  } else if (!sel || !sel.feature) throw new Error("Aucune parcelle sélectionnée : donnez une référence, un rang de la prospection ou une adresse");
  else if (vue) showTab(vue);
  await new Promise((ok) => setTimeout(ok, 50));
  await attendre(selPrete);
  if (!sel || !sel.feature) throw new Error((sel && sel.error) || 'Parcelle introuvable à cet endroit');
  // lecture du règlement de la zone en cours : on attend ses règles (2 min 30 au plus)
  await attendre(() => !sel.iaLecture || sel.iaLecture.etat !== 'cours', 150000);
}

/** Résumé de la parcelle sélectionnée : uniquement des données publiques et des calculs du site. */
function iaResume() {
  const p = sel.feature.properties, fu = fusionRegles(store.getRules(sel.key), sel.graph), pot = potentielSel(), s = noteSel(pot);
  const regles = {};
  RULE_FIELDS.forEach((x) => { const v = fu.regles[x.k]; if (v !== null && v !== undefined) regles[x.label] = { valeur: x.pct ? arrondi(v * 100, 1) : v, source: fu.origine[x.k] === 'plan' ? 'plan graphique du PLU' : 'règles saisies pour la zone' }; });
  return {
    reference: refOf(p), commune: p.nom_com, adresse: sel.adresse?.label || p.adresse || null, surface_m2: +p.contenance,
    zone: sel.zLabel, zone_libelle: sel.zone?.properties.libelong || null, logement_autorise: zoneConstructible(sel.zone) === true && !zoneHorsLogement(sel.zone),
    regles_connues: regles, regles_manquantes: RULE_FIELDS.filter((x) => fu.regles[x.k] === null || fu.regles[x.k] === undefined).map((x) => x.label),
    potentiel: pot && pot.ok ? { niveaux: pot.niv, emprise_max_m2: arrondi(pot.E), surface_plancher_m2: arrondi(pot.sdp), logements: pot.real } : { indisponible: pot ? pot.raison : 'règles manquantes' },
    note_sur_100: s ? s.tot : null, occupation: sel.occ?.label || null,
    bati_existant: sel.bati ? { batiments: sel.bati.n, emprise_m2: arrondi(sel.bati.emprise), hauteur_max_m: sel.bati.hmax } : null,
    contraintes: (sel.contraintes || []).map((x) => x.t), document_urbanisme: sel.partition,
  };
}

const IA_FAIS = { niveaux: 'niv', emprise_pct: 'ces', profondeur_m: 'd', surface_logement_m2: 'taille', retrait_m: 'b', recul_m: 'recul', places_par_logement: 'placesLgt', logements_sociaux_pct: 'social' };
const iaActions = {
  zones_commune: (a) => pro.zonesListe(a.commune),
  lancer_prospection: async (a) => { showTab('pro'); return pro.lancer(a); },
  resultats_prospection: async (a) => {
    const r = pro.syntheseResultats(0); if (!r) throw new Error('Aucune prospection lancée');
    const d = Math.max(1, +a.depuis || 1), n = Math.min(30, +a.nombre || 10);
    return { ...r, terrains: pro.terrains().slice(d - 1, d - 1 + n).map((h, i) => pro.terrainResume(h, d + i)) };
  },
  infos_parcelle: async (a) => { await iaParcelle(a, 'fiche'); return iaResume(); },
  faisabilite: async (a) => {
    await iaParcelle(a, null);
    if (zoneConstructible(sel.zone) === false) throw new Error(`Zone ${sel.zLabel} agricole ou naturelle : pas de logement possible`);
    showTab('pot');
    const idu = sel.feature.properties.idu;
    if (!(await attendre(() => sel && sel.fais && sel.fais.v && sel.fais.idu === idu))) throw new Error('Faisabilité non calculée (cadastre voisin ou bâtiments indisponibles), réessayez');
    const F = sel.fais;
    for (const [k, c] of Object.entries(IA_FAIS)) if (a[k] !== undefined && a[k] !== null && Number.isFinite(+a[k])) { F.v[c] = +a[k]; if (c === 'niv') F.v.niveaux = null; }
    renderPot();
    if (a.vue_3d && !F.vue3d) vue3d(true);
    const B = F.B || fais.bilan(F.v, F.es ? F.es.emprise : null);
    const plu = { ces: 'emprise au sol', niv: 'hauteur (niveaux)', b: 'retrait', recul: 'recul', placesLgt: 'stationnement', ptSsol: 'pleine terre' };
    const orig = { ces: 'ces', niv: 'h', b: 'ret', recul: 'recul', placesLgt: 'stat', ptSsol: 'pt' };
    return {
      ...iaResume(),
      facade_m: arrondi(F.v.a, 1), facade_sur_rue_detectee: F.surRue,
      hypotheses: { emprise_max_pct: F.v.ces, niveaux: F.v.niv, profondeur_m: F.v.d, retrait_m: F.v.b, recul_m: F.v.recul, m2_sdp_par_logement: F.v.taille, ratio_sdp_sur_brute_pct: F.v.ratioBrut, places_par_logement: F.v.placesLgt, pleine_terre_pct: F.v.ptSsol },
      valeurs_issues_du_plu: Object.keys(plu).filter((k) => F.origine[orig[k]] === 'plan').map((k) => plu[k]),
      valeurs_issues_des_regles_saisies: Object.keys(plu).filter((k) => F.origine[orig[k]] === 'zone').map((k) => plu[k]),
      bilan: { emprise_m2: arrondi(B.emp), emprise_max_autorisee_m2: arrondi(B.empMax), surface_brute_m2: arrondi(B.brute), surface_plancher_m2: arrondi(B.sdp), surface_habitable_m2: arrondi(B.shab), logements: B.lgt, logements_sociaux: B.sociaux, places_necessaires: B.places, places_en_surface: B.placesSurf, niveaux_sous_sol: B.nivSsol },
    };
  },
  ajouter_suivi: async (a) => {
    const r = pro.results; let cibles = [];
    if (a.meilleurs) cibles = pro.terrains().slice(0, Math.min(50, +a.meilleurs));
    if (Array.isArray(a.rangs)) cibles.push(...a.rangs.map((n) => pro.terrain(+n)).filter(Boolean));
    let ajoutes = 0, deja = 0;
    for (const h of new Set(cibles)) {
      const p = h.f.properties;
      if (store.addToCrm({ idu: p.idu, ref: refOf(p), commune: r ? r.com.nom : p.nom_com || '', adresse: p.adresse || h.adresse || '', zone: h.zone.properties.libelle, contenance: Math.round(h.occ.S), centre: turf.pointOnFeature(h.f).geometry.coordinates, geometry: turf.truncate(h.f, { precision: 6 }).geometry, nature: h.occ.label, note: '', score: h.s.tot })) ajoutes++; else deja++;
    }
    if (a.parcelle_selectionnee || (!cibles.length && !a.meilleurs && !a.rangs)) {
      if (!sel || !sel.feature) throw new Error('Aucune parcelle sélectionnée');
      const p = sel.feature.properties, pot = potentielSel(), s = noteSel(pot);
      if (store.addToCrm({ idu: p.idu, ref: refOf(p), commune: p.nom_com, adresse: sel.adresse?.label || p.adresse || '', zone: sel.zLabel, contenance: p.contenance, centre: sel.pt.coordinates, geometry: turf.truncate(sel.feature, { precision: 6 }).geometry, nature: sel.occ?.label || '', note: '', score: s ? s.tot : null })) ajoutes++; else deja++;
    }
    if (tab === 'crm') renderCrm();
    return { ajoutes, deja_suivis: deja, total_suivi: store.crmList().length };
  },
  afficher: async (a) => {
    const v = { parcelle: 'fiche', faisabilite: 'pot', prospection: 'pro', suivi: 'crm', '3d': 'pot' }[a.vue];
    if (a.vue === 'carte') { voirCarte(); return { ok: true }; }
    if (!v) throw new Error('Vue inconnue');
    showTab(v);
    if (a.vue === '3d') {
      if (!sel || !sel.feature) throw new Error('Aucune parcelle sélectionnée');
      const idu = sel.feature.properties.idu;
      await attendre(() => sel && sel.fais && sel.fais.v && sel.fais.idu === idu);
      if (sel.fais && sel.fais.v && !sel.fais.vue3d) { vue3d(true); renderPot(); }
    }
    return { ok: true };
  },
};
const assistant = initAssistant({
  toast, actions: iaActions, statut: () => pro.statut(),
  contexte: () => {
    const l = [`vue ${({ fiche: 'fiche parcelle', pot: 'faisabilité', pro: 'prospection', crm: 'suivi' })[tab]}`];
    l.push(sel && sel.feature ? `parcelle sélectionnée ${refOf(sel.feature.properties)} (${sel.feature.properties.nom_com || ''}, zone ${sel.zLabel || '?'})` : 'aucune parcelle sélectionnée');
    const r = pro.results;
    l.push(r ? `dernière prospection : ${r.com.nom}, ${pro.terrains().length} terrains pour du logement` : 'aucune prospection lancée');
    if (pro.running) l.push('une prospection est en cours');
    return l.join(' ; ');
  },
});
window.tfAssistant = assistant;

showTab('fiche', { garderMode: true });
if (estMobile()) modeMobile('carte');

// Diagnostic (console du navigateur) : état courant de l'application
window.tfDebug = () => ({ tab, ficheTab, selToken, sel, pro });
