"""
Copie hebdomadaire des PLU publiés au Géoportail de l'Urbanisme (GPU), pour les départements de data-config.json.

Pour chaque commune : document(s) d'urbanisme en vigueur (PLU, PLUi, carte communale, PSMV) ou RNU.
Pour chaque document : zonage (zone_urba ou secteur_cc) et prescriptions surfaciques, en GeoJSON WGS84.
Un document n'est retéléchargé que s'il a changé depuis la dernière copie (identifiant GPU différent).

Sources, dans l'ordre :
  1. archive officielle du document sur le GPU (seules les couches utiles sont lues dans le zip, à distance) ;
  2. API Carto de l'IGN, par partition (secours).

Sortie (dossier --out) :
  index.json                      documents copiés, date, nombre d'objets, source
  communes/<dep>.json             commune -> partitions, ou RNU
  p/<partition>/zones.json        zonage
  p/<partition>/presc.json        prescriptions surfaciques
"""
import argparse, json, os, re, shutil, sys, tempfile, time, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

GPU = "https://www.geoportail-urbanisme.gouv.fr/api"
GEOAPI = "https://geo.api.gouv.fr"
APICARTO = "https://apicarto.ign.fr/api/gpu"
UA = {"User-Agent": "TerraFoncier-copie-PLU (github.com/eristaldesir75-crypto/terrafoncier)"}
S = requests.Session()
S.headers.update(UA)

ZONE_PROPS = ["libelle", "libelong", "typezone", "destdomi", "nomfic", "urlfic", "idurba", "datappro", "datvalid", "formdomi", "destoui", "destcdt", "destnon"]
PRESC_PROPS = ["libelle", "txt", "typepsc", "stypepsc", "nomfic", "urlfic", "idurba"]


def log(*a):
    print(*a, flush=True)


def get(url, *, params=None, tries=3, timeout=40, stream=False):
    last = None
    for i in range(tries):
        try:
            r = S.get(url, params=params, timeout=timeout, stream=stream)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code}")
            return r
        except Exception as e:  # réseau ou serveur surchargé : on réessaie en espaçant
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url} : {last}")


def gpu_json(path, params=None):
    r = get(f"{GPU}{path}", params=params)
    if r.status_code in (400, 404):  # grille inconnue du GPU (EPCI récent, etc.)
        return None
    r.raise_for_status()
    return r.json()


# ---------- Communes -> documents ----------
def docs_en_vigueur(grid):
    """Documents d'urbanisme (DU) en vigueur rattachés à une grille (commune ou EPCI)."""
    l = gpu_json("/document", {"grid": grid, "status": "document.production"}) or []
    return [d for d in l if str(d.get("name", "")).startswith("DU_")]


def communes_du_departement(dep):
    r = get(f"{GEOAPI}/departements/{dep}/communes", params={"fields": "nom,code,codeEpci,centre"})
    r.raise_for_status()
    return r.json()


def partition_par_point(lng, lat):
    """Secours : zone trouvée au point sur le service cartographique du GPU (document d'un ancien EPCI, etc.)."""
    d = 0.0002
    url = "https://data.geopf.fr/wms-v/ows"
    p = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetFeatureInfo", "LAYERS": "du", "QUERY_LAYERS": "du", "STYLES": "",
         "CRS": "EPSG:4326", "BBOX": f"{lat-d},{lng-d},{lat+d},{lng+d}", "WIDTH": 101, "HEIGHT": 101, "I": 50, "J": 50,
         "INFO_FORMAT": "application/json", "FEATURE_COUNT": 50}
    try:
        fc = get(url, params=p, tries=2).json()
    except Exception:
        return None
    for f in fc.get("features", []):
        if re.match(r"^(zone_urba|secteur_cc)_", str(f.get("id", ""))):
            return f["properties"].get("partition")
    return None


def cartographie_communes(deps):
    """Retourne ({dep: {insee: entrée}}, {partition: doc})."""
    par_dep, docs, epci_cache = {}, {}, {}
    for dep in deps:
        coms = communes_du_departement(dep)
        log(f"Département {dep} : {len(coms)} communes")
        out = {}

        def une(c):
            insee = c["code"]
            ds = docs_en_vigueur(insee)
            if not ds and c.get("codeEpci"):
                e = c["codeEpci"]
                if e not in epci_cache:
                    epci_cache[e] = docs_en_vigueur(e)
                ds = epci_cache[e]
            parts = {d["name"]: d for d in ds}
            entry = {"nom": c["nom"]}
            if not parts and c.get("centre"):
                p = partition_par_point(*c["centre"]["coordinates"])
                if p:
                    l = gpu_json("/document", {"partition": p, "status": "document.production"}) or []
                    parts = {d["name"]: d for d in l if str(d.get("name", "")).startswith("DU_")}
            if parts:
                entry["partitions"] = sorted(parts)
            else:
                g = gpu_json(f"/grid/{insee}") or {}
                entry["rnu"] = bool(g.get("rnu"))
            return insee, entry, parts

        t0 = time.time()
        with ThreadPoolExecutor(8) as ex:
            for k, fut in enumerate(as_completed([ex.submit(une, c) for c in coms]), 1):
                if k % 50 == 0:
                    log(f"  {k}/{len(coms)} communes ({time.time() - t0:.0f} s)")
                try:
                    insee, entry, parts = fut.result()
                except Exception as e:
                    log("  commune en erreur :", e)
                    continue
                out[insee] = entry
                for k, d in parts.items():
                    docs[k] = d
        par_dep[dep] = dict(sorted(out.items()))
        n = sum(1 for v in out.values() if v.get("partitions"))
        log(f"  {n} communes couvertes par un document, {sum(1 for v in out.values() if v.get('rnu'))} au RNU")
    return par_dep, docs


