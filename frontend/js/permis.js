/* global turf */
// Constructions récentes autour d'une parcelle : permis de logements (Sitadel), localisés par leur parcelle cadastrale,
// synthèse par promoteur et comparaison avec le potentiel de la parcelle étudiée.
import * as api from './api.js';

const geoCache = new Map();
/** Centre de la première parcelle trouvée d'un permis (référence cadastrale déclarée dans le permis). */
async function centrePermis(p) {
  for (const c of p.parcelles.slice(0, 3)) {
    const k = `${p.insee}|${c.section}|${c.numero}`;
    if (!geoCache.has(k)) geoCache.set(k, api.parcelleByRef(p.insee, c.section, c.numero).catch(() => null));
    const f = await geoCache.get(k);
    if (f) return { centre: turf.centroid(f).geometry.coordinates, parcelle: f };
  }
  return null;
}

/** Localise une liste de permis (4 à la fois). */
export async function localiser(list, { onProgress } = {}) {
  let i = 0, done = 0;
  async function worker() {
    while (i < list.length) {
      const p = list[i++];
      if (p.centre === undefined) {
        const r = await centrePermis(p);
        p.centre = r ? r.centre : null;
        p.surfParcelle = r ? +r.parcelle.properties.contenance || null : null;
      }
      done++;
      onProgress && onProgress(done, list.length);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return list;
}

const mediane = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Densité d'une opération en logements par hectare (terrain déclaré au permis, sinon parcelle cadastrale). */
export function densite(p) {
  const t = p.terrain > 0 && p.terrain < 200000 ? p.terrain : p.surfParcelle;
  return t && t > 100 ? (p.logements * 10000) / t : null;
}

export function synthese(list) {
  const ok = list.filter((p) => p.etat !== 4);
  const promo = new Map();
  for (const p of ok) {
    const k = p.siren || p.demandeur || 'Particulier ou non publié';
    const e = promo.get(k) || { nom: p.demandeur || 'Particulier ou non publié', siren: p.siren, ops: 0, logements: 0, collectifs: 0, sociaux: 0, derniere: '' };
    e.ops++; e.logements += p.logements; e.collectifs += p.collectifs; e.sociaux += p.sociaux;
    if ((p.autorisation || '') > e.derniere) e.derniere = p.autorisation || '';
    promo.set(k, e);
  }
  const col = ok.filter((p) => p.collectifs >= 5);
  return {
    ops: ok.length, annules: list.length - ok.length,
    logements: ok.reduce((a, p) => a + p.logements, 0),
    collectifs: ok.reduce((a, p) => a + p.collectifs, 0),
    sociaux: ok.reduce((a, p) => a + p.sociaux, 0),
    termines: ok.filter((p) => p.etat === 6).length, chantiers: ok.filter((p) => p.etat === 5).length, autorises: ok.filter((p) => p.etat === 2).length,
    densiteMed: mediane(col.map(densite)), lgtMed: mediane(col.map((p) => p.collectifs)), nivMed: mediane(col.map((p) => p.niveaux).filter((n) => n > 0)),
    shabMed: mediane(col.filter((p) => p.logements).map((p) => p.shab / p.logements)),
    promoteurs: [...promo.values()].sort((a, b) => b.logements - a.logements),
  };
}

/** Distance en mètres entre la parcelle étudiée et chaque opération localisée. */
export function distances(list, pt) {
  for (const p of list) p.dist = p.centre ? turf.distance(pt, p.centre, { units: 'meters' }) : null;
  return list;
}
