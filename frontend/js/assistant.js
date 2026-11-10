// Assistant IA (bulle de discussion) : comprend une demande en français et pilote le site
// (prospection, fiche parcelle, faisabilité, suivi). L'IA ne calcule rien elle-même : elle appelle
// les fonctions du site et résume leurs vrais résultats.
// Modèle : Google Gemini, appelé directement depuis le navigateur avec la clé de l'utilisateur,
// enregistrée sur cet appareil seulement. Seules des données publiques sont envoyées
// (demandes, cadastre, PLU, résultats de calcul) : jamais les notes du suivi ni de données de propriétaires.

const CLE = 'tf-ia-cle', MODELE = 'tf-ia-modele';
const API = 'https://generativelanguage.googleapis.com/v1beta';
const lire = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const ecrire = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* stockage refusé */ } };

const SYSTEME = `Tu es l'assistant de Fonciscope, un outil de prospection foncière et d'études de faisabilité en France.
Tu parles à un professionnel de la promotion immobilière. Réponds en français, de façon brève et concrète.

Règles absolues :
- N'invente jamais un chiffre, une règle de PLU, une parcelle ou une adresse. Toute donnée vient des fonctions du site.
- Pour agir, appelle les fonctions. Si une information manque pour agir (par exemple la commune), demande-la en une phrase.
- Après une prospection, donne le nombre de terrains, rappelle les critères appliqués, puis liste les 5 meilleurs
  (rang, référence, adresse, zone, surface, logements, note). Précise quand les logements sont une estimation.
- Après une faisabilité, donne emprise, surface de plancher, logements, places, et quelles valeurs viennent du PLU.
- Rappelle si besoin que tout est à confirmer avec le règlement écrit du PLU.

Correspondances utiles :
- « R+1 » = 2 niveaux, « R+2 » = 3 niveaux, « R+3 » = 4 niveaux.
- « collectif » : collectif=true. « maisons », « pavillons » : maisons_seulement=true.
- « remembrement », « regrouper des parcelles » : mode remembrement ou les2. « parcelle seule » : mode seule.
- « zones UC et UB » : zones=["UC","UB"] (un code couvre ses sous-secteurs, UC couvre UC1, UCa...).
- « le 3 », « le troisième » après une prospection : rang 3 de la liste.
- « cette parcelle » : la parcelle sélectionnée (n'indique ni référence ni rang).`;

