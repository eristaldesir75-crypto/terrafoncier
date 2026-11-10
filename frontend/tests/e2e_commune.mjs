// Choix d'une commune : toutes ses zones d'habitat sont lues par l'IA (Gemini simulé)
import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript(() => { localStorage.setItem('tf-ia-cle', 'AQ.test-cle-factice-0123456789'); localStorage.setItem('tf-ia-modele', 'gemini-2.5-flash'); });
const page = await ctx.newPage();
const erreurs = []; page.on('pageerror', (e) => erreurs.push(String(e)));
let n = 0;
await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
  const u = route.request().url();
  if (/models\?/.test(u)) return route.fulfill({ json: { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] } });
  n++;
  const txt = JSON.parse(route.request().postData()).contents[0].parts.map((p) => p.text || '').join('');
  const zs = (txt.match(/zones suivantes : ([^\n]*?), trouve/) || [, ''])[1].split(', ').filter(Boolean);
  console.log(`APPEL ${n} : ${txt.length} caractères, ${zs.length} zones : ${zs.join(' ')}`);
  return route.fulfill({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(zs.map((z) => ({ zone: z, zone_trouvee: true, ces: { valeur: 50, article: 'a', page: '1', extrait: 't' }, h: { valeur: 12, article: 'a', page: '1', extrait: 't' }, recul: null, ret: null, pt: null, stat: null }))) }] } }] } });
});
page.on('console', (m) => { if (/data\/regles/.test(m.text())) console.log('CONSOLE', m.text().slice(0, 200)); });
const t0 = Date.now();
await page.goto('https://fonciscope.github.io/#12/47.39/0.66', { waitUntil: 'load' });
await page.waitForTimeout(2500);
await page.fill('#q', 'La Riche');
await page.waitForSelector('#suggest li', { timeout: 15000 });
await page.click('#suggest li');
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  const t = await page.locator('#toast').innerText().catch(() => '');
  if (i % 3 === 0) console.log(`${i} s TOAST :`, t);
  if (/règles lues|impossible/.test(t)) break;
}
const regles = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('tf-rules') || '{}')));
console.log('ZONES ENREGISTRÉES :', regles.length, regles.join(' '), '· appels', n, '·', Math.round((Date.now() - t0) / 1000), 's');
console.log('ERREURS JS :', erreurs.length ? erreurs.join('\n') : 'aucune');
await b.close();
