// Nature du foncier : ce qui se trouve réellement sur une parcelle.
// Sources : bâtiments BD TOPO (usage, logements, étages, hauteur, date d'apparition), parkings BD TOPO,
// zones d'activité ou d'intérêt BD TOPO (équipements publics), friches Cartofriches.
/* global turf */

export const NATURES = {
  terrain_nu: { label: 'Terrain nu', opp: true },
  friche: { label: 'Friche', opp: true },
  parking: { label: 'Parking extérieur', opp: true },
  garages: { label: 'Ensemble de garages', opp: true },
  garage: { label: 'Garage ou annexe isolé', opp: true },
  maison_grand: { label: 'Maison sur grand terrain', opp: true },
  maison: { label: 'Maison individuelle', opp: true },
  activite: { label: 'Bâtiment commercial ou industriel', opp: true },
  petit_collectif: { label: 'Petit collectif (3-4 logements)', opp: false },
  collectif: { label: 'Immeuble collectif', opp: false },
  equipement: { label: 'Équipement public', opp: false },
  autre: { label: 'Bâti non qualifié', opp: true },
};

// Catégories d'équipements BD TOPO qui ne sont pas des opportunités foncières
const EQUIP_PUBLIC = /^(Science et enseignement|Santé|Administratif ou militaire|Religieux|Sport|Gestion des eaux|Transport)/i;
const RESIDENTIEL = /r[ée]sidentiel/i;
const ACTIVITE = /commercial|industriel|agricole/i;

const year = (d) => { const y = parseInt(String(d || '').slice(0, 4), 10); return Number.isFinite(y) ? y : null; };

/** Statistiques du bâti d'une parcelle à partir des bâtiments qui s'y trouvent (avec leur surface au sol). */
export function batiStats(items) {
  const st = { n: 0, emprise: 0, sdp: 0, logements: 0, logInconnus: 0, etagesMax: 0, hMax: 0, anneeMax: null, annexes: 0, annexeEmprise: 0, residEmprise: 0, actEmprise: 0, legers: 0, legerEmprise: 0, liste: [] };
  for (const { p, aire } of items) {
    const usage = `${p.usage_1 || ''} ${p.usage_2 || ''}`;
    const etages = Math.max(1, +p.nombre_d_etages || 1);
    const leger = p.construction_legere === true;
    st.n++;
    st.liste.push({ aire, usage: p.usage_1 || p.nature || 'Indifférencié', logements: p.nombre_de_logements ?? null, etages: p.nombre_d_etages ?? null, hauteur: p.hauteur ?? null, annee: year(p.date_d_apparition), leger });
    if (leger) { st.legers++; st.legerEmprise += aire; continue; }
    st.emprise += aire;
    st.sdp += aire * etages;
    if (p.nombre_de_logements === null || p.nombre_de_logements === undefined) { if (RESIDENTIEL.test(usage)) st.logInconnus++; } else st.logements += +p.nombre_de_logements;
    st.etagesMax = Math.max(st.etagesMax, +p.nombre_d_etages || 0);
    st.hMax = Math.max(st.hMax, +p.hauteur || 0);
    const y = year(p.date_d_apparition);
    if (y && (RESIDENTIEL.test(usage) || ACTIVITE.test(usage))) st.anneeMax = Math.max(st.anneeMax || 0, y);
    const annexe = /annexe/i.test(p.usage_1 || '') || (!RESIDENTIEL.test(usage) && !ACTIVITE.test(usage) && !(+p.nombre_de_logements) && aire < 45);
    if (annexe) { st.annexes++; st.annexeEmprise += aire; }
    if (RESIDENTIEL.test(p.usage_1 || '')) st.residEmprise += aire;
    if (ACTIVITE.test(p.usage_1 || '') || /industriel/i.test(p.nature || '')) st.actEmprise += aire;
  }
  return st;
}

/**
 * Classe une parcelle. Fonction pure (testable) :
 * @param S surface de la parcelle (m²)
 * @param st statistiques du bâti (batiStats)
 * @param ctx { parkingPart (0-1), equipement (libellé ou null), friche (objet ou null) }
 */
