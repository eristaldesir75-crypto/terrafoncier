// Moteur de prospection : balaye toutes les parcelles d'une commune (ou de la zone affichée),
// applique les critères, qualifie le foncier, calcule le potentiel et note chaque terrain.
/* global turf */
import * as api from './api.js';
import * as store from './store.js';
import { computePotentiel, parseQuery } from './potentiel.js';
import { NATURES, grille, analyser } from './occupation.js';
import { noter, contraintesDe, compacite, POIDS_NATURE } from './score.js';
import { voisinages, regroupements, fusion, sansDoublons, facadesSurRue } from './remembrement.js';
import * as permis from './permis.js';
import { reglesGraphiquesParcelle, fusionRegles } from './regles.js';

const NATURES_DEFAUT = Object.keys(NATURES).filter((k) => NATURES[k].opp);
const TUILE = 0.01; // degrés (≈ 1,1 km × 0,75 km)

export const CRIT_DEFAUT = {
  commune: null, scope: 'commune', smin: 1500, smax: '', lmin: 30, lmax: 50, sdpMin: '', hMin: '',
  zonesU: true, zonesAU: true, zonesFiltre: '', exclActivite: true, natures: NATURES_DEFAUT,
  exclRecent: true, oapSeul: false, exclContraintes: false, scoreMin: 0,
  // collectif réellement permis par le PLU, et remembrement de parcelles voisines
  collectif: true, nivMin: 2, mode: 'les2', maxParcelles: 3,
  // entrepôts et locaux d'activité, listés à part (en zone d'habitat : reconversion ; en zone d'activités : foncier d'activité)
  entrepots: false,
  // remembrement : terrains avec pignon sur rue
  rueSeul: true, facadeMin: 10,
};
const CATS = { logement: 'Logement possible', entrepot: "Entrepôts et locaux d'activité", tout: 'Tout' };
// Zone d'activités économiques (pas de logement) : entrepôts, industrie, commerce, artisanat
const zoneActivite = (z) => {
  const p = z.properties, t = (p.typezone || '').toUpperCase();
  if (!/^(U|AU)/.test(t) || /^2AU/i.test(p.libelle || '')) return false;
  return /activit|industri|commerc|artisan|[ée]conomi|logisti|entrep/i.test(p.libelong || '') || /(^|-)(U?AE|UX|UI|UY|UZ)\d*[a-z]?(-|$)/i.test(p.libelle || '');
};
const MAISONS = ['maison', 'maison_grand'];
const natLabel = (k) => (k === 'remembrement' ? 'Remembrement' : NATURES[k] ? NATURES[k].label : k);
const pause = () => new Promise((ok) => setTimeout(ok, 0));
const mediane = (a) => { const s = a.slice().sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Densités réellement autorisées : opérations de 5 logements collectifs ou plus depuis 2015 (permis Sitadel),
 * localisées par leur parcelle, médiane par zone du PLU et pour la commune.
 */
async function densitesVoisines(insee, idxZones) {
  const l = await api.permisLogements(insee, { minLogements: 5 });
  const ops = l.filter((p) => p.etat !== 4 && p.collectifs >= 5 && (p.autorisation || '') >= '2015');
  await permis.localiser(ops);
  const zones = new Map(), tous = [];
  for (const p of ops) {
    const d = permis.densite(p);
    if (!d || d > 800) continue;
    tous.push(d);
    if (!p.centre) continue;
    const pt = turf.point(p.centre);
    const z = idxZones.pres([p.centre[0], p.centre[1], p.centre[0], p.centre[1]]).find((zz) => turf.booleanPointInPolygon(pt, zz));
    if (!z) continue;
    const k = z.properties.libelle;
    if (!zones.has(k)) zones.set(k, []);
    zones.get(k).push(d);
  }
  const res = { commune: { med: mediane(tous), n: tous.length }, zones: new Map() };
  for (const [k, v] of zones) res.zones.set(k, { med: mediane(v), n: v.length });
  return res;
}

/**
 * @param ctx { map, setHits, selectFeature, rulesBlock, toast, download, esc, f0, m2, refOf, zoneConstructible, zoneHorsLogement, onResults }
 */
export function initProspection(ctx) {
  const { esc, f0, m2, refOf } = ctx;
  const $ = (s, el = document) => el.querySelector(s);
  const st = {
    crit: { ...CRIT_DEFAUT, ...(store.prospectionCrit() || {}) },
    results: null, running: false, ctrl: null, zonesMissing: [], filtreNature: null, tri: { k: 'score', dir: -1 }, ouvert: null,
  };

  // ---------- Formulaire ----------
  function render() {
    const v = $('#v-pro');
    const c = st.crit;
    const box = (id, label, on) => `<label class="chk"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;
    v.innerHTML = `
      <form id="proForm" class="pro-form">
        <div class="field-row">
          <label for="proCommune">Commune<input type="text" id="proCommune" placeholder="Nom ou code INSEE, ex. Saran" value="${esc(c.commune ? `${c.commune.nom} (${c.commune.code})` : '')}" required></label>
          <label for="proScope">Périmètre<select id="proScope"><option value="commune" ${c.scope === 'commune' ? 'selected' : ''}>Toute la commune</option><option value="ecran" ${c.scope === 'ecran' ? 'selected' : ''}>Zone affichée sur la carte</option></select></label>
        </div>
        <details class="quick"><summary>Remplir à partir d'une phrase</summary>
          <div class="field-row"><input type="text" id="proQuick" placeholder="Ex. : 30 à 50 logements, parcelles de plus de 1 500 m²"><button type="button" class="ghost" id="proQuickGo">Appliquer</button></div>
        </details>
        <fieldset><legend>Terrain</legend>
          <div class="field-row">
            <label for="proSmin">Surface min (m²)<input type="number" id="proSmin" min="0" step="50" value="${esc(c.smin)}"></label>
            <label for="proSmax">Surface max (m²)<input type="number" id="proSmax" min="0" step="50" value="${esc(c.smax)}" placeholder="sans limite"></label>
          </div>
        </fieldset>
        <fieldset><legend>Montage</legend>
          <div class="field-row">
            <label for="proMode">Terrains recherchés<select id="proMode">
              <option value="les2" ${c.mode === 'les2' ? 'selected' : ''}>Parcelle seule et remembrement</option>
              <option value="seule" ${c.mode === 'seule' ? 'selected' : ''}>Parcelle seule</option>
              <option value="remembrement" ${c.mode === 'remembrement' ? 'selected' : ''}>Remembrement uniquement</option></select></label>
            <label for="proMaxP">Remembrement jusqu'à<select id="proMaxP">${[2, 3, 4].map((n) => `<option value="${n}" ${+c.maxParcelles === n ? 'selected' : ''}>${n} parcelles</option>`).join('')}</select></label>
          </div>
          <div class="field-row"><label class="chk"><input type="checkbox" id="proRue" ${c.rueSeul ? 'checked' : ''}> Remembrement avec pignon sur rue d'au moins</label><label for="proFacMin">Façade sur rue (m)<input type="number" id="proFacMin" min="0" step="1" value="${esc(c.facadeMin)}"></label></div>
          <p class="note">Remembrement : 2 à ${c.maxParcelles} parcelles voisines (vraie limite commune), dans la même zone du PLU, toutes du type de foncier coché ci-dessous, qui ensemble atteignent la surface minimale et forment un terrain compact.</p>
        </fieldset>
        <fieldset><legend>Programme</legend>
          <div class="chk-row">${box('proColl', '<b>Collectif possible selon le PLU</b> (hauteur, emprise, pleine terre)', c.collectif)}</div>
          <div class="field-row">
            <label for="proNiv">Hauteur permise au moins<select id="proNiv">${[[2, 'R+1 (2 niveaux)'], [3, 'R+2 (3 niveaux)'], [4, 'R+3 (4 niveaux)'], [5, 'R+4 et plus']].map(([n, t]) => `<option value="${n}" ${+c.nivMin === n ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          </div>
          <div class="field-row">
            <label for="proLmin">Logements min<input type="number" id="proLmin" min="0" value="${esc(c.lmin)}"></label>
            <label for="proLmax">Logements max<input type="number" id="proLmax" min="0" value="${esc(c.lmax)}"></label>
          </div>
          <div class="field-row">
            <label for="proSdp">Surface de plancher min (m²)<input type="number" id="proSdp" min="0" step="100" value="${esc(c.sdpMin)}" placeholder="aucune"></label>
            <label for="proHmin">Hauteur autorisée min (m)<input type="number" id="proHmin" min="0" step="1" value="${esc(c.hMin)}" placeholder="aucune"></label>
          </div>
          <p class="note">Avec « Collectif possible selon le PLU », seuls les terrains dont les règles sont connues (plan graphique du PLU ou règles saisies pour la zone) et qui permettent au moins 5 logements à la hauteur choisie sont retenus. Les autres sont mis de côté : renseignez les règles de leur zone pour les faire entrer.</p>
        </fieldset>
        <fieldset><legend>Zones du PLU</legend>
          <div id="proZonesChoix"></div>
          <div id="proZonesAncien" hidden>
            <div class="chk-row">${box('proZU', 'Zones U', c.zonesU)}${box('proZAU', 'Zones AU', c.zonesAU)}${box('proExclAct', "Exclure zones d'activités et d'équipements", c.exclActivite)}</div>
            <label for="proZF">Limiter aux zones commençant par<input type="text" id="proZF" placeholder="Ex. : UR, UC, 1AU" value="${esc(c.zonesFiltre)}"></label>
          </div>
        </fieldset>
        <fieldset><legend>Type de foncier</legend>
          <div class="actions"><button type="button" class="ghost" id="proMaisons">Maisons seulement</button><button type="button" class="ghost" id="proMutable">Tout le foncier mutable</button></div>
          <div class="chk-row">${Object.entries(NATURES).map(([k, n]) => box(`proN-${k}`, n.label, c.natures.includes(k))).join('')}</div>
          <div class="chk-row">${box('proEntr', "Ajouter aussi les entrepôts des <b>zones d'activités</b> (logement interdit par le PLU), dans la liste à part", c.entrepots)}</div>
        </fieldset>
        <fieldset><legend>Autres critères</legend>
          <div class="chk-row">${box('proRecent', 'Exclure le bâti récent (depuis 2010)', c.exclRecent)}${box('proOap', 'Uniquement en secteur d\'OAP', c.oapSeul)}${box('proContr', 'Exclure EBC et emplacements réservés', c.exclContraintes)}</div>
          <label for="proScoreMin">Note minimale<input type="number" id="proScoreMin" min="0" max="100" value="${esc(c.scoreMin)}"></label>
        </fieldset>
        <div class="actions sticky-actions"><button type="submit" ${st.running ? 'disabled' : ''}>Lancer la prospection</button>${st.running ? '<button type="button" class="ghost" id="proStop">Arrêter</button>' : ''}</div>
      </form>
      <div id="proStatus" aria-live="polite"></div>
      <div id="proZones"></div>
      <div id="proRes"></div>`;
    $('#proQuickGo', v).onclick = () => {
      const p = parseQuery($('#proQuick', v).value);
      $('#proSmin', v).value = p.smin; $('#proLmin', v).value = p.lmin; $('#proLmax', v).value = p.lmax >= 100000 ? '' : p.lmax;
      ctx.toast('Critères remplis à partir de la phrase');
    };
    const coche = (l) => Object.keys(NATURES).forEach((k) => ($(`#proN-${k}`, v).checked = l.includes(k)));
    $('#proMaisons', v).onclick = () => { coche(MAISONS); ctx.toast('Maisons seulement : seules ou réunies avec une maison voisine'); };
    $('#proMutable', v).onclick = () => coche(NATURES_DEFAUT);
    $('#proForm', v).onsubmit = async (e) => {
      e.preventDefault();
      lireFormulaire(v);
      await resolveCommune($('#proCommune', v).value);
      if (st.crit.commune) run();
    };
    const stop = $('#proStop', v); if (stop) stop.onclick = () => st.ctrl && st.ctrl.abort();
    $('#proCommune', v).addEventListener('change', async (e) => {
      const avant = st.crit.commune && st.crit.commune.code;
      await resolveCommune(e.target.value);
      if (st.crit.commune && st.crit.commune.code !== avant) { e.target.value = `${st.crit.commune.nom} (${st.crit.commune.code})`; st.crit.zonesChoix = null; }
      afficherZones(v);
    });
    afficherZones(v);
    if (st.results) renderResults();
  }

  function lireFormulaire(v) {
    const n = (id) => { const x = $(id, v).value; return x === '' ? '' : +x; };
    Object.assign(st.crit, {
      scope: $('#proScope', v).value, smin: n('#proSmin') || 0, smax: n('#proSmax'), lmin: n('#proLmin') || 0, lmax: n('#proLmax'),
      sdpMin: n('#proSdp'), hMin: n('#proHmin'), zonesU: $('#proZU', v).checked, zonesAU: $('#proZAU', v).checked,
      exclActivite: $('#proExclAct', v).checked, zonesFiltre: $('#proZF', v).value.trim(),
      natures: Object.keys(NATURES).filter((k) => $(`#proN-${k}`, v).checked),
      exclRecent: $('#proRecent', v).checked, oapSeul: $('#proOap', v).checked, exclContraintes: $('#proContr', v).checked,
      scoreMin: n('#proScoreMin') || 0,
      zonesChoix: (() => {
        const l = [...v.querySelectorAll('#proZonesChoix input[data-zone]')];
        return l.length && st.crit.commune ? { code: st.crit.commune.code, libs: l.filter((i) => i.checked).map((i) => i.dataset.zone) } : st.crit.zonesChoix || null;
      })(),
      rueSeul: $('#proRue', v).checked, facadeMin: n('#proFacMin') || 0,
      entrepots: $('#proEntr', v).checked, collectif: $('#proColl', v).checked, nivMin: +$('#proNiv', v).value, mode: $('#proMode', v).value, maxParcelles: +$('#proMaxP', v).value,
    });
    store.saveProspectionCrit({ ...st.crit, commune: st.crit.commune });
  }

  async function resolveCommune(text) {
    const t = text.trim();
    const c = st.crit.commune;
    if (c && t.startsWith(c.nom)) return;
    const code = t.match(/\b(\d[\dAB]\d{3})\b/);
    try {
      st.crit.commune = code ? await api.communeByCode(code[1]) : (await api.searchCommunes(t))[0] || null;
      if (!st.crit.commune) ctx.toast('Commune introuvable');
    } catch (e) { ctx.toast(e.message); }
  }

  function setStatus(html, pct) {
    const s = $('#proStatus');
    if (s) s.innerHTML = `<div class="status">${html}</div>${pct !== undefined ? `<div class="progress"><i style="width:${Math.round(pct)}%"></i></div>` : ''}`;
  }

  // ---------- Moteur ----------
  function critPourNote() {
    const c = st.crit;
    return { smin: c.smin || 0, smax: c.smax || 1e12, lmin: c.lmin || 1, lmax: c.lmax || 100000 };
  }

  function zoneOk(z) {
    const c = st.crit, t = (z.properties.typezone || '').toUpperCase(), lib = z.properties.libelle || '';
    if (ctx.zoneConstructible(z) !== true) return false;
    // zones cochées dans la liste de la commune
    if (c.zonesChoix && c.commune && c.zonesChoix.code === c.commune.code) return c.zonesChoix.libs.includes(lib);
    if (t.startsWith('U') && !c.zonesU) return false;
    if (t.startsWith('AU') && !c.zonesAU) return false;
    if (c.exclActivite && ctx.zoneHorsLogement(z)) return false;
    if (c.zonesFiltre) {
      const pref = c.zonesFiltre.split(/[,;\s]+/).filter(Boolean).map((x) => x.toUpperCase());
      if (!pref.some((p) => lib.toUpperCase().startsWith(p))) return false;
    }
    return true;
  }

  /**
   * Pourquoi un terrain n'entre pas dans les résultats : 'regles' (le PLU ne permet pas le programme),
   * 'attente' (règles inconnues alors que le collectif est exigé), ou null.
   */
  function refus(h, rules, pot) {
    const c = st.crit;
    if (pot) {
      if (c.lmin && pot.real < Math.ceil(c.lmin * 0.5)) return 'regles';
      if (c.sdpMin && pot.sdp < c.sdpMin) return 'regles';
      if (c.collectif && (pot.niv < (c.nivMin || 2) || pot.real < 5)) return 'regles';
    } else if (c.collectif) return 'attente';
    if (c.hMin && rules && rules.h !== null && rules.h !== undefined && rules.h < c.hMin) return 'regles';
    return null;
  }

  /**
   * Terrains sans règles PLU connues : nombre de logements estimé d'après la densité des opérations collectives
   * autorisées dans la même zone (3 au moins), sinon dans la commune. Ceux qui atteignent le programme entrent
   * dans les résultats avec la mention « estimation » ; les autres restent en attente de règles.
   */
  function appliquerEstimations(r) {
    const d = r.densites, c = st.crit;
    if (!d) return;
    const critN = critPourNote(), garde = [];
    const base = (lib) => { const z = d.zones.get(lib); if (z && z.n >= 3) return { ...z, base: `zone ${lib}` }; if (d.commune.n >= 3) return { ...d.commune, base: 'commune' }; return null; };
    const estimer = (h) => {
      const b = base(h.zone.properties.libelle);
      h.estim = b ? { lg: Math.floor((h.occ.S * b.med) / 10000), dens: Math.round(b.med), n: b.n, base: b.base } : null;
    };
    for (const h of r.list) if (!h.pot && !h.zoneAct) estimer(h);
    for (const h of r.attente) {
      estimer(h);
      const ok = h.estim && h.estim.lg >= Math.max(5, Math.ceil((c.lmin || 0) * 0.5));
      if (ok) {
        h.s = noter({ S: h.occ.S, crit: critN, occ: h.occ, pot: null, contraintes: h.contraintes, compacite: compacite(h.f), facade: h.facade });
        if (h.s.tot >= (c.scoreMin || 0)) { r.list.push(h); continue; }
      }
      garde.push(h);
    }
    r.attente.length = 0; r.attente.push(...garde);
    r.list.sort((a, b) => b.s.tot - a.s.tot);
  }

  /** Document d'urbanisme (partition GPU) d'une commune : copie hebdomadaire, sinon points de la commune. */
  async function trouverPartition(com, signal) {
    // Le PLU est identifié par la zone trouvée en un point de la commune. Le centre officiel peut tomber
    // dans un fleuve ou un espace non zoné (Tours, Chinon) : plusieurs points autour sont essayés.
    let partition = null;
    const copie = await api.communeCopie(com.code);
    if (copie && copie.rnu) throw new api.ApiError(`${com.nom} est au RNU : pas de PLU ni de carte communale, c'est le règlement national d'urbanisme qui s'applique`);
    if (copie && copie.partitions && copie.partitions.length) partition = copie.partitions.find((x) => !/PSMV/i.test(x)) || copie.partitions[0];
    const [cx, cy] = com.centre.coordinates;
    const points = [[0, 0], [0.006, 0], [-0.006, 0], [0, 0.004], [0, -0.004], [0.012, 0.008], [-0.012, -0.008], [0.012, -0.008], [-0.012, 0.008]];
    for (let i = 0; !partition && i < points.length; i += 3) {
      const res = await Promise.all(points.slice(i, i + 3).map(([dx, dy]) => api.duAt(cx + dx, cy + dy, { signal }).catch(() => null)));
      for (const d of res) { const z = d && (d['zone-urba'][0] || d['secteur-cc'][0]); if (z && z.properties.partition && !partition) partition = z.properties.partition; }
    }
    if (!partition) {
      try { partition = (await api.gpuAt('zone-urba', com.centre, { retries: 1 }))[0]?.properties.partition || null; } catch { partition = null; }
    }
    if (!partition) {
      let rnu = null;
      try { rnu = (await api.municipality(com.code))?.properties.is_rnu ?? null; } catch { rnu = null; }
      if (rnu) throw new api.ApiError(`${com.nom} est au RNU : pas de PLU ni de carte communale, c'est le règlement national d'urbanisme qui s'applique`);
      try { partition = (await api.gpuAt('document', com.centre, { retries: 1 }))[0]?.properties.partition || null; }
      catch { throw new api.ApiError("Le Géoportail de l'Urbanisme (IGN) ne répond pas pour le moment. Réessayez dans quelques minutes"); }
    }
    if (!partition) throw new api.ApiError(`Aucun PLU publié au Géoportail de l'Urbanisme pour ${com.nom} (document non numérisé)`);
    return partition;
  }

  // ---------- Zones du PLU de la commune, à cocher ----------
  const zonesCache = new Map();
  /** Zones du PLU présentes sur la commune, regroupées par libellé : [{ libelle, libelong, typezone, n, logement }]. */
  function zonesDeLaCommune(com) {
    if (!zonesCache.has(com.code)) {
      zonesCache.set(com.code, (async () => {
        const partition = await trouverPartition(com);
        const [zs, full] = await Promise.all([api.gpuByPartition('zone-urba', partition), com.contour ? com : api.communeByCode(com.code)]);
        const contour = full && full.contour ? turf.feature(full.contour) : null;
        const cb = contour ? turf.bbox(contour) : null;
        const par = new Map();
        for (const z of zs) {
          if (!z.geometry) continue;
          if (contour) {
            const b = turf.bbox(z);
            if (b[0] > cb[2] || b[2] < cb[0] || b[1] > cb[3] || b[3] < cb[1]) continue;
            try { if (!turf.booleanIntersects(z, contour)) continue; } catch { /* géométrie invalide : on garde */ }
          }
          const p = z.properties, k = p.libelle || '?';
          const e = par.get(k) || { libelle: k, libelong: p.libelong || '', typezone: (p.typezone || '').toUpperCase(), n: 0, logement: zoneLogement(z), construct: ctx.zoneConstructible(z) === true };
          e.n++; par.set(k, e);
        }
        const ordre = (t) => (t.startsWith('U') ? 0 : t.startsWith('AU') ? 1 : 2);
        return { partition, zones: [...par.values()].sort((a, b) => ordre(a.typezone) - ordre(b.typezone) || a.libelle.localeCompare(b.libelle, 'fr', { numeric: true })) };
      })().catch((e) => { zonesCache.delete(com.code); throw e; }));
    }
    return zonesCache.get(com.code);
  }
  /** Zone où le PLU autorise le logement (U ou AU, hors activités, équipements, parcs, 2AU). */
  const zoneLogement = (z) => ctx.zoneConstructible(z) === true && !ctx.zoneHorsLogement(z);

  async function afficherZones(v) {
    const box = $('#proZonesChoix', v); if (!box) return;
    const com = st.crit.commune;
    if (!com) { box.innerHTML = '<p class="note">Choisissez une commune : la liste de ses zones du PLU s\'affichera ici.</p>'; return; }
    box.innerHTML = `<p class="note">Chargement des zones du PLU de ${esc(com.nom)}…</p>`;
    let d;
    try { d = await zonesDeLaCommune(com); } catch (e) {
      box.innerHTML = `<p class="note">Liste des zones indisponible (${esc(e.message)}). Les options ci-dessous s'appliquent.</p>`;
      $('#proZonesAncien', v).hidden = false; return;
    }
    if (st.crit.commune !== com) return;
    const choix = st.crit.zonesChoix && st.crit.zonesChoix.code === com.code ? new Set(st.crit.zonesChoix.libs) : null;
    const coche = (z) => (choix ? choix.has(z.libelle) : z.logement);
    const ligne = (z) => `<label class="zchk${z.construct ? '' : ' off'}"><input type="checkbox" data-zone="${esc(z.libelle)}" ${coche(z) && z.construct ? 'checked' : ''} ${z.construct ? '' : 'disabled'}>
      <span><b>${esc(z.libelle)}</b> <span class="note">${esc(z.libelong || '')}</span></span></label>`;
    const hab = d.zones.filter((z) => z.logement), autres = d.zones.filter((z) => !z.logement);
    box.innerHTML = `
      <p class="note">${d.zones.length} zones du PLU (${esc(d.partition)}) sur ${esc(com.nom)}. Seules les zones cochées sont prospectées.</p>
      <div class="actions"><button type="button" class="ghost" data-zsel="hab">Zones d'habitat</button><button type="button" class="ghost" data-zsel="tout">Tout cocher</button><button type="button" class="ghost" data-zsel="rien">Tout décocher</button></div>
      ${hab.length ? `<div class="zgroup"><div class="label">Zones où le PLU autorise le logement</div>${hab.map(ligne).join('')}</div>` : ''}
      ${autres.length ? `<details class="zgroup"${autres.some((z) => coche(z) && z.construct) ? ' open' : ''}><summary>Autres zones (${autres.length}) : activités, équipements, agricoles, naturelles</summary>${autres.map(ligne).join('')}</details>` : ''}`;
    $('#proZonesAncien', v).hidden = true;
    box.querySelectorAll('[data-zsel]').forEach((b) => (b.onclick = () => {
      box.querySelectorAll('input[data-zone]:not(:disabled)').forEach((i) => {
        const z = d.zones.find((x) => x.libelle === i.dataset.zone);
        i.checked = b.dataset.zsel === 'tout' ? true : b.dataset.zsel === 'rien' ? false : z.logement;
      });
    }));
  }

  async function run() {
    const c = st.crit, com = c.commune, hyp = store.settings();
    const bounds = c.scope === 'ecran' ? ctx.map.getBounds() : null;
    st.running = true; st.results = null; st.filtreNature = null; st.cat = 'logement'; st.ouvert = null; st.ctrl = new AbortController();
    const signal = st.ctrl.signal;
    render();
    const t0 = performance.now();
    try {
      if (!bounds) ctx.map.flyTo({ center: com.centre.coordinates, zoom: 13 });
      setStatus(`Document d'urbanisme de ${esc(com.nom)}…`, 3);
      const partition = await trouverPartition(com, signal);

      setStatus(`Zonage ${esc(partition)}…`, 6);
      const zones = (await api.gpuByPartition('zone-urba', partition, { signal })).filter((z) => z.geometry);
      zones.forEach((z) => (z.bbox = turf.bbox(z)));

      const parcels = await api.parcellesCommune(com.code, { signal, onProgress: (n, tot) => setStatus(`Parcelles cadastrales : ${f0(n)}${tot ? ' / ' + f0(tot) : ''}`, 8 + (tot ? (27 * n) / tot : 10)) });
      // façade sur rue de chaque parcelle (côtés non mitoyens)
      setStatus('Façades sur rue des parcelles…', 34); await pause();
      const facades = facadesSurRue(parcels);

      // 1. Parcelles situées dans une zone retenue (index des zones pour aller vite)
      const idxZones = grille(zones, 0.005);
      const seule = c.mode !== 'remembrement', remb = c.mode !== 'seule';
      const cand = [], pool = [];
      const compte = { total: parcels.length, surface: 0, perimetre: 0, zone: 0, nature: 0, regles: 0, sansRegles: 0, contraintes: 0, score: 0, groupes: 0 };
      for (let n = 0; n < parcels.length; n++) {
        const f = parcels[n];
        if (n % 2000 === 0) { setStatus(`Zonage des parcelles : ${f0(n)} / ${f0(parcels.length)}`, 35 + (5 * n) / parcels.length); await pause(); }
        if (!f.geometry) continue;
        const S = +f.properties.contenance || 0;
        const okSeule = seule && S >= (c.smin || 0) && !(c.smax && S > c.smax);
        const okPool = remb && S >= 150 && S < (c.smin || Infinity);
        if (!okSeule && !okPool) { compte.surface++; continue; }
        const pt = turf.pointOnFeature(f), [x, y] = pt.geometry.coordinates;
        if (bounds && !bounds.contains([x, y])) { compte.perimetre++; continue; }
        const z = idxZones.pres([x, y, x, y]).find((zz) => turf.booleanPointInPolygon(pt, zz));
        // zone d'activités : seulement pour la liste des entrepôts ; sinon zone qui autorise le logement
        let dest = z && c.entrepots && zoneActivite(z) && ctx.zoneConstructible(z) === true ? 'activite' : z && zoneOk(z) ? 'logement' : null;
        if (!dest) { compte.zone++; continue; }
        if (dest === 'activite' && !okSeule) { compte.surface++; continue; }
        const k = { f, zone: z, zoneLib: z.properties.libelle, pt: [x, y], S, dest };
        if (okSeule) cand.push(k); else pool.push(k);
      }
      if (!cand.length && !pool.length) {
        st.results = { com, partition, list: [], attente: [], compte, secs: Math.round((performance.now() - t0) / 1000), avertissements: [] };
        setStatus(resume(st.results));
        return;
      }

      // 2. Occupation réelle : bâtiments, parkings, équipements (seulement autour des terrains étudiés)
      const cells = new Map();
      for (const k of [...cand, ...pool]) {
        const b = turf.bbox(k.f);
        for (let x = Math.floor(b[0] / TUILE); x <= Math.floor(b[2] / TUILE); x++) {
          for (let y = Math.floor(b[1] / TUILE); y <= Math.floor(b[3] / TUILE); y++) cells.set(`${x}:${y}`, [x * TUILE, y * TUILE, (x + 1) * TUILE, (y + 1) * TUILE]);
        }
      }
      const tiles = [...cells.values()];
      const avertissements = [];
      const prescP = api.gpuByPartition('prescription-surf', partition, { signal }).catch(() => { avertissements.push("Prescriptions du PLU indisponibles : contraintes (EBC, emplacements réservés, OAP) et règles du plan graphique non vérifiées"); return null; });
      const frichesP = api.friches(com.code);
      const occ = await api.occupationTiles(tiles, { signal, onProgress: (d, n) => setStatus(`Bâtiments, parkings et équipements : secteur ${d} / ${n} (${f0(cand.length)} parcelles seules, ${f0(pool.length)} petites parcelles pour le remembrement)`, 40 + (35 * d) / n) });
      setStatus('Prescriptions du PLU et friches…', 76);
      const [presc, fr] = await Promise.all([prescP, frichesP]);
      if (fr === null) avertissements.push('Cartofriches indisponible : les friches ne sont pas repérées');

      const idx = { bat: grille(occ.batiments), park: grille(occ.parkings), eq: grille(occ.equipements) };
      const comBbox = turf.bbox(turf.featureCollection([...cand, ...pool].map((k) => k.f)));
      const idxPresc = presc ? grille(presc.filter((p) => p.geometry && (() => { const b = turf.bbox(p); return b[0] <= comBbox[2] && b[2] >= comBbox[0] && b[1] <= comBbox[3] && b[3] >= comBbox[1]; })())) : null;
      const frichesParIdu = new Map();
      (fr || []).forEach((x) => x.idus.forEach((i) => frichesParIdu.set(i, x)));

      // Nature du foncier : retenue si cochée, bâti récent écarté (sauf terrain nu, parking, friche)
      const natureOk = (o) => (c.natures.includes(o.cle) || (c.entrepots && o.cle === 'activite')) && !(c.exclRecent && o.flags.some((x) => x.k === 'recent') && !['terrain_nu', 'parking', 'friche'].includes(o.cle));

      // Évaluation commune à une parcelle seule et à un remembrement
      const out = [], attente = [], missing = new Map(), critN = critPourNote();
      const evaluer = (h) => {
        const contraintes = contraintesDe(h.f, idxPresc, h.occ.S);
        const oap = contraintes.some((x) => x.k === 'oap');
        if (c.oapSeul && !oap) { compte.contraintes++; return; }
        if (c.exclContraintes && contraintes.some((x) => x.k === 'ebc' || x.k === 'er')) { compte.contraintes++; return; }
        h.contraintes = contraintes; h.oap = oap;
        h.cat = h.cat || (h.occ.cle === 'activite' ? 'entrepot' : 'logement');
        h.key = store.ruleKey(partition, h.zone.properties.libelle);
        if (h.zoneAct) {
          // zone d'activités : pas de logement, foncier d'activité noté sur sa taille, sa sous-exploitation et ses contraintes
          h.pot = null; h.aConfirmer = false;
          h.s = noter({ S: h.occ.S, crit: critN, occ: h.occ, pot: null, contraintes, compacite: compacite(h.f), facade: h.facade });
          if (h.s.tot < (c.scoreMin || 0)) { compte.score++; return; }
          out.push(h); return;
        }
        // Règles de la zone (saisies ou extraites), complétées par le plan graphique du PLU sous le terrain
        h.graph = reglesGraphiquesParcelle(h.f, idxPresc);
        if (h.graph && !h.graph.n) h.graph = null;
        classer(h, { initial: true });
      };
      // Calcule potentiel et note ; range le terrain dans la liste, en attente de règles, ou l'écarte
      const classer = (h, { initial } = {}) => {
        const fu = fusionRegles(store.getRules(h.key), h.graph);
        const rules = fu.utile ? fu.regles : null;
        let pot = null;
        h.aConfirmer = !rules;
        if (rules) {
          pot = computePotentiel(h.f, rules, hyp, { contenance: h.occ.S, batiSdp: h.occ.stats.sdp });
          if (!pot.ok) { pot = null; h.aConfirmer = true; }
        }
        h.pot = pot;
        const raison = refus(h, rules, pot);
        if (raison === 'regles') { compte.regles++; return 'ecarte'; }
        if (raison === 'attente') {
          compte.sansRegles++;
          const m = missing.get(h.key) || { key: h.key, zone: h.zone, n: 0 }; m.n++; missing.set(h.key, m);
          attente.push(h); return 'attente';
        }
        if (!rules) { const m = missing.get(h.key) || { key: h.key, zone: h.zone, n: 0 }; m.n++; missing.set(h.key, m); }
        h.s = noter({ S: h.occ.S, crit: critN, occ: h.occ, pot, contraintes: h.contraintes, compacite: compacite(h.f), facade: h.facade });
        if (h.s.tot < (c.scoreMin || 0)) { compte.score++; return 'ecarte'; }
        if (initial || !out.includes(h)) out.push(h);
        return 'garde';
      };

      // 3a. Parcelles seules
      setStatus(`Analyse de ${f0(cand.length)} parcelles…`, 80);
      for (let n = 0; n < cand.length; n++) {
        if (n % 500 === 0) await pause();
        const k = cand[n];
        const o = analyser(k.f, idx, frichesParIdu);
        if (k.dest === 'activite') {
          if (o.cle !== 'activite') { compte.nature++; continue; }
          evaluer({ f: k.f, zone: k.zone, occ: o, cat: 'entrepot', zoneAct: true, facade: facades.get(k.f.properties.idu) });
          continue;
        }
        if (!natureOk(o)) { compte.nature++; continue; }
        evaluer({ f: k.f, zone: k.zone, occ: o, facade: facades.get(k.f.properties.idu) });
      }

      // 3b. Remembrement : petites parcelles voisines du foncier coché, dans la même zone
      let nbGroupes = 0;
      if (remb && pool.length) {
        setStatus(`Remembrement : analyse de ${f0(pool.length)} petites parcelles…`, 86);
        const items = [];
        for (let n = 0; n < pool.length; n++) {
          if (n % 500 === 0) await pause();
          const k = pool[n];
          const o = analyser(k.f, idx, frichesParIdu);
          if (!natureOk(o)) continue;
          items.push({ ...k, occ: o, facade: facades.get(k.f.properties.idu) || 0 });
        }
        setStatus(`Remembrement : recherche des parcelles voisines parmi ${f0(items.length)}…`, 90);
        await pause();
        const vois = voisinages(items);
        const groupes = regroupements(items, vois, { smin: c.smin || 0, smax: c.smax || 0, maxParcelles: c.maxParcelles || 3 })
          .sort((a, b) => a.length - b.length);
        setStatus(`Remembrement : étude de ${f0(Math.min(groupes.length, 4000))} regroupements possibles…`, 93);
        const evalues = [];
        for (let n = 0; n < groupes.length && n < 4000; n++) {
          if (n % 200 === 0) await pause();
          const membres = groupes[n].map((i) => items[i]);
          const facG = membres.reduce((a, m) => a + (m.facade || 0), 0);
          if (c.rueSeul && facG < (c.facadeMin || 0)) { compte.facade = (compte.facade || 0) + 1; continue; }
          const u = fusion(membres.map((m) => m.f));
          if (!u || compacite(u) < 0.3) continue;
          const S = membres.reduce((a, m) => a + m.S, 0);
          const p0 = membres[0].f.properties, memeSection = membres.every((m) => m.f.properties.section === p0.section);
          u.properties = {
            ...p0, contenance: S, remembrement: true,
            idu: membres.map((m) => m.f.properties.idu).join('+'),
            numero: membres.map((m) => (memeSection ? '' : m.f.properties.section + ' ') + String(m.f.properties.numero).padStart(4, '0')).join('+'),
            membres: membres.map((m) => ({ idu: m.f.properties.idu, ref: refOf(m.f.properties), S: m.S, nature: m.occ.label })),
          };
          const st2 = membres.reduce((a, m) => ({ sdp: a.sdp + m.occ.stats.sdp, emprise: a.emprise + m.occ.stats.emprise, logements: a.logements + m.occ.stats.logements, anneeMax: Math.max(a.anneeMax, m.occ.stats.anneeMax || 0) }), { sdp: 0, emprise: 0, logements: 0, anneeMax: 0 });
          const flags = [...new Map(membres.flatMap((m) => m.occ.flags).map((x) => [x.k, x])).values()];
          const poids = Math.round(membres.reduce((a, m) => a + (POIDS_NATURE[m.occ.cle] ?? 10), 0) / membres.length) - 2 * (membres.length - 1);
          const o = {
            cle: 'remembrement', S, ces: S ? st2.emprise / S : 0, poids,
            label: `Remembrement de ${membres.length} parcelles`,
            stats: { ...st2, n: membres.reduce((a, m) => a + m.occ.stats.n, 0), legers: 0, liste: [] },
            flags, raisons: membres.map((m) => `${refOf(m.f.properties)} : ${m.occ.label.toLowerCase()} (${f0(m.S)} m²)`),
          };
          const h = { f: u, zone: membres[0].zone, occ: o, groupe: true, membres, facade: Math.round(facG * 10) / 10 };
          const avant = out.length;
          evaluer(h);
          if (out.length > avant) evalues.push(out.pop());
        }
        // pas plus de 2 variantes par parcelle, les mieux notées d'abord
        evalues.sort((a, b) => b.s.tot - a.s.tot);
        const gardes = sansDoublons(evalues, 2);
        nbGroupes = gardes.length;
        out.push(...gardes);
        compte.groupes = groupes.length;
        if (groupes.length > 4000) avertissements.push(`${f0(groupes.length)} regroupements possibles : les 4 000 plus simples (moins de parcelles) ont été étudiés. Réduisez le périmètre (zone affichée) pour tout voir.`);
      }
      // regroupements en attente de règles : 2 au plus par parcelle aussi
      const attSeules = attente.filter((h) => !h.groupe), attGrp = sansDoublons(attente.filter((h) => h.groupe), 2);
      attente.length = 0; attente.push(...attSeules, ...attGrp);

      out.sort((a, b) => b.s.tot - a.s.tot);
      st.results = { com, partition, list: out, attente, compte, cand: cand.length, groupes: nbGroupes, secs: Math.round((performance.now() - t0) / 1000), avertissements, date: new Date().toISOString(), classer };
      st.zonesMissing = [...missing.values()].sort((a, b) => b.n - a.n);
      // logements estimés d'après les opérations voisines pour les terrains sans règles PLU
      setStatus('Estimation des logements d\'après les opérations collectives autorisées alentour…', 97);
      try { st.results.densites = await densitesVoisines(com.code, idxZones); } catch { st.results.densites = null; avertissements.push('Permis de construire (Sitadel) indisponibles : pas d\'estimation des logements pour les zones sans règles'); }
      const avantEstim = st.results.attente.length;
      appliquerEstimations(st.results);
      const entres = avantEstim - st.results.attente.length;
      if (entres) avertissements.push(`${f0(entres)} terrain(s) sans règles PLU connues ajoutés avec un nombre de logements estimé d'après la densité des opérations collectives autorisées alentour (mention « ≈ »). À confirmer avec le règlement de la zone.`);
      store.addHistorique({ date: st.results.date, commune: com.nom, code: com.code, total: parcels.length, retenus: out.length, top: out.slice(0, 5).map((h) => ({ ref: refOf(h.f.properties), score: h.s.tot, nature: h.occ.label })) });
      st.compteRef = compte;
      if (st.results.attente.length) avertissements.push(`${f0(st.results.attente.length)} terrain(s) mis de côté : règles du PLU inconnues pour leur zone et pas assez d'opérations voisines pour estimer. Renseignez les règles dans « zones sans règles » ci-dessous, ils entreront dans les résultats.`);
      setStatus(resume(st.results));
      ctx.setHits(out.filter((h) => h.cat !== 'entrepot'));
      ctx.onResults && ctx.onResults(true);
      renderResults();
      await ajouterAdresses(st.results);
    } catch (e) {
      setStatus(`<p class="err">${esc(e.name === 'AbortError' || signal.aborted ? 'Prospection arrêtée' : e.message)}</p>`);
    } finally {
      st.running = false; st.ctrl = null;
      const btn = $('#proForm button[type=submit]'); if (btn) btn.disabled = false; $('#proStop')?.remove();
      if (st.results) renderResults();
    }
  }

  /** Adresses (BAN) des terrains retenus : 400 premiers, chaque parcelle d'un remembrement. */
  async function ajouterAdresses(r) {
    const cibles = r.list.slice(0, 400);
    const feats = [], refs = [];
    for (const h of cibles) {
      const parts = h.groupe ? h.membres.map((m) => m.f) : [h.f];
      parts.forEach((f, j) => { feats.push(f); refs.push([h, j, parts.length]); });
    }
    setStatus(`${resume(r)}<br><span class="note">Recherche des adresses (${feats.length})…</span>`);
    const res = await api.adressesParcelles(feats, (d, n) => { if (d % 40 === 0) setStatus(`${resume(r)}<br><span class="note">Adresses : ${d} / ${n}</span>`); });
    const parH = new Map();
    res.forEach((a, k) => { const [h, j] = refs[k]; if (!parH.has(h)) parH.set(h, []); parH.get(h)[j] = a; });
    for (const [h, l] of parH) {
      const txt = [...new Set(l.filter(Boolean).map((a) => a.rue + (a.precision === 'voisine' ? ` (voisine, ${a.distance} m)` : '')))];
      h.adresse = txt.join(' / ');
      h.adresses = l;
      if (h.groupe && Array.isArray(h.f.properties.membres)) l.forEach((x, j) => { if (x && h.f.properties.membres[j]) h.f.properties.membres[j].adresse = x.label; });
      if (l[0]) h.f.properties.adresse = l.filter(Boolean).map((a) => a.label + (a.precision === 'voisine' ? ` (adresse voisine à ${a.distance} m)` : '')).join(' / ');
    }
    setStatus(resume(r));
    if (st.results === r) renderResults();
  }

  function resume(r) {
    const c = r.compte;
    const g = r.list.filter((h) => h.groupe).length, e = r.list.filter((h) => h.cat === 'entrepot').length;
    return `<b>${f0(r.list.length - e)} terrain(s) pour du logement</b>${g ? ` dont ${f0(g)} remembrement(s)` : ''}${e ? ` · <b>${f0(e)} entrepôt(s) et local(aux) d'activité</b>` : ''} sur ${f0(c.total)} parcelles en ${r.secs} s
      <span class="note">· écartées : ${f0(c.surface)} surface, ${c.perimetre ? f0(c.perimetre) + ' hors zone affichée, ' : ''}${f0(c.zone)} zonage, ${f0(c.nature)} nature du foncier, ${f0(c.contraintes)} contraintes, ${f0(c.regles)} règles du PLU (programme impossible)${c.sansRegles ? `, ${f0(c.sansRegles)} en attente de règles` : ''}${c.facade ? `, ${f0(c.facade)} regroupements sans pignon sur rue` : ''}${c.score ? ', ' + f0(c.score) + ' note trop basse' : ''}</span>`;
  }

  // ---------- Résultats ----------
  const COLS = [
    { k: 'rang', t: '#', v: (h, i) => i + 1, n: true },
    { k: 'ref', t: 'Parcelle(s)', v: (h) => refOf(h.f.properties) },
    { k: 'adresse', t: 'Adresse', v: (h) => h.adresse || '' },
    { k: 'zone', t: 'Zone', v: (h) => h.zone.properties.libelle },
    { k: 'facade', t: 'Façade', v: (h) => (h.facade ?? -1), fmt: (x) => (x < 0 ? '—' : `${f0(x)} m`), n: true },
    { k: 'surface', t: 'Surface', v: (h) => h.occ.S, fmt: (x) => m2(x), n: true },
    { k: 'nature', t: 'Nature', v: (h) => h.occ.label },
    { k: 'ces', t: 'Bâti', v: (h) => h.occ.ces, fmt: (x) => `${Math.round(x * 100)} %`, n: true },
    { k: 'niv', t: 'Niv.', v: (h) => (h.pot ? h.pot.niv : -1), fmt: (x) => (x < 0 ? '?' : x <= 1 ? 'RDC' : 'R+' + (x - 1)), n: true },
    { k: 'lgt', t: 'Logts', v: (h) => (h.zoneAct ? -2 : h.pot ? h.pot.real : h.estim ? h.estim.lg - 0.1 : -1), fmt: (x) => (x === -2 ? '—' : x < 0 ? '?' : Number.isInteger(x) ? x : `≈ ${Math.round(x + 0.1)}`), n: true },
    { k: 'score', t: 'Note', v: (h) => h.s.tot, n: true },
  ];

  function renderResults() {
    const r = st.results; if (!r) return;
    const z = $('#proZones');
    if (z) {
      z.innerHTML = st.zonesMissing.length ? `<details class="missing"><summary><b>${st.zonesMissing.length} zone(s) sans règles</b> : potentiel non calculé pour ${st.zonesMissing.reduce((a, m) => a + m.n, 0)} terrain(s). Renseignez-les pour affiner la note.</summary><div class="missing-list"></div></details>` : '';
      const ml = $('.missing-list', z);
      st.zonesMissing.slice(0, 12).forEach((m) => {
        const d = document.createElement('details');
        d.innerHTML = `<summary><b>${esc(m.zone.properties.libelle)}</b> — ${m.n} terrain(s) ${m.zone.properties.urlfic ? `· <a href="${esc(m.zone.properties.urlfic)}" target="_blank" rel="noopener">règlement</a>` : ''}</summary>`;
        d.appendChild(ctx.rulesBlock(m.key, m.zone.properties.libelle, rerank, { zone: m.zone, partition: r.partition }));
        ml && ml.appendChild(d);
      });
    }
    const res = $('#proRes'); if (!res) return;
    // Deux listes : terrains pour du logement, entrepôts et locaux d'activité
    const cat = st.cat || 'logement';
    const nCat = { logement: r.list.filter((h) => h.cat !== 'entrepot').length, entrepot: r.list.filter((h) => h.cat === 'entrepot').length, tout: r.list.length };
    const base = cat === 'tout' ? r.list : cat === 'entrepot' ? r.list.filter((h) => h.cat === 'entrepot') : r.list.filter((h) => h.cat !== 'entrepot');
    // Comptes par nature, cliquables pour filtrer
    const parNature = {};
    base.forEach((h) => (parNature[h.occ.cle] = (parNature[h.occ.cle] || 0) + 1));
    let liste = st.filtreNature ? base.filter((h) => h.occ.cle === st.filtreNature) : base.slice();
    const col = COLS.find((x) => x.k === st.tri.k) || COLS[COLS.length - 1];
    if (col.k !== 'rang') liste.sort((a, b) => { const va = col.v(a), vb = col.v(b); return (va > vb ? 1 : va < vb ? -1 : 0) * st.tri.dir; });
    res.innerHTML = `
      ${r.avertissements.length ? `<div class="warn">${r.avertissements.map(esc).join('<br>')}</div>` : ''}
      <nav class="cat-tabs" role="tablist">${Object.entries(CATS).map(([k, t]) => `<button type="button" role="tab" class="cat-tab" data-cat="${k}" aria-selected="${cat === k}">${t} <span class="n">${f0(nCat[k])}</span></button>`).join('')}</nav>
      ${cat === 'entrepot' ? `<p class="note">Entrepôts, bâtiments industriels ou commerciaux situés en zone où le PLU autorise le logement : reconversion en logements possible, potentiel calculé.${r.list.some((h) => h.zoneAct) ? " Ceux des zones d'activités (logement interdit) sont signalés, Logts « — »." : ''}</p>` : ''}
      <div class="res-head">
        <div class="chips">${Object.entries(parNature).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<button type="button" class="chip-btn ${st.filtreNature === k ? 'on' : ''}" data-nat="${k}">${esc(natLabel(k))} · ${n}</button>`).join('')}${st.filtreNature ? '<button type="button" class="chip-btn" data-nat="">Tout afficher</button>' : ''}</div>
        ${r.list.length ? '<button type="button" class="ghost" id="proCsv">Exporter en CSV</button>' : ''}
      </div>
      ${r.list.length ? `<div class="tw"><table class="res-table">
        <thead><tr>${COLS.map((x) => `<th class="${x.n ? 'n' : ''}"><button type="button" class="sort" data-sort="${x.k}">${x.t}${st.tri.k === x.k ? (st.tri.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead>
        <tbody>${liste.slice(0, 300).map((h, i) => ligne(h, i)).join('')}</tbody></table></div>
        ${liste.length > 300 ? `<p class="note">300 premiers terrains affichés sur ${liste.length} ; l'export CSV les contient tous.</p>` : ''}` : '<p class="empty">Aucun terrain ne correspond. Élargissez la surface, les zones ou les types de foncier.</p>'}
      <p class="note">Note sur 100 : taille 15, nature du foncier 25, sous-exploitation 15, potentiel PLU 25, contraintes et forme 20. Quand les règles de la zone manquent, la note est calculée sur les autres critères (mention « partielle »).</p>`;
    res.querySelectorAll('[data-nat]').forEach((b) => (b.onclick = () => { st.filtreNature = b.dataset.nat || null; renderResults(); ctx.setHits(st.filtreNature ? base.filter((h) => h.occ.cle === st.filtreNature) : base); }));
    res.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => {
      st.cat = b.dataset.cat; st.filtreNature = null; renderResults();
      const r2 = st.results; ctx.setHits(st.cat === 'tout' ? r2.list : st.cat === 'entrepot' ? r2.list.filter((h) => h.cat === 'entrepot') : r2.list.filter((h) => h.cat !== 'entrepot'));
    }));
    res.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => { const k = b.dataset.sort; st.tri = { k, dir: st.tri.k === k ? -st.tri.dir : (k === 'score' || k === 'surface' || k === 'lgt' ? -1 : 1) }; renderResults(); }));
    res.querySelectorAll('tr[data-i]').forEach((tr) => {
      const h = liste[+tr.dataset.i];
      tr.onclick = (e) => {
        if (e.target.closest('a')) return;
        st.ouvert = st.ouvert === h ? null : h;
        renderResults();
        ctx.map.fitBounds(turf.bbox(h.f), { padding: 80, maxZoom: 18 });
      };
    });
    res.querySelectorAll('[data-fiche]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const h = liste[+b.dataset.fiche]; ctx.map.fitBounds(turf.bbox(h.f), { padding: 80, maxZoom: 18 }); ctx.selectFeature(h.f, undefined, 'fiche'); }));
    res.querySelectorAll('[data-carte]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const h = liste[+b.dataset.carte]; ctx.map.fitBounds(turf.bbox(h.f), { padding: 60, maxZoom: 18 }); if (window.tfVoirCarte) window.tfVoirCarte(); }));
    const csv = $('#proCsv'); if (csv) csv.onclick = () => exportCsv(r);
  }

  function ligne(h, i) {
    const open = st.ouvert === h;
    const cells = COLS.map((x) => { const v = x.v(h, i); return `<td class="${x.n ? 'n' : ''} c-${x.k}" data-l="${x.t}">${x.k === 'score' ? `<span class="score s${Math.floor(v / 20)}">${v}</span>${h.s.partiel ? '<small class="part">partielle</small>' : ''}` : esc(x.fmt ? x.fmt(v) : v)}</td>`; }).join('');
    const detail = open ? `<tr class="detail"><td colspan="${COLS.length}">
      <div class="why">${h.s.parts.map((p) => `<div class="why-row"><span>${esc(p.label)}</span><span class="bar"><i style="width:${p.v === null ? 0 : Math.round((100 * p.v) / p.max)}%"></i></span><b>${p.v === null ? '—' : p.v}/${p.max}</b><small>${esc(p.why)}</small></div>`).join('')}</div>
      ${h.cat === 'entrepot' ? `<p><span class="pill ${h.zoneAct ? 'no' : 'ok'}">${h.zoneAct ? "zone d'activités" : "zone d'habitat"}</span> ${h.zoneAct ? "Entrepôt ou local d'activité en zone d'activités : le logement y est interdit par le PLU." : 'Entrepôt ou local d\'activité en zone qui autorise le logement : reconversion en logements possible.'}</p>` : ''}
      ${h.groupe ? `<p><span class="pill wa">remembrement</span> ${h.membres.length} parcelles voisines, propriétaires probablement différents : ${h.membres.map((m, j) => `<b>${esc(refOf(m.f.properties))}</b> ${esc(m.occ.label.toLowerCase())}, ${f0(m.S)} m²${h.adresses && h.adresses[j] ? ', ' + esc(h.adresses[j].label) : ''}`).join(' · ')}</p>` : ''}
      <p class="note">${esc(h.occ.raisons.join(' ; '))}${h.occ.flags.length ? ' · ' + h.occ.flags.map((x) => esc(x.t)).join(' · ') : ''}${h.facade !== undefined ? ` · façade sur rue ${f0(h.facade)} m` : ''}${h.oap ? ' · en secteur d\'OAP' : ''}${h.aConfirmer ? (h.estim ? ` · <b>≈ ${h.estim.lg} logements estimés</b> (densité médiane de ${h.estim.dens} logts/ha sur ${h.estim.n} opérations collectives autorisées, ${esc(h.estim.base)}) : à confirmer avec le règlement` : ' · potentiel à confirmer (règles de zone manquantes)') : ''}${h.graph ? ' · plan graphique : ' + Object.values(h.graph.sources).map(esc).join(', ') : ''}</p>
      <div class="actions"><button type="button" data-fiche="${i}">Ouvrir la fiche</button><button type="button" class="ghost" data-carte="${i}">Voir sur la carte</button></div></td></tr>` : '';
    return `<tr data-i="${i}" class="${open ? 'open' : ''}">${cells}</tr>${detail}`;
  }

  function exportCsv(r) {
    const head = 'rang;categorie;reference;idu;adresse;facade_rue_m;commune;zone;logements_estimes_operations_voisines;surface_m2;nature;nb_parcelles;niveaux;emprise_batie_pct;logements_existants;annee_bati_recent;emprise_max_m2;sdp_m2;logements_theoriques;logements_realisables;note;note_partielle;oap;contraintes;detail_note';
    const rows = r.list.map((h, i) => [i + 1, h.cat === 'entrepot' ? (h.zoneAct ? "entrepot_zone_activites" : 'entrepot_zone_habitat') : 'logement', refOf(h.f.properties), h.f.properties.idu, `"${String(h.f.properties.adresse || h.adresse || '').replace(/"/g, "'")}"`, h.facade ?? '', r.com.nom, h.zone.properties.libelle, h.estim ? h.estim.lg : '', Math.round(h.occ.S), h.occ.label, h.groupe ? h.membres.length : 1, h.pot ? h.pot.niv : '', Math.round(h.occ.ces * 100), h.occ.stats.logements, h.occ.stats.anneeMax || '', h.pot ? Math.round(h.pot.E) : '', h.pot ? Math.round(h.pot.sdp) : '', h.pot ? h.pot.lg : '', h.pot ? h.pot.real : '', h.s.tot, h.s.partiel ? 'oui' : 'non', h.oap ? 'oui' : 'non', `"${h.contraintes.map((c) => c.t).join(', ')}"`, `"${h.s.parts.map((p) => `${p.label} ${p.v ?? '-'}/${p.max}`).join(' | ')}"`].join(';'));
    ctx.download(`prospection-${r.com.code}.csv`, '﻿' + [head, ...rows].join('\n'), 'text/csv;charset=utf-8');
  }

  /** Recalcule potentiel et notes après saisie des règles d'une zone (sans relancer le balayage). */
  function rerank() {
    const r = st.results; if (!r || !r.classer) return;
    const tous = [...r.list, ...r.attente];
    r.list.length = 0; r.attente.length = 0;
    // compteurs remis à zéro pour les terrains réévalués
    Object.assign(r.compte, { regles: 0, sansRegles: 0, score: 0 });
    for (const h of tous) { if (h.zoneAct) r.list.push(h); else r.classer(h); }
    appliquerEstimations(r);
    // un même îlot ne doit pas revenir en 20 variantes : 2 regroupements au plus par parcelle
    const seules = r.list.filter((h) => !h.groupe), grp = sansDoublons(r.list.filter((h) => h.groupe).sort((a, b) => b.s.tot - a.s.tot), 2);
    r.list.length = 0; r.list.push(...seules, ...grp);
    r.list.sort((a, b) => b.s.tot - a.s.tot);
    st.zonesMissing = [];
    const m = new Map();
    for (const h of r.attente) { const x = m.get(h.key) || { key: h.key, zone: h.zone, n: 0 }; x.n++; m.set(h.key, x); }
    for (const h of r.list) if (h.aConfirmer) { const x = m.get(h.key) || { key: h.key, zone: h.zone, n: 0 }; x.n++; m.set(h.key, x); }
    st.zonesMissing = [...m.values()].sort((a, b) => b.n - a.n);
    setStatus(resume(r));
    const cat = st.cat || 'logement';
    ctx.setHits(cat === 'tout' ? r.list : cat === 'entrepot' ? r.list.filter((h) => h.cat === 'entrepot') : r.list.filter((h) => h.cat !== 'entrepot'));
    renderResults();
  }

  return {
    render,
    setCommune(c) { st.crit.commune = c; },
    get results() { return st.results; },
  };
}
