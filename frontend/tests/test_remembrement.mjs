// Test du remembrement avec la vraie bibliothèque Turf (npm i @turf/turf)
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
globalThis.turf = turf;
const { voisinages, regroupements, fusion, sansDoublons } = await import('../js/remembrement.js');

// Lotissement de 3 × 2 parcelles carrées de ~20 m (0.00027° de longitude ≈ 20 m à 47° N), plus une parcelle isolée
const dx = 0.00027, dy = 0.00018, x0 = 1.86, y0 = 47.95;
const carre = (i, j, props) => turf.polygon([[[x0 + i * dx, y0 + j * dy], [x0 + (i + 1) * dx, y0 + j * dy], [x0 + (i + 1) * dx, y0 + (j + 1) * dy], [x0 + i * dx, y0 + (j + 1) * dy], [x0 + i * dx, y0 + j * dy]]], props);
const items = [];
for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) {
  const f = carre(i, j, { idu: `P${i}${j}`, section: 'AB', numero: `${i}${j}` });
  items.push({ f, S: turf.area(f), zoneLib: 'UB' });
}
const isolee = carre(10, 10, { idu: 'ISO', section: 'AB', numero: '99' });
items.push({ f: isolee, S: turf.area(isolee), zoneLib: 'UB' });
// une parcelle d'une autre zone, collée au lotissement
const autre = carre(3, 0, { idu: 'AUTRE', section: 'AB', numero: '30' });
items.push({ f: autre, S: turf.area(autre), zoneLib: 'N' });

const S1 = items[0].S;
console.log('surface d\'une parcelle', Math.round(S1), 'm²');
const v = voisinages(items);
// P00 (0) : voisins P10 (1) et P01 (3) ; pas P11 (4), qui ne touche que par un coin
assert.deepEqual([...v[0].keys()].sort(), [1, 3]);
assert.ok(!v[0].has(4), 'un simple coin ne fait pas un voisin');
assert.equal(v[6].size, 0, 'parcelle isolée sans voisin');
assert.ok(v[2].has(7), 'la parcelle de la zone N touche P20');

// Regroupements atteignant ~2,5 parcelles de surface : 3 parcelles connexes, même zone, jamais la parcelle N
const groupes = regroupements(items, v, { smin: 2.5 * S1, smax: 0, maxParcelles: 3 });
assert.ok(groupes.length > 0);
for (const g of groupes) {
  assert.equal(g.length, 3);
  assert.ok(!g.includes(7), 'pas de mélange de zones');
  assert.ok(!g.includes(6), 'pas de parcelle isolée');
}
console.log(groupes.length, 'regroupements de 3 parcelles :', groupes.map((g) => g.map((i) => items[i].f.properties.idu).join('+')).join(' ; '));
// pas de regroupement si la surface est atteignable en 2 : arrêt dès la surface atteinte
const g2 = regroupements(items, v, { smin: 1.5 * S1, smax: 0, maxParcelles: 4 });
assert.ok(g2.every((g) => g.length === 2));

// Fusion : un seul polygone, surface conservée
const u = fusion(groupes[0].map((i) => items[i].f));
assert.ok(u && u.geometry.type === 'Polygon');
assert.ok(Math.abs(turf.area(u) - 3 * S1) < 1);
assert.equal(fusion([items[0].f, isolee]), null, 'deux parcelles éloignées ne forment pas un terrain');

// Doublons : au plus 2 regroupements par parcelle
const objets = groupes.map((g, k) => ({ s: { tot: 100 - k }, membres: g.map((i) => items[i]) }));
const gardes = sansDoublons(objets, 2);
const compte = {};
gardes.forEach((g) => g.membres.forEach((m) => (compte[m.f.properties.idu] = (compte[m.f.properties.idu] || 0) + 1)));
assert.ok(Object.values(compte).every((n) => n <= 2));
console.log('test_remembrement : OK');

// Façades sur rue : rangée de 3 parcelles le long d'une rue (côté sud), une 4e derrière la parcelle du milieu
{
  const { facadesSurRue } = await import('../js/remembrement.js');
  // carrés de dx × dy en degrés
  const cs = (i, j, idu) => carre(i, j, { idu });
  const fs = [cs(0, 0, 'A'), cs(1, 0, 'B'), cs(2, 0, 'C'), cs(1, 1, 'D')];
  const fac = facadesSurRue(fs);
  const L = (a, b) => turf.distance(a, b, { units: 'meters' });
  const lx = L([x0, y0], [x0 + dx, y0]), ly = L([x0, y0], [x0, y0 + dy]);
  // A : côtés sud, ouest et nord libres (le nord de A n'est pas bordé : D est derrière B seulement)
  assert.ok(Math.abs(fac.get('A') - (lx + ly + lx)) < 0.5, 'A ' + fac.get('A'));
  // B : seul le côté sud est libre (A à l'ouest, C à l'est, D au nord)
  assert.ok(Math.abs(fac.get('B') - lx) < 0.5, 'B ' + fac.get('B'));
  // D : bordée seulement au sud par B
  assert.ok(Math.abs(fac.get('D') - (lx + 2 * ly)) < 0.5, 'D ' + fac.get('D'));
  console.log('façades sur rue : OK', Object.fromEntries(fac));
}
