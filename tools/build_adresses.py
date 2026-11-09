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
UA = {"User-Agent": "TerraFoncier-adresses (github.com/eristaldesir75-crypto/terrafoncier)"}


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
        n = lie = 0
        for row in rd:
            n += 1
            parcelles = (row.get("cad_parcelles") or "").strip()
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
        stats[dep] = {"adresses": n, "liens_parcelle": lie, "communes": len(par_commune)}
        log(f"  {n} adresses, {lie} liens adresse-parcelle, {len(par_commune)} communes")
    (out / "index.json").write_text(json.dumps({"date": time.strftime("%Y-%m-%d"), "departements": stats}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
