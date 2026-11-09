// Accès aux API publiques françaises, directement depuis le navigateur.
// Toutes sont gratuites et sans clé : API Carto (IGN), Géoplateforme, geo.api.gouv.fr, Géorisques.

const APICARTO = 'https://apicarto.ign.fr/api';
const GEOCODE = 'https://data.geopf.fr/geocodage/search';
const GEOAPI = 'https://geo.api.gouv.fr';
const GEORISQUES = 'https://georisques.gouv.fr/api/v1';

export class ApiError extends Error {}

async function getJSON(url, { timeout = 20000, signal, retries = 2 } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (r.status === 429 || r.status >= 500) throw new ApiError(`Le service ${host} est surchargé (${r.status})`);
      if (!r.ok) throw Object.assign(new ApiError(`Le service a répondu ${r.status} (${host})`), { final: true });
      const j = await r.json();
      // API Carto peut répondre 200 avec un message d'erreur du serveur IGN surchargé, sans « features »
      // (une commune de geo.api.gouv.fr a aussi un champ « code » : seul un message d'erreur compte)
      if (j && typeof j === 'object' && !Array.isArray(j) && !('features' in j) && (j.type === 'error' || (j.message && typeof j.code !== 'string'))) {
        throw new ApiError(`Le service ${host} est momentanément indisponible`);
      }
      return j;
    } catch (e) {
      const aborted = e.name === 'AbortError';
      if (signal && signal.aborted) throw e;
      const err = e instanceof ApiError ? e : new ApiError(aborted ? `Délai dépassé (${host})` : `Service injoignable (${host})`);
      if (err.final || attempt >= retries) throw err;
      await new Promise((ok) => setTimeout(ok, 1200 * (attempt + 1)));
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

const g = (geom) => encodeURIComponent(JSON.stringify(geom));
export const point = (lng, lat) => ({ type: 'Point', coordinates: [+lng.toFixed(7), +lat.toFixed(7)] });

// ---------- Recherche ----------
export async function searchCommunes(text) {
  const u = `${GEOAPI}/communes?nom=${encodeURIComponent(text)}&fields=nom,code,codesPostaux,centre,codeDepartement,population&boost=population&limit=6`;
  return getJSON(u, { timeout: 8000 });
}
export async function searchAddress(text) {
  const u = `${GEOCODE}?q=${encodeURIComponent(text)}&limit=5`;
  const fc = await getJSON(u, { timeout: 8000 });
  return fc.features || [];
}
export async function communeByCode(insee) {
  return getJSON(`${GEOAPI}/communes/${insee}?fields=nom,code,centre,contour,codeDepartement,population`);
}

// ---------- Cadastre ----------
export async function parcelleAt(lng, lat) {
  const fc = await getJSON(`${APICARTO}/cadastre/parcelle?geom=${g(point(lng, lat))}`);
  return (fc.features || [])[0] || null;
}
export async function parcelleByRef(insee, section, numero) {
  const u = `${APICARTO}/cadastre/parcelle?code_insee=${insee}&section=${encodeURIComponent(section)}&numero=${String(numero).padStart(4, '0')}`;
  const fc = await getJSON(u);
  return (fc.features || [])[0] || null;
}
/** Toutes les parcelles d'une commune : première page, puis le reste en parallèle (4 requêtes à la fois). */
export async function parcellesCommune(insee, { onProgress, signal, max = 40000 } = {}) {
  const limit = 500;
  const url = (start) => `${APICARTO}/cadastre/parcelle?code_insee=${insee}&_limit=${limit}&_start=${start}`;
  const first = await getJSON(url(0), { signal, timeout: 40000 });
  const out = [...(first.features || [])];
  const total = Math.min(max, first.totalFeatures || first.numberMatched || out.length);
  onProgress && onProgress(out.length, total);
  if (out.length < limit || out.length >= total) return out;
  const starts = [];
  for (let s = limit; s < total; s += limit) starts.push(s);
  const pages = new Array(starts.length);
  let next = 0;
  async function worker() {
    while (next < starts.length) {
      const i = next++;
      const fc = await getJSON(url(starts[i]), { signal, timeout: 40000 });
      pages[i] = fc.features || [];
      onProgress && onProgress(out.length + pages.reduce((a, p) => a + (p ? p.length : 0), 0), total);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  pages.forEach((p) => out.push(...p));
  return out;
}

// ---------- Urbanisme (Géoportail de l'Urbanisme) ----------
export async function gpuAt(layer, geom, opts = {}) {
  const fc = await getJSON(`${APICARTO}/gpu/${layer}?geom=${g(geom)}`, opts);
  return fc.features || [];
}
// Les couches d'un PLU entier sont lourdes : gardées en mémoire pendant la visite (fiche, tableau des zones, prospection)
const partCache = new Map();
export function gpuByPartition(layer, partition, opts = {}) {
  const k = `${layer}|${partition}`;
  if (!partCache.has(k)) {
    // copie hebdomadaire publiée avec le site d'abord (rapide, indépendante de l'IGN), API Carto sinon
    const p = copieLocale(layer, partition).then((c) => c || gpuByPartitionBrut(layer, partition, {})).catch((e) => { partCache.delete(k); throw e; });
    partCache.set(k, p);
  }
  const p = partCache.get(k);
  if (!opts.signal) return p;
  return new Promise((ok, ko) => {
    opts.signal.addEventListener('abort', () => ko(new DOMException('Arrêté', 'AbortError')), { once: true });
    p.then(ok, ko);
  });
}
// ---------- Copie hebdomadaire des PLU (data/plu, construite par le traitement « Copie des PLU ») ----------
let indexCopie = null;
export function copiePlu() {
  if (!indexCopie) indexCopie = fetch('data/plu/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return indexCopie;
}
async function copieLocale(layer, partition) {
  if (!['zone-urba', 'secteur-cc', 'prescription-surf'].includes(layer)) return null;
  const idx = await copiePlu();
  const doc = idx && idx.documents && idx.documents[partition];
  if (!doc) return null;
  const cc = doc.type === 'CC';
  if ((layer === 'zone-urba' && cc) || (layer === 'secteur-cc' && !cc)) return [];
  try {
    const r = await fetch(`data/plu/p/${encodeURIComponent(partition)}/${layer === 'prescription-surf' ? 'presc' : 'zones'}.json`);
    if (!r.ok) return null;
    return (await r.json()).features || [];
  } catch { return null; }
}
const communesCopie = new Map();
/** Document(s) d'urbanisme d'une commune d'après la copie : { partitions: [...] } ou { rnu: true }, null si non copiée. */
export async function communeCopie(insee) {
  const dep = /^97/.test(insee) ? insee.slice(0, 3) : insee.slice(0, 2);
  if (!communesCopie.has(dep)) communesCopie.set(dep, fetch(`data/plu/communes/${dep}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  const c = await communesCopie.get(dep);
  return (c && c[insee]) || null;
}

async function gpuByPartitionBrut(layer, partition, { signal } = {}) {
  const out = [];
  for (let start = 0; start < 20000; start += 1000) {
    const fc = await getJSON(`${APICARTO}/gpu/${layer}?partition=${encodeURIComponent(partition)}&_limit=1000&_start=${start}`, { signal, timeout: 60000 });
    const f = fc.features || [];
    out.push(...f);
    const total = fc.totalFeatures || fc.numberMatched || null;
    // le service peut ignorer _limit et tout renvoyer d'un coup
    if (f.length < 1000 || f.length > 1000 || (total && out.length >= total)) break;
  }
  return out;
}
export async function municipality(insee) {
  const fc = await getJSON(`${APICARTO}/gpu/municipality?insee=${insee}`);
  return (fc.features || [])[0] || null;
}

/** Tout ce que le GPU sait sur un point : document, zone, prescriptions, informations, servitudes. */
export const CORE_LAYERS = ['zone-urba', 'secteur-cc'];
export const EXTRA_LAYERS = ['document', 'prescription-surf', 'prescription-lin', 'info-surf', 'assiette-sup-s'];
export async function urbanismeAt(geom, layers = [...CORE_LAYERS, ...EXTRA_LAYERS], opts = {}) {
  const res = await Promise.allSettled(layers.map((l) => gpuAt(l, geom, opts)));
  const o = {};
  layers.forEach((l, i) => { o[l] = res[i].status === 'fulfilled' ? res[i].value : null; });
  return o;
}

/**
 * Même information que urbanismeAt, lue sur le service cartographique (WMS) du Géoportail de l'Urbanisme.
 * Ce service tourne sur une autre infrastructure qu'API Carto : il sert de secours quand API Carto est saturé,
 * et il renvoie aussi les prescriptions graphiques (hauteur, emprise, pleine terre) avec leur valeur.
 * Retourne un objet { 'zone-urba': [...], 'secteur-cc': [...], 'prescription-surf': [...], 'info-surf': [...], ... }.
 */
const WMS_DU = 'https://data.geopf.fr/wms-v/ows';
const WMS_KEYS = { zone_urba: 'zone-urba', secteur_cc: 'secteur-cc', prescription_surf: 'prescription-surf', prescription_lin: 'prescription-lin', prescription_pct: 'prescription-pct', info_surf: 'info-surf', info_lin: 'info-lin', info_pct: 'info-pct', doc_urba: 'document' };
export async function duAt(lng, lat, opts = {}) {
  const d = 0.0002; // ± 20 m autour du point, 101 × 101 pixels : un pixel ≈ 0,3 m
  const u = `${WMS_DU}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=du&QUERY_LAYERS=du&STYLES=&CRS=EPSG:4326`
    + `&BBOX=${lat - d},${lng - d},${lat + d},${lng + d}&WIDTH=101&HEIGHT=101&I=50&J=50&INFO_FORMAT=application/json&FEATURE_COUNT=200`;
  const fc = await getJSON(u, { timeout: 20000, retries: 1, ...opts });
  const out = { 'zone-urba': [], 'secteur-cc': [], 'prescription-surf': [], 'prescription-lin': [], 'info-surf': [] };
  const seen = new Set();
  for (const f of fc.features || []) {
    const id = String(f.id || '');
    if (seen.has(id)) continue; seen.add(id);
    const m = id.match(/^([a-z]+_[a-z]+)_du_/);
    const k = m && WMS_KEYS[m[1]];
    if (!k) continue;
    (out[k] = out[k] || []).push(f);
  }
  return out;
}

/** URL d'accès au règlement pour une zone du GPU. */
export function reglementUrl(zone, partition) {
  const p = zone && zone.properties;
  if (p && p.urlfic) return p.urlfic;
  if (partition) return `https://www.geoportail-urbanisme.gouv.fr/document/download-by-partition/${partition}`;
  return null;
}
export function gpuViewerUrl(lng, lat) {
  return `https://www.geoportail-urbanisme.gouv.fr/map/#tile=1&lon=${lng}&lat=${lat}&zoom=18`;
}

// ---------- Bâti (BD TOPO) ----------
export async function batiments(geom) {
  try {
    const fc = await getJSON(`${APICARTO}/wfs-geoportail/search?source=BDTOPO_V3:batiment&geom=${g(geom)}&_limit=200`);
    return fc.features || [];
  } catch { return null; }
}

/** Objets BD TOPO d'une couche dans une emprise [ouest, sud, est, nord], par pages de 1000. */
async function bdtopoBBox(source, bbox, { signal } = {}) {
  const poly = { type: 'Polygon', coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] };
  const out = [];
  for (let start = 0; start < 20000; start += 1000) {
    const fc = await getJSON(`${APICARTO}/wfs-geoportail/search?source=${source}&geom=${g(poly)}&_limit=1000&_start=${start}`, { signal, timeout: 40000 });
    const f = fc.features || [];
    out.push(...f);
    if (f.length < 1000) break;
  }
  return out;
}

/**
 * Bâtiments, parkings et équipements BD TOPO pour une liste de tuiles (emprises), 4 tuiles à la fois.
 * Les doublons (un objet à cheval sur deux tuiles) sont retirés par identifiant.
 */
export async function occupationTiles(tiles, { signal, onProgress } = {}) {
  const seen = { bat: new Set(), park: new Set(), eq: new Set() };
  const res = { batiments: [], parkings: [], equipements: [] };
  let next = 0, done = 0;
  const add = (kind, key, list) => list.forEach((f) => { const id = f.properties.cleabs || f.id; if (!seen[kind].has(id)) { seen[kind].add(id); res[key].push(f); } });
  async function worker() {
    while (next < tiles.length) {
      const t = tiles[next++];
      const [b, e, z] = await Promise.all([
        bdtopoBBox('BDTOPO_V3:batiment', t, { signal }),
        bdtopoBBox('BDTOPO_V3:equipement_de_transport', t, { signal }),
        bdtopoBBox('BDTOPO_V3:zone_d_activite_ou_d_interet', t, { signal }),
      ]);
      add('bat', 'batiments', b);
      add('park', 'parkings', e.filter((x) => x.properties.nature === 'Parking'));
      add('eq', 'equipements', z);
      done++;
      onProgress && onProgress(done, tiles.length);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return res;
}

/** Parkings et équipements autour d'une géométrie (fiche parcelle). */
export async function occupationAt(geom) {
  const q = (source) => getJSON(`${APICARTO}/wfs-geoportail/search?source=${source}&geom=${g(geom)}&_limit=200`).then((fc) => fc.features || []).catch(() => null);
  const [e, z] = await Promise.all([q('BDTOPO_V3:equipement_de_transport'), q('BDTOPO_V3:zone_d_activite_ou_d_interet')]);
  return { parkings: e ? e.filter((x) => x.properties.nature === 'Parking') : null, equipements: z };
}

// ---------- Friches (Cartofriches, Cerema) ----------
const frichesCache = new Map();
/** Friches recensées dans une commune ; chaque friche liste les parcelles (IDU) de son unité foncière. */
export async function friches(insee) {
  if (frichesCache.has(insee)) return frichesCache.get(insee);
  const p = getJSON(`https://apidf-preprod.cerema.fr/cartofriches/friches/?code_insee=${insee}`, { timeout: 30000, retries: 1 })
    .then((fc) => (fc.features || fc.results || []).map((x) => {
      const pr = x.properties || x;
      let idus = [];
      try { idus = JSON.parse(String(pr.unite_fonciere_refcad || '[]').replace(/'/g, '"')); } catch { idus = []; }
      return { id: pr.site_id, nom: pr.site_nom, type: pr.site_type, statut: pr.site_statut, adresse: pr.site_adresse, surface: pr.unite_fonciere_surface, idus };
    }))
    .catch(() => null);
  frichesCache.set(insee, p);
  return p;
}

// ---------- Risques (Géorisques) ----------
export async function risques(lng, lat) {
  try {
    const r = await getJSON(`${GEORISQUES}/gaspar/risques?latlon=${lng},${lat}`, { timeout: 10000 });
    const d = (r.data && r.data[0]) || null;
    return d ? (d.risques_detail || []).map((x) => x.libelle_risque_long) : [];
  } catch { return null; }
}

// ---------- Serveur IA (optionnel) ----------
export async function extractRules(backend, payload) {
  const r = await fetch(backend.replace(/\/$/, '') + '/extract', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) {
    let msg = `Le serveur IA a répondu ${r.status}`;
    try { const j = await r.json(); if (j.detail) msg += ` : ${j.detail}`; } catch {}
    throw new ApiError(msg);
  }
  return r.json();
}

// ---------- Permis de construire de logements (Sitadel, SDES, mis à jour chaque mois) ----------
// Autorisations délivrées depuis 2013. Le demandeur n'est publié que pour les personnes morales (promoteurs, bailleurs, SCI).
const SITADEL = 'https://data.statistiques.developpement-durable.gouv.fr/dido/api/v1/datafiles/8b35affb-55fc-4c1f-915b-7750f974446a/rows';
const permisCache = new Map();
export function permisLogements(insee, { minLogements = 2 } = {}) {
  const k = `${insee}|${minLogements}`;
  if (permisCache.has(k)) return permisCache.get(k);
  const p = (async () => {
    const out = [];
    for (let page = 1; page <= 30; page++) {
      const j = await getJSON(`${SITADEL}?page=${page}&pageSize=100&COMM=eq:${insee}&NB_LGT_TOT_CREES=gte:${minLogements}`, { timeout: 20000, retries: 1 });
      const d = j.data || [];
      out.push(...d);
      if (d.length < 100 || out.length >= (j.total || 0)) break;
    }
    return out.map(normPermis);
  })().catch((e) => { permisCache.delete(k); throw e; });
  permisCache.set(k, p);
  return p;
}
const ETATS_DAU = { 2: 'Autorisé', 4: 'Annulé', 5: 'Chantier commencé', 6: 'Terminé' };
function normPermis(x) {
  const parcelles = [];
  for (let i = 1; i <= 25; i++) {
    const s = String(x[`SEC_CADASTRE${i}`] || '').trim().toUpperCase(), n = String(x[`NUM_CADASTRE${i}`] || '').replace(/\D/g, '');
    if (s && s !== '0' && n && +n > 0) parcelles.push({ section: s.padStart(2, '0'), numero: n.padStart(4, '0') });
  }
  const adr = [x.ADR_NUM_TER, x.ADR_LIBVOIE_TER || x.ADR_LIEUDIT_TER].filter(Boolean).join(' ');
  return {
    num: x.NUM_DAU, type: x.TYPE_DAU, etat: x.ETAT_DAU, etatLib: ETATS_DAU[x.ETAT_DAU] || 'Inconnu',
    demandeur: x.DENOM_DEM || null, siren: x.SIREN_DEM || null,
    logements: +x.NB_LGT_TOT_CREES || 0, collectifs: +x.NB_LGT_COL_CREES || 0, individuels: +x.NB_LGT_IND_CREES || 0,
    sociaux: +x.NB_LGT_PRET_LOC_SOCIAL || 0, residence: +x.NB_LGT_RES || 0, demolis: +x.NB_LGT_DEMOLIS || 0,
    terrain: +x.SUPERFICIE_TERRAIN || 0, shab: +x.SURF_HAB_CREEE || 0, niveaux: +x.NB_NIV_MAX || 0,
    t: [x.NB_LGT_1P, x.NB_LGT_2P, x.NB_LGT_3P, x.NB_LGT_4P, x.NB_LGT_5P, x.NB_LGT_6P_PLUS].map((v) => +v || 0),
    autorisation: x.DATE_REELLE_AUTORISATION || null, chantier: x.DATE_REELLE_DOC || null, achevement: x.DATE_REELLE_DAACT || null,
    depot: x.AN_DEPOT, adresse: adr, parcelles, insee: x.COMM,
  };
}

// ---------- Ventes de logements neufs sur plan (VEFA, DVF open data via l'API du Cerema) ----------
const ventesCache = new Map();
export function ventesNeuves(insee, { depuis = 2020 } = {}) {
  const k = `${insee}|${depuis}`;
  if (ventesCache.has(k)) return ventesCache.get(k);
  const p = (async () => {
    const out = [];
    let url = `https://apidf-preprod.cerema.fr/dvf_opendata/geomutations/?code_insee=${insee}&anneemut_min=${depuis}&vefa=True&page_size=500`;
    for (let i = 0; url && i < 20; i++) {
      const fc = await getJSON(url, { timeout: 30000, retries: 1 });
      out.push(...(fc.features || []));
      url = fc.next ? String(fc.next).replace(/^http:/, 'https:') : null;
    }
    return out;
  })().catch((e) => { ventesCache.delete(k); throw e; });
  ventesCache.set(k, p);
  return p;
}

// ---------- Adresse d'une parcelle (Base Adresse Nationale, géocodage inverse IGN) ----------
const adrCache = new Map();
/** Adresse la plus proche d'un point : { label, rue, distance } ou null. */
export function adresseAt(lng, lat) {
  const k = `${lng.toFixed(5)},${lat.toFixed(5)}`;
  if (!adrCache.has(k)) {
    adrCache.set(k, getJSON(`${GEOCODE.replace('/search', '/reverse')}?lon=${lng}&lat=${lat}&index=address&limit=1`, { timeout: 10000, retries: 1 })
      .then((fc) => {
        const f = (fc.features || [])[0];
        if (!f) return null;
        const p = f.properties;
        return { label: p.label, rue: [p.housenumber, p.street || p.name].filter(Boolean).join(' '), distance: Math.round(p.distance || 0) };
      })
      .catch(() => null));
  }
  return adrCache.get(k);
}
/** Adresses d'une liste de points, 6 requêtes à la fois. */
export async function adresses(points, onProgress) {
  const out = new Array(points.length);
  let i = 0, done = 0;
  async function w() { while (i < points.length) { const j = i++; out[j] = await adresseAt(points[j][0], points[j][1]); done++; onProgress && onProgress(done, points.length); } }
  await Promise.all([w(), w(), w(), w(), w(), w()]);
  return out;
}
