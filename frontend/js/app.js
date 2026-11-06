/* global maplibregl, turf */
import * as api from './api.js';
import { computePotentiel, RULE_FIELDS } from './potentiel.js';
import * as store from './store.js';
import { grille, analyser } from './occupation.js';
import { noter, contraintesDe, compacite } from './score.js';
import { initProspection, CRIT_DEFAUT } from './prospection.js';

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
      cadastre: { type: 'raster', tiles: [wmts('CADASTRALPARCELS.PARCELLAIRE_EXPRESS', 'PCI vecteur', 'image/png')], tileSize: 256, maxzoom: 19, attribution: 'Cadastre © DGFiP / IGN' },
      zonage: { type: 'raster', tiles: [wms('du')], tileSize: 256, attribution: "Géoportail de l'Urbanisme" },
      presc: { type: 'raster', tiles: [wms('prescription,info')], tileSize: 256 },
      sel: { type: 'geojson', data: empty },
      env: { type: 'geojson', data: empty },
      hits: { type: 'geojson', data: empty },
      bati: { type: 'geojson', data: empty },
    },
    layers: [
      { id: 'plan', type: 'raster', source: 'plan' },
      { id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } },
      { id: 'zonage', type: 'raster', source: 'zonage', minzoom: 11, paint: { 'raster-opacity': 0.45 } },
      { id: 'presc', type: 'raster', source: 'presc', minzoom: 13, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } },
      { id: 'cadastre', type: 'raster', source: 'cadastre', minzoom: 15 },
      { id: 'hits-fill', type: 'fill', source: 'hits', paint: { 'fill-color': ['step', ['get', 'score'], SCORE_COLORS[0], 20, SCORE_COLORS[1], 40, SCORE_COLORS[2], 60, SCORE_COLORS[3], 80, SCORE_COLORS[4]], 'fill-opacity': 0.6 } },
      { id: 'hits-line', type: 'line', source: 'hits', paint: { 'line-color': '#18222d', 'line-width': 0.8, 'line-opacity': 0.6 } },
      { id: 'bati-fill', type: 'fill', source: 'bati', paint: { 'fill-color': '#7a4ec9', 'fill-opacity': 0.35 } },
      { id: 'sel-fill', type: 'fill', source: 'sel', paint: { 'fill-color': '#2347c5', 'fill-opacity': 0.12 } },
      { id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#2347c5', 'line-width': 3 } },
      { id: 'env-line', type: 'line', source: 'env', paint: { 'line-color': '#e0661b', 'line-width': 2, 'line-dasharray': [2, 1.5] } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
map.on('click', (e) => selectAt(e.lngLat.lng, e.lngLat.lat));

// Infobulle au survol des terrains de la prospection
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, className: 'tf-pop' });
map.on('mousemove', 'hits-fill', (e) => {
  map.getCanvas().style.cursor = 'pointer';
  const p = e.features[0].properties;
  popup.setLngLat(e.lngLat).setHTML(`<b>${esc(p.ref)}</b> · ${esc(p.zone)}<br>${esc(p.nature)} · ${m2(+p.surface)}<br>Note <b>${p.score}</b>/100${p.partiel === 'true' || p.partiel === true ? ' (partielle)' : ''}`).addTo(map);
});
map.on('mouseleave', 'hits-fill', () => { map.getCanvas().style.cursor = ''; popup.remove(); });

const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
document.querySelectorAll('input[name=fond]').forEach((r) => r.addEventListener('change', () => { vis('plan', r.value === 'plan' && r.checked); vis('ortho', r.value === 'ortho' && r.checked); }));
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

