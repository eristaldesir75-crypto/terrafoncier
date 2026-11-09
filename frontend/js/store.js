// Stockage local (dans le navigateur de l'utilisateur) : règles saisies, suivi, réglages.
// Rien ne quitte l'appareil, sauf export volontaire.

const K = { rules: 'tf-rules', crm: 'tf-crm', settings: 'tf-settings', crit: 'tf-prospection-crit', hist: 'tf-historique' };

function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const DEFAULT_SETTINGS = { backend: '', hEt: 3, k: 0.8, sMoy: 60, sLot: 400 };
// Ratio logements : SDP / 60 (l'ancienne valeur par défaut, 65, est remplacée une fois)
export const settings = () => { const s = read(K.settings, {}); if (s.sMoy === 65 && !s.ratio60) { s.sMoy = 60; s.ratio60 = true; write(K.settings, s); } return { ...DEFAULT_SETTINGS, ...s }; };
export const saveSettings = (s) => write(K.settings, s);

// Règles par zone : clé = partition|libellé de zone
export const ruleKey = (partition, libelle) => `${partition || 'RNU'}|${libelle || '?'}`;
export const allRules = () => read(K.rules, {});
export const getRules = (key) => allRules()[key] || null;
export function saveRules(key, rules) { const a = allRules(); a[key] = { ...rules, savedAt: new Date().toISOString() }; write(K.rules, a); }

// Derniers critères de prospection (pour les retrouver à la prochaine visite)
export const prospectionCrit = () => read(K.crit, null);
export function saveProspectionCrit(c) {
  const com = c.commune ? { nom: c.commune.nom, code: c.commune.code, centre: c.commune.centre } : null;
  write(K.crit, { ...c, commune: com });
}

// Historique des prospections lancées (résumé, 30 dernières)
export const historique = () => read(K.hist, []);
export function addHistorique(h) { const l = historique(); l.unshift(h); write(K.hist, l.slice(0, 30)); }

// Suivi des opportunités
export const STATUTS = ['Détecté', 'À étudier', 'Contacté', 'Relance', 'En négociation', 'Sous promesse', 'Abandonné'];
export const crmList = () => read(K.crm, []);
export const saveCrm = (list) => write(K.crm, list);
export function addToCrm(item) {
  const list = crmList();
  if (list.some((x) => x.idu === item.idu)) return false;
  list.unshift({ statut: 0, note: '', relance: '', createdAt: new Date().toISOString(), ...item });
  saveCrm(list); return true;
}

// Sauvegarde complète (suivi, règles saisies, réglages, critères, historique) pour changer d'appareil ou d'adresse
export function sauvegarde() {
  const d = {};
  Object.values(K).forEach((k) => { d[k] = read(k, null); });
  return { app: 'TerraFoncier', version: 1, date: new Date().toISOString(), donnees: d };
}
/** Restaure une sauvegarde : le suivi et les règles sont fusionnés avec ceux déjà présents. */
export function restaurer(obj) {
  if (!obj || obj.app !== 'TerraFoncier' || !obj.donnees) throw new Error("Ce fichier n'est pas une sauvegarde TerraFoncier");
  const d = obj.donnees;
  const crm = crmList(), ids = new Set(crm.map((x) => x.idu));
  (d[K.crm] || []).forEach((x) => { if (!ids.has(x.idu)) crm.push(x); });
  write(K.crm, crm);
  write(K.rules, { ...(d[K.rules] || {}), ...allRules() });
  if (d[K.settings] && !read(K.settings, null)) write(K.settings, d[K.settings]);
  if (d[K.crit] && !read(K.crit, null)) write(K.crit, d[K.crit]);
  const h = historique(); write(K.hist, [...h, ...(d[K.hist] || [])].slice(0, 30));
  return { suivi: crm.length, regles: Object.keys(allRules()).length };
}