# ---------- Géométries ----------
def arrondi(o, nd=6):
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, list):
        return [arrondi(x, nd) for x in o]
    return o


# Prescriptions utilisées par le site : EBC, emplacements réservés, patrimoine, OAP, emprise, hauteur, pleine terre
PRESC_CODES = {"01", "05", "07", "18", "38", "39", "43"}
PRESC_RE = re.compile(r"(?i)espaces? bois|EBC|emplacements? r[ée]serv|patrimoin|paysag|orientations? d.am[ée]nagement|\bOAP\b|hauteur|emprise|pleine terre")


def utile(p):
    t = str(p.get("typepsc") or "").zfill(2)
    return t in PRESC_CODES or bool(PRESC_RE.search(str(p.get("libelle") or "")))


def simplifie(g):
    """Contours simplifiés à 50 cm près (les PLU sont souvent très densifiés en sommets)."""
    try:
        from shapely.geometry import shape, mapping
        s = shape(g).simplify(0.000005, preserve_topology=True)
        if s.is_empty:
            return g
        m = mapping(s)
        return {"type": m["type"], "coordinates": json.loads(json.dumps(m["coordinates"]))}
    except Exception:
        return g


def nettoie(features, props, partition, doc_id, filtre=None):
    out = []
    for f in features:
        g = f.get("geometry")
        if not g:
            continue
        if filtre and not filtre({k.lower(): v for k, v in (f.get("properties") or {}).items()}):
            continue
        g = simplifie(g)
        p0 = {k.lower(): v for k, v in (f.get("properties") or {}).items()}
        p = {k: p0.get(k) for k in props if p0.get(k) not in (None, "")}
        if not p.get("urlfic") and p.get("nomfic"):
            p["urlfic"] = f"{GPU}/document/{doc_id}/files/{p['nomfic']}"
        if p.get("typepsc") is not None:
            p["typepsc"] = str(p["typepsc"]).zfill(2)
        p["partition"] = partition
        out.append({"type": "Feature", "properties": p, "geometry": {"type": g["type"], "coordinates": arrondi(g["coordinates"])}})
    return out


def depuis_archive(doc):
    """Lit zone_urba / secteur_cc / prescription_surf dans l'archive du GPU, sans télécharger les PDF si possible."""
    import geopandas as gpd

    url = f"{GPU}/document/{doc['id']}/download/{doc['originalName']}.zip"
    tmp = Path(tempfile.mkdtemp(prefix="plu_"))
    try:
        couches = {}
        want = re.compile(r"(?i)(?:^|/)(zone_urba|secteur_cc|prescription_surf)\.(shp|shx|dbf|prj|cpg)$")
        try:
            from remotezip import RemoteZip
            with RemoteZip(url, headers=UA, timeout=120) as z:
                noms = [n for n in z.namelist() if want.search(n)]
                for n in noms:
                    z.extract(n, tmp)
            mode = "archive (lecture partielle)"
        except Exception as e:
            # le serveur ne permet pas la lecture partielle : archive complète
            r = get(url, timeout=600, stream=True)
            r.raise_for_status()
            zp = tmp / "doc.zip"
            with open(zp, "wb") as fh:
                for chunk in r.iter_content(1 << 20):
                    fh.write(chunk)
            with zipfile.ZipFile(zp) as z:
                for n in z.namelist():
                    if want.search(n):
                        z.extract(n, tmp)
            zp.unlink()
            mode = f"archive complète ({type(e).__name__})"
        for shp in tmp.rglob("*"):
            m = re.match(r"(?i)(zone_urba|secteur_cc|prescription_surf)\.shp$", shp.name)
            if not m:
                continue
            gdf = gpd.read_file(shp)
            if gdf.crs is None:
                gdf = gdf.set_crs(2154)
            gdf = gdf.to_crs(4326)
            couches[m.group(1).lower()] = json.loads(gdf.to_json(drop_id=True))["features"]
        return couches, mode
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def depuis_apicarto(partition, layer):
    """Pages de 1000 ; le service ignore parfois la pagination et renvoie tout, ou la même page : dédoublonnage par identifiant."""
    out, vus, start = [], set(), 0
    while start < 100000:
        r = get(f"{APICARTO}/{layer}", params={"partition": partition, "_limit": 1000, "_start": start}, tries=5, timeout=120)
        r.raise_for_status()
        f = r.json().get("features", [])
        nouveaux = 0
        for x in f:
            k = x.get("id") or json.dumps(x.get("properties"), sort_keys=True)[:200] + str(len(json.dumps(x.get("geometry"))))
            if k in vus:
                continue
            vus.add(k); out.append(x); nouveaux += 1
        if len(f) != 1000 or nouveaux == 0:
            break
        start += 1000
    return out


