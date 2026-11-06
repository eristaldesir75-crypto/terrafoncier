/* global maplibregl, turf */
import * as api from './api.js';
import { computePotentiel, scoreTerrain, parseQuery, RULE_FIELDS } from './potentiel.js';
import * as store from './store.js';

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

// ---------- Carte ----------
const wmts = (layer, style, fmt) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${encodeURIComponent(style)}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${encodeURIComponent(fmt)}`;
const wms = (layers) => `https://data.geopf.fr/wms-v/ows?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layers}&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`;
const empty = { type: 'FeatureCollection', features: [] };

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
    },
    layers: [
      { id: 'plan', type: 'raster', source: 'plan' },
      { id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } },
      { id: 'zonage', type: 'raster', source: 'zonage', minzoom: 11, paint: { 'raster-opacity': 0.55 } },
      { id: 'presc', type: 'raster', source: 'presc', minzoom: 13, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } },
      { id: 'cadastre', type: 'raster', source: 'cadastre', minzoom: 15 },
      { id: 'hits-fill', type: 'fill', source: 'hits', paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'score'], 0, '#c7d0f5', 100, '#2347c5'], 'fill-opacity': 0.55 } },
      { id: 'hits-line', type: 'line', source: 'hits', paint: { 'line-color': '#2347c5', 'line-width': 1 } },
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
map.on('mouseenter', 'hits-fill', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'hits-fill', () => (map.getCanvas().style.cursor = ''));

const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
document.querySelectorAll('input[name=fond]').forEach((r) => r.addEventListener('change', () => { vis('plan', r.value === 'plan' && r.checked); vis('ortho', r.value === 'ortho' && r.checked); }));
$('#lay-cadastre').addEventListener('change', (e) => vis('cadastre', e.target.checked));
$('#lay-zonage').addEventListener('change', (e) => vis('zonage', e.target.checked));
$('#lay-presc').addEventListener('change', (e) => vis('presc', e.target.checked));

let markers = [];
function setHits(list) {
  markers.forEach((m) => m.remove()); markers = [];
  map.getSource('hits')?.setData({ type: 'FeatureCollection', features: list.map((h) => ({ ...h.f, properties: { ...h.f.properties, score: h.s ? h.s.tot : 0 } })) });
  list.slice(0, 25).forEach((h, i) => {
    const el = document.createElement('div');
    el.textContent = i + 1;
    el.style.cssText = 'background:#2347c5;color:#fff;font:600 11px/20px system-ui;width:20px;height:20px;border-radius:50%;text-align:center;border:2px solid #fff;cursor:pointer';
    el.addEventListener('click', (ev) => { ev.stopPropagation(); selectFeature(h.f); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat(turf.pointOnFeature(h.f).geometry.coordinates).addTo(map));
  });
}

// ---------- Onglets ----------
let tab = 'fiche';
function showTab(v) {
  tab = v;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.v === v)));
  ['fiche', 'pot', 'pro', 'crm'].forEach((x) => ($(`#v-${x}`).hidden = x !== v));
  if (v === 'fiche') renderFiche();
  if (v === 'pot') renderPot();
  if (v === 'pro') renderPro();
  if (v === 'crm') renderCrm();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.v)));

// ---------- Sélection d'une parcelle ----------
let sel = null; // { feature, urba, zone, partition, doc, key, bati, risques, loading }
let selToken = 0;

async function selectAt(lng, lat) {
  const token = ++selToken;
  sel = { loading: true }; if (tab !== 'pro' && tab !== 'crm') showTab('fiche'); else renderFiche();
  try {
    const f = await api.parcelleAt(lng, lat);
    if (token !== selToken) return;
    if (!f) { sel = null; renderFiche(); toast('Aucune parcelle à cet endroit'); return; }
    await selectFeature(f, token);
  } catch (e) { sel = { error: e.message }; renderFiche(); }
}

