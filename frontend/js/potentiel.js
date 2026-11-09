// Calcul du potentiel constructible : le minimum de plusieurs plafonds, chacun issu d'une règle.
// Une règle absente ne bloque que son propre plafond, jamais remplacée par une valeur supposée.
/* global turf */

export const RULE_FIELDS = [
  { k: 'ces', label: "Emprise au sol max (%)", unit: '%', pct: true },
  { k: 'h', label: 'Hauteur max (m)', unit: 'm' },
  { k: 'recul', label: 'Recul sur voie (m)', unit: 'm' },
  { k: 'ret', label: 'Retrait limites séparatives (m)', unit: 'm' },
  { k: 'pt', label: 'Pleine terre min (%)', unit: '%', pct: true },
  { k: 'stat', label: 'Places de stationnement / logement', unit: 'pl.' },
];

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(+v) ? null : +v);

/**
 * @param feature  Parcelle GeoJSON (Polygon/MultiPolygon, WGS84)
 * @param rules    { ces, h, recul, ret, pt, stat } — ces et pt en fraction (0.4)
 * @param hyp      { hEt, k, sMoy, sLot }
 * @param opts     { contenance, batiSdp, constructible }
 */
export function computePotentiel(feature, rules, hyp, opts = {}) {
  if (opts.constructible === false) return { ok: false, raison: 'Zone non constructible pour du logement (A ou N)' };
  const r = Object.fromEntries(RULE_FIELDS.map((f) => [f.k, num(rules && rules[f.k])]));
  if (r.ces === null && r.h === null) return { ok: false, raison: "Règles d'emprise et de hauteur manquantes : saisissez-les ou lancez l'extraction IA" };

  const S = num(opts.contenance) || turf.area(feature);
  // Enveloppe : retrait sur toutes les limites (approximation), puis recul supplémentaire côté voie estimé sur la façade.
  const retrait = r.ret ?? 0;
  let envFeat = null, envArea = S;
  try {
    envFeat = retrait > 0 ? turf.buffer(feature, -retrait, { units: 'meters' }) : feature;
    envArea = envFeat ? turf.area(envFeat) : 0;
  } catch { envFeat = null; envArea = S; }
  if (r.recul !== null && r.recul > retrait && envArea > 0) {
    const facade = Math.sqrt(envArea); // estimation : façade ≈ côté d'un carré équivalent
    envArea = Math.max(0, envArea - (r.recul - retrait) * facade);
  }

  const caps = [{ n: 'Enveloppe après reculs', v: envArea }];
  if (r.ces !== null) caps.push({ n: "Emprise réglementaire (CES)", v: r.ces * S });
  if (r.pt !== null) caps.push({ n: 'Terrain hors pleine terre', v: S * (1 - r.pt) });
  const lim = caps.reduce((a, b) => (b.v < a.v ? b : a));
  const E = Math.max(0, lim.v);

  const missing = RULE_FIELDS.filter((f) => r[f.k] === null).map((f) => f.label);
  const niv = r.h !== null ? Math.max(1, Math.floor(r.h / hyp.hEt)) : 1;
  const sdp = E * niv * hyp.k;
  // Nombre de logements = surface de plancher / ratio (60 m² par défaut, réglable)
  const lg = Math.floor(sdp / hyp.sMoy);

  const contraintes = [];
  if (r.h === null) contraintes.push({ t: 'Hauteur inconnue : calcul limité à un niveau', d: 0 });
  if (opts.batiSdp > 0) contraintes.push({ t: `Bâti existant (≈ ${Math.round(opts.batiSdp)} m² de plancher) à démolir ou intégrer`, d: 0.05 });
  const compact = envArea > 0 ? (4 * Math.PI * turf.area(feature)) / Math.pow(turf.length(turf.polygonToLine(feature), { units: 'meters' }), 2) : 0;
  if (compact && compact < 0.35) contraintes.push({ t: 'Forme peu compacte (parcelle étroite ou en lanière)', d: 0.2 });
  if (r.stat !== null && lg > 0) {
    const besoin = lg * r.stat * 25, libre = S - E - (r.pt || 0) * S;
    if (besoin > libre) contraintes.push({ t: `Stationnement : ${Math.ceil(lg * r.stat)} places ne tiennent pas en surface, sous-sol à prévoir`, d: 0 });
  }
  const dec = Math.min(0.6, contraintes.reduce((a, c) => a + c.d, 0));

  const sc = [
    { n: 'Collectif maximal', niv, sdp, lg },
    { n: 'Intermédiaire (R+2 max)', niv: Math.min(3, niv), sdp: E * Math.min(3, niv) * hyp.k, lg: Math.floor((E * Math.min(3, niv) * hyp.k) / hyp.sMoy) },
    { n: `Individuel (lots de ${hyp.sLot} m²)`, niv: Math.min(2, niv), sdp: null, lg: Math.floor(S / hyp.sLot) },
  ];
  return { ok: true, S, r, envFeat, envArea, caps, lim, E, niv, sdp, lg, real: lg, contraintes, dec, sc, missing };
}

/** Score sur 100 pour la prospection. */
export function scoreTerrain({ pot, cible, zoneType, ownerKnown, batiRatio = 0, verifiedRules = false }) {
  const { lmin, lmax } = cible;
  const real = pot.real;
  // dans la fourchette : 35 ; au-dessus : la note baisse avec l'écart (un terrain 10 fois trop grand n'est pas la cible) ; en dessous : au prorata
  const programme = real >= lmin && real <= lmax ? 35 : real > lmax ? Math.max(5, Math.round((35 * lmax) / real)) : Math.round((35 * real) / Math.max(1, lmin));
  const regles = (verifiedRules ? 12 : 8) + (zoneType === 'U' ? 8 : zoneType && zoneType.startsWith('AU') ? 6 : 0);
  const maitrise = ownerKnown ? 15 : 8;
  const bati = Math.round(10 * Math.max(0, 1 - batiRatio * 3));
  const forme = pot.contraintes.some((c) => c.t.startsWith('Forme')) ? 0 : 15;
  const missingPenalty = Math.min(10, pot.missing.length * 2);
  const det = { Programme: programme, Règles: regles - missingPenalty, Maîtrise: maitrise, Forme: forme, Bâti: bati };
  const tot = Math.max(0, Object.values(det).reduce((a, b) => a + b, 0));
  return { tot, det };
}

/** Lit une requête en français : « 30 à 50 logements … plus de 1 500 m² ». */
export function parseQuery(q) {
  const s = (q || '').replace(/ | /g, ' ');
  const lg = s.match(/(\d+)\s*(?:à|a|-|–)\s*(\d+)\s*logements?/i) || s.match(/(\d+)\s*logements?/i);
  const su = s.match(/(\d[\d .]*)\s*m(?:²|2)(?!\w)/i);
  return {
    lmin: lg ? +lg[1] : 10,
    lmax: lg && lg[2] ? +lg[2] : lg ? +lg[1] * 2 : 100000,
    smin: su ? +su[1].replace(/[ .]/g, '') : 1000,
  };
}
