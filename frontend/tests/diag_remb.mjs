// Pourquoi le remembrement disparaît à La Riche : comptes détaillés avec différents critères
import { chromium } from 'playwright';
const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('https://fonciscope.github.io/#14/47.39/0.66', { waitUntil: 'load' });
await page.waitForTimeout(2500);
for (const crit of [{ commune: 'La Riche', zones: ['UA', 'UAa'] }, { commune: 'La Riche' }]) {
  const r = await page.evaluate(async (crit) => {
    const pro = window.tfDebug().pro;
    const res = await pro.lancer(crit);
    const R = pro.results;
    const g = R.list.filter((h) => h.groupe), ga = R.attente.filter((h) => h.groupe);
    return { crit, appliques: res.criteres_appliques, ecartees: res.ecartees, compte: R.compte, liste: R.list.length, groupes_liste: g.length, groupes_attente: ga.length,
      estim_groupes_attente: ga.slice(0, 10).map((h) => [Math.round(h.occ.S), h.estim ? h.estim.lg : null, h.zone.properties.libelle]),
      densites: R.densites ? { commune: R.densites.commune, zones: [...R.densites.zones.entries()] } : null, avert: R.avertissements };
  }, crit).catch((e) => ({ erreur: e.message }));
  console.log('DIAG', JSON.stringify(r));
}
await b.close();