export function classer(S, st, ctx = {}) {
  const raisons = [];
  const ces = S > 0 ? st.emprise / S : 0;
  let cle;
  if (ctx.friche) { cle = 'friche'; raisons.push(`Friche recensée par Cartofriches : ${ctx.friche.nom || ctx.friche.type || 'sans nom'} (${ctx.friche.statut || 'statut inconnu'})`); }
  else if (ctx.equipement) { cle = 'equipement'; raisons.push(`Équipement public : ${ctx.equipement}`); }
  else if (st.emprise < 20 && (ctx.parkingPart || 0) < 0.3) { cle = 'terrain_nu'; raisons.push(st.legers ? `Aucun bâtiment en dur (${st.legers} construction(s) légère(s))` : 'Aucun bâtiment'); }
  else if ((ctx.parkingPart || 0) >= 0.3 && ces < 0.15) { cle = 'parking'; raisons.push(`Parking sur ${Math.round(ctx.parkingPart * 100)} % de la parcelle`); }
  else if (st.logements >= 5 || (st.residEmprise > 0 && st.etagesMax >= 4)) { cle = 'collectif'; raisons.push(`${st.logements || '?'} logements, ${st.etagesMax} étages`); }
  else if (st.actEmprise >= 0.5 * st.emprise) { cle = 'activite'; raisons.push(`Bâtiment d'activité (${Math.round(st.actEmprise)} m² au sol)`); }
  else if (st.annexes >= 3 && st.logements === 0 && st.annexeEmprise >= 0.6 * st.emprise) { cle = 'garages'; raisons.push(`${st.annexes} annexes ou boxes, aucun logement`); }
  else if (st.annexes >= 1 && st.logements === 0 && st.residEmprise === 0 && st.annexeEmprise >= 0.6 * st.emprise) { cle = 'garage'; raisons.push('Annexe sans logement'); }
  else if (st.logements >= 3) { cle = 'petit_collectif'; raisons.push(`${st.logements} logements`); }
  else if (st.residEmprise > 0 && st.logements <= 2) {
    cle = S >= 1000 ? 'maison_grand' : 'maison';
    raisons.push(`${st.logements || 1} logement(s), ${st.etagesMax || 1} niveau(x)${S >= 1000 ? `, terrain de ${Math.round(S)} m²` : ''}`);
  } else { cle = 'autre'; raisons.push('Usage du bâti non précisé dans la BD TOPO'); }

  const flags = [];
  if (st.anneeMax && st.anneeMax >= 2010) flags.push({ k: 'recent', t: `Bâti récent (apparu en ${st.anneeMax})` });
  if (st.emprise >= 20 && ces < 0.15 && S >= 800 && !['collectif', 'equipement'].includes(cle)) flags.push({ k: 'sous_exploite', t: `Sous-exploitée : ${Math.round(ces * 100)} % d'emprise bâtie` });
  if ((ctx.parkingPart || 0) >= 0.1 && cle !== 'parking') flags.push({ k: 'parking', t: `Parking sur ${Math.round(ctx.parkingPart * 100)} % de la parcelle` });
  return { cle, label: NATURES[cle].label, opp: NATURES[cle].opp, ces, raisons, flags };
}

// ---------- Rattachement géographique ----------

/** Index simple par grille pour retrouver vite les objets proches d'une emprise. */
export function grille(features, pas = 0.002) {
  const cells = new Map();
  for (const f of features) {
    const b = turf.bbox(f);
    f.__bbox = b;
    for (let x = Math.floor(b[0] / pas); x <= Math.floor(b[2] / pas); x++) {
      for (let y = Math.floor(b[1] / pas); y <= Math.floor(b[3] / pas); y++) {
        const k = `${x}:${y}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(f);
      }
    }
  }
  return {
    pres(b) {
      const out = new Set();
      for (let x = Math.floor(b[0] / pas); x <= Math.floor(b[2] / pas); x++) {
        for (let y = Math.floor(b[1] / pas); y <= Math.floor(b[3] / pas); y++) (cells.get(`${x}:${y}`) || []).forEach((f) => out.add(f));
      }
      return [...out].filter((f) => f.__bbox[0] <= b[2] && f.__bbox[2] >= b[0] && f.__bbox[1] <= b[3] && f.__bbox[3] >= b[1]);
    },
  };
}

/** Bâtiments dont le centre est sur la parcelle (un bâtiment voisin qui touche la limite n'est pas compté). */
export function batimentsDe(parcelle, indexBat) {
  const b = turf.bbox(parcelle);
  return indexBat.pres(b).filter((x) => {
    x.__c = x.__c || turf.pointOnFeature(x);
    return turf.booleanPointInPolygon(x.__c, parcelle);
  }).map((x) => ({ p: x.properties, aire: (x.__a = x.__a || turf.area(x)) }));
}

/** Part de la parcelle couverte par des parkings (0 à 1). */
export function partParking(parcelle, indexPark, S) {
  let a = 0;
  for (const k of indexPark.pres(turf.bbox(parcelle))) {
    try { const x = turf.intersect(turf.featureCollection([k, parcelle])); if (x) a += turf.area(x); } catch { /* géométrie invalide ignorée */ }
  }
  return Math.min(1, S > 0 ? a / S : 0);
}

/** Libellé de l'équipement public qui contient le centre de la parcelle, ou null. */
export function equipementDe(parcelle, indexEq) {
  const c = turf.pointOnFeature(parcelle);
  for (const z of indexEq.pres(turf.bbox(parcelle))) {
    const p = z.properties;
    if (!EQUIP_PUBLIC.test(p.categorie || '')) continue;
    try { if (turf.booleanPointInPolygon(c, z)) return `${p.nature || p.categorie}${p.toponyme ? ' — ' + p.toponyme : ''}`; } catch { /* ignoré */ }
  }
  return null;
}

/** Analyse complète d'une parcelle à partir des index déjà chargés. */
export function analyser(parcelle, idx, frichesParIdu) {
  const S = +parcelle.properties.contenance || turf.area(parcelle);
  const st = batimentsDe(parcelle, idx.bat);
  const stats = batiStats(st);
  const ctx = {
    parkingPart: idx.park ? partParking(parcelle, idx.park, S) : 0,
    equipement: idx.eq ? equipementDe(parcelle, idx.eq) : null,
    friche: frichesParIdu ? frichesParIdu.get(parcelle.properties.idu) || null : null,
  };
  return { S, stats, ctx, ...classer(S, stats, ctx) };
}
