-- TerraFoncier — base PostGIS pour la version à grande échelle (étape 2).
-- La PWA fonctionne sans cette base ; elle sert quand le balayage en direct des API devient trop lent.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector, pour la recherche dans les règlements

CREATE SCHEMA IF NOT EXISTS ref;    -- copies des sources publiques
CREATE SCHEMA IF NOT EXISTS regle;  -- ce que l'IA extrait des règlements
CREATE SCHEMA IF NOT EXISTS calc;   -- ce que la plateforme calcule
CREATE SCHEMA IF NOT EXISTS crm;    -- ce que les utilisateurs produisent

-- ---------- Traçabilité ----------
CREATE TABLE ref.import_log (
  id bigserial PRIMARY KEY, source text NOT NULL, perimetre text NOT NULL,
  millesime text, nb_objets integer, importe_le timestamptz DEFAULT now()
);

-- ---------- Sources publiques ----------
CREATE TABLE ref.commune (
  insee char(5) PRIMARY KEY, nom text NOT NULL, dep text NOT NULL, epci_siren char(9),
  partition text, confiance char(1) CHECK (confiance IN ('A','B','C','D')),
  geom geometry(MultiPolygon, 2154)
);
CREATE TABLE ref.parcelle (
  idu char(14) NOT NULL, dep text NOT NULL, insee char(5) NOT NULL, section text, numero text,
  contenance integer, millesime text, geom geometry(MultiPolygon, 2154) NOT NULL,
  PRIMARY KEY (dep, idu)
) PARTITION BY LIST (dep);
-- une partition par département, ex. : CREATE TABLE ref.parcelle_45 PARTITION OF ref.parcelle FOR VALUES IN ('45');

CREATE TABLE ref.batiment (
  id text PRIMARY KEY, dep text, hauteur real, nb_etages smallint, usage1 text,
  geom geometry(MultiPolygon, 2154) NOT NULL
);
CREATE TABLE ref.document_urba (
  partition text PRIMARY KEY, type_doc text, nom text, date_appro date, statut text,
  url_reglement text, maj_gpu timestamptz
);
CREATE TABLE ref.zone_urba (
  id bigserial PRIMARY KEY, partition text NOT NULL REFERENCES ref.document_urba ON DELETE CASCADE,
  libelle text NOT NULL, libelong text, typezone text, destdomi text, urlfic text,
  geom geometry(MultiPolygon, 2154) NOT NULL
);
CREATE TABLE ref.prescription (
  id bigserial PRIMARY KEY, partition text NOT NULL, typepsc text, libelle text, geom geometry(Geometry, 2154)
);
CREATE TABLE ref.sup (
  id bigserial PRIMARY KEY, categorie text, libelle text, geom geometry(Geometry, 2154)
);
CREATE TABLE ref.mutation (  -- DVF
  id bigserial PRIMARY KEY, date_mut date, valeur numeric, nature text, type_local text,
  surface_bati integer, surface_terrain integer, idu char(14)
);
CREATE TABLE ref.proprietaire_pm (  -- fichier DGFiP des personnes morales (open data)
  idu char(14), siren char(9), denomination text, forme text, code_droit text, millesime text
);

-- ---------- Règlements et règles ----------
CREATE TABLE regle.piece (
  id bigserial PRIMARY KEY, partition text NOT NULL, type_piece text, url text,
  sha256 char(64) UNIQUE NOT NULL, nb_pages integer, telecharge_le timestamptz DEFAULT now()
);
CREATE TABLE regle.passage (
  id bigserial PRIMARY KEY, piece_id bigint REFERENCES regle.piece ON DELETE CASCADE,
  page integer NOT NULL, article text, texte text NOT NULL, embedding vector(1024)
);
CREATE TABLE regle.regle (
  id bigserial PRIMARY KEY, partition text NOT NULL, zone text NOT NULL,
  theme text NOT NULL CHECK (theme IN ('ces','h','recul','ret','pt','stat','destinations','aspect','autre')),
  valeur numeric, unite text, condition text,
  passage_id bigint REFERENCES regle.passage,           -- pas de valeur sans passage source
  citation text, page integer, article text,
  statut text NOT NULL CHECK (statut IN ('extrait','a_verifier','verifie','corrige','non_trouve')),
  modele text, verifie_par text, maj timestamptz DEFAULT now(),
  CONSTRAINT valeur_citee CHECK (valeur IS NULL OR (citation IS NOT NULL AND passage_id IS NOT NULL)),
  UNIQUE (partition, zone, theme)
);

-- ---------- Calculs ----------
CREATE TABLE calc.unite_fonciere (
  id bigserial PRIMARY KEY, idus char(14)[] NOT NULL, motif text, geom geometry(MultiPolygon, 2154)
);
CREATE TABLE calc.potentiel (
  objet text NOT NULL,          -- IDU ou 'UF:<id>'
  version_regles timestamptz NOT NULL,
  emprise numeric, sdp numeric, logements_theo integer, logements_real integer,
  plafond_limitant text, scenarios jsonb, score smallint, score_detail jsonb,
  calcule_le timestamptz DEFAULT now(), PRIMARY KEY (objet, version_regles)
);

-- ---------- CRM ----------
CREATE TABLE crm.organisation (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text NOT NULL);
CREATE TABLE crm.opportunite (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES crm.organisation,
  objet text NOT NULL, statut text NOT NULL DEFAULT 'detecte', prospecteur text,
  note text, prochaine_relance date, cree_le timestamptz DEFAULT now()
);
CREATE TABLE crm.contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES crm.organisation,
  opportunite_id uuid REFERENCES crm.opportunite ON DELETE CASCADE,
  nom text, adresse text, source_donnee text NOT NULL, date_source date NOT NULL,
  opposition boolean DEFAULT false, purge_le date   -- RGPD : durée de conservation
);
CREATE TABLE crm.action (
  id bigserial PRIMARY KEY, opportunite_id uuid REFERENCES crm.opportunite ON DELETE CASCADE,
  type text CHECK (type IN ('courrier','appel','email','visite','note')), contenu text,
  valide_par text NOT NULL, fait_le timestamptz DEFAULT now()
);
ALTER TABLE crm.opportunite ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.contact ENABLE ROW LEVEL SECURITY;

-- ---------- Index ----------
CREATE INDEX ON ref.parcelle USING gist (geom);
CREATE INDEX ON ref.parcelle (insee, contenance);
CREATE INDEX ON ref.batiment USING gist (geom);
CREATE INDEX ON ref.zone_urba USING gist (geom);
CREATE INDEX ON ref.zone_urba (partition, libelle);
CREATE INDEX ON ref.prescription USING gist (geom);
CREATE INDEX ON ref.sup USING gist (geom);
CREATE INDEX ON ref.mutation (idu);
CREATE INDEX ON ref.proprietaire_pm (idu);
CREATE INDEX ON regle.passage USING hnsw (embedding vector_cosine_ops);

-- ---------- Requête type : candidats d'une commune ----------
-- SELECT p.idu, p.contenance, z.libelle
-- FROM ref.parcelle p JOIN ref.zone_urba z ON ST_Intersects(z.geom, ST_PointOnSurface(p.geom))
-- WHERE p.insee = '45302' AND p.contenance >= 1500 AND z.typezone IN ('U','AUc');
