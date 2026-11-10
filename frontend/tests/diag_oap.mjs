// Diagnostic : comment les OAP de Saran sont publiées au GPU (prescriptions, informations)
import { chromium } from 'playwright';
const b = await chromium.launch(); const page = await b.newPage();
await page.goto('https://fonciscope.github.io/#14/47.95/1.87', { waitUntil: 'load' });
await page.waitForTimeout(2000);
const r = await page.evaluate(async () => {
  const api = await import('/js/api.js');
  const part = 'DU_244500468', out = {};
  for (const l of ['prescription-surf', 'info-surf']) {
    try {
      const f = await api.gpuByPartition(l, part);
      const g = {};
      f.forEach((x) => { const p = x.properties; const k = `${p.typepsc || p.typeinf || ''}|${p.stypepsc || p.stypeinf || ''}|${(p.libelle || '').slice(0, 60)}`; g[k] = (g[k] || 0) + 1; });
      out[l] = { n: f.length, groupes: Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 40) };
    } catch (e) { out[l] = 'ERREUR ' + e.message; }
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await b.close();
