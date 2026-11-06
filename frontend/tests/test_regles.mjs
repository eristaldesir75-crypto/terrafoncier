import assert from 'node:assert/strict';
import { reglesGraphiques, fusionRegles } from '../js/regles.js';
const P = (typepsc, libelle, txt) => ({ properties: { typepsc, libelle, txt } });
// Données réelles lues au GPU sur Saran 45302 AY 0209 (PLUi Orléans Métropole)
const g = reglesGraphiques([
  P('18', "Secteur d'orientation d'aménagement et de programmation", ''),
  P('39', 'Hauteur maximale au faîtage', '8'),
  P('43', 'Emprise minimale de pleine terre', '20'),
  P('39', "Hauteur maximale à l'égout", '6'),
  P('38', 'Emprise maximale au sol', '50'),
]);
assert.equal(g.ces, 0.5); assert.equal(g.h, 6); assert.equal(g.hFaitage, 8); assert.equal(g.pt, 0.2); assert.equal(g.n, 3);
// valeurs non numériques ignorées, la plus restrictive retenue
const g2 = reglesGraphiques([P('39', 'Hauteur maximale', 'nr'), P('39', 'Hauteur maximale', '12'), P('39', 'Hauteur maximale', '9,5'), P('38', 'Emprise maximale', '150')]);
assert.equal(g2.h, 9.5); assert.equal(g2.ces, null);
// fusion : le plan prime, le reste de la zone est conservé
const f = fusionRegles({ ces: 0.4, h: 12, recul: 5, ret: 3, pt: null, stat: 1 }, g);
assert.deepEqual([f.regles.ces, f.regles.h, f.regles.pt, f.regles.recul], [0.5, 6, 0.2, 5]);
assert.equal(f.origine.ces, 'plan'); assert.equal(f.origine.recul, 'zone');
assert.equal(fusionRegles(null, null).utile, false);
assert.equal(fusionRegles(null, g).utile, true);
console.log('test_regles : OK');
