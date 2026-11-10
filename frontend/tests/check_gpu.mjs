// Vérifie que les liens de téléchargement des pièces du PLU (Géoportail de l'Urbanisme) répondent.
const G = 'https://www.geoportail-urbanisme.gouv.fr/api';
for (const part of ['DU_37261', 'DU_244500468']) {
  const r = await fetch(`${G}/document?partition=${part}&status=document.production`, { headers: { Origin: 'https://fonciscope.github.io' } });
  const l = await r.json();
  const d = l[0];
  console.log(part, 'document', r.status, 'CORS:', r.headers.get('access-control-allow-origin'), d && d.id, d && d.originalName);
  const f = await fetch(`${G}/document/${d.id}/files`, { headers: { Origin: 'https://fonciscope.github.io' } });
  const files = await f.json();
  console.log('  fichiers', f.status, 'CORS:', f.headers.get('access-control-allow-origin'), files.length, files.slice(0, 4).map((x) => x.name).join(', '));
  const regl = files.find((x) => /reglement/i.test(x.name) && !/graphique|prescription/i.test(x.name)) || files[0];
  for (const u of [`${G}/document/${d.id}/files/${encodeURIComponent(regl.name)}`, `${G}/document/${d.id}/download/${encodeURIComponent(d.originalName)}.zip`]) {
    const h = await fetch(u, { method: 'GET', redirect: 'follow' });
    const buf = new Uint8Array(await h.arrayBuffer().catch(() => new ArrayBuffer(0)));
    console.log('  ', h.status, h.headers.get('content-type'), (buf.length / 1e6).toFixed(1) + ' Mo', h.url.slice(0, 110));
  }
}
