// Où mène le lien d'une pièce du PLU, et le navigateur a-t-il le droit de la lire (CORS) ?
const u = 'https://www.geoportail-urbanisme.gouv.fr/api/document/75e6fbcfb001360102af814d68e19eb8/files/37195_reglement_20250224.pdf';
const h = { Origin: 'https://fonciscope.github.io' };
const r = await fetch(u, { redirect: 'manual', headers: h });
console.log('GPU', r.status, r.headers.get('location'), 'ACAO=', r.headers.get('access-control-allow-origin'));
const loc = r.headers.get('location');
if (loc) { const r2 = await fetch(loc, { method: 'GET', headers: { ...h, Range: 'bytes=0-100' } }); console.log('CIBLE', r2.status, 'ACAO=', r2.headers.get('access-control-allow-origin'), r2.headers.get('content-type')); }
const z = await (await fetch('https://apicarto.ign.fr/api/gpu/zone-urba?partition=DU_37195&_limit=3')).json();
console.log('URLFIC', z.features?.map((f) => f.properties.urlfic).join(' | '));
for (const x of (z.features || []).slice(0, 1)) { if (!x.properties.urlfic) continue; const r3 = await fetch(x.properties.urlfic, { redirect: 'manual', headers: h }); console.log('URLFIC GET', r3.status, r3.headers.get('location'), 'ACAO=', r3.headers.get('access-control-allow-origin')); }
