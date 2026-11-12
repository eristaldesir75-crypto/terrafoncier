/**
 * Relais Gemini de Fonciscope (Google Apps Script, sur le compte Google du propriétaire du site).
 * La clé Gemini est rangée dans les propriétés du script (Paramètres du projet > Propriétés du script,
 * nom GEMINI_API_KEY) : elle n'apparaît ni dans ce code ni sur le site. Le site envoie ses demandes ici,
 * le relais les transmet à Gemini avec la clé et renvoie la réponse.
 * Seules deux opérations sont permises : la liste des modèles et la génération de texte.
 */
const API = 'https://generativelanguage.googleapis.com/v1beta';

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return sortie(400, '{"error":{"message":"demande illisible"}}'); }
  const cle = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!cle) return sortie(500, '{"error":{"message":"clé GEMINI_API_KEY absente des propriétés du script"}}');
  const chemin = String(d.chemin || '');
  if (!/^\/models(\?pageSize=\d+|\/[\w.\-]+:generateContent)$/.test(chemin)) return sortie(400, '{"error":{"message":"opération refusée par le relais"}}');
  const options = { method: d.methode === 'POST' ? 'post' : 'get', headers: { 'x-goog-api-key': cle }, muteHttpExceptions: true };
  if (d.methode === 'POST') { options.contentType = 'application/json'; options.payload = String(d.corps || '{}'); }
  const r = UrlFetchApp.fetch(API + chemin, options);
  return sortie(r.getResponseCode(), r.getContentText());
}

function doGet() {
  return ContentService.createTextOutput('Relais Gemini de Fonciscope : en service.');
}

function sortie(status, texte) {
  return ContentService.createTextOutput(JSON.stringify({ status: status, texte: texte })).setMimeType(ContentService.MimeType.JSON);
}