const OUTILS = [
  {
    name: 'zones_commune',
    description: "Liste les zones du PLU d'une commune (code, libellé, logement autorisé ou non). À utiliser avant une prospection quand l'utilisateur parle de zones sans donner leurs codes exacts.",
    parameters: { type: 'OBJECT', properties: { commune: { type: 'STRING', description: 'Nom ou code INSEE de la commune' } }, required: ['commune'] },
  },
  {
    name: 'lancer_prospection',
    description: "Lance la prospection d'une commune et renvoie les critères appliqués et les meilleurs terrains. Les critères non indiqués reprennent ceux du formulaire de prospection. Sans zones indiquées, toutes les zones où le PLU autorise le logement sont prises. Peut durer une à deux minutes.",
    parameters: {
      type: 'OBJECT',
      properties: {
        commune: { type: 'STRING', description: 'Nom ou code INSEE' },
        perimetre: { type: 'STRING', enum: ['commune', 'ecran'], description: "commune entière, ou zone affichée sur la carte" },
        zones: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Codes ou débuts de codes de zones du PLU, ex. ["UC","1AU"]' },
        surface_min: { type: 'NUMBER', description: 'Surface minimale du terrain en m²' },
        surface_max: { type: 'NUMBER' },
        logements_min: { type: 'NUMBER' },
        logements_max: { type: 'NUMBER' },
        collectif: { type: 'BOOLEAN', description: 'Exiger que le PLU permette du collectif' },
        niveaux_min: { type: 'INTEGER', description: 'Nombre de niveaux minimum permis (R+2 = 3)' },
        mode: { type: 'STRING', enum: ['seule', 'remembrement', 'les2'] },
        max_parcelles: { type: 'INTEGER', description: 'Remembrement : 2 à 4 parcelles' },
        pignon_sur_rue: { type: 'BOOLEAN' },
        facade_min_m: { type: 'NUMBER', description: 'Façade sur rue minimale du remembrement (m)' },
        maisons_seulement: { type: 'BOOLEAN' },
        entrepots: { type: 'BOOLEAN', description: "Ajouter les entrepôts des zones d'activités (liste à part)" },
        oap_seulement: { type: 'BOOLEAN' },
        exclure_oap: { type: 'BOOLEAN', description: "Écarter les parcelles en secteur d'OAP" },
        exclure_ebc_er: { type: 'BOOLEAN', description: 'Exclure espaces boisés classés et emplacements réservés' },
        exclure_bati_recent: { type: 'BOOLEAN' },
        note_min: { type: 'NUMBER' },
      },
    },
  },
  {
    name: 'resultats_prospection',
    description: 'Renvoie les terrains de la dernière prospection, du rang « depuis » au rang « depuis + nombre ».',
    parameters: { type: 'OBJECT', properties: { depuis: { type: 'INTEGER' }, nombre: { type: 'INTEGER' } } },
  },
  {
    name: 'infos_parcelle',
    description: "Ouvre la fiche d'une parcelle et renvoie zone du PLU, règles connues, potentiel, contraintes, bâti. Sans paramètre : la parcelle sélectionnée.",
    parameters: {
      type: 'OBJECT',
      properties: {
        reference: { type: 'STRING', description: 'Référence cadastrale, ex. « 45302 AY 209 » ou « AY 209 »' },
        commune: { type: 'STRING', description: 'Commune, si la référence ne contient pas le code INSEE' },
        rang: { type: 'INTEGER', description: 'Rang dans les résultats de la dernière prospection' },
        adresse: { type: 'STRING' },
      },
    },
  },
  {
    name: 'faisabilite',
    description: "Calcule la faisabilité d'une parcelle (bâtiment dessiné sur la carte, bilan pré-rempli par le PLU) et renvoie le bilan. Les valeurs données remplacent celles du PLU. Sans parcelle indiquée : la parcelle sélectionnée.",
    parameters: {
      type: 'OBJECT',
      properties: {
        reference: { type: 'STRING' }, commune: { type: 'STRING' }, rang: { type: 'INTEGER' }, adresse: { type: 'STRING' },
        niveaux: { type: 'NUMBER', description: 'Nombre de niveaux (R+2 = 3)' },
        emprise_pct: { type: 'NUMBER', description: 'Emprise au sol maximale en %' },
        profondeur_m: { type: 'NUMBER', description: 'Épaisseur du bâtiment (m), 15 par défaut' },
        surface_logement_m2: { type: 'NUMBER', description: 'm² de surface de plancher par logement' },
        retrait_m: { type: 'NUMBER' }, recul_m: { type: 'NUMBER' },
        places_par_logement: { type: 'NUMBER' }, logements_sociaux_pct: { type: 'NUMBER' },
        vue_3d: { type: 'BOOLEAN' },
      },
    },
  },
  {
    name: 'ajouter_suivi',
    description: 'Ajoute des terrains au suivi (tableau de bord) : les N meilleurs de la dernière prospection, des rangs, ou la parcelle sélectionnée.',
    parameters: { type: 'OBJECT', properties: { meilleurs: { type: 'INTEGER' }, rangs: { type: 'ARRAY', items: { type: 'INTEGER' } }, parcelle_selectionnee: { type: 'BOOLEAN' } } },
  },
  {
    name: 'afficher',
    description: "Affiche une vue du site.",
    parameters: { type: 'OBJECT', properties: { vue: { type: 'STRING', enum: ['carte', 'parcelle', 'faisabilite', 'prospection', 'suivi', '3d'] } }, required: ['vue'] },
  },
];

