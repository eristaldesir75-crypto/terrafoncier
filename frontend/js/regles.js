// Règles lues sur le plan graphique du PLU (prescriptions du Géoportail de l'Urbanisme).
// Certains PLU fixent la hauteur, l'emprise au sol ou la pleine terre sur un plan, secteur par secteur,
// avec la valeur dans le champ « txt » de la prescription (types 38, 39 et 43 du standard CNIG).
// Ces valeurs priment, à la parcelle, sur une valeur saisie pour toute la zone.

const nombre = (t) => {
  const m = String(t ?? '').replace(',', '.').match(/^\s*(\d+(?:\.\d+)?)\s*(%|m)?\s*$/i);
  return m ? +m[1] : null;
};

/** Valeurs lisibles dans une liste de prescriptions : { ces, h, pt, sources: { ces: libellé, ... } }. */
export function reglesGraphiques(prescriptions) {
  const r = { ces: null, h: null, hFaitage: null, hEgout: null, pt: null, sources: {} };
  for (const f of prescriptions || []) {
    const p = f.properties || {};
    const type = String(p.typepsc || ''), lib = String(p.libelle || ''), v = nombre(p.txt);
    if (v === null) continue;
    if (type === '38' && /emprise/i.test(lib) && !/pleine terre|libre|vert/i.test(lib) && v > 0 && v <= 100) {
      if (r.ces === null || v / 100 < r.ces) { r.ces = v / 100; r.sources.ces = `${lib} : ${v} %`; }
    } else if (type === '39' && v > 0 && v < 200) {
      if (/égout|egout|acrot/i.test(lib)) { if (r.hEgout === null || v < r.hEgout) r.hEgout = v; }
      else if (r.hFaitage === null || v < r.hFaitage) r.hFaitage = v;
    } else if (type === '43' && v >= 0 && v <= 100) {
      if (r.pt === null || v / 100 > r.pt) { r.pt = v / 100; r.sources.pt = `${lib} : ${v} %`; }
    }
  }
  // Pour compter les niveaux, la hauteur à l'égout (ou à l'acrotère) est la plus juste ; le faîtage sinon
  if (r.hEgout !== null) { r.h = r.hEgout; r.sources.h = `Hauteur à l'égout : ${r.hEgout} m${r.hFaitage !== null ? ` (faîtage ${r.hFaitage} m)` : ''}`; }
  else if (r.hFaitage !== null) { r.h = r.hFaitage; r.sources.h = `Hauteur maximale : ${r.hFaitage} m`; }
  r.n = ['ces', 'h', 'pt'].filter((k) => r[k] !== null).length;
  return r;
}

/** Prescriptions graphiques qui couvrent le cœur d'une parcelle (point intérieur), via un index grille(). */
export function reglesGraphiquesParcelle(parcelle, indexPresc) {
  if (!indexPresc) return null;
  const pt = turf.pointOnFeature(parcelle);
  const sous = indexPresc.pres(turf.bbox(parcelle)).filter((pz) => {
    if (!['38', '39', '43'].includes(String(pz.properties.typepsc))) return false;
    try { return turf.booleanPointInPolygon(pt, pz); } catch { return false; }
  });
  return reglesGraphiques(sous);
}

/**
 * Règles applicables à une parcelle : règles de la zone (saisies ou extraites), complétées ou remplacées
 * par les valeurs du plan graphique. `origine` indique, champ par champ, d'où vient la valeur.
 */
export function fusionRegles(zone, graph) {
  const r = { ...(zone || {}) }, origine = {};
  ['ces', 'h', 'recul', 'ret', 'pt', 'stat'].forEach((k) => { if (r[k] !== null && r[k] !== undefined && r[k] !== '') origine[k] = 'zone'; });
  if (graph) ['ces', 'h', 'pt'].forEach((k) => { if (graph[k] !== null && graph[k] !== undefined) { r[k] = graph[k]; origine[k] = 'plan'; } });
  ['ces', 'h', 'recul', 'ret', 'pt', 'stat'].forEach((k) => { if (r[k] === undefined || r[k] === '') r[k] = null; });
  return { regles: r, origine, utile: Object.keys(origine).length > 0 };
}
