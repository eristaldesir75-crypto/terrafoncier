// Lecture du règlement par l'IA sur une parcelle de La Riche (zone UA), Gemini simulé :
// vérifie le téléchargement du PDF officiel, la lecture pdf.js et le choix des pages envoyées.
import { chromium, devices } from 'playwright';
const URL = process.env.SITE || 'https://fonciscope.github.io/';
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'] });
await ctx.addInitScript(() => { localStorage.setItem('tf-ia-cle', 'AIzaSyTEST-cle-factice-0123456789'); localStorage.setItem('tf-ia-modele', 'gemini-2.5-flash'); });
const page = await ctx.newPage();
const erreurs = []; page.on('pageerror', (e) => erreurs.push(String(e)));
page.on('console', (m) => { if (/lecture|pdf/i.test(m.text())) console.log('CONSOLE', m.text().slice(0, 300)); });
const img = async (nom) => { const t = (await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false })).toString('base64'); for (let i = 0; i < t.length; i += 3000) console.log(`IMG-${nom}-${String(i / 3000).padStart(4, '0')}:${t.slice(i, i + 3000)}`); };
await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  const parts = body.contents?.[0]?.parts || [];
  const txt = parts.map((p) => p.text || '').join('');
  const pages = [...txt.matchAll(/\[page (\d+)[^\]]*\]/g)].map((m) => +m[1]);
  console.log('ENVOI GEMINI :', txt.length, 'caractères,', pages.length, 'pages :', pages.join(','), parts.some((p) => p.inline_data) ? '(PDF joint)' : '');
  for (const kw of ['emprise au sol', 'hauteur', 'stationnement', 'limites séparatives', 'pleine terre', 'voies']) console.log('  mot-clé', kw, ':', (txt.toLowerCase().match(new RegExp(kw, 'g')) || []).length);
  const ua = txt.match(/[^\n]{0,80}(zone|ZONE|Zone) UA[^\n]{0,80}/g) || [];
  console.log('  titres UA :', ua.slice(0, 6).join(' || '));
  const m = txt.match(/emprise au sol[^\n]{0,300}/i); console.log('  extrait emprise :', m && m[0].slice(0, 300));
  const zs = (txt.match(/zones suivantes : ([^\n]*?), trouve/) || [, ''])[1].split(', ').filter(Boolean);
  console.log('  ZONES DEMANDÉES :', zs.length, zs.join(' '));
  return route.fulfill({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(zs.map((z, k) => ({ zone: z, zone_trouvee: true, ces: { valeur: 40 + k, article: 'art. 9', page: String(pages[0] || 1), extrait: 'test', condition: '' }, h: { valeur: 9 + k, article: 'art. 10', page: '2', extrait: 'test' }, recul: null, ret: { valeur: 3, article: 'art. 7', page: '1', extrait: 'test' }, pt: null, stat: { valeur: 1, article: 'art. 12', page: '1', extrait: 'test' } }))) }] } }] } });
});
await page.goto(URL + '#18/47.38925/0.66135', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3000);
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForSelector('#peek .peek-kpis', { timeout: 40000 }).catch(() => {});
await page.click('#peek [data-go=fiche]').catch(() => {});
await page.waitForTimeout(1500);
await page.click('[data-ft=urba]').catch(() => {});
const t0 = Date.now(); let vu = false;
for (let i = 0; i < 90; i++) {
  const e = await page.evaluate(() => { const s = window.tfDebug().sel; return s && s.iaLecture ? s.iaLecture.etat + ' ' + (s.iaLecture.etape || '') + (s.iaLecture.message || '') : 'aucune'; });
  if (i % 5 === 0) console.log(`ÉTAT ${Math.round((Date.now() - t0) / 1000)} s :`, e);
  if (/cours/.test(e)) vu = true;
  if (/erreur/.test(e) || (vu && /aucune/.test(e)) || (!vu && i > 45)) { console.log('FIN :', e); break; }
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(1000);
console.log('FICHE :', (await page.locator('#v-fiche').innerText()).replace(/\n+/g, ' | ').slice(0, 1200));
await img('L1-fiche');
console.log('RÈGLES :', await page.evaluate(() => localStorage.getItem('tf-rules')));
console.log('ERREURS JS :', erreurs.length ? erreurs.join('\n') : 'aucune');
await b.close();
