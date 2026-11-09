# Fonciscope

Application gratuite de prospection foncière : cadastre et PLU de toute la France en direct, règles par zone, potentiel constructible, prospection automatique d'une commune et suivi des opportunités. Elle s'utilise dans un navigateur et s'installe sur téléphone comme une application (PWA).

## Ce que fait la version actuelle

| Fonction | Source | Statut |
| --- | --- | --- |
| Carte Plan IGN / photo aérienne, cadastre, zonage PLU, prescriptions | Géoplateforme IGN, Géoportail de l'Urbanisme | En direct, France entière |
| Recherche adresse, commune, référence cadastrale (`45302 AB 123`) | Géocodage IGN, geo.api.gouv.fr, API Carto | En direct |
| Fiche parcelle : contenance, document, zone, OAP, prescriptions, servitudes, bâti, risques, liens règlement et DVF | API Carto (cadastre, GPU, BD TOPO), Géorisques | En direct |
| Règles de zone | Saisie manuelle (une fois par zone, réutilisée partout) ou serveur IA | Opérationnel |
| Potentiel : enveloppe géométrique, plafond limitant, SDP, logements, 3 scénarios, contraintes | Calcul local | Opérationnel |
| Prospection : « 30 à 50 logements, plus de 1 500 m² » sur une commune, classement sur 100, export CSV | Balayage en direct de la commune | Opérationnel |
| Suivi : statuts, relances, notes, courrier de prospection à relire, export CSV / GeoJSON | Stockage sur l'appareil | Opérationnel |
| Extraction IA des règlements avec citation contrôlée | `backend/` + clé gratuite Gemini ou Mistral | Prêt à déployer |
| Propriétaires | Liens vers le fichier DGFiP des personnes morales ; particuliers non accessibles en open data | Volontairement limité (RGPD) |

## Mettre le site en ligne gratuitement (10 minutes)

1. Créez un compte sur [github.com](https://github.com), puis un dépôt public nommé `terrafoncier`.
2. Envoyez le contenu de ce dossier dans le dépôt (bouton « Add file » > « Upload files », ou `git push`).
3. Dans le dépôt : **Settings > Pages > Source : GitHub Actions**. Le fichier `.github/workflows/pages.yml` publie le dossier `frontend/` à chaque envoi.
4. Le site est en ligne à `https://<votre-compte>.github.io/terrafoncier/`. Sur téléphone, ouvrez cette adresse puis « Ajouter à l'écran d'accueil » : c'est l'application.

Coût : 0 €. Les API utilisées sont publiques et gratuites, sans clé.

Pour tester sur votre ordinateur sans rien publier : dans le dossier `frontend/`, lancez `python3 -m http.server 8080`, puis ouvrez `http://localhost:8080`.

## Activer l'extraction IA des règlements (gratuit)

L'extraction lit le PDF du règlement, demande au modèle les règles de la zone avec la phrase exacte, puis vérifie que chaque phrase existe bien dans le PDF. Une valeur non retrouvée est marquée « à vérifier » et n'entre pas dans les calculs.

Trois fournisseurs au choix (variable `LLM_PROVIDER`) :

| Fournisseur | Coût | Clé | Remarque |
| --- | --- | --- | --- |
| `gemini` (par défaut) | Gratuit dans la limite des quotas Google | [aistudio.google.com/apikey](https://aistudio.google.com/apikey), compte Google, sans carte | Longs documents acceptés ; quotas visibles dans AI Studio |
| `mistral` | Gratuit (offre Experiment) | [console.mistral.ai](https://console.mistral.ai), numéro de téléphone vérifié, sans carte | Les requêtes peuvent servir à entraîner les modèles Mistral |
| `anthropic` | Payant à l'usage | [console.anthropic.com](https://console.anthropic.com) | Le plus fiable sur les extractions longues |

Les règlements de PLU sont des documents publics : leur envoi à un fournisseur gratuit ne pose pas de problème de confidentialité. N'envoyez pas de données personnelles de propriétaires à ces services.

1. Créez votre clé gratuite (Gemini conseillé).
2. Sur [render.com](https://render.com) (offre gratuite) : **New > Blueprint**, choisissez votre dépôt ; `render.yaml` (à la racine) crée le service. Renseignez `GEMINI_API_KEY`.
3. Dans l'application : **Réglages > Adresse du serveur IA**, collez l'adresse du service (ex. `https://terrafoncier-ia.onrender.com`).

Le nom du modèle se change avec `LLM_MODEL` (par défaut `gemini-2.5-flash`, `mistral-small-latest` ou `claude-sonnet-5-5`). Si Google retire un modèle de l'offre gratuite, choisissez-en un autre listé dans AI Studio.

Sur l'offre gratuite de Render, le service s'endort après inactivité (première requête lente) et le cache est effacé à chaque redémarrage.

Lancer le serveur en local : `cd backend && pip install -r requirements.txt && LLM_PROVIDER=gemini GEMINI_API_KEY=… uvicorn app.main:app --reload`. Tests : `python3 tests/test_logic.py`.

## Passer à l'échelle (étape suivante)

La prospection en direct convient à une commune à la fois. Pour balayer un département en quelques secondes, chargez les données dans PostGIS :

```bash
psql "$PG" -f db/schema.sql
PG="postgresql://…" ./db/import_departement.sh 45
```

La base, le modèle de données et la feuille de route sont décrits dans les documents « Cahier des charges » et « Architecture technique ».

## Limites connues

- Toutes les communes ne sont pas au Géoportail de l'Urbanisme ; la fiche l'indique (« Aucun document au GPU »).
- L'enveloppe applique le retrait des limites séparatives à tout le pourtour et estime le recul sur voie : c'est une approximation, pas un plan masse.
- Les règlements scannés (sans texte) ne sont pas lus par le serveur IA.
- Le suivi est enregistré sur l'appareil : exportez-le pour le sauvegarder ou le partager.
- Les estimations ne remplacent ni un certificat d'urbanisme ni une étude de faisabilité.

## Sources et licences des données

Données IGN, DGFiP, DGALN (Géoportail de l'Urbanisme) et Géorisques sous Licence Ouverte Etalab 2.0 ; la mention des sources est affichée sur la carte.