async function selectFeature(f, token = ++selToken, forceTab) {
  sel = { feature: f, loading: true };
  map.getSource('sel').setData(f);
  map.getSource('env').setData(empty);
  map.getSource('bati').setData(empty);
  if (forceTab) showTab(forceTab);
  else if (tab !== 'pot' && tab !== 'pro' && tab !== 'crm') showTab('fiche');
  const pt = turf.pointOnFeature(f).geometry;
  const simple = turf.truncate(turf.simplify(f, { tolerance: 0.000005, highQuality: true }), { precision: 6 }).geometry;
  const insee = f.properties.code_insee;
  // Affichage progressif : la fiche apparaît dès que la zone et le bâti sont connus ;
  // document, prescriptions, servitudes, risques, parkings, équipements et friches complètent ensuite.
  const extraP = api.urbanismeAt(pt, api.EXTRA_LAYERS, { retries: 1, timeout: 15000 });
  const occAtP = api.occupationAt(simple);
  const frP = api.friches(insee);
  const risqP = api.risques(pt.coordinates[0], pt.coordinates[1]);
  let urba, bati;
  try {
    [urba, bati] = await Promise.all([api.urbanismeAt(pt, api.CORE_LAYERS, { retries: 1, timeout: 12000 }), api.batiments(simple)]);
  } catch (e) { if (token === selToken) { sel = { error: e.message }; renderFiche(); } return; }
  if (token !== selToken) return;
  api.EXTRA_LAYERS.forEach((l) => (urba[l] = 'loading'));
  const zone = (urba['zone-urba'] || [])[0] || null;
  const cc = (urba['secteur-cc'] || [])[0] || null;
  const partition = zone?.properties.partition || cc?.properties.partition || null;
  const zLabel = zone?.properties.libelle || cc?.properties.libelle || (urba['zone-urba'] === null ? '?' : 'RNU');
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
    occ, risques: undefined, pt, friches: undefined, occAtOk: false, occComplet: false, contraintes: null, commune: null,
  };
  const rerender = () => { if (token !== selToken) return; if (tab === 'fiche') renderFiche(); else if (tab === 'pot') renderPot(); };
  extraP.then((x) => {
    if (token !== selToken) return;
    Object.assign(sel.urba, x);
    sel.doc = (x.document || [])[0] || null;
    if (!sel.partition && sel.doc) { sel.partition = sel.doc.properties.partition; sel.key = store.ruleKey(sel.partition, sel.zLabel); }
    const ps = Array.isArray(x['prescription-surf']) ? x['prescription-surf'] : null;
    sel.contraintes = ps ? contraintesDe(f, grille(ps.filter((p) => p.geometry)), occ ? occ.S : +f.properties.contenance) : null;
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
const FICHE_TABS = [['synthese', 'Synthèse'], ['urba', 'Urbanisme'], ['bati', 'Bâti et occupation'], ['contraintes', 'Contraintes'], ['commune', 'Commune']];

function potentielSel() {
  if (!sel || !sel.feature) return null;
  const rules = store.getRules(sel.key) || {};
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
      <div class="actions"><button type="button" class="ghost" id="addCrm">Ajouter au suivi</button><button type="button" class="ghost" id="copyFiche">Copier la fiche</button></div>
    </div>
    ${sel.urba['zone-urba'] === null ? `<div class="warn">Le Géoportail de l'Urbanisme (IGN) ne répond pas pour le moment : zonage et règles indisponibles. Les autres informations restent valables. <button type="button" class="ghost" id="retryGpu">Réessayer</button></div>` : ''}
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
  ({ synthese: ficheSynthese, urba: ficheUrba, bati: ficheBati, contraintes: ficheContraintes, commune: ficheCommune }[ficheTab] || ficheSynthese)(body);
}

function ficheSynthese(body) {
  const p = sel.feature.properties, z = sel.zone?.properties;
  const pot = potentielSel(), s = noteSel(pot), constr = zoneConstructible(sel.zone);
  const occ = sel.occ;
  body.innerHTML = `
    <div class="kpis">
      <div><span>Surface</span><strong>${m2(p.contenance)}</strong></div>
      <div><span>Zone</span><strong>${esc(sel.zLabel)}</strong></div>
      <div><span>Nature</span><strong class="small">${esc(occ ? occ.label : '—')}</strong></div>
      <div><span>Logements</span><strong>${pot && pot.ok ? `${pot.real}` : '?'}</strong></div>
    </div>
    ${s ? `<div class="score-card"><span class="score big ${scoreClass(s.tot)}">${s.tot}</span><div><b>Note de potentiel foncier</b>${s.partiel ? ' <span class="pill wa">partielle</span>' : ''}<p class="note">${s.partiel ? 'Règles de la zone à renseigner pour une note complète. ' : ''}Calculée avec vos derniers critères de prospection.</p></div></div>
      <div class="why">${s.parts.map((x) => `<div class="why-row"><span>${esc(x.label)}</span><span class="bar"><i style="width:${x.v === null ? 0 : Math.round((100 * x.v) / x.max)}%"></i></span><b>${x.v === null ? '—' : x.v}/${x.max}</b><small>${esc(x.why)}</small></div>`).join('')}</div>` : '<p class="note">Bâti indisponible : la note ne peut pas être calculée.</p>'}
    <dl class="kv">
      <dt>Zone</dt><dd>${z ? `<b>${esc(z.libelle)}</b> ${esc(z.libelong || '')} <span class="pill ${constr ? 'ok' : constr === false ? 'no' : 'wa'}">${esc(z.typezone || '')}</span>` : sel.urba['zone-urba'] === null ? '<span class="pill wa">service indisponible</span> <button type="button" class="ghost" id="retryUrba">Réessayer</button>' : '—'}</dd>
      <dt>Bâti</dt><dd>${occ ? `${occ.stats.n - occ.stats.legers} bâtiment(s), ${Math.round(occ.ces * 100)} % d'emprise${occ.stats.logements ? `, ${occ.stats.logements} logement(s)` : ''}` : 'Donnée indisponible'}</dd>
      <dt>Signaux</dt><dd>${occ && occ.flags.length ? occ.flags.map((x) => esc(x.t)).join(' · ') : 'Aucun'}</dd>
      <dt>Potentiel</dt><dd>${pot && pot.ok ? `${m2(pot.sdp)} de plancher, ${pot.lg} logements théoriques, ${pot.real} réalisables` : constr === false ? 'Zone A ou N : pas de logement' : 'Règles de la zone à renseigner (onglet Urbanisme)'}</dd>
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
      <dt>OAP</dt><dd>${pending ? 'Chargement…' : oap.length ? oap.map((x) => esc(x.properties.libelle)).join(' · ') : 'Aucune détectée'}</dd>
      <dt>Prescriptions</dt><dd>${pending ? 'Chargement…' : prescF.length ? [...new Set(prescF.map((x) => x.properties.libelle || x.properties.txt).filter(Boolean))].map(esc).join(' · ') : 'Aucune'}</dd>
    </dl>
    <div class="actions">
      ${regl ? `<a href="${esc(regl)}" target="_blank" rel="noopener">Règlement</a>` : ''}
      <a href="${api.gpuViewerUrl(lng, lat)}" target="_blank" rel="noopener">Géoportail de l'Urbanisme</a>
    </div>
    ${planGraphique.length ? `<p class="note"><span class="pill wa">plan graphique</span> ${[...new Set(planGraphique)].map(esc).join(', ')} : la valeur est fixée sur un plan du PLU, pas seulement dans le règlement écrit. Vérifiez-la sur le Géoportail de l'Urbanisme avant de saisir les règles.</p>` : ''}
    <div id="rulesSlot"></div>`;
  const slot = $('#rulesSlot', body);
  if (!z && !sel.cc && sel.zLabel === '?') slot.innerHTML = '<p class="note">Zone non déterminée : réessayez pour charger le zonage avant de saisir des règles.</p>';
  else if (constr !== false) slot.appendChild(rulesBlock(sel.key, sel.zLabel, renderFiche));
  else slot.innerHTML = '<p class="note">Zone agricole ou naturelle : pas de potentiel de logement.</p>';
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
