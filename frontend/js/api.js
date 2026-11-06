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
      if (j && typeof j === 'object' && !Array.isArray(j) && !('features' in j) && (j.message || j.code)) {
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
export async function gpuAt(layer, geom) {
  const fc = await getJSON(`${APICARTO}/gpu/${layer}?geom=${g(geom)}`);
  return fc.features || [];
}
export async function gpuByPartition(layer, partition, { signal } = {}) {
  const out = [];
  for (let start = 0; start < 20000; start += 1000) {
    const fc = await getJSON(`${APICARTO}/gpu/${layer}?partition=${encodeURIComponent(partition)}&_limit=1000&_start=${start}`, { signal, timeout: 40000 });
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
export const CORE_LAYERS = ['document', 'zone-urba', 'secteur-cc'];
export const EXTRA_LAYERS = ['prescription-surf', 'prescription-lin', 'info-surf', 'assiette-sup-s'];
export async function urbanismeAt(geom, layers = [...CORE_LAYERS, ...EXTRA_LAYERS]) {
  const res = await Promise.allSettled(layers.map((l) => gpuAt(l, geom)));
  const o = {};
  layers.forEach((l, i) => { o[l] = res[i].status === 'fulfilled' ? res[i].value : null; });
  return o;
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