async function selectFeature(f, token = ++selToken) {
  sel = { feature: f, loading: true };
  map.getSource('sel').setData(f);
  map.getSource('env').setData(empty);
  if (tab !== 'pot') showTab('fiche');
  const pt = turf.pointOnFeature(f).geometry;
  const simple = turf.truncate(turf.simplify(f, { tolerance: 0.000005, highQuality: true }), { precision: 6 }).geometry;
  // Couches lentes (prescriptions, servitudes) chargées à part : la fiche s'affiche sans les attendre
  const extraP = api.urbanismeAt(pt, api.EXTRA_LAYERS);
  let urba, bati, risq;
  try {
    [urba, bati, risq] = await Promise.all([api.urbanismeAt(pt, api.CORE_LAYERS), api.batiments(simple), api.risques(pt.coordinates[0], pt.coordinates[1])]);
  } catch (e) { if (token === selToken) { sel = { error: e.message }; renderFiche(); } return; }
  if (token !== selToken) return;
  api.EXTRA_LAYERS.forEach((l) => (urba[l] = 'loading'));
  extraP.then((x) => { if (token !== selToken) return; Object.assign(sel.urba, x); if (tab === 'fiche') renderFiche(); });
  const zone = (urba['zone-urba'] || [])[0] || null;
  const cc = (urba['secteur-cc'] || [])[0] || null;
  const doc = (urba.document || [])[0] || null;
  const partition = zone?.properties.partition || cc?.properties.partition || doc?.properties.partition || null;
  const zLabel = zone?.properties.libelle || cc?.properties.libelle || (doc ? '?' : 'RNU');
  let batiInfo = null;
  if (bati) {
    // Un bâtiment compte s'il est en majorité sur la parcelle (les voisins qui touchent la limite sont écartés)
    const inside = [];
    let emprise = 0;
    for (const b of bati) {
      let part = 0;
      try { const x = turf.intersect(turf.featureCollection([b, f])); part = x ? turf.area(x) : 0; } catch { part = 0; }
      if (part >= 5 && part >= 0.5 * turf.area(b)) { inside.push(b); emprise += part; }
    }
    const sdp = inside.reduce((a, b) => a + turf.area(b) * Math.max(1, +(b.properties.nombre_d_etages || 1)), 0);
    const hmax = Math.max(0, ...inside.map((b) => +(b.properties.hauteur || 0)));
    batiInfo = { n: inside.length, emprise, sdp, hmax };
  }
  sel = { feature: f, urba, zone, cc, doc, partition, zLabel, key: store.ruleKey(partition, zLabel), bati: batiInfo, risques: risq, pt };
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

// ---------- Vue Parcelle ----------
function renderFiche() {
  const v = $('#v-fiche');
  if (!sel) { v.innerHTML = `<h2>Commencez par la carte</h2><p class="empty">Recherchez une adresse ou une commune, zoomez, puis touchez une parcelle. Ses données cadastrales et d'urbanisme s'affichent ici.</p>`; return; }
  if (sel.error) { v.innerHTML = `<h2>Données indisponibles</h2><p class="empty">${esc(sel.error)}. Réessayez dans un instant.</p>`; return; }
  if (sel.loading) { v.innerHTML = `<p class="ref">${esc(refOf(sel.feature?.properties))}</p><p class="empty">Interrogation du cadastre et du Géoportail de l'Urbanisme…</p>`; return; }
  const p = sel.feature.properties, z = sel.zone?.properties, d = sel.doc?.properties;
  const [lng, lat] = sel.pt.coordinates;
  const arr = (k) => (Array.isArray(sel.urba[k]) ? sel.urba[k] : []);
  const pending = sel.urba['prescription-surf'] === 'loading';
  const prescF = [...arr('prescription-surf'), ...arr('prescription-lin')];
  const presc = prescF.map((x) => x.properties.libelle || x.properties.txt).filter(Boolean);
  // Prescriptions graphiques d'emprise (38), de hauteur (39) ou de pleine terre (43) : la valeur est sur un plan, pas dans le règlement écrit
  const planGraphique = prescF.filter((x) => ['38', '39', '43'].includes(String(x.properties.typepsc))).map((x) => x.properties.libelle);
  const infos = arr('info-surf').map((x) => x.properties.libelle).filter(Boolean);
  const sup = arr('assiette-sup-s').map((x) => `${x.properties.suptype || x.properties.typeass || ''} ${x.properties.nomass || x.properties.libelle || ''}`.trim()).filter(Boolean);
  const oap = presc.concat(infos).some((t) => /OAP|orientation/i.test(t));
  const constr = zoneConstructible(sel.zone);
  const regl = api.reglementUrl(sel.zone, sel.partition);
  v.innerHTML = `
    <div><span class="ref">${esc(refOf(p))} · IDU ${esc(p.idu)}</span><h2 style="font-size:19px;margin-top:2px">${esc(p.nom_com || '')}, section ${esc(p.section)} n° ${esc(p.numero)}</h2></div>
    <dl class="kv">
      <dt>Contenance</dt><dd>${m2(p.contenance)} <span class="note">(calculée : ${m2(turf.area(sel.feature))})</span></dd>
      <dt>Document</dt><dd>${d ? `${esc(d.du_type || 'Document')} · ${esc(d.grid_title || sel.partition || '')}${z && z.datappro ? ' · approuvé le ' + esc(String(z.datappro).replace(/^(\d{4})(\d{2})(\d{2})$/, '$3/$2/$1')) : ''}` : sel.cc ? 'Carte communale' : 'Aucun document au GPU (RNU possible)'}</dd>
      <dt>Zone</dt><dd>${z ? `<b>${esc(z.libelle)}</b> ${esc(z.libelong || '')} <span class="pill ${constr ? 'ok' : constr === false ? 'no' : 'wa'}">${esc(z.typezone || '')}</span>` : sel.cc ? esc(sel.cc.properties.libelle || 'Secteur de carte communale') : sel.urba['zone-urba'] === null ? '<span class="pill wa">service indisponible</span> <button type="button" class="ghost" id="retryUrba">Réessayer</button>' : '—'}</dd>
      <dt>OAP</dt><dd>${oap ? 'Oui, voir prescriptions' : 'Aucune détectée'}</dd>
      <dt>Prescriptions</dt><dd>${pending ? 'Chargement…' : presc.length ? presc.map(esc).join(' · ') : 'Aucune'}</dd>
      <dt>Informations</dt><dd>${pending ? 'Chargement…' : infos.length ? infos.map(esc).join(' · ') : 'Aucune'}</dd>
      <dt>Servitudes</dt><dd>${pending ? 'Chargement…' : sup.length ? sup.map(esc).join(' · ') : 'Aucune au GPU'}</dd>
      <dt>Bâti existant</dt><dd>${sel.bati ? (sel.bati.n ? `${sel.bati.n} bâtiment(s), ${m2(sel.bati.emprise)} au sol, hauteur max ${f0(sel.bati.hmax)} m` : 'Aucun') : 'Donnée indisponible'}</dd>
      <dt>Risques (commune)</dt><dd>${sel.risques ? (sel.risques.length ? sel.risques.map(esc).join(' · ') : 'Aucun recensé') : 'Donnée indisponible'}</dd>
      <dt>Propriétaire</dt><dd>Personne morale : <a href="https://www.data.gouv.fr/datasets/fichiers-des-locaux-et-des-parcelles-des-personnes-morales" target="_blank" rel="noopener">fichier DGFiP</a>. Particulier : relevé de propriété auprès du service des impôts ou de la mairie.</dd>
    </dl>
    <div class="actions">
      ${regl ? `<a href="${esc(regl)}" target="_blank" rel="noopener">Règlement</a>` : ''}
      <a href="${api.gpuViewerUrl(lng, lat)}" target="_blank" rel="noopener">Géoportail de l'Urbanisme</a>
      <a href="https://explore.data.gouv.fr/fr/immobilier?onglet=carte&filtre=tous&lat=${lat}&lng=${lng}&zoom=17" target="_blank" rel="noopener">Ventes DVF</a>
    </div>
    ${planGraphique.length ? `<p class="note"><span class="pill wa">plan graphique</span> ${planGraphique.map(esc).join(', ')} : la valeur est fixée sur un plan du PLU, pas seulement dans le règlement écrit. Vérifiez-la sur le Géoportail de l'Urbanisme avant de saisir les règles.</p>` : ''}
    <div id="rulesSlot"></div>
    <div class="actions"><button type="button" id="goPot">Calculer le potentiel</button><button type="button" class="ghost" id="addCrm">Ajouter au suivi</button><button type="button" class="ghost" id="copyFiche">Copier la fiche</button></div>`;
  if (!z && !sel.cc && sel.zLabel === '?') $('#rulesSlot', v).innerHTML = '<p class="note">Zone non déterminée : réessayez pour charger le zonage avant de saisir des règles.</p>';
  else if (constr !== false) $('#rulesSlot', v).appendChild(rulesBlock(sel.key, sel.zLabel, renderFiche));
  else $('#rulesSlot', v).innerHTML = '<p class="note">Zone agricole ou naturelle : pas de potentiel de logement.</p>';
  $('#goPot', v).onclick = () => showTab('pot');
  const retry = $('#retryUrba', v); if (retry) retry.onclick = () => selectFeature(sel.feature);
  $('#addCrm', v).onclick = () => {
    const ok = store.addToCrm({ idu: p.idu, ref: refOf(p), commune: p.nom_com, zone: sel.zLabel, contenance: p.contenance, centre: sel.pt.coordinates, geometry: turf.truncate(sel.feature.geometry ? sel.feature : sel.feature, { precision: 6 }).geometry });
    toast(ok ? 'Ajouté au suivi' : 'Déjà dans le suivi');
  };
  $('#copyFiche', v).onclick = () => copy(ficheText());
}
function ficheText() {
  const p = sel.feature.properties, rules = store.getRules(sel.key);
  const pot = computePotentiel(sel.feature, rules || {}, store.settings(), { contenance: p.contenance, batiSdp: sel.bati?.sdp, constructible: zoneConstructible(sel.zone) });
  return [
    `Parcelle ${refOf(p)} — ${p.nom_com}`, `Contenance : ${m2(p.contenance)}`,
    `Zone : ${sel.zLabel} ${sel.zone?.properties.libelong || ''}`,
    ...(rules ? RULE_FIELDS.map((fd) => `- ${fd.label} : ${rules[fd.k] ?? 'non renseigné'}${rules.citations?.[fd.k]?.article ? ' (' + rules.citations[fd.k].article + ', p. ' + rules.citations[fd.k].page + ')' : ''}`) : ['Règles : non saisies']),
    pot.ok ? `Potentiel : emprise ${m2(pot.E)}, SDP ${m2(pot.sdp)}, ${pot.lg} logements théoriques, ${pot.real} réalisables` : `Potentiel : ${pot.raison}`,
    'Estimation indicative — ne remplace ni un certificat d’urbanisme ni une étude de faisabilité.',
  ].join('\n');
}

// ---------- Vue Potentiel ----------
function renderPot() {
  const v = $('#v-pot');
  if (!sel || !sel.feature || sel.loading) { v.innerHTML = '<p class="empty">Sélectionnez une parcelle sur la carte.</p>'; return; }
  const p = sel.feature.properties, hyp = store.settings();
  const rules = store.getRules(sel.key) || {};
  const pot = computePotentiel(sel.feature, rules, hyp, { contenance: p.contenance, batiSdp: sel.bati?.sdp, constructible: zoneConstructible(sel.zone) });
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
    <div><div class="label">Contraintes</div>${pot.contraintes.length ? `<ul style="margin:0;padding-left:18px">${pot.contraintes.map((c) => `<li>${esc(c.t)}${c.d ? ` (−${Math.round(c.d * 100)} %)` : ''}</li>`).join('')}</ul>` : '<p class="note">Aucune contrainte détectée automatiquement.</p>'}
      ${pot.missing.length ? `<p class="note">Règles non renseignées : ${pot.missing.map(esc).join(', ')}.</p>` : ''}</div>
    <p class="note">Estimation indicative. Hypothèses modifiables dans Réglages. Ne remplace ni un certificat d'urbanisme ni une étude de faisabilité.</p>`;
}

// ---------- Vue Prospection ----------
let pro = { commune: null, query: 'Opération de 30 à 50 logements, parcelles de plus de 1 500 m²', results: null, running: false, ctrl: null, zonesMissing: [] };
function renderPro() {
  const v = $('#v-pro');
  const c = parseQuery(pro.query);
  v.innerHTML = `
    <form id="proForm" class="filters" style="display:flex;flex-direction:column;gap:8px">
      <label class="label" for="proCommune">Commune</label>
      <input type="text" id="proCommune" placeholder="Nom ou code INSEE, ex. Saran" value="${esc(pro.commune ? `${pro.commune.nom} (${pro.commune.code})` : '')}">
      <label class="label" for="proQuery">Votre recherche</label>
      <textarea id="proQuery" rows="2">${esc(pro.query)}</textarea>
      <div class="chips"><span class="chip">surface ≥ ${f0(c.smin)} m²</span><span class="chip">${c.lmin} à ${c.lmax >= 100000 ? '∞' : c.lmax} logements</span><span class="chip">zones U et AU</span></div>
      <div class="actions"><button type="submit" ${pro.running ? 'disabled' : ''}>Lancer la prospection</button>${pro.running ? '<button type="button" class="ghost" id="proStop">Arrêter</button>' : ''}</div>
    </form>
    <div id="proStatus"></div>
    <div id="proZones"></div>
    <div id="proRes"></div>`;
  $('#proForm', v).onsubmit = async (e) => { e.preventDefault(); pro.query = $('#proQuery', v).value; await resolveCommune($('#proCommune', v).value); if (pro.commune) runProspection(); };
  const stop = $('#proStop', v); if (stop) stop.onclick = () => pro.ctrl && pro.ctrl.abort();
  if (pro.results) renderProResults();
}
async function resolveCommune(text) {
  const t = text.trim();
  if (pro.commune && t.startsWith(pro.commune.nom)) return;
  const code = t.match(/\b(\d[\dAB]\d{3})\b/);
  try {
    if (code) pro.commune = await api.communeByCode(code[1]);
    else { const l = await api.searchCommunes(t); pro.commune = l[0] || null; }
    if (!pro.commune) toast('Commune introuvable');
  } catch (e) { toast(e.message); }
}
function setStatus(html, pct) { const s = $('#proStatus'); if (s) s.innerHTML = `${html}${pct !== undefined ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}`; }

async function runProspection() {
  const com = pro.commune, crit = parseQuery(pro.query), hyp = store.settings();
  pro.running = true; pro.results = null; pro.ctrl = new AbortController(); renderPro();
  try {
    map.flyTo({ center: com.centre.coordinates, zoom: 13 });
    setStatus(`Document d'urbanisme de ${esc(com.nom)}…`, 5);
    const docs = await api.gpuAt('document', com.centre);
    const partition = docs[0]?.properties.partition;
    if (!partition) throw new api.ApiError(`Aucun PLU publié au GPU pour ${com.nom} (RNU ou document non numérisé)`);
    setStatus(`Zonage (${esc(partition)})…`, 10);
    const zones = (await api.gpuByPartition('zone-urba', partition, { signal: pro.ctrl.signal })).filter((z) => z.geometry);
    zones.forEach((z) => (z.bbox = turf.bbox(z)));
    setStatus('Parcelles cadastrales…', 15);
    const parcels = await api.parcellesCommune(com.code, { signal: pro.ctrl.signal, onProgress: (n, tot) => setStatus(`Parcelles cadastrales : ${f0(n)}${tot ? ' / ' + f0(tot) : ''}…`, 15 + (tot ? (60 * n) / tot : 30)) });
    setStatus(`Analyse de ${f0(parcels.length)} parcelles…`, 80);
    const big = parcels.filter((f) => +f.properties.contenance >= crit.smin && f.geometry);
    const out = [], missing = new Map();
    let excluded = 0;
    for (const f of big) {
      const pt = turf.pointOnFeature(f), [x, y] = pt.geometry.coordinates;
      const z = zones.find((zz) => x >= zz.bbox[0] && x <= zz.bbox[2] && y >= zz.bbox[1] && y <= zz.bbox[3] && turf.booleanPointInPolygon(pt, zz));
      if (!z || zoneConstructible(z) !== true) continue;
      if (zoneHorsLogement(z)) { excluded++; continue; }
      const key = store.ruleKey(partition, z.properties.libelle);
      const rules = store.getRules(key);
      const item = { f, zone: z, key, pot: null, s: null };
      if (rules) {
        item.pot = computePotentiel(f, rules, hyp, { contenance: f.properties.contenance });
        if (item.pot.ok) item.s = scoreTerrain({ pot: item.pot, cible: crit, zoneType: (z.properties.typezone || '').toUpperCase(), verifiedRules: rules.source === 'ia' });
        if (!item.pot.ok || item.pot.real < Math.ceil(crit.lmin * 0.5)) continue;
      } else {
        const m = missing.get(key) || { key, zone: z, n: 0 }; m.n++; missing.set(key, m);
      }
      out.push(item);
    }
    out.sort((a, b) => (b.s ? b.s.tot : -1) - (a.s ? a.s.tot : -1) || (+b.f.properties.contenance - +a.f.properties.contenance));
    pro.results = { com, partition, total: parcels.length, big: big.length, list: out };
    pro.zonesMissing = [...missing.values()].sort((a, b) => b.n - a.n);
    setHits(out.filter((h) => h.s));
    setStatus(`${f0(parcels.length)} parcelles balayées · ${f0(big.length)} au-dessus de ${f0(crit.smin)} m² · ${f0(excluded)} écartées (zones d'activités, d'équipements ou 2AU) · ${out.filter((h) => h.s).length} classées`);
  } catch (e) {
    setStatus(`<p class="empty">${esc(e.name === 'AbortError' ? 'Prospection arrêtée' : e.message)}</p>`);
  } finally {
    pro.running = false; pro.ctrl = null;
    const btn = $('#proForm button[type=submit]'); if (btn) btn.disabled = false; $('#proStop')?.remove();
    if (pro.results) renderProResults();
  }
}
function renderProResults() {
  const r = pro.results; if (!r) return;
  const z = $('#proZones');
  if (z) {
    z.innerHTML = pro.zonesMissing.length ? `<div class="label">Zones sans règles enregistrées</div><p class="note">Saisissez les règles de ces zones pour classer leurs parcelles (une fois par zone).</p>` : '';
    pro.zonesMissing.slice(0, 8).forEach((m) => {
      const d = document.createElement('details');
      d.innerHTML = `<summary><b>${esc(m.zone.properties.libelle)}</b> — ${m.n} parcelle(s) ${m.zone.properties.urlfic ? `· <a href="${esc(m.zone.properties.urlfic)}" target="_blank" rel="noopener">règlement</a>` : ''}</summary>`;
      d.appendChild(rulesBlock(m.key, m.zone.properties.libelle, rerank, { zone: m.zone, partition: r.partition }));
      z.appendChild(d);
    });
  }
  const ranked = r.list.filter((h) => h.s);
  const res = $('#proRes'); if (!res) return;
  res.innerHTML = `<div class="actions" style="justify-content:space-between;align-items:center"><div class="label">${ranked.length} terrain(s) classé(s)</div>${ranked.length ? '<button type="button" class="ghost" id="proCsv">Exporter en CSV</button>' : ''}</div>
    <ul class="results">${ranked.slice(0, 150).map((h, i) => `<li data-i="${i}" tabindex="0"><span class="num">${i + 1}</span><span><b>${esc(refOf(h.f.properties))}</b> · ${esc(h.zone.properties.libelle)} · ${m2(h.f.properties.contenance)} · ${h.pot.real} logts</span><span class="sc">${h.s.tot}</span><small>${Object.entries(h.s.det).map(([k, x]) => `${k} ${x}`).join(' · ')}</small></li>`).join('')}</ul>
    <p class="note">Score sur 100 : adéquation au programme 35, règles 20, maîtrise foncière 15, forme 15, bâti 10. Le bâti n'est pas analysé lors du balayage : ouvrez la fiche pour le vérifier.</p>`;
  res.querySelectorAll('.results li').forEach((li) => {
    const h = ranked[+li.dataset.i];
    const go = () => { map.fitBounds(turf.bbox(h.f), { padding: 80, maxZoom: 18 }); selectFeature(h.f); };
    li.onclick = go; li.onkeydown = (e) => e.key === 'Enter' && go();
  });
  const csv = $('#proCsv'); if (csv) csv.onclick = () => {
    const head = 'rang;reference;idu;commune;zone;contenance_m2;emprise_m2;sdp_m2;logements_theoriques;logements_realisables;score';
    const rows = ranked.map((h, i) => [i + 1, refOf(h.f.properties), h.f.properties.idu, r.com.nom, h.zone.properties.libelle, h.f.properties.contenance, Math.round(h.pot.E), Math.round(h.pot.sdp), h.pot.lg, h.pot.real, h.s.tot].join(';'));
    download(`prospection-${r.com.code}.csv`, '﻿' + [head, ...rows].join('\n'), 'text/csv;charset=utf-8');
  };
}
function rerank() {
  const r = pro.results; if (!r) return;
  const crit = parseQuery(pro.query), hyp = store.settings(), missing = new Map();
  r.list.forEach((h) => {
    const rules = store.getRules(h.key);
    if (rules) { h.pot = computePotentiel(h.f, rules, hyp, { contenance: h.f.properties.contenance }); h.s = h.pot.ok && h.pot.real >= Math.ceil(crit.lmin * 0.5) ? scoreTerrain({ pot: h.pot, cible: crit, zoneType: (h.zone.properties.typezone || '').toUpperCase(), verifiedRules: rules.source === 'ia' }) : null; }
    else { const m = missing.get(h.key) || { key: h.key, zone: h.zone, n: 0 }; m.n++; missing.set(h.key, m); }
  });
  r.list.sort((a, b) => (b.s ? b.s.tot : -1) - (a.s ? a.s.tot : -1));
  pro.zonesMissing = [...missing.values()].sort((a, b) => b.n - a.n);
  setHits(r.list.filter((h) => h.s)); renderProResults();
}

// ---------- Vue Suivi ----------
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
  const v = $('#v-crm'), list = store.crmList();
  const counts = store.STATUTS.map((s, i) => [s, list.filter((x) => x.statut === i).length]).filter(([, n]) => n);
  const today = new Date().toISOString().slice(0, 10);
  v.innerHTML = `<div><h2 style="font-size:19px">Suivi des opportunités</h2><p class="note">Enregistré sur cet appareil. Exportez régulièrement pour sauvegarder ou partager.</p></div>
    <div class="chips">${counts.map(([s, n]) => `<span class="chip">${esc(s)} · ${n}</span>`).join('')}</div>
    ${list.length ? '' : '<p class="empty">Aucune opportunité. Ajoutez-en depuis une fiche parcelle.</p>'}
    <div class="crm">${list.map((x, i) => `<div class="row">
      <span><b>${esc(x.ref)}</b> · ${esc(x.commune)} · ${esc(x.zone)} · ${m2(x.contenance)}${x.relance && x.relance <= today ? ' <span class="pill wa">relance due</span>' : ''}</span>
      <select id="c-st-${i}" data-i="${i}" data-f="statut" aria-label="Statut">${store.STATUTS.map((s, j) => `<option value="${j}" ${j === x.statut ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label class="full note" for="c-rel-${i}">Prochaine relance <input type="date" id="c-rel-${i}" data-i="${i}" data-f="relance" value="${esc(x.relance)}"></label>
      <textarea class="full" id="c-note-${i}" data-i="${i}" data-f="note" rows="2" placeholder="Notes : propriétaire, échanges, prix évoqué…">${esc(x.note)}</textarea>
      <div class="full actions"><button type="button" class="ghost" data-go="${i}">Voir</button><button type="button" class="ghost" data-letter="${i}">Préparer un courrier</button><button type="button" class="ghost" data-del="${i}">Retirer</button></div>
    </div>`).join('')}</div>
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
    const head = 'reference;idu;commune;zone;contenance_m2;statut;prochaine_relance;note';
    const rows = list.map((x) => [x.ref, x.idu, x.commune, x.zone, x.contenance, store.STATUTS[x.statut], x.relance, `"${(x.note || '').replace(/"/g, '""')}"`].join(';'));
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
  if (s.kind === 'commune') { pro.commune = s.data; map.flyTo({ center: s.data.centre.coordinates, zoom: 14 }); toast(`${s.data.nom} : touchez une parcelle, ou lancez une prospection`); }
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

showTab('fiche');
