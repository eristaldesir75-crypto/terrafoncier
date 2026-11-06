// Règles de constructibilité de toutes les zones d'un PLU.
// Pour chaque zone du Géoportail de l'Urbanisme : type, description, destinations, lien vers le règlement,
// valeurs fixées par le plan graphique (emprise, hauteur, pleine terre) relevées dans la zone,
// et règles enregistrées par l'utilisateur (saisie ou IA).

const nombre = (t) => {
  const m = String(t ?? '').replace(',', '.').match(/^\s*(\d+(?:\.\d+)?)\s*(%|m)?\s*$/i);
  return m ? +m[1] : null;
};

/** Regroupe zones et prescriptions graphiques par libellé de zone. */
export function reglesParZone(zones, prescriptions) {
  const par = new Map();
  for (const z of zones) {
    if (!z.geometry) continue;
    const p = z.properties, k = p.libelle || '?';
    if (!par.has(k)) {
      par.set(k, {
        libelle: k, libelong: p.libelong || '', typezone: p.typezone || '', urlfic: p.urlfic || '', destdomi: p.destdomi || '',
        destoui: p.destoui || '', destcdt: p.destcdt || '', destnon: p.destnon || '',
        polys: [], surface: 0, ces: new Set(), hEgout: new Set(), hFaitage: new Set(), pt: new Set(), oap: 0,
      });
    }
    const e = par.get(k);
    z.__bbox = z.__bbox || turf.bbox(z);
    e.polys.push(z);
    try { e.surface += turf.area(z); } catch { /* géométrie invalide */ }
  }
  const toutes = [...par.values()];
  for (const ps of prescriptions || []) {
    const p = ps.properties || {}, type = String(p.typepsc || '');
    if (!['38', '39', '43', '18'].includes(type) || !ps.geometry) continue;
    const v = nombre(p.txt);
    if (type !== '18' && v === null) continue;
    let pt;
    try { pt = turf.pointOnFeature(ps); } catch { continue; }
    const [x, y] = pt.geometry.coordinates;
    const e = toutes.find((zz) => zz.polys.some((z) => x >= z.__bbox[0] && x <= z.__bbox[2] && y >= z.__bbox[1] && y <= z.__bbox[3] && turf.booleanPointInPolygon(pt, z)));
    if (!e) continue;
    const lib = String(p.libelle || '');
    if (type === '18') e.oap++;
    else if (type === '38' && /emprise/i.test(lib) && !/pleine terre|libre|vert/i.test(lib) && v > 0 && v <= 100) e.ces.add(v);
    else if (type === '39' && v > 0 && v < 200) (/égout|egout|acrot/i.test(lib) ? e.hEgout : e.hFaitage).add(v);
    else if (type === '43' && v >= 0 && v <= 100) e.pt.add(v);
  }
  const ordre = { U: 0, AU: 1, AUC: 1, AUS: 2, A: 3, N: 4 };
  return toutes
    .map(({ polys, ...e }) => ({ ...e, n: polys.length, ces: [...e.ces].sort((a, b) => a - b), hEgout: [...e.hEgout].sort((a, b) => a - b), hFaitage: [...e.hFaitage].sort((a, b) => a - b), pt: [...e.pt].sort((a, b) => a - b) }))
    .sort((a, b) => (ordre[a.typezone.toUpperCase()] ?? 5) - (ordre[b.typezone.toUpperCase()] ?? 5) || a.libelle.localeCompare(b.libelle, 'fr', { numeric: true }));
}

/** « 50 % », « 30 à 50 % selon secteur », ou null. */
export function plage(vals, unite) {
  if (!vals || !vals.length) return null;
  const f = (x) => `${String(x).replace('.', ',')}${unite === '%' ? ' %' : ' ' + unite}`;
  return vals.length === 1 ? f(vals[0]) : `${String(vals[0]).replace('.', ',')} à ${f(vals[vals.length - 1])} selon secteur`;
}
