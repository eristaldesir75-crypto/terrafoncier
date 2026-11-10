// Diagnostic : terrains proposés par la prospection qui touchent un secteur d'OAP (prescription type 18)
import { chromium } from 'playwright';
const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('https://fonciscope.github.io/#14/47.95/1.87', { waitUntil: 'load' });
await page.waitForTimeout(2500);
const r = await page.evaluate(async () => {
  const api = await import('/js/api.js');
  const pro = window.tfDebug().pro;
  const res = await pro.lancer({ commune: 'Saran', exclure_oap: true });
  const presc = await api.gpuByPartition('prescription-surf', 'DU_244500468');
  const oap = presc.filter((p) => String(p.properties.typepsc) === '18' && p.geometry);
  const info = await api.gpuByPartition('info-surf', 'DU_244500468');
  const infoOap = info.filter((p) => /OAP|orientation/i.test(p.properties.libelle || ''));
  const out = [];
  for (const h of pro.terrains()) {
    let a = 0, dedans = false;
    const pt = turf.pointOnFeature(h.f);
    for (const o of oap) {
      const bb = turf.bbox(o), hb = turf.bbox(h.f);
      if (bb[0] > hb[2] || bb[2] < hb[0] || bb[1] > hb[3] || bb[3] < hb[1]) continue;
      try { const x = turf.intersect(turf.featureCollection([o, h.f])); if (x) a += turf.area(x); } catch { /* */ }
      if (turf.booleanPointInPolygon(pt, o)) dedans = true;
    }
    if (a > 0) out.push({ ref: h.f.properties.idu, S: Math.round(h.occ.S), oap_m2: Math.round(a), pct: Math.round((100 * a) / h.occ.S), point_dedans: dedans, groupe: !!h.groupe, contraintes: h.contraintes.map((c) => c.k) });
  }
  return { crit: res.criteres_appliques.exclure_oap, ecartees: res.ecartees, total: pro.terrains().length, oap: oap.length, infoOap: infoOap.map((x) => x.properties.libelle).slice(0, 10), touchent: out };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