const ETAPES = {
  zones_commune: (a) => `Zones du PLU de ${a.commune || 'la commune'}`,
  lancer_prospection: (a) => `Prospection de ${a.commune || 'la commune'}`,
  resultats_prospection: () => 'Lecture des résultats',
  infos_parcelle: (a) => `Fiche ${a.reference || (a.rang ? 'du terrain n° ' + a.rang : a.adresse || 'de la parcelle')}`,
  faisabilite: (a) => `Faisabilité ${a.reference || (a.rang ? 'du terrain n° ' + a.rang : 'de la parcelle')}`,
  ajouter_suivi: () => 'Ajout au suivi',
  afficher: (a) => `Affichage : ${a.vue}`,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Mise en forme légère du texte de l'IA : gras, listes, retours à la ligne. */
function rendu(t) {
  const lignes = esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n');
  let html = '', liste = false;
  for (const l of lignes) {
    const m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (m) { if (!liste) { html += '<ul>'; liste = true; } html += `<li>${m[1]}</li>`; continue; }
    if (liste) { html += '</ul>'; liste = false; }
    if (l.trim()) html += `<p>${l.replace(/^#+\s*/, '')}</p>`;
  }
  return html + (liste ? '</ul>' : '');
}

export class ErreurIA extends Error {}
/** Clé Gemini de l'utilisateur (enregistrée sur cet appareil), ou chaîne vide. */
export const cleIA = () => lire(CLE);

/** Choix du modèle : le plus récent des modèles « Flash » stables accessibles avec la clé. */
/** Modèles Gemini Flash accessibles avec la clé, du plus récent au plus ancien (pour changer de modèle en cas de panne). */
export async function modelesFlash(cle) {
  const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': cle } });
  if (!r.ok) throw await erreurHttp(r);
  const j = await r.json();
  const ver = (n) => { const v = n.match(/gemini-(\d+(?:\.\d+)?)/); return v ? +v[1] : 0; };
  return (j.models || []).filter((x) => (x.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(x.name) && !/image|tts|live|audio|thinking|exp/i.test(x.name))
    .map((x) => x.name.replace(/^models\//, '')).sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || (/preview/.test(a) - /preview/.test(b)) || ver(b) - ver(a));
}
export async function choisirModele(cle, force) {
  const m = !force && lire(MODELE);
  if (m) return m;
  const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': cle } });
  if (!r.ok) throw await erreurHttp(r);
  const j = await r.json();
  const ok = (j.models || []).filter((x) => (x.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(x.name) && !/lite|image|tts|live|audio|thinking|exp/i.test(x.name));
  const ver = (n) => { const v = n.match(/gemini-(\d+(?:\.\d+)?)/); return v ? +v[1] : 0; };
  ok.sort((a, b) => (/preview/.test(a.name) - /preview/.test(b.name)) || ver(b.name) - ver(a.name) || (/latest/.test(b.name) - /latest/.test(a.name)));
  if (!ok.length) throw new ErreurIA("Aucun modèle Gemini Flash disponible avec cette clé");
  const nom = ok[0].name.replace(/^models\//, '');
  ecrire(MODELE, nom);
  return nom;
}

export async function erreurHttp(r) {
  let msg = '';
  try { const j = await r.json(); msg = j.error?.message || ''; } catch { /* corps illisible */ }
  if (r.status === 400 && /api key|API_KEY/i.test(msg)) return new ErreurIA('Clé Gemini refusée : vérifiez-la (bouton « Clé » en haut de la bulle)');
  if (r.status === 403) return new ErreurIA("Clé Gemini sans accès à l'API : vérifiez qu'elle a été créée sur aistudio.google.com");
  if (r.status === 429) { const e = new ErreurIA(`Quota gratuit de Gemini atteint pour le modèle ${r.url.match(/models\/([^:]+)/)?.[1] || ''} : réessayez dans une minute (ou demain si la limite du jour est atteinte)`); e.quota = true; e.jour = /per ?day|PerDay|daily/i.test(msg); return e; }
  if (r.status === 404) { const e = new ErreurIA('Modèle indisponible'); e.modele = true; return e; }
  if (r.status >= 500) { const e = new ErreurIA(`Gemini ne répond pas pour le moment (erreur ${r.status}${msg ? ' : ' + msg.slice(0, 140) : ''}) : réessayez dans un instant`); e.serveur = true; return e; }
  return new ErreurIA(`Gemini : ${msg || 'erreur ' + r.status}`);
}

/** Réflexion du modèle réduite au minimum : l'assistant ne fait que traduire et résumer, la réponse arrive bien plus vite. */
const reflexion = (modele) => (/gemini-2\./.test(modele) ? { thinkingBudget: /pro/.test(modele) ? 128 : 0 } : { thinkingLevel: 'low' });
let sansReflexion = false; // modèle qui refuse le réglage : envoyé sans

const epuises = new Set(); // modèles dont le quota est atteint pendant cette visite
async function generer(cle, contents, contexte) {
  let modele = await choisirModele(cle);
  if (epuises.has(modele)) { const l = (await modelesFlash(cle).catch(() => [])).filter((m) => !epuises.has(m)); if (l[0]) modele = l[0]; }
  const corps = () => JSON.stringify({
    systemInstruction: { parts: [{ text: `${SYSTEME}\n\nÉtat actuel du site : ${contexte}` }] },
    contents, tools: [{ functionDeclarations: OUTILS }],
    generationConfig: { temperature: 0.2, ...(sansReflexion ? {} : { thinkingConfig: reflexion(modele) }) },
  });
  for (let essai = 0; essai < 3; essai++) {
    const ctrl = new AbortController(), minuteur = setTimeout(() => ctrl.abort(), 90000);
    let r;
    try { r = await fetch(`${API}/models/${modele}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cle }, body: corps(), signal: ctrl.signal }); }
    catch (e) { if (ctrl.signal.aborted) throw new ErreurIA("Gemini n'a pas répondu en 90 secondes : réessayez"); throw e; }
    finally { clearTimeout(minuteur); }
    if (!r.ok && r.status === 400 && !sansReflexion) {
      const txt = await r.clone().text();
      if (/think/i.test(txt)) { sansReflexion = true; continue; }
    }
    if (r.ok) {
      const j = await r.json();
      const c = j.candidates && j.candidates[0];
      if (!c || !c.content) throw new ErreurIA(j.promptFeedback?.blockReason ? 'Demande refusée par Gemini' : 'Réponse vide de Gemini');
      return c.content;
    }
    const e = await erreurHttp(r);
    if (e.serveur && essai < 2) { await new Promise((ok) => setTimeout(ok, 2500 * (essai + 1))); continue; }
    // quota d'un modèle atteint : chaque modèle a son propre quota gratuit, on passe au suivant
    if (e.quota && essai < 2) { const l = (await modelesFlash(cle).catch(() => [])).filter((m) => m !== modele && !epuises.has(m)); epuises.add(modele); if (l[0]) { modele = l[0]; continue; } }
    if (e.modele && essai < 2) { modele = await choisirModele(cle, true); continue; }
    throw e;
  }
  throw new ErreurIA('Gemini ne répond pas');
}

/**
 * @param ctx { actions: { [nom]: async (args) => résultat }, contexte: () => string }
 */
export function initAssistant(ctx) {
  const histo = []; // échanges envoyés à Gemini (mémoire de la conversation, le temps de la visite)
  let occupe = false;

  const fab = document.createElement('button');
  fab.type = 'button'; fab.className = 'ia-fab'; fab.id = 'iaFab';
  fab.setAttribute('aria-label', "Ouvrir l'assistant"); fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 6.5a1.5 1.5 0 1 0 0 .01Zm5 0a1.5 1.5 0 1 0 0 .01Zm5 0a1.5 1.5 0 1 0 0 .01Z"/></svg><span>Assistant</span>';
  const box = document.createElement('section');
  box.className = 'ia-box'; box.id = 'iaBox'; box.hidden = true;
  box.setAttribute('aria-label', 'Assistant');
  box.innerHTML = `
    <header class="ia-head"><div><b>Assistant</b><span class="ia-sous">Prospection, fiches et faisabilité à la demande</span></div>
      <div class="ia-head-act"><button type="button" class="ghost ia-mini" id="iaCleBtn">Clé</button><button type="button" class="ghost ia-mini" id="iaNew" title="Nouvelle conversation">Effacer</button><button type="button" class="ia-x" id="iaClose" aria-label="Fermer">×</button></div></header>
    <div class="ia-fil" id="iaFil" aria-live="polite"></div>
    <form class="ia-form" id="iaForm"><textarea id="iaQ" rows="1" placeholder="Votre demande…" aria-label="Votre demande"></textarea><button type="submit" id="iaGo" aria-label="Envoyer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20.5 21 12 3 3.5 3 10l12 2-12 2z"/></svg></button></form>`;
  (document.querySelector('.mapcol') || document.body).append(fab, box);
  // sur téléphone, la bulle remonte au-dessus de la fiche résumée posée sur la carte
  const peek = document.getElementById('peek');
  const majPos = () => document.body.style.setProperty('--ia-dec', peek && !peek.hidden ? `${peek.offsetHeight + 8}px` : '0px');
  if (peek) new MutationObserver(majPos).observe(peek, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
  const fil = box.querySelector('#iaFil'), q = box.querySelector('#iaQ'), form = box.querySelector('#iaForm');

  const EXEMPLES = [
    'Prospecte Saran pour du collectif R+2, terrains de plus de 1 500 m², remembrement jusqu\'à 3 parcelles',
    'Qu\'est-ce que je peux construire sur cette parcelle ?',
    'Fais la faisabilité du terrain n° 1 en R+3',
    'Ajoute les 5 meilleurs au suivi',
  ];
  function accueil() {
    if (!lire(CLE)) { ecranCle(); return; }
    fil.innerHTML = `<div class="ia-msg ia-bot"><p>Dites-moi ce que vous cherchez : je lance la prospection, ouvre les fiches et calcule les faisabilités avec les données du site.</p></div>
      <div class="ia-ex">${EXEMPLES.map((e) => `<button type="button" class="chip-btn" data-ex="${esc(e)}">${esc(e)}</button>`).join('')}</div>`;
    fil.querySelectorAll('[data-ex]').forEach((b) => (b.onclick = () => { q.value = b.dataset.ex; envoyer(); }));
  }
  function ecranCle() {
    fil.innerHTML = `<div class="ia-cle">
      <p><b>Activez l'assistant avec votre clé Gemini gratuite.</b></p>
      <ol><li>Ouvrez <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> avec votre compte Google.</li><li>Touchez « Create API key », puis copiez la clé.</li><li>Collez-la ci-dessous.</li></ol>
      <label for="iaCle">Clé Gemini<input type="password" id="iaCle" autocomplete="off" spellcheck="false" placeholder="Collez votre clé ici"></label>
      <div class="actions"><button type="button" id="iaCleOk">Activer</button>${lire(CLE) ? '<button type="button" class="ghost" id="iaCleSup">Supprimer la clé</button>' : ''}</div>
      <p class="note">La clé reste dans ce navigateur, sur cet appareil : à coller une fois par appareil. L'assistant n'envoie à Gemini que vos demandes et des données publiques (cadastre, PLU, résultats de calcul), jamais vos notes de suivi. Sur la version gratuite, Google peut utiliser ces échanges pour améliorer ses modèles.</p></div>`;
    const inp = fil.querySelector('#iaCle');
    fil.querySelector('#iaCleOk').onclick = async () => {
      const k = inp.value.trim();
      if (!/^[\w.-]{20,}$/.test(k)) { ctx.toast('Clé incomplète : collez-la en entier'); return; }
      const b = fil.querySelector('#iaCleOk'); b.disabled = true; b.textContent = 'Vérification…';
      try { ecrire(MODELE, ''); await choisirModele(k, true); ecrire(CLE, k); ctx.toast('Assistant activé'); accueil(); q.focus(); }
      catch (e) { b.disabled = false; b.textContent = 'Activer'; ctx.toast(e instanceof ErreurIA ? e.message : 'Vérification impossible : connexion à Google refusée'); }
    };
    const sup = fil.querySelector('#iaCleSup');
    if (sup) sup.onclick = () => { ecrire(CLE, ''); ecrire(MODELE, ''); ctx.toast('Clé supprimée de cet appareil'); ecranCle(); };
  }

  function ouvrir(on) {
    box.hidden = !on; fab.setAttribute('aria-expanded', String(on)); fab.hidden = on;
    document.body.classList.toggle('ia-ouvert', on);
    if (on) { if (!fil.children.length) accueil(); setTimeout(() => (lire(CLE) ? q : fil.querySelector('#iaCle'))?.focus(), 50); }
  }
  fab.onclick = () => ouvrir(true);
  box.querySelector('#iaClose').onclick = () => ouvrir(false);
  box.querySelector('#iaCleBtn').onclick = () => ecranCle();
  box.querySelector('#iaNew').onclick = () => { if (occupe) return; histo.length = 0; accueil(); };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); envoyer(); } });
  q.addEventListener('input', () => { q.style.height = 'auto'; q.style.height = Math.min(120, q.scrollHeight) + 'px'; });
  form.onsubmit = (e) => { e.preventDefault(); envoyer(); };

  const bas = () => { fil.scrollTop = fil.scrollHeight; };
  function bulle(cls, html) { fil.querySelector('.ia-ex')?.remove(); const d = document.createElement('div'); d.className = `ia-msg ${cls}`; d.innerHTML = html; fil.appendChild(d); bas(); return d; }
  function etape(txt) {
    const d = document.createElement('div'); d.className = 'ia-etape en-cours';
    d.innerHTML = `<i></i><span>${esc(txt)}</span><small></small>`; fil.appendChild(d); bas();
    return {
      detail(t) { d.querySelector('small').textContent = t; },
      voir(fn) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost ia-voir'; b.textContent = 'Voir'; b.onclick = fn; d.appendChild(b); },
      fin(ok, t) { d.classList.remove('en-cours'); d.classList.add(ok ? 'ok' : 'ko'); d.querySelector('small').textContent = t || ''; },
    };
  }
  /** Les résultats volumineux sont raccourcis dans la mémoire de la conversation. */
  function compacter() {
    for (const c of histo) for (const p of c.parts) {
      const fr = p.functionResponse;
      if (!fr || fr.response.compact) continue;
      const res = fr.response.resultat, txt = JSON.stringify(res);
      if (txt.length > 2500) {
        const court = res && res.meilleurs ? { ...res, criteres_appliques: undefined, meilleurs: res.meilleurs.slice(0, 5) } : res;
        fr.response = { compact: true, resultat: JSON.stringify(court).slice(0, 2500) };
      } else fr.response.compact = true;
    }
  }
  function alleger() {
    while (histo.length > 30) histo.shift();
    while (histo.length && histo[0].role !== 'user') histo.shift();
    // une conversation doit commencer par un message de l'utilisateur, pas par une réponse de fonction
    while (histo.length && histo[0].parts.some((p) => p.functionResponse)) { histo.shift(); while (histo.length && histo[0].role !== 'user') histo.shift(); }
  }

  async function envoyer() {
    const t = q.value.trim();
    if (!t || occupe) return;
    const cle = lire(CLE);
    if (!cle) { ecranCle(); return; }
    occupe = true; box.querySelector('#iaGo').disabled = true;
    compacter();
    q.value = ''; q.style.height = 'auto';
    bulle('ia-moi', `<p>${esc(t)}</p>`);
    const avant = histo.length;
    histo.push({ role: 'user', parts: [{ text: t }] });
    const attente = bulle('ia-bot ia-pense', '<span></span><span></span><span></span>');
    try {
      for (let tour = 0; tour < 8; tour++) {
        alleger();
        const rep = await generer(cle, histo, ctx.contexte());
        histo.push({ role: 'model', parts: rep.parts || [] });
        const appels = (rep.parts || []).filter((p) => p.functionCall);
        const texte = (rep.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim();
        if (!appels.length) {
          attente.remove();
          bulle('ia-bot', rendu(texte || "Je n'ai pas compris la demande. Pouvez-vous la reformuler ?"));
          return;
        }
        if (texte) fil.insertBefore(Object.assign(document.createElement('div'), { className: 'ia-msg ia-bot', innerHTML: rendu(texte) }), attente);
        const reponses = [];
        for (const p of appels) {
          const { name, args = {}, id } = p.functionCall;
          const et = etape((ETAPES[name] || (() => name))(args));
          fil.appendChild(attente); bas();
          let res;
          const suivi = name === 'lancer_prospection' ? setInterval(() => et.detail(ctx.statut ? ctx.statut() : ''), 800) : null;
          try {
            if (!ctx.actions[name]) throw new Error('Action inconnue');
            res = await ctx.actions[name](args);
            et.fin(true, '');
            if (['lancer_prospection', 'infos_parcelle', 'faisabilite', 'afficher'].includes(name)) et.voir(() => ouvrir(false));
          } catch (e) {
            res = { erreur: e.message || String(e) };
            et.fin(false, res.erreur);
          } finally { if (suivi) clearInterval(suivi); }
          reponses.push({ functionResponse: { name, ...(id ? { id } : {}), response: { resultat: res } } });
        }
        histo.push({ role: 'user', parts: reponses });
      }
      attente.remove();
      bulle('ia-bot', '<p>Demande trop longue à traiter en une fois : découpez-la en plusieurs étapes.</p>');
    } catch (e) {
      attente.remove();
      // la demande sans réponse est retirée de la mémoire pour pouvoir la reposer
      histo.length = Math.min(histo.length, avant);
      bulle('ia-bot ia-err', `<p>${esc(e instanceof ErreurIA ? e.message : 'Connexion à Gemini impossible : vérifiez votre connexion internet')}</p>`);
    } finally {
      occupe = false; box.querySelector('#iaGo').disabled = false;
      if (!window.matchMedia('(max-width: 760px)').matches) q.focus();
    }
  }

  return { ouvrir, ecranCle: () => { ouvrir(true); ecranCle(); }, envoyer: (t) => { q.value = t; return envoyer(); } };
}
