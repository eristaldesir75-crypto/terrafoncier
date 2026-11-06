import assert from 'node:assert/strict';
// turf minimal pour des carrés (le site charge la vraie bibliothèque)
const bb = (f) => { const c = f.geometry.coordinates[0]; const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
globalThis.turf = {
  bbox: bb, area: (f) => { const b = bb(f); return (b[2] - b[0]) * (b[3] - b[1]); },
  pointOnFeature: (f) => { const b = bb(f); return { geometry: { coordinates: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] } }; },
  booleanPointInPolygon: (pt, f) => { const [x, y] = pt.geometry.coordinates, b = bb(f); return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]; },
};
const { reglesParZone, plage } = await import('../js/zones.js');
const sq = (x, y, s, properties) => ({ properties, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] } });
const zones = [sq(0, 0, 10, { libelle: 'UR2', typezone: 'U', libelong: 'résidentiel' }), sq(10, 0, 10, { libelle: 'UR2', typezone: 'U' }), sq(20, 0, 10, { libelle: 'N', typezone: 'N' }), sq(30, 0, 10, { libelle: '1AU', typezone: 'AU' })];
const presc = [
  sq(1, 1, 2, { typepsc: '38', libelle: 'Emprise maximale au sol', txt: '40' }),
  sq(11, 1, 2, { typepsc: '38', libelle: 'Emprise maximale au sol', txt: '30' }),
  sq(1, 5, 2, { typepsc: '39', libelle: "Hauteur maximale à l'égout", txt: '6' }),
  sq(1, 7, 2, { typepsc: '39', libelle: 'Hauteur maximale au faîtage', txt: '9' }),
  sq(31, 1, 2, { typepsc: '43', libelle: 'Emprise minimale de pleine terre', txt: '25' }),
  sq(32, 4, 2, { typepsc: '18', libelle: "Secteur d'OAP", txt: '' }),
  sq(33, 6, 2, { typepsc: '39', libelle: 'Hauteur', txt: 'nr' }),
];
const L = reglesParZone(zones, presc);
assert.deepEqual(L.map((z) => z.libelle), ['UR2', '1AU', 'N']);
const ur = L[0];
assert.equal(ur.n, 2); assert.deepEqual(ur.ces, [30, 40]); assert.deepEqual(ur.hEgout, [6]); assert.deepEqual(ur.hFaitage, [9]);
assert.equal(plage(ur.ces, '%'), '30 à 40 % selon secteur'); assert.equal(plage(ur.hEgout, 'm'), '6 m'); assert.equal(plage([], '%'), null);
assert.deepEqual(L[1].pt, [25]); assert.equal(L[1].oap, 1); assert.deepEqual(L[1].hFaitage, []);
console.log('test_zones : OK');
