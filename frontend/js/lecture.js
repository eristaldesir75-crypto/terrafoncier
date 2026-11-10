// Lecture du règlement écrit du PLU par l'IA (Gemini, clé de l'utilisateur) :
// le PDF officiel du Géoportail de l'Urbanisme est lu dans le navigateur (pdf.js), les pages de la zone
// sont envoyées à Gemini, qui renvoie les règles chiffrées avec l'article, la page et l'extrait cité.
// Les règles lues sont enregistrées pour la zone (une seule lecture par zone) et marquées « lu par l'IA, à vérifier ».
import * as api from './api.js';
import * as store from './store.js';
import { cleIA, choisirModele, erreurHttp, ErreurIA, modelesFlash } from './assistant.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_CAR = 160000; // texte envoyé par zone (≈ 45 000 jetons)

let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = new Promise((ok, ko) => {
      if (window.pdfjsLib) return ok(window.pdfjsLib);
      const s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
      s.onerror = () => { pdfjsP = null; ko(new Error('Lecteur de PDF indisponible (cdnjs)')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsP;
}

/** URL du règlement écrit : fiche de la zone au GPU, sinon pièce « règlement » du document. */
export async function urlReglement(zone, partition) {
  const u = api.reglementUrl(zone, partition);
  const directe = u && !/download-by-partition/.test(u) ? u : null;
  // PLUi : règlement souvent en plusieurs fichiers (dispositions communes, tomes par zone ou par commune) :
  // ceux qui citent la zone ou la commune d'abord, puis les dispositions communes, puis le plus court
  let pieces = [];
  try {
    const d = await api.piecesPlu(partition);
    const F = d ? d.fichiers : [];
    const lib = zone && zone.properties ? zone.properties.libelle || '' : '';
    const base = lib.replace(/-.*$/, '').replace(/[a-z]+\d*$/, '');
    const insee = zone && zone.properties && zone.properties.insee ? String(zone.properties.insee) : '';
    const note = (x) => {
      const n = x.nom.replace(/\.pdf$/i, '');
      let v = 0;
      if (lib && new RegExp(`(^|[^A-Za-z0-9])${lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`).test(n)) v += 10;
      else if (base && new RegExp(`(^|[^A-Za-z0-9])${base}([^A-Za-z]|$)`).test(n)) v += 6;
      if (/zones?_?u|urbaines?/i.test(n) && /^\d?U/.test(lib)) v += 3;
      if (/zones?_?au|a_urbaniser/i.test(n) && /^\d?AU/.test(lib)) v += 3;
      if (insee && n.includes(insee)) v += 5;
      if (/commun|g[ée]n[ée]ral|disposition|tome_?1|livre_?1|partie_?1/i.test(n)) v += 2;
      return v;
    };
    pieces = F.filter((x) => /r[eè]glement/i.test(x.nom + ' ' + x.rubrique) && !/graphique|prescription|zonage|plan|annexe|lexique|nuancier|palette|ppri|pprn|ppr_|sanitaire|servitude|info_surf|publicit|rlp/i.test(x.nom) && /\.pdf$/i.test(x.nom))
      .sort((a, b) => note(b) - note(a) || a.nom.length - b.nom.length);
  } catch { pieces = []; }
  // le lien du GPU redirige vers data.geopf.fr sans autoriser la lecture par le navigateur (CORS) : lien direct vers le fichier
  const direct = (u0) => { const m = u0 && u0.match(/\/api\/document\/([0-9a-f]+)\/files\/([^?#]+)/); return m ? `https://data.geopf.fr/annexes/gpu/documents/${encodeURIComponent(partition)}/${m[1]}/${m[2]}` : u0; };
  return [...new Set([directe, ...pieces.slice(0, 4).map((x) => x.url)].filter(Boolean).map(direct))];
}

// Texte des PDF déjà lus, le temps de la visite (un règlement sert à toutes ses zones)
const textes = new Map();
/** Lit plusieurs fichiers du règlement (PLUi en plusieurs tomes) : pages réunies, chacune avec son fichier et sa page. */
async function lireReglement(urls, onEtape, max = 3) {
  const docs = [];
  for (const u of urls) {
    if (docs.length >= max) break;
    try { docs.push(await lirePdf([u], onEtape)); } catch (e) { if (!docs.length && u === urls[urls.length - 1]) throw e; }
  }
  if (!docs.length) throw new Error('Aucun règlement écrit lisible pour ce document');
  const nom = (u) => decodeURIComponent(u.split('/').pop());
  const pages = docs.flatMap((d) => d.pages.map((t, i) => ({ t, lab: docs.length > 1 ? `page ${i + 1} de ${nom(d.url)}` : `page ${i + 1}` })));
  return { url: docs[0].url, urls: docs.map((d) => d.url), pages, octets: docs[0].octets, pdf: docs[0].pdf };
}
async function lirePdf(urls, onEtape) {
  for (const url of urls) {
    if (textes.has(url)) return textes.get(url);
    const p = (async () => {
      onEtape && onEtape('Téléchargement du règlement…');
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Règlement inaccessible (${r.status})`);
      const buf = await r.arrayBuffer();
      if (!/^%PDF/.test(new TextDecoder().decode(buf.slice(0, 5)))) throw new Error("Le règlement publié n'est pas un PDF");
      const lib = await pdfjs();
      const doc = await lib.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        if (i % 10 === 1) onEtape && onEtape(`Lecture du règlement : page ${i} / ${doc.numPages}`);
        const c = await (await doc.getPage(i)).getTextContent();
        pages.push(c.items.map((x) => x.str + (x.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' '));
      }
      return { url, pages, octets: buf.byteLength, pdf: buf };
    })();
    textes.set(url, p);
    try { return await p; } catch (e) { textes.delete(url); if (url === urls[urls.length - 1]) throw e; }
  }
  throw new Error('Aucun règlement écrit publié pour ce document');
}

const echap = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Codes à chercher : la zone et sa zone mère (UAa → UA, UC2-O → UC2, UC). */
function codes(zone) {
  const l = [zone];
  let z = zone.replace(/-.*$/, ''); if (z !== zone) l.push(z);
  const m = z.match(/^(\d?[A-Z]+\d*)[a-z]+\d*$/); if (m) l.push(m[1]);
  const m2 = z.match(/^(\d?[A-Z]+)\d+$/); if (m2) l.push(m2[1]);
  return [...new Set(l)].filter((x) => x.length >= 1);
}

/** Pages du règlement qui concernent la zone (chapitre de la zone, dispositions communes sur le stationnement). */
function pagesDeZone(pages, zone) {
  const cs = codes(zone);
  const re = cs.map((c) => new RegExp(`(?<![A-Za-z0-9])${echap(c)}(?![A-Za-z0-9])`, 'g'));
  const titre = cs.map((c) => new RegExp(`(zone|secteur|chapitre|titre|dispositions applicables)[^\\n]{0,40}(?<![A-Za-z0-9])${echap(c)}(?![A-Za-z0-9])`, 'i'));
  const labs = pages.map((p) => p.lab);
  pages = pages.map((p) => p.t);
  const score = pages.map((t, i) => {
    let s = 0;
    re.forEach((r, k) => { const n = (t.match(r) || []).length; s += n * (k === 0 ? 2 : 1); });
    if (titre.some((r) => r.test(t))) s += 6;
    return { i, s };
  });
  // chapitre de la zone : de la première page titrée à la page qui titre une autre zone
  const choisies = new Set();
  const debut = score.find((x) => titre[0].test(pages[x.i]) && x.s >= 8) || score.find((x) => titre.some((r) => r.test(pages[x.i])) && x.s >= 7);
  if (debut) {
    const autreZone = /(dispositions applicables|chapitre|zone)[^\n]{0,30}(?<![A-Za-z0-9])(\d?[AUN][A-Z]*\d*[a-z]?)(?![A-Za-z0-9])/;
    for (let i = debut.i; i < pages.length && i < debut.i + 40; i++) {
      if (i > debut.i + 2) { const m = pages[i].slice(0, 400).match(autreZone); if (m && !cs.includes(m[2]) && score[i].s < 3) break; }
      choisies.add(i);
    }
  }
  // pages les plus citées (règlements par thème), puis dispositions communes sur le stationnement
  score.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 25).forEach((x) => choisies.add(x.i));
  pages.forEach((t, i) => { if (/stationnement/i.test(t) && /logement/i.test(t) && /place/i.test(t) && choisies.size < 70) choisies.add(i); });
  const liste = [...choisies].sort((a, b) => a - b);
  let total = 0; const out = [];
  for (const i of liste) { const t = `[${labs[i]}]\n${pages[i]}\n`; if (total + t.length > MAX_CAR) break; out.push(t); total += t.length; }
  return out.join('\n');
}

const CHAMP = (desc) => ({
  type: 'OBJECT', nullable: true,
  properties: { valeur: { type: 'NUMBER', nullable: true, description: desc }, article: { type: 'STRING' }, page: { type: 'INTEGER' }, extrait: { type: 'STRING', description: 'Phrase exacte du règlement' }, condition: { type: 'STRING', description: 'Cas particuliers, conversion faite, ou « non réglementé »' } },
});
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    zone_trouvee: { type: 'BOOLEAN' },
    ces: CHAMP("Emprise au sol maximale en % de la surface du terrain (100 si l'emprise n'est pas réglementée)"),
    h: CHAMP("Hauteur maximale en mètres à l'égout du toit ou à l'acrotère (sinon hauteur totale ou au faîtage)"),
    recul: CHAMP("Recul minimal par rapport à la voie ou à l'alignement, en mètres (0 si implantation à l'alignement)"),
    ret: CHAMP('Retrait minimal par rapport aux limites séparatives, en mètres (minimum absolu si formule H/2)'),
    pt: CHAMP('Surface minimale de pleine terre ou d\'espaces verts de pleine terre, en % du terrain'),
    stat: CHAMP("Places de stationnement voiture par logement collectif (pour un logement de 60 m² si la règle est par m²)"),
    remarque: { type: 'STRING' },
  },
  required: ['zone_trouvee'],
};

const consigne = (zone, commune) => `Voici des extraits du règlement écrit du PLU${commune ? ' de ' + commune : ''}, avec les numéros de page entre crochets.
Trouve les règles applicables aux constructions de LOGEMENTS dans la zone ${zone} (si la zone est un secteur, les règles de sa zone mère s'appliquent sauf mention contraire pour le secteur).
Pour chaque règle : la valeur chiffrée, l'article, la page (numéro entre crochets), l'extrait exact, et en « condition » les cas particuliers ou la conversion faite.
Si une règle n'est pas trouvée, renvoie null pour ce champ. N'invente jamais de valeur. Si la hauteur est donnée en niveaux (R+2...), convertis à 3 m par niveau et dis-le dans condition.
zone_trouvee = false si les extraits ne contiennent pas le chapitre ou les règles de la zone ${zone}.`;

/**
 * Appel à Gemini, robuste aux pannes : nouvel essai si le serveur est saturé, puis sans schéma imposé
 * (certaines erreurs 500 viennent du schéma), puis avec un autre modèle Flash.
 */
async function demander(cle, parts, onEtape) {
  const principal = await choisirModele(cle);
  let autres = null;
  const essais = [{ m: principal, schema: true }, { m: principal, schema: true, pause: 3000 }, { m: principal, schema: false, pause: 2000 }, { m: 'autre', schema: false }, { m: 'autre2', schema: false }];
  let derniere = null;
  for (const e of essais) {
    let mod = e.m;
    if (mod.startsWith('autre')) {
      if (!autres) { try { autres = (await modelesFlash(cle)).filter((x) => x !== principal); } catch { autres = []; } }
      mod = autres[mod === 'autre' ? 0 : 1];
      if (!mod) continue;
    }
    if (e.pause) await new Promise((ok) => setTimeout(ok, e.pause));
    if (derniere && onEtape) onEtape(`Gemini saturé, nouvel essai${mod !== principal ? ' avec ' + mod : ''}…`);
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 150000);
    try {
      const gc = { temperature: 0, responseMimeType: 'application/json', ...(e.schema ? { responseSchema: SCHEMA } : {}) };
      const p2 = e.schema ? parts : [...parts, { text: `Réponds uniquement en JSON avec ce format : {"zone_trouvee": bool, "ces": {"valeur": nombre|null, "article": "", "page": n, "extrait": "", "condition": ""}, "h": {...}, "recul": {...}, "ret": {...}, "pt": {...}, "stat": {...}, "remarque": ""}. ces et pt en %, h, recul et ret en mètres, stat en places par logement.` }];
      const r = await fetch(`${GEMINI}/models/${mod}:generateContent`, {
        method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cle },
        body: JSON.stringify({ contents: [{ role: 'user', parts: p2 }], generationConfig: gc }),
      });
      if (!r.ok) {
        const err = await erreurHttp(r);
        if (err.serveur || err.modele) { derniere = err; continue; }
        throw err;
      }
      const j = await r.json();
      const txt = (j.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').replace(/^```(?:json)?\s*|\s*```$/g, '');
      try { return JSON.parse(txt); } catch { derniere = new ErreurIA('Réponse illisible de Gemini'); continue; }
    } catch (x) {
      if (ctrl.signal.aborted) { derniere = new ErreurIA("Gemini n'a pas répondu en 2 min 30"); continue; }
      throw x;
    } finally { clearTimeout(t); }
  }
  throw derniere || new ErreurIA('Gemini ne répond pas pour le moment');
}

// Règles déjà lues par l'IA côté serveur (traitement « Lecture des règlements », data/regles) : chargées une fois
// par document et enregistrées pour les zones qui n'ont pas encore de règles sur cet appareil.
const copies = new Map();
export function reglesCopie(partition) {
  if (!partition) return Promise.resolve(0);
  if (!copies.has(partition)) {
    copies.set(partition, fetch(`data/regles/${encodeURIComponent(partition)}.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j) => {
        let n = 0;
        for (const [zone, regles] of Object.entries((j && j.zones) || {})) {
          const key = store.ruleKey(partition, zone), avant = store.getRules(key);
          if (avant && avant.source !== 'ia-copie') continue;
          if (!['ces', 'h', 'recul', 'ret', 'pt', 'stat'].some((k) => regles[k] !== null && regles[k] !== undefined)) continue;
          store.saveRules(key, { ...regles, source: 'ia-copie' }); n++;
        }
        return n;
      }));
  }
  return copies.get(partition);
}

const enCours = new Map();
/**
 * Lit les règles d'une zone dans le règlement et les enregistre.
 * @returns { regles, trouve } — regles : objet enregistré (ou null si rien de trouvé)
 */
export function lireZone({ key, zone, partition, commune, onEtape, force = false }) {
  if (enCours.has(key)) return enCours.get(key);
  const p = (async () => {
    // déjà lue côté serveur ?
    await reglesCopie(partition);
    const dej = store.getRules(key);
    if (!force && dej && dej.source === 'ia-copie') return { regles: dej, trouve: ['ces', 'h', 'recul', 'ret', 'pt', 'stat'].filter((k) => dej[k] !== null && dej[k] !== undefined).length };
    const cle = cleIA();
    if (!cle) throw new ErreurIA("Ajoutez votre clé Gemini (bulle Assistant) pour lire le règlement automatiquement");
    const libelle = zone.properties.libelle;
    const urls = await urlReglement(zone, partition);
    if (!urls.length) throw new Error('Aucun règlement écrit publié au Géoportail de l\'Urbanisme pour ce document');
    const doc = await lireReglement(urls, onEtape);
    const texte = pagesDeZone(doc.pages, libelle);
    let parts;
    if (texte.replace(/\[page [^\]]*\]|\s/g, '').length > 1500) parts = [{ text: `${consigne(libelle, commune)}\n\n${texte}` }];
    else if (doc.octets <= 18e6) {
      // règlement scanné (pas de texte) : le PDF est envoyé tel quel, Gemini le lit comme une image
      onEtape && onEtape('Règlement scanné : envoi du PDF à Gemini…');
      const b = new Uint8Array(doc.pdf); let bin = '';
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      parts = [{ inline_data: { mime_type: 'application/pdf', data: btoa(bin) } }, { text: consigne(libelle, commune).replace('des extraits', 'le règlement').replace(', avec les numéros de page entre crochets', '') }];
    } else throw new Error('Règlement scanné trop volumineux pour être lu automatiquement');
    onEtape && onEtape(`Lecture des règles de la zone ${libelle} par Gemini…`);
    const res = await demander(cle, parts, onEtape);
    const conv = { ces: (v) => Math.min(1, v / 100), pt: (v) => Math.min(1, v / 100) };
    const regles = { source: 'ia', citations: {}, document: doc.url, zoneTrouvee: !!res.zone_trouvee, remarque: res.remarque || '' };
    let n = 0;
    for (const k of ['ces', 'h', 'recul', 'ret', 'pt', 'stat']) {
      const x = res[k];
      const v = x && Number.isFinite(x.valeur) && x.valeur >= 0 ? x.valeur : null;
      regles[k] = v === null ? null : conv[k] ? conv[k](v) : v;
      if (v !== null) n++;
      if (x && (v !== null || x.extrait)) regles.citations[k] = { value: v, status: v === null ? 'non_trouve' : 'extrait', article: x.article || '', page: x.page || null, citation: x.extrait || '', condition: x.condition || '' };
    }
    // enregistré même vide : la zone n'est pas relue à chaque parcelle (bouton « Relire » pour réessayer)
    const avant = store.getRules(key);
    if (avant && avant.source === 'manuel') { for (const k of ['ces', 'h', 'recul', 'ret', 'pt', 'stat']) if (avant[k] !== null && avant[k] !== undefined) { regles[k] = avant[k]; delete regles.citations[k]; } regles.source = 'manuel+ia'; }
    store.saveRules(key, regles);
    return { regles, trouve: n };
  })();
  enCours.set(key, p);
  p.finally(() => enCours.delete(key)).catch(() => {});
  return p;
}

/** La zone a-t-elle déjà été lue par l'IA (avec ou sans résultat) ? */
export const dejaLue = (key) => { const r = store.getRules(key); return !!(r && /ia/.test(r.source || '')); };
