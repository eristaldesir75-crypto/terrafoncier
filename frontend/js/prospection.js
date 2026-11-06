// Moteur de prospection : balaye toutes les parcelles d'une commune (ou de la zone affichée),
// applique les critères, qualifie le foncier, calcule le potentiel et note chaque terrain.
/* global turf */
import * as api from './api.js';
import * as store from './store.js';
import { computePotentiel, parseQuery } from './potentiel.js';
import { NATURES, grille, analyser } from './occupation.js';
import { noter, contraintesDe, compacite } from './score.js';
import { reglesGraphiquesParcelle, fusionRegles } from './regles.js';

const NATURES_DEFAUT = Object.keys(NATURES).filter((k) => NATURES[k].opp);
const TUILE = 0.01; // degrés (≈ 1,1 km × 0,75 km)

export const CRIT_DEFAUT = {
  commune: null, scope: 'commune', smin: 1500, smax: '', lmin: 30, lmax: 50, sdpMin: '', hMin: '',
  zonesU: true, zonesAU: true, zonesFiltre: '', exclActivite: true, natures: NATURES_DEFAUT,
  exclRecent: true, oapSeul: false, exclContraintes: false, scoreMin: 0,
};

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
        <fieldset><legend>Programme</legend>
          <div class="field-row">
            <label for="proLmin">Logements min<input type="number" id="proLmin" min="0" value="${esc(c.lmin)}"></label>
            <label for="proLmax">Logements max<input type="number" id="proLmax" min="0" value="${esc(c.lmax)}"></label>
          </div>
          <div class="field-row">
            <label for="proSdp">Surface de plancher min (m²)<input type="number" id="proSdp" min="0" step="100" value="${esc(c.sdpMin)}" placeholder="aucune"></label>
            <label for="proHmin">Hauteur autorisée min (m)<input type="number" id="proHmin" min="0" step="1" value="${esc(c.hMin)}" placeholder="aucune"></label>
          </div>
          <p class="note">Ces critères s'appliquent quand les règles de la zone sont renseignées ; sinon le terrain est gardé avec la mention « à confirmer ».</p>
        </fieldset>
        <fieldset><legend>Zonage PLU</legend>
          <div class="chk-row">${box('proZU', 'Zones U', c.zonesU)}${box('proZAU', 'Zones AU', c.zonesAU)}${box('proExclAct', "Exclure zones d'activités et d'équipements", c.exclActivite)}</div>
          <label for="proZF">Limiter aux zones commençant par<input type="text" id="proZF" placeholder="Ex. : UR, UC, 1AU" value="${esc(c.zonesFiltre)}"></label>
        </fieldset>
        <fieldset><legend>Type de foncier</legend>
          <div class="chk-row">${Object.entries(NATURES).map(([k, n]) => box(`proN-${k}`, n.label, c.natures.includes(k))).join('')}</div>
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
    $('#proForm', v).onsubmit = async (e) => {
      e.preventDefault();
      lireFormulaire(v);
      await resolveCommune($('#proCommune', v).value);
      if (st.crit.commune) run();
    };
    const stop = $('#proStop', v); if (stop) stop.onclick = () => st.ctrl && st.ctrl.abort();
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
    if (t.startsWith('U') && !c.zonesU) return false;
    if (t.startsWith('AU') && !c.zonesAU) return false;
    if (c.exclActivite && ctx.zoneHorsLogement(z)) return false;
    if (c.zonesFiltre) {
      const pref = c.zonesFiltre.split(/[,;\s]+/).filter(Boolean).map((x) => x.toUpperCase());
      if (!pref.some((p) => lib.toUpperCase().startsWith(p))) return false;
    }
    return true;
  }

  async function run() {
    const c = st.crit, com = c.commune, hyp = store.settings();
    const bounds = c.scope === 'ecran' ? ctx.map.getBounds() : null;
    st.running = true; st.results = null; st.filtreNature = null; st.ouvert = null; st.ctrl = new AbortController();
    const signal = st.ctrl.signal;
    render();
    const t0 = performance.now();
    try {
      if (!bounds) ctx.map.flyTo({ center: com.centre.coordinates, zoom: 13 });
      setStatus(`Document d'urbanisme de ${esc(com.nom)}…`, 3);
      // Le PLU est identifié par la zone trouvée en un point de la commune. Le centre officiel peut tomber
      // dans un fleuve ou un espace non zoné (Tours, Chinon) : plusieurs points autour sont essayés.
      let partition = null;
      const [cx, cy] = com.centre.coordinates;
      const points = [[0, 0], [0.006, 0], [-0.006, 0], [0, 0.004], [0, -0.004], [0.012, 0.008], [-0.012, -0.008], [0.012, -0.008], [-0.012, 0.008]];
      for (let i = 0; i < points.length && !partition; i += 3) {
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

      setStatus(`Zonage ${esc(partition)}…`, 6);
      const zones = (await api.gpuByPartition('zone-urba', partition, { signal })).filter((z) => z.geometry);
      zones.forEach((z) => (z.bbox = turf.bbox(z)));

      const parcels = await api.parcellesCommune(com.code, { signal, onProgress: (n, tot) => setStatus(`Parcelles cadastrales : ${f0(n)}${tot ? ' / ' + f0(tot) : ''}`, 8 + (tot ? (27 * n) / tot : 10)) });

      // 1. Filtres géographiques et de surface (rapides)
      const cand = [];
      const compte = { total: parcels.length, surface: 0, perimetre: 0, zone: 0, nature: 0, regles: 0, contraintes: 0, score: 0 };
      for (const f of parcels) {
        if (!f.geometry) continue;
        const S = +f.properties.contenance || 0;
        if (S < (c.smin || 0) || (c.smax && S > c.smax)) { compte.surface++; continue; }
        const pt = turf.pointOnFeature(f), [x, y] = pt.geometry.coordinates;
        if (bounds && !bounds.contains([x, y])) { compte.perimetre++; continue; }
        const z = zones.find((zz) => x >= zz.bbox[0] && x <= zz.bbox[2] && y >= zz.bbox[1] && y <= zz.bbox[3] && turf.booleanPointInPolygon(pt, zz));
        if (!z || !zoneOk(z)) { compte.zone++; continue; }
        cand.push({ f, zone: z, pt: [x, y] });
      }
      if (!cand.length) {
        st.results = { com, partition, list: [], compte, secs: Math.round((performance.now() - t0) / 1000), avertissements: [] };
        setStatus(resume(st.results));
        return;
      }

      // 2. Occupation réelle : bâtiments, parkings, équipements (seulement autour des candidats)
      const cells = new Map();
      for (const k of cand) {
        const b = turf.bbox(k.f);
        for (let x = Math.floor(b[0] / TUILE); x <= Math.floor(b[2] / TUILE); x++) {
          for (let y = Math.floor(b[1] / TUILE); y <= Math.floor(b[3] / TUILE); y++) cells.set(`${x}:${y}`, [x * TUILE, y * TUILE, (x + 1) * TUILE, (y + 1) * TUILE]);
        }
      }
      const tiles = [...cells.values()];
      const avertissements = [];
      const prescP = api.gpuByPartition('prescription-surf', partition, { signal }).catch(() => { avertissements.push("Prescriptions du PLU indisponibles : contraintes (EBC, emplacements réservés, OAP) non vérifiées"); return null; });
      const frichesP = api.friches(com.code);
      const occ = await api.occupationTiles(tiles, { signal, onProgress: (d, n) => setStatus(`Bâtiments, parkings et équipements : secteur ${d} / ${n} (${f0(cand.length)} terrains candidats)`, 35 + (45 * d) / n) });
      setStatus('Prescriptions du PLU et friches…', 82);
      const [presc, fr] = await Promise.all([prescP, frichesP]);
      if (fr === null) avertissements.push('Cartofriches indisponible : les friches ne sont pas repérées');

      const idx = { bat: grille(occ.batiments), park: grille(occ.parkings), eq: grille(occ.equipements) };
      const comBbox = turf.bbox(turf.featureCollection(cand.map((k) => k.f)));
      const idxPresc = presc ? grille(presc.filter((p) => p.geometry && (() => { const b = turf.bbox(p); return b[0] <= comBbox[2] && b[2] >= comBbox[0] && b[1] <= comBbox[3] && b[3] >= comBbox[1]; })())) : null;
      const frichesParIdu = new Map();
      (fr || []).forEach((x) => x.idus.forEach((i) => frichesParIdu.set(i, x)));

      // 3. Analyse, potentiel, note
      setStatus(`Analyse de ${f0(cand.length)} terrains…`, 90);
      const out = [], missing = new Map(), critN = critPourNote();
      for (const k of cand) {
        const o = analyser(k.f, idx, frichesParIdu);
        if (!c.natures.includes(o.cle)) { compte.nature++; continue; }
        if (c.exclRecent && o.flags.some((x) => x.k === 'recent') && !['terrain_nu', 'parking', 'friche'].includes(o.cle)) { compte.nature++; continue; }
        const contraintes = contraintesDe(k.f, idxPresc, o.S);
        const oap = contraintes.some((x) => x.k === 'oap');
        if (c.oapSeul && !oap) { compte.contraintes++; continue; }
        if (c.exclContraintes && contraintes.some((x) => x.k === 'ebc' || x.k === 'er')) { compte.contraintes++; continue; }
        const key = store.ruleKey(partition, k.zone.properties.libelle);
        // Règles de la zone (saisies ou extraites), complétées par le plan graphique du PLU à la parcelle
        const graph = reglesGraphiquesParcelle(k.f, idxPresc);
        const fu = fusionRegles(store.getRules(key), graph);
        const rules = fu.utile ? fu.regles : null;
        let pot = null, aConfirmer = !rules;
        if (rules) {
          pot = computePotentiel(k.f, rules, hyp, { contenance: o.S, batiSdp: o.stats.sdp });
          if (pot.ok) {
            if (c.lmin && pot.real < Math.ceil(c.lmin * 0.5)) { compte.regles++; continue; }
            if (c.sdpMin && pot.sdp < c.sdpMin) { compte.regles++; continue; }
          } else aConfirmer = true;
          if (c.hMin && rules.h !== null && rules.h !== undefined && rules.h < c.hMin) { compte.regles++; continue; }
        } else {
          const m = missing.get(key) || { key, zone: k.zone, n: 0 }; m.n++; missing.set(key, m);
        }
        const s = noter({ S: o.S, crit: critN, occ: o, pot: pot && pot.ok ? pot : null, contraintes, compacite: compacite(k.f) });
        if (s.tot < (c.scoreMin || 0)) { compte.score++; continue; }
        out.push({ f: k.f, zone: k.zone, key, occ: o, pot: pot && pot.ok ? pot : null, contraintes, oap, s, aConfirmer, graph: graph && graph.n ? graph : null });
      }
      out.sort((a, b) => b.s.tot - a.s.tot);
      st.results = { com, partition, list: out, compte, cand: cand.length, secs: Math.round((performance.now() - t0) / 1000), avertissements, date: new Date().toISOString() };
      st.zonesMissing = [...missing.values()].sort((a, b) => b.n - a.n);
      store.addHistorique({ date: st.results.date, commune: com.nom, code: com.code, total: parcels.length, retenus: out.length, top: out.slice(0, 5).map((h) => ({ ref: refOf(h.f.properties), score: h.s.tot, nature: h.occ.label })) });
      setStatus(resume(st.results));
      ctx.setHits(out);
      ctx.onResults && ctx.onResults(true);
    } catch (e) {
      setStatus(`<p class="err">${esc(e.name === 'AbortError' || signal.aborted ? 'Prospection arrêtée' : e.message)}</p>`);
    } finally {
      st.running = false; st.ctrl = null;
      const btn = $('#proForm button[type=submit]'); if (btn) btn.disabled = false; $('#proStop')?.remove();
      if (st.results) renderResults();
    }
  }

  function resume(r) {
    const c = r.compte;
    return `<b>${f0(r.list.length)} terrain(s) retenu(s)</b> sur ${f0(c.total)} parcelles en ${r.secs} s
      <span class="note">· écartées : ${f0(c.surface)} surface, ${c.perimetre ? f0(c.perimetre) + ' hors zone affichée, ' : ''}${f0(c.zone)} zonage, ${f0(c.nature)} nature du foncier, ${f0(c.contraintes)} contraintes, ${f0(c.regles)} règles du PLU${c.score ? ', ' + f0(c.score) + ' note trop basse' : ''}</span>`;
  }

  // ---------- Résultats ----------
  const COLS = [
    { k: 'rang', t: '#', v: (h, i) => i + 1, n: true },
    { k: 'ref', t: 'Parcelle', v: (h) => refOf(h.f.properties) },
    { k: 'zone', t: 'Zone', v: (h) => h.zone.properties.libelle },
    { k: 'surface', t: 'Surface', v: (h) => h.occ.S, fmt: (x) => m2(x), n: true },
    { k: 'nature', t: 'Nature', v: (h) => h.occ.label },
    { k: 'ces', t: 'Bâti', v: (h) => h.occ.ces, fmt: (x) => `${Math.round(x * 100)} %`, n: true },
    { k: 'lgt', t: 'Logts', v: (h) => (h.pot ? h.pot.real : -1), fmt: (x) => (x < 0 ? '?' : x), n: true },
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
    // Comptes par nature, cliquables pour filtrer
    const parNature = {};
    r.list.forEach((h) => (parNature[h.occ.cle] = (parNature[h.occ.cle] || 0) + 1));
    let liste = st.filtreNature ? r.list.filter((h) => h.occ.cle === st.filtreNature) : r.list.slice();
    const col = COLS.find((x) => x.k === st.tri.k) || COLS[COLS.length - 1];
    if (col.k !== 'rang') liste.sort((a, b) => { const va = col.v(a), vb = col.v(b); return (va > vb ? 1 : va < vb ? -1 : 0) * st.tri.dir; });
    res.innerHTML = `
      ${r.avertissements.length ? `<div class="warn">${r.avertissements.map(esc).join('<br>')}</div>` : ''}
      <div class="res-head">
        <div class="chips">${Object.entries(parNature).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<button type="button" class="chip-btn ${st.filtreNature === k ? 'on' : ''}" data-nat="${k}">${esc(NATURES[k].label)} · ${n}</button>`).join('')}${st.filtreNature ? '<button type="button" class="chip-btn" data-nat="">Tout afficher</button>' : ''}</div>
        ${r.list.length ? '<button type="button" class="ghost" id="proCsv">Exporter en CSV</button>' : ''}
      </div>
      ${r.list.length ? `<div class="tw"><table class="res-table">
        <thead><tr>${COLS.map((x) => `<th class="${x.n ? 'n' : ''}"><button type="button" class="sort" data-sort="${x.k}">${x.t}${st.tri.k === x.k ? (st.tri.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead>
        <tbody>${liste.slice(0, 300).map((h, i) => ligne(h, i)).join('')}</tbody></table></div>
        ${liste.length > 300 ? `<p class="note">300 premiers terrains affichés sur ${liste.length} ; l'export CSV les contient tous.</p>` : ''}` : '<p class="empty">Aucun terrain ne correspond. Élargissez la surface, les zones ou les types de foncier.</p>'}
      <p class="note">Note sur 100 : taille 15, nature du foncier 25, sous-exploitation 15, potentiel PLU 25, contraintes et forme 20. Quand les règles de la zone manquent, la note est calculée sur les autres critères (mention « partielle »).</p>`;
    res.querySelectorAll('[data-nat]').forEach((b) => (b.onclick = () => { st.filtreNature = b.dataset.nat || null; renderResults(); ctx.setHits(st.filtreNature ? r.list.filter((h) => h.occ.cle === st.filtreNature) : r.list); }));
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
    const csv = $('#proCsv'); if (csv) csv.onclick = () => exportCsv(r);
  }

  function ligne(h, i) {
    const open = st.ouvert === h;
    const cells = COLS.map((x) => { const v = x.v(h, i); return `<td class="${x.n ? 'n' : ''}">${x.k === 'score' ? `<span class="score s${Math.floor(v / 20)}">${v}</span>${h.s.partiel ? '<small class="part">partielle</small>' : ''}` : esc(x.fmt ? x.fmt(v) : v)}</td>`; }).join('');
    const detail = open ? `<tr class="detail"><td colspan="${COLS.length}">
      <div class="why">${h.s.parts.map((p) => `<div class="why-row"><span>${esc(p.label)}</span><span class="bar"><i style="width:${p.v === null ? 0 : Math.round((100 * p.v) / p.max)}%"></i></span><b>${p.v === null ? '—' : p.v}/${p.max}</b><small>${esc(p.why)}</small></div>`).join('')}</div>
      <p class="note">${esc(h.occ.raisons.join(' ; '))}${h.occ.flags.length ? ' · ' + h.occ.flags.map((x) => esc(x.t)).join(' · ') : ''}${h.oap ? ' · en secteur d\'OAP' : ''}${h.aConfirmer ? ' · potentiel à confirmer (règles de zone manquantes)' : ''}${h.graph ? ' · plan graphique : ' + Object.values(h.graph.sources).map(esc).join(', ') : ''}</p>
      <div class="actions"><button type="button" data-fiche="${i}">Ouvrir la fiche</button></div></td></tr>` : '';
    return `<tr data-i="${i}" class="${open ? 'open' : ''}">${cells}</tr>${detail}`;
  }

  function exportCsv(r) {
    const head = 'rang;reference;idu;commune;zone;surface_m2;nature;emprise_batie_pct;logements_existants;annee_bati_recent;emprise_max_m2;sdp_m2;logements_theoriques;logements_realisables;note;note_partielle;oap;contraintes;detail_note';
    const rows = r.list.map((h, i) => [i + 1, refOf(h.f.properties), h.f.properties.idu, r.com.nom, h.zone.properties.libelle, Math.round(h.occ.S), h.occ.label, Math.round(h.occ.ces * 100), h.occ.stats.logements, h.occ.stats.anneeMax || '', h.pot ? Math.round(h.pot.E) : '', h.pot ? Math.round(h.pot.sdp) : '', h.pot ? h.pot.lg : '', h.pot ? h.pot.real : '', h.s.tot, h.s.partiel ? 'oui' : 'non', h.oap ? 'oui' : 'non', `"${h.contraintes.map((c) => c.t).join(', ')}"`, `"${h.s.parts.map((p) => `${p.label} ${p.v ?? '-'}/${p.max}`).join(' | ')}"`].join(';'));
    ctx.download(`prospection-${r.com.code}.csv`, '﻿' + [head, ...rows].join('\n'), 'text/csv;charset=utf-8');
  }

  /** Recalcule potentiel et notes après saisie des règles d'une zone (sans relancer le balayage). */
  function rerank() {
    const r = st.results; if (!r) return;
    const hyp = store.settings(), critN = critPourNote(), missing = new Map();
    r.list.forEach((h) => {
      const fu = fusionRegles(store.getRules(h.key), h.graph);
      const rules = fu.utile ? fu.regles : null;
      if (rules) {
        const pot = computePotentiel(h.f, rules, hyp, { contenance: h.occ.S, batiSdp: h.occ.stats.sdp });
        h.pot = pot.ok ? pot : null; h.aConfirmer = !pot.ok;
      } else { const m = missing.get(h.key) || { key: h.key, zone: h.zone, n: 0 }; m.n++; missing.set(h.key, m); }
      h.s = noter({ S: h.occ.S, crit: critN, occ: h.occ, pot: h.pot, contraintes: h.contraintes, compacite: compacite(h.f) });
    });
    r.list.sort((a, b) => b.s.tot - a.s.tot);
    st.zonesMissing = [...missing.values()].sort((a, b) => b.n - a.n);
    ctx.setHits(r.list); renderResults();
  }

  return {
    render,
    setCommune(c) { st.crit.commune = c; },
    get results() { return st.results; },
  };
}
