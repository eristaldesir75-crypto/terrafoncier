// Bilan de faisabilité : mêmes chiffres que l'exemple de référence (parcelle de 418 m², zone UA)
import assert from 'node:assert/strict';
const { bilan, niveauxPct } = await import('../js/faisabilite.js');
assert.deepEqual(niveauxPct(2.8), [100, 100, 80]);
assert.deepEqual(niveauxPct(3), [100, 100, 100]);
const v = { S: 418, inc: 0, ces: 60, a: 16.72, b: 0, d: 15, niv: 2.8, niveaux: null, ratioBrut: 80, ratioHab: 95, taille: 60, social: 0, seuilSocial: 0, placesLgt: 1, m2Place: 60, placeSurf: 20, ptSsol: 20, placeSsol: 30 };
const b = bilan(v);
const r = (x) => Math.round(x);
assert.equal(r(b.empMax), 251); assert.equal(r(b.c * 100) / 100, 16.72); assert.equal(r(b.empCalc), 251); assert.equal(r(b.emp), 251);
assert.equal(r(b.brute), 702); assert.equal(r(b.sdp), 562); assert.equal(r(b.shab), 534);
assert.equal(b.lgt, 9); assert.equal(b.places, 9);
assert.equal(r(b.surfBox), 84); assert.equal(b.placesSurf, 4);
assert.equal(Math.round(b.parNivSsol * 10) / 10, 334.4); assert.equal(b.maxParNiv, 11); assert.equal(b.nivSsol, 1);
console.log('test_faisabilite : OK (emprise 251 m², SDP 562 m², 9 logements, 4 places en surface, 1 niveau de sous-sol)');