def copie_document(doc, dest):
    part, did = doc["name"], doc["id"]
    couches, source = {}, ""
    try:
        couches, source = depuis_archive(doc)
    except Exception as e:
        log(f"  {part} : archive illisible ({type(e).__name__}: {str(e)[:300]}), secours API Carto")
    if not (couches.get("zone_urba") or couches.get("secteur_cc")):
        try:
            z = depuis_apicarto(part, "zone-urba") or depuis_apicarto(part, "secteur-cc")
            p = depuis_apicarto(part, "prescription-surf")
            couches, source = {"zone_urba": z, "prescription_surf": p}, "API Carto"
        except Exception as e:
            raise RuntimeError(f"{part} : aucune source disponible ({e})")
    zones = nettoie(couches.get("zone_urba") or couches.get("secteur_cc") or [], ZONE_PROPS, part, did)
    presc = nettoie(couches.get("prescription_surf") or [], PRESC_PROPS, part, did, filtre=utile)
    if not zones:
        raise RuntimeError(f"{part} : zonage vide")
    d = dest / "p" / part
    d.mkdir(parents=True, exist_ok=True)
    for nom, feats in (("zones.json", zones), ("presc.json", presc)):
        txt = json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":"))
        if len(txt) > 80e6:  # limite GitHub de 100 Mo par fichier : coordonnées au mètre près
            for f in feats:
                f["geometry"]["coordinates"] = arrondi(f["geometry"]["coordinates"], 5)
            txt = json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":"))
        if len(txt) > 95e6:
            raise RuntimeError(f"{part} : {nom} trop volumineux ({len(txt)/1e6:.0f} Mo)")
        (d / nom).write_text(txt)
    return {"id": did, "nom": doc.get("originalName"), "type": doc.get("type"), "maj": doc.get("updateDate"),
            "zones": len(zones), "presc": len(presc), "source": source, "copie": time.strftime("%Y-%m-%d")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="data-config.json")
    ap.add_argument("--prev", default="prev", help="copie précédente (branche data)")
    ap.add_argument("--out", default="out")
    ap.add_argument("--max-docs", type=int, default=0, help="limite pour un essai")
    ap.add_argument("--deps", default="", help="départements à traiter (essai), sinon ceux de la configuration")
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text())
    deps = [str(d).zfill(2) for d in (a.deps.split(",") if a.deps else cfg["departements"])]
    prev, out = Path(a.prev), Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    (out / "communes").mkdir(parents=True)
    old = json.loads((prev / "index.json").read_text())["documents"] if (prev / "index.json").exists() else {}

    par_dep, docs = cartographie_communes(deps)
    for dep, coms in par_dep.items():
        (out / "communes" / f"{dep}.json").write_text(json.dumps(coms, ensure_ascii=False, separators=(",", ":")))
    log(f"{len(docs)} documents en vigueur")

    index, a_faire = {}, []
    for part, d in sorted(docs.items()):
        o = old.get(part)
        if o and o.get("id") == d["id"] and (prev / "p" / part / "zones.json").exists():
            shutil.copytree(prev / "p" / part, out / "p" / part)
            index[part] = o
        else:
            a_faire.append(d)
    if a_faire and a.max_docs:
        a_faire = a_faire[: a.max_docs]
    log(f"{len(index)} documents inchangés, {len(a_faire)} à copier")

    erreurs = []
    with ThreadPoolExecutor(3) as ex:
        futs = {ex.submit(copie_document, d, out): d for d in a_faire}
        for i, fut in enumerate(as_completed(futs), 1):
            d = futs[fut]
            try:
                index[d["name"]] = fut.result()
                r = index[d["name"]]
                log(f"  [{i}/{len(a_faire)}] {d['name']} {d.get('type')} : {r['zones']} zones, {r['presc']} prescriptions ({r['source']})")
            except Exception as e:
                erreurs.append(str(e))
                log(f"  [{i}/{len(a_faire)}] ERREUR {e}")
                # on garde l'ancienne copie si elle existe : mieux vaut un PLU d'il y a une semaine que rien
                o = old.get(d["name"])
                if o and (prev / "p" / d["name"]).exists():
                    shutil.copytree(prev / "p" / d["name"], out / "p" / d["name"])
                    index[d["name"]] = {**o, "retard": True}

    (out / "index.json").write_text(json.dumps({"date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "departements": deps,
                                               "documents": index, "erreurs": erreurs[:200]}, ensure_ascii=False, indent=0))
    taille = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    log(f"Copie terminée : {len(index)} documents, {len(erreurs)} erreur(s), {taille/1e6:.1f} Mo")


if __name__ == "__main__":
    sys.exit(main())
