"""Liste des documents d'urbanisme en vigueur (PLU, PLUi, PLUm, cartes communales) de toute la France,
d'après le Géoportail de l'Urbanisme : pour chaque commune, ses documents et ceux de son intercommunalité.
Sert à la lecture des règlements par l'IA au-delà des départements copiés. Résultat : france.json."""
import argparse, json, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import build_plu as B

# départements voisins des secteurs de prospection d'abord, puis le reste de la France
PRIORITE = ["37", "45", "91", "41", "28", "18", "36", "86", "72", "49", "77", "78", "92", "93", "94", "95", "75", "89", "58", "03", "23", "87"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    deps = [d["code"] for d in B.get(f"{B.GEOAPI}/departements").json()]
    deps = [d for d in PRIORITE if d in deps] + [d for d in deps if d not in PRIORITE]
    docs, epci_cache, t0 = {}, {}, time.time()
    for rang, dep in enumerate(deps):
        try:
            coms = B.communes_du_departement(dep)
        except Exception as e:
            B.log(f"{dep} : {e}"); continue

        def une(c):
            ds = B.docs_en_vigueur(c["code"])
            e = c.get("codeEpci")
            if e:
                if e not in epci_cache:
                    epci_cache[e] = B.docs_en_vigueur(e)
                ds = ds + epci_cache[e]
            return ds

        with ThreadPoolExecutor(8) as ex:
            for fut in as_completed([ex.submit(une, c) for c in coms]):
                try:
                    for d in fut.result():
                        p = d["name"]
                        if p not in docs:
                            docs[p] = {"id": d.get("id"), "nom": d.get("originalName"), "type": d.get("type"), "rang": rang}
                except Exception:
                    pass
        B.log(f"{dep} : {len(coms)} communes, {len(docs)} documents au total ({time.time() - t0:.0f} s)")
    Path(a.out).write_text(json.dumps({"date": time.strftime("%Y-%m-%d"), "documents": docs}, ensure_ascii=False))
    B.log(f"France : {len(docs)} documents")


if __name__ == "__main__":
    main()
