// Note de potentiel foncier sur 100, détaillée critère par critère pour comprendre la sélection.
/* global turf */

const POIDS_NATURE = {
  terrain_nu: 25, friche: 25, parking: 23, garages: 23, garage: 20, maison_grand: 22, maison: 17,
  activite: 16, autre: 11, petit_collectif: 6, collectif: 2, equipement: 0,
};

// Prescriptions du PLU qui pèsent sur un projet (codes CNIG et libellés)
const PRESC = [
  { k: 'ebc', re: /espace[s]? bois[ée]|EBC/i, codes: ['01'], malus: 6, t: 'Espace boisé classé' },
  { k: 'er', re: /emplacement[s]? r[ée]serv/i, codes: ['05'], malus: 5, t: 'Emplacement réservé' },
  { k: 'patrimoine', re: /patrimoin|[ée]l[ée]ment.*(paysag|bâti)|paysag.*prot[ée]g/i, codes: ['07'], malus: 3, t: 'Élément de patrimoine ou de paysage protégé' },
  { k: 'oap', re: /orientation[s]? d'am[ée]nagement|\bOAP\b/i, codes: ['18'], malus: 0, t: "Secteur d'OAP" },
];

/** Prescriptions surfaciques qui couvrent une part significative de la parcelle. */
export function contraintesDe(parcelle, indexPresc, S) {
  const out = [];
  if (!indexPresc) return out;
  for (const pz of indexPresc.pres(turf.bbox(parcelle))) {
    const p = pz.properties;
    const lib = `${p.libelle || ''} ${p.txt && p.txt !== 'nr' ? p.txt : ''}`;
    const def = PRESC.find((d) => d.codes.includes(String(p.typepsc)) || d.re.test(lib));
    if (!def) continue;
    let a = 0;
    try { const x = turf.intersect(turf.featureCollection([pz, parcelle])); a = x ? turf.area(x) : 0; } catch { a = 0; }
    if (a >= 50 || a >= 0.1 * S) out.push({ k: def.k, t: def.t, libelle: p.libelle || def.t, part: Math.min(1, a / S), malus: def.malus });
  }
  // une seule ligne par type
  return [...new Map(out.map((c) => [c.k, c])).values()];
}

/**
 * @param o { S, crit:{smin,smax,lmin,lmax}, occ (occupation.analyser), pot (computePotentiel ou null), contraintes, compacite }
 * @returns { tot, partiel, parts:[{k, label, v, max, why}] }
 */
export function noter(o) {
  const parts = [];
  const { S, crit, occ, pot } = o;

  // 1. Taille du terrain (15)
  const ref = Math.max(crit.smin || 1000, 500);
  const vT = Math.round(15 * Math.min(1, S / (2 * ref)));
  parts.push({ k: 'taille', label: 'Taille', v: vT, max: 15, why: `${Math.round(S).toLocaleString('fr-FR')} m²${S >= 2 * ref ? ', confortable pour une opération' : ''}` });

  // 2. Nature du foncier (25)
  let vN = POIDS_NATURE[occ.cle] ?? 10;
  const recent = occ.flags.find((f) => f.k === 'recent');
  if (recent && !['terrain_nu', 'friche', 'parking'].includes(occ.cle)) vN = Math.max(0, vN - 8);
  parts.push({ k: 'nature', label: 'Nature du foncier', v: vN, max: 25, why: `${occ.label}${recent ? ' ; ' + recent.t.toLowerCase() + ' (−8)' : ''}` });

  // 3. Sous-exploitation (15) : bâti existant rapporté au potentiel réglementaire, sinon emprise bâtie
  let vS, whyS;
  if (pot && pot.ok && pot.sdp > 0) {
    const ratio = Math.min(1, occ.stats.sdp / pot.sdp);
    vS = Math.round(15 * (1 - ratio));
    whyS = `Bâti existant ≈ ${Math.round(occ.stats.sdp)} m² de plancher pour ${Math.round(pot.sdp)} m² possibles (${Math.round(ratio * 100)} %)`;
  } else {
    vS = Math.round(15 * Math.max(0, 1 - occ.ces / 0.5));
    whyS = `Emprise bâtie : ${Math.round(occ.ces * 100)} % du terrain`;
  }
  parts.push({ k: 'sous', label: 'Sous-exploitation', v: vS, max: 15, why: whyS });

  // 4. Potentiel au regard du programme (25) — seulement si les règles de la zone sont connues
  let partiel = false;
  if (pot && pot.ok) {
    const r = pot.real, { lmin, lmax } = crit;
    let v;
    if (r >= lmin && r <= lmax) v = 25;
    else if (r > lmax) v = Math.max(5, Math.round((25 * lmax) / r));
    else v = Math.round((25 * r) / Math.max(1, lmin));
    // Gain net : si le bâti existant consomme déjà plus de la moitié du potentiel, le gain réel fond
    const ratio = Math.min(1, (occ.stats?.sdp || 0) / pot.sdp);
    let net = '';
    if (ratio > 0.5) { v = Math.round(v * (1 - ratio) * 2); net = ` ; le bâti existant en utilise déjà ${Math.round(ratio * 100)} %`; }
    parts.push({ k: 'pot', label: 'Potentiel PLU', v, max: 25, why: `${r} logements réalisables (${Math.round(pot.sdp)} m² de plancher) pour un programme de ${lmin} à ${lmax >= 100000 ? '∞' : lmax}${net}` });
  } else {
    partiel = true;
    parts.push({ k: 'pot', label: 'Potentiel PLU', v: null, max: 25, why: 'Règles de la zone non renseignées : potentiel non calculé' });
  }

  // 5. Contraintes et forme (20)
  let vC = 20;
  const why = [];
  for (const c of o.contraintes || []) {
    if (c.malus) { vC -= c.malus; why.push(`${c.t} sur ${Math.round(c.part * 100)} % (−${c.malus})`); }
  }
  if (o.compacite !== undefined && o.compacite < 0.35) { vC -= 5; why.push('Forme étroite ou en lanière (−5)'); }
  if (occ.flags.some((f) => f.k === 'parking') && occ.cle !== 'parking') why.push('Parking partiel');
  vC = Math.max(0, vC);
  parts.push({ k: 'contraintes', label: 'Contraintes et forme', v: vC, max: 20, why: why.length ? why.join(' ; ') : 'Aucune contrainte du PLU détectée' });

  const got = parts.filter((p) => p.v !== null);
  const sum = got.reduce((a, p) => a + p.v, 0), maxi = got.reduce((a, p) => a + p.max, 0);
  // sans les règles du PLU, la note reste plafonnée : une opportunité confirmée passe devant
  const tot = Math.round((100 * sum) / maxi);
  return { tot: partiel ? Math.min(tot, 85) : tot, partiel, parts };
}

/** Compacité d'une parcelle (1 = disque, proche de 0 = lanière). */
export function compacite(f) {
  try { return (4 * Math.PI * turf.area(f)) / Math.pow(turf.length(turf.polygonToLine(f), { units: 'meters' }), 2); } catch { return 1; }
}
