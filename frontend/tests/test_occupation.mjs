// Tests des règles de classification et de notation (sans réseau). Lancer : node frontend/tests/test_occupation.mjs
import assert from 'node:assert/strict';
const { batiStats, classer } = await import('../js/occupation.js');
const { noter } = await import('../js/score.js');

const b = (p, aire) => ({ p: { construction_legere: false, ...p }, aire });
const maison = b({ usage_1: 'Résidentiel', nombre_de_logements: 1, nombre_d_etages: 2, hauteur: 6, date_d_apparition: '1985-01-01Z' }, 110);
const garage = (n) => Array.from({ length: n }, () => b({ usage_1: 'Annexe', nombre_de_logements: 0, nombre_d_etages: 1, hauteur: 2.5 }, 18));
const immeuble = b({ usage_1: 'Résidentiel', nombre_de_logements: 24, nombre_d_etages: 5, hauteur: 16, date_d_apparition: '1972-01-01Z' }, 450);
const recente = b({ usage_1: 'Résidentiel', nombre_de_logements: 1, nombre_d_etages: 2, hauteur: 6, date_d_apparition: '2019-01-01Z' }, 120);
const hangar = b({ usage_1: 'Industriel', nature: 'Industriel, agricole ou commercial', nombre_de_logements: 0, nombre_d_etages: 1, hauteur: 8 }, 900);

const cas = [
  ['terrain nu', 2000, [], {}, 'terrain_nu'],
  ['maison sur grand terrain', 2400, [maison, ...garage(1)], {}, 'maison_grand'],
  ['petite maison', 600, [maison], {}, 'maison'],
  ['ensemble de garages', 900, garage(8), {}, 'garages'],
  ['immeuble collectif', 3000, [immeuble], {}, 'collectif'],
  ['hangar', 4000, [hangar], {}, 'activite'],
  ['parking', 1800, [], { parkingPart: 0.8 }, 'parking'],
  ['friche', 5000, [hangar], { friche: { nom: 'Ateliers', statut: 'friche sans projet' } }, 'friche'],
  ['école', 6000, [hangar], { equipement: 'Enseignement primaire' }, 'equipement'],
];
for (const [nom, S, items, ctx, attendu] of cas) {
  const r = classer(S, batiStats(items), ctx);
  assert.equal(r.cle, attendu, `${nom} : attendu ${attendu}, obtenu ${r.cle}`);
  console.log('ok', nom, '→', r.label, '|', r.raisons.join(' ; '));
}
const rec = classer(1500, batiStats([recente]), {});
assert.ok(rec.flags.some((f) => f.k === 'recent'), 'bâti récent signalé');

// Notation : une maison sur grand terrain doit battre un immeuble collectif, à potentiel égal
const crit = { smin: 1500, smax: 1e9, lmin: 30, lmax: 50 };
const pot = { ok: true, real: 40, sdp: 2600 };
const occM = classer(2400, batiStats([maison]), {}); occM.stats = batiStats([maison]);
const occC = classer(3000, batiStats([immeuble]), {}); occC.stats = batiStats([immeuble]);
const sM = noter({ S: 2400, crit, occ: occM, pot, contraintes: [] });
const sC = noter({ S: 3000, crit, occ: occC, pot, contraintes: [] });
console.log('maison', sM.tot, '| collectif', sC.tot);
assert.ok(sM.tot > sC.tot + 20, 'la maison passe nettement devant le collectif');
const sP = noter({ S: 2400, crit, occ: occM, pot: null, contraintes: [] });
assert.equal(sP.partiel, true); assert.ok(sP.tot > 0 && sP.tot <= 100);
const sE = noter({ S: 2400, crit, occ: occM, pot, contraintes: [{ k: 'ebc', t: 'EBC', part: 0.5, malus: 6 }] });
assert.ok(sE.tot < sM.tot, 'un EBC fait baisser la note');
console.log('tous les tests passent');
