"""
Adresses rattachées aux parcelles cadastrales, d'après la Base Adresse Nationale (BAN).

Le fichier départemental de la BAN liste, pour chaque adresse, les parcelles cadastrales auxquelles elle est
rattachée (colonne cad_parcelles). On en tire, par commune, un fichier { idu: ["12 Rue X", ...] }.

Sortie : <out>/<insee>.json  et  <out>/index.json (date, nombre d'adresses par département)
"""
import argparse, csv, gzip, io, json, sys, time
from collections import defaultdict
from pathlib import Path

import requests

URL = "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-{dep}.csv.gz"
CADASTRE = "https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/departements/{dep}/cadastre-{dep}-parcelles.json.gz"
UA = {"User-Agent": "Fonciscope-adresses (github.com/eristaldesir75-crypto/terrafoncier)"}


def log(*a):
    print(*a, flush=True)


def telecharge(dep):
    for i in range(4):
        try:
            r = requests.get(URL.format(dep=dep), headers=UA, timeout=300)
            r.raise_for_status()
            return gzip.decompress(r.content).decode("utf-8")
        except Exception as e:
            log(f"  essai {i + 1} : {e}")
            time.sleep(10 * (i + 1))
    raise RuntimeError(f"BAN {dep} indisponible")


def parcelles_des_points(dep, points):
    """Parcelle cadastrale (plan Etalab) qui contient chaque point d'adresse : {indice du point: idu}."""
    import geopandas as gpd
    tmp = Path(f"/tmp/cadastre-{dep}.json.gz")
    with requests.get(CADASTRE.format(dep=dep), headers=UA, timeout=900, stream=True) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for ch in r.iter_content(1 << 20):
                fh.write(ch)
    parc = gpd.read_file(f"/vsigzip/{tmp}", columns=["id"])
    tmp.unlink()
    log(f"  plan cadastral : {len(parc)} parcelles")
    pts = gpd.GeoDataFrame({"k": [k for k, _, _ in points]}, geometry=gpd.points_from_xy([x for _, x, _ in points], [y for _, _, y in points]), crs=4326)
    if parc.crs is None:
        parc = parc.set_crs(4326)
    parc = parc.to_crs(4326)[["id", "geometry"]]
    j = gpd.sjoin(pts, parc, how="inner", predicate="within")
    res = dict(zip(j["k"], j["id"]))
    # points placés sur le trottoir, juste devant la parcelle : parcelle la plus proche à moins de 8 m
    reste = pts[~pts["k"].isin(res.keys())]
    if len(reste):
        r2 = gpd.sjoin_nearest(reste.to_crs(2154), parc.to_crs(2154), how="inner", max_distance=8, distance_col="d")
        r2 = r2.sort_values("d").drop_duplicates("k")
        for k, idu in zip(r2["k"], r2["id"]):
            res.setdefault(k, idu)
        log(f"  {len(r2)} points d'adresse rattachés à la parcelle la plus proche (moins de 8 m)")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="data-config.json")
    ap.add_argument("--out", default="out/adresses")
    ap.add_argument("--deps", default="")
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text())
    deps = [str(d).zfill(2) for d in (a.deps.split(",") if a.deps else cfg["departements"])]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stats = {}
    for dep in deps:
        txt = telecharge(dep)
        rd = csv.DictReader(io.StringIO(txt), delimiter=";")
        log(f"Département {dep} : colonnes {rd.fieldnames[:25]}")
        par_commune = defaultdict(lambda: defaultdict(list))
        cp = {}
        n = lie = geo = 0
        lignes, sans = [], []
        for row in rd:
            lignes.append(row)
            if not (row.get("cad_parcelles") or "").strip():
                try:
                    sans.append((len(lignes) - 1, float(row["lon"]), float(row["lat"])))
                except (KeyError, ValueError):
                    pass
        # adresses sans parcelle rattachée : parcelle du plan cadastral qui contient le point d'adresse
        try:
            trouve = parcelles_des_points(dep, sans) if sans else {}
        except Exception as e:
            log(f"  plan cadastral indisponible ({e}) : seules les parcelles rattachées par la BAN sont utilisées")
            trouve = {}
        for i, row in enumerate(lignes):
            n += 1
            parcelles = (row.get("cad_parcelles") or "").strip()
            if not parcelles and i in trouve:
                parcelles = trouve[i]
                geo += 1
            if not parcelles:
                continue
            num = (row.get("numero") or "").strip()
            if num in ("", "99999"):  # lieu-dit sans numéro
                num = ""
            rep = (row.get("rep") or "").strip()
            voie = (row.get("nom_voie") or "").strip()
            lib = " ".join(x for x in [f"{num}{rep}" if num else "", voie] if x)
            insee = row.get("code_insee")
            cp[insee] = (row.get("code_postal") or "", row.get("nom_commune") or "")
            for idu in parcelles.split("|"):
                idu = idu.strip()
                if len(idu) == 14 and lib not in par_commune[insee][idu]:
                    par_commune[insee][idu].append(lib)
                    lie += 1
        for insee, m in par_commune.items():
            code_postal, nom = cp.get(insee, ("", ""))
            (out / f"{insee}.json").write_text(json.dumps({"cp": code_postal, "commune": nom, "p": m}, ensure_ascii=False, separators=(",", ":")))
        stats[dep] = {"adresses": n, "liens_parcelle": lie, "par_position": geo, "communes": len(par_commune)}
        log(f"  {n} adresses, {lie} liens adresse-parcelle (dont {geo} par la position du point d'adresse), {len(par_commune)} communes")
    (out / "index.json").write_text(json.dumps({"date": time.strftime("%Y-%m-%d"), "departements": stats}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
