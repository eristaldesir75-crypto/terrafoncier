// Met en cache l'interface pour une ouverture rapide et hors ligne (les données restent en ligne).
// Stratégie « réseau d'abord » avec revalidation : une nouvelle version publiée est toujours prise en compte.
const CACHE = 'fonciscope-v60';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/potentiel.js', 'js/store.js', 'js/occupation.js', 'js/score.js', 'js/prospection.js', 'js/regles.js', 'js/zones.js', 'js/permis.js', 'js/remembrement.js', 'js/faisabilite.js', 'js/assistant.js', 'js/lecture.js', 'icon-512.png', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];
self.addEventListener('install', (e) => e.waitUntil(
  caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())
));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // API et tuiles : toujours en direct
  const net = e.request.mode === 'navigate' ? fetch(e.request) : fetch(e.request.url, { cache: 'no-cache' });
  e.respondWith(net.then((r) => {
    if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
