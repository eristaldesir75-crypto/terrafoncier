// Test de la bulle d'assistant sur le site publié, avec un Gemini simulé (aucune clé réelle) :
// l'IA simulée demande une prospection, une faisabilité, un ajout au suivi ; les vraies fonctions du site répondent.
import { chromium, devices } from 'playwright';
const URL = process.env.SITE || 'https://fonciscope.github.io/';
const MOBILE = !!process.env.MOBILE;
const browser = await chromium.launch();
const ctx = await browser.newContext(MOBILE ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const erreurs = [];
page.on('pageerror', (e) => erreurs.push(String(e)));
const img = async (nom) => {
  const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
  const t = buf.toString('base64');
  for (let i = 0; i < t.length; i += 3000) console.log(`IMG-${nom}-${String(i / 3000).padStart(4, '0')}:${t.slice(i, i + 3000)}`);
  console.log(`IMG-${nom}-N:${Math.ceil(t.length / 3000)}`);
};
let appels = 0;
const corpsRecus = [];
await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
  const u = route.request().url();
  if (/\/models\?/.test(u) || /\/models$/.test(u)) {
    return route.fulfill({ json: { models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] },
    ] } });
  }
  appels++;
  const b = JSON.parse(route.request().postData());
  corpsRecus.push(b);
  console.log('MODELE APPELÉ :', u.match(/models\/([^:]+)/)[1], '· outils', b.tools[0].functionDeclarations.length, '· contexte :', b.systemInstruction.parts[0].text.split('État actuel du site : ')[1]);
  const der = b.contents[b.contents.length - 1];
  const fr = der.parts.find((p) => p.functionResponse);
  if (fr) {
    const r = fr.functionResponse.response.resultat;
    console.log(`RÉPONSE ${fr.functionResponse.name} :`, JSON.stringify(r).slice(0, 1500), r.meilleurs ? "LOGEMENTS " + r.meilleurs.map((m) => m.logements).join(",") : "");
    return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ text: `**Fait.** ${fr.functionResponse.name} : ${r.erreur ? 'erreur ' + r.erreur : 'ok'}\n- point 1\n- point 2` }] } }] } });
  }
  const t = der.parts[0].text || '';
  let call;
  if (/prospecte/i.test(t)) call = { name: 'lancer_prospection', args: { commune: 'Saran', surface_min: 1500, collectif: true, niveaux_min: 2, mode: 'les2', perimetre: 'commune' } };
  else if (/zones/i.test(t)) call = { name: 'zones_commune', args: { commune: 'Saran' } };
  else if (/faisabilit/i.test(t)) call = { name: 'faisabilite', args: { rang: 1, niveaux: 4 } };
  else if (/suivi/i.test(t)) call = { name: 'ajouter_suivi', args: { meilleurs: 3 } };
  else if (/parcelle/i.test(t)) call = { name: 'infos_parcelle', args: { reference: '45302 AY 209' } };
  if (call) return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ functionCall: call, thoughtSignature: 'sig' }] } }] } });
  return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ text: 'Bonjour' }] } }] } });
});

await page.goto(URL + '#13/47.950/1.870', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('#iaFab');
await page.waitForTimeout(500);
await img('A1-cle');
await page.fill('#iaCle', 'AIzaSyTEST-cle-factice-0123456789');
await page.click('#iaCleOk');
await page.waitForSelector('.ia-ex', { timeout: 10000 });
console.log('MODÈLE CHOISI :', await page.evaluate(() => localStorage.getItem('tf-ia-modele')));
await img('A2-accueil');
const dire = async (t, attente = 30000) => {
  const n0 = await page.locator('.ia-bot:not(.ia-pense)').count();
  await page.fill('#iaQ', t);
  await page.press('#iaQ', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.ia-bot:not(.ia-pense)').length > n && !document.querySelector('.ia-pense'), n0, { timeout: attente }).catch(() => console.log('DÉLAI DÉPASSÉ pour', t));
  console.log('FIL :', (await page.locator('#iaFil').innerText()).replace(/\n+/g, ' | ').slice(-600));
};
await dire('Quelles zones à Saran ?');
page.on('console', (m) => { if (m.text().startsWith('ETAPE')) console.log(m.text()); });
await page.evaluate(() => { let der = '', t0 = performance.now(); setInterval(() => { const s = (document.querySelector('#proStatus')?.innerText || '').split('\n')[0].replace(/[\d\s]+\/[\d\s]+/g, ' n/n').slice(0, 70); if (s !== der) { der = s; console.log('ETAPE ' + Math.round((performance.now() - t0) / 1000) + ' s : ' + s); } }, 250); });
await dire('Prospecte Saran pour du collectif, plus de 1500 m²', 240000);
await img('A3-prospection');
await dire('Fais la faisabilité du terrain 1 en R+3', 60000);
await img('A4-faisabilite');
await dire('Ajoute les 3 meilleurs au suivi');
await dire('Infos sur la parcelle 45302 AY 209', 60000);
await img('A5-parcelle');
console.log('SUIVI :', await page.evaluate(() => JSON.parse(localStorage.getItem('tf-crm') || '[]').length));
const histo = corpsRecus[corpsRecus.length - 1].contents;
console.log('HISTORIQUE ENVOYÉ :', histo.length, 'messages · rôles', histo.map((c) => c.role[0]).join(''), '· signature conservée', JSON.stringify(histo).includes('"thoughtSignature":"sig"'));
const tout = JSON.stringify(corpsRecus);
console.log('DONNÉES SENSIBLES ENVOYÉES :', /tf-crm|AIzaSyTEST/.test(tout) ? 'OUI' : 'non', '· appels Gemini', appels);
console.log('ERREURS JS :', erreurs.length ? erreurs.join('\n') : 'aucune');
await browser.close();
if (erreurs.some((e) => /TypeError|ReferenceError|SyntaxError/.test(e))) process.exit(1);
