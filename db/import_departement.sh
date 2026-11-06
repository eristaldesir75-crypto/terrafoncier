#!/usr/bin/env bash
# Import d'un département dans PostGIS : cadastre Etalab + zonage du Géoportail de l'Urbanisme.
# Usage : PG="postgresql://user:pass@host/db" ./import_departement.sh 45
# Prérequis : curl, gzip, ogr2ogr (GDAL), psql.
set -euo pipefail
DEP="${1:?code département, ex. 45}"
PG="${PG:?variable PG (chaîne de connexion PostgreSQL)}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
log() { echo "[$(date +%H:%M:%S)] $*"; }

# 1. Parcelles (cadastre Etalab, dernier millésime)
URL="https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/departements/${DEP}/cadastre-${DEP}-parcelles.json.gz"
log "Téléchargement des parcelles : $URL"
curl -fsSL "$URL" -o "$WORK/parcelles.json.gz" && gunzip "$WORK/parcelles.json.gz"
psql "$PG" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS ref.parcelle_${DEP} PARTITION OF ref.parcelle FOR VALUES IN ('${DEP}');" \
                               -c "DROP TABLE IF EXISTS ref.parcelle_transit;"
ogr2ogr -f PostgreSQL "PG:$PG" "$WORK/parcelles.json" -nln ref.parcelle_transit -t_srs EPSG:2154 \
  -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom -makevalid -progress
psql "$PG" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DELETE FROM ref.parcelle WHERE dep = '${DEP}';
INSERT INTO ref.parcelle (idu, dep, insee, section, numero, contenance, millesime, geom)
  SELECT id, '${DEP}', commune, section, numero, contenance, 'latest', geom FROM ref.parcelle_transit;
INSERT INTO ref.import_log (source, perimetre, millesime, nb_objets)
  SELECT 'cadastre-etalab', '${DEP}', 'latest', count(*) FROM ref.parcelle_transit;
DROP TABLE ref.parcelle_transit;
COMMIT;
SQL

# 2. Zonage PLU du département (flux WFS de la Géoplateforme)
WFS="https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=wfs_du:zone_urba&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326"
FILTER="partition LIKE 'DU_${DEP}%'"
log "Téléchargement du zonage (partitions communales DU_${DEP}*). Les PLUi (partition par SIREN) sont à ajouter via ref.commune."
curl -fsSL -G "$WFS" --data-urlencode "CQL_FILTER=${FILTER}" -o "$WORK/zones.json"
psql "$PG" -c "DROP TABLE IF EXISTS ref.zone_transit;"
ogr2ogr -f PostgreSQL "PG:$PG" "$WORK/zones.json" -nln ref.zone_transit -t_srs EPSG:2154 -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom -makevalid
psql "$PG" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
INSERT INTO ref.document_urba (partition) SELECT DISTINCT partition FROM ref.zone_transit ON CONFLICT DO NOTHING;
DELETE FROM ref.zone_urba WHERE partition IN (SELECT DISTINCT partition FROM ref.zone_transit);
INSERT INTO ref.zone_urba (partition, libelle, libelong, typezone, destdomi, urlfic, geom)
  SELECT partition, libelle, libelong, typezone, destdomi, urlfic, geom FROM ref.zone_transit;
INSERT INTO ref.import_log (source, perimetre, nb_objets) SELECT 'gpu-zone_urba', '${DEP}', count(*) FROM ref.zone_transit;
DROP TABLE ref.zone_transit;
COMMIT;
SQL
log "Terminé : département ${DEP}."
