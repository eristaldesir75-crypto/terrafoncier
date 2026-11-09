// Test de bout en bout sur le site publié : prospection en remembrement sur un quartier de Saran.
import { chromium } from 'playwright';
const URL = process.env.SITE || 'https://fonciscope.github.io/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const erreurs = [];
page.on('pageerror', (e) => erreurs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
await page.goto(URL + '#' + (process.env.CENTRE || '15/47.9480/1.8700'), { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('#tab-pro');
await page.waitForTimeout(3000);
await page.click('#tab-pro');
await page.fill('#proCommune', process.env.COMMUNE || 'Saran (45302)');
await page.selectOption('#proScope', 'ecran');
await page.selectOption('#proMode', process.env.MODE || 'les2');
await page.fill('#proSmin', process.env.SMIN || '1200');
await page.fill('#proLmin', process.env.LMIN || '6');
await page.fill('#proLmax', '80');
if (process.env.MAISONS) await page.click('#proMaisons');
await page.click('#proForm button[type=submit]');
const t0 = Date.now();
let statut = '';
while (Date.now() - t0 < 240000) {
  await page.waitForTimeout(3000);
  statut = await page.locator('#proStatus').innerText().catch(() => '');
  if (/retenu|arrêtée|ne répond|RNU|Aucun PLU|surchargé|Délai/.test(statut)) break;
}
console.log('STATUT :', statut.replace(/\s+/g, ' '));
// attend les adresses (BAN)
for (let k = 0; k < 40; k++) { const st2 = await page.locator('#proStatus').innerText().catch(() => ''); if (!/dresses/.test(st2)) break; await page.waitForTimeout(2000); }
await page.waitForTimeout(2000);
const res = await page.locator('#proRes').innerText().catch(() => '');
console.log('RÉSULTATS :\n' + res.slice(0, 2500));
const zones = await page.locator('#proZones').innerText().catch(() => '');
if (zones) console.log('ZONES SANS RÈGLES :', zones.slice(0, 300));
// liste des entrepôts
const tabE = page.locator('[data-cat=entrepot]');
if (await tabE.count()) { await tabE.click(); await page.waitForTimeout(800); console.log('ENTREPÔTS :\n' + (await page.locator('#proRes').innerText()).slice(0, 1500)); await page.locator('[data-cat=logement]').click(); await page.waitForTimeout(500); }
// ouvre le premier remembrement s'il existe
const ligne = page.locator('#proRes tr[data-i]').filter({ hasText: 'Remembrement' }).first();
if (await ligne.count()) {
  await ligne.click();
  await page.waitForTimeout(500);
  console.log('DÉTAIL REMEMBREMENT :', (await page.locator('#proRes tr.detail').first().innerText()).slice(0, 900));
  await page.locator('#proRes [data-fiche]').first().click();
  await page.waitForTimeout(12000);
  console.log('FICHE :', (await page.locator('#v-fiche').innerText()).slice(0, 900));
}
await page.screenshot({ path: 'e2e.png' });
console.log('ERREURS JS :', erreurs.length ? erreurs.join('\n') : 'aucune');
await browser.close();
if (erreurs.some((e) => /TypeError|ReferenceError|SyntaxError/.test(e))) process.exit(1);
