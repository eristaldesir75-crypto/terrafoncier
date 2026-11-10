/* global turf */
// Remembrement : regroupements de 2 à 4 parcelles voisines (limite commune réelle), dans la même zone du PLU,
// qui ensemble atteignent la surface visée et forment un terrain assez compact pour un collectif.

/** Clé d'un sommet arrondi à ~10 cm : deux parcelles voisines du cadastre partagent les mêmes sommets. */
const cle = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

function sommets(geom) {
  const out = [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const poly of polys) for (const ring of poly) for (const p of ring) out.push(p);
  return out;
}

/**
 * Voisinage entre parcelles : deux parcelles sont voisines si elles partagent au moins 2 sommets
 * espacés d'au moins `minFacade` mètres (une vraie limite commune, pas un simple coin).
 * @param items [{ f, ... }]
 * @returns Array<Map<index, longueurCommune>>
 */
export function voisinages(items, minFacade = 4) {
  const parSommet = new Map();
  items.forEach((it, i) => {
    const vus = new Set();
    for (const p of sommets(it.f.geometry)) {
      const k = cle(p);
      if (vus.has(k)) continue;
      vus.add(k);
      let l = parSommet.get(k);
      if (!l) { l = []; parSommet.set(k, l); }
      l.push(i);
    }
  });
  const communs = new Map(); // "i|j" -> [sommets partagés]
  for (const [k, l] of parSommet) {
    if (l.length < 2 || l.length > 6) continue;
    for (let a = 0; a < l.length; a++) {
      for (let b = a + 1; b < l.length; b++) {
        const i = Math.min(l[a], l[b]), j = Math.max(l[a], l[b]), kk = `${i}|${j}`;
        let s = communs.get(kk);
        if (!s) { s = []; communs.set(kk, s); }
        if (s.length < 40) s.push(k.split(',').map(Number));
      }
    }
  }
  const voisins = items.map(() => new Map());
  for (const [kk, pts] of communs) {
    if (pts.length < 2) continue;
    let longueur = 0;
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) longueur = Math.max(longueur, turf.distance(pts[a], pts[b], { units: 'meters' }));
    if (longueur < minFacade) continue;
    const [i, j] = kk.split('|').map(Number);
    voisins[i].set(j, longueur); voisins[j].set(i, longueur);
  }
  return voisins;
}

/**
 * Regroupements candidats : ensembles connexes de 2 à `maxParcelles` parcelles de la même zone,
 * dont la surface totale atteint `smin` (sans dépasser `smax`), arrêtés dès que la surface est atteinte.
 * @returns Array<number[]> indices des parcelles de chaque regroupement
 */
export function regroupements(items, voisins, { smin, smax, maxParcelles = 3, maxGroupes = 6000 }) {
  const vus = new Set(), out = [];
  const S = (g) => g.reduce((a, i) => a + items[i].S, 0);
  for (let seed = 0; seed < items.length && out.length < maxGroupes; seed++) {
    const z = items[seed].zoneLib;
    const pile = [[seed]];
    while (pile.length && out.length < maxGroupes) {
      const g = pile.pop();
      // voisins du groupe, même zone, classés par longueur de limite commune
      const front = new Map();
      for (const i of g) for (const [j, l] of voisins[i]) if (!g.includes(j) && items[j].zoneLib === z) front.set(j, Math.max(front.get(j) || 0, l));
      // parcelles avec façade sur rue d'abord, puis par longueur de limite commune
      const cands = [...front.entries()].sort((a, b) => ((items[b[0]].facade || 0) >= 4) - ((items[a[0]].facade || 0) >= 4) || b[1] - a[1]).slice(0, 4).map((x) => x[0]);
      for (const j of cands) {
        const g2 = [...g, j].sort((a, b) => a - b), k = g2.join('|');
        if (vus.has(k)) continue;
        vus.add(k);
        const s = S(g2);
        if (smax && s > smax) continue;
        if (s >= smin) out.push(g2);
        else if (g2.length < maxParcelles) pile.push(g2);
      }
    }
  }
  return out;
}

/** Terrain réuni : géométrie fusionnée (un seul polygone), ou null si les parcelles ne forment pas un seul tenant. */
export function fusion(features) {
  let u = null;
  try { u = turf.union(turf.featureCollection(features)); } catch { u = null; }
  if (!u) return null;
  if (u.geometry.type === 'MultiPolygon') {
    // micro-interstices du cadastre : on garde le plus grand morceau s'il porte l'essentiel de la surface
    const parts = u.geometry.coordinates.map((c) => turf.polygon(c));
    const aires = parts.map((p) => turf.area(p)), tot = aires.reduce((a, b) => a + b, 0), max = Math.max(...aires);
    if (max < 0.97 * tot) return null;
    u = parts[aires.indexOf(max)];
  }
  return u;
}

/** Garde au plus `parParcelle` regroupements par parcelle, les mieux notés d'abord (évite 20 variantes du même îlot). */
export function sansDoublons(groupes, parParcelle = 2) {
  const n = new Map(), out = [];
  for (const g of groupes) {
    if (g.membres.some((m) => (n.get(m.f.properties.idu) || 0) >= parParcelle)) continue;
    g.membres.forEach((m) => n.set(m.f.properties.idu, (n.get(m.f.properties.idu) || 0) + 1));
    out.push(g);
  }
  return out;
}

/**
 * Façade sur rue de chaque parcelle : longueur des côtés qui ne sont partagés avec aucune autre parcelle
 * (limite avec la voie ou le domaine public). Deux parcelles voisines du cadastre partagent les mêmes sommets :
 * un côté est mitoyen si ses deux extrémités appartiennent aussi à une même autre parcelle.
 * @param features toutes les parcelles du secteur
 * @returns Map idu -> mètres de façade
 */
export function facadesSurRue(features) {
  const parSommet = new Map();
  features.forEach((f, i) => {
    if (!f.geometry) return;
    for (const p of sommets(f.geometry)) {
      const k = cle(p);
      let s = parSommet.get(k);
      if (!s) { s = new Set(); parSommet.set(k, s); }
      s.add(i);
    }
  });
  const out = new Map();
  features.forEach((f, i) => {
    if (!f.geometry) return;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    let rue = 0;
    for (const poly of polys) {
      const ring = poly[0];
      for (let j = 0; j < ring.length - 1; j++) {
        const a = parSommet.get(cle(ring[j])), b = parSommet.get(cle(ring[j + 1]));
        let mitoyen = false;
        if (a && b) for (const x of a) if (x !== i && b.has(x)) { mitoyen = true; break; }
        if (!mitoyen) rue += turf.distance(ring[j], ring[j + 1], { units: 'meters' });
      }
    }
    out.set(f.properties.idu, Math.round(rue * 10) / 10);
  });
  return out;
}
