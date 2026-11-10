"""Lecture des règlements écrits des PLU par l'IA (Gemini), pour tous les documents de la copie des PLU.

Pour chaque document d'urbanisme copié (data/plu/index.json), le règlement écrit est téléchargé au
Géoportail de l'Urbanisme, son texte extrait (pypdf), puis Gemini en tire, zone par zone, l'emprise au sol,
la hauteur, le recul, le retrait, la pleine terre et le stationnement, avec l'article, la page et l'extrait cité.

Résultat : regles/<partition>.json, réutilisé par le site pour toutes les parcelles (« lu par l'IA »).
Un document n'est relu que s'il a changé (même identifiant GPU = déjà lu). Le quota gratuit de Gemini étant
limité, chaque passage traite un nombre maximal de documents et le suivant reprend là où il s'est arrêté.

Clé : variable d'environnement GEMINI_API_KEY (secret GitHub), jamais écrite dans les fichiers.
Seuls des documents publics (règlements de PLU) sont envoyés à Gemini.
"""
import argparse, io, json, os, re, sys, time
from pathlib import Path
import requests
from pypdf import PdfReader

GPU = "https://www.geoportail-urbanisme.gouv.fr/api"
GEM = "https://generativelanguage.googleapis.com/v1beta"
S = requests.Session()
S.headers["User-Agent"] = "Fonciscope-lecture-reglements (github.com/fonciscope/fonciscope.github.io)"
MAX_CAR = 600_000          # texte envoyé en une fois (≈ 170 000 jetons)
ZONES_PAR_APPEL = 30
CHAMPS = ["ces", "h", "recul", "ret", "pt", "stat"]


def log(*a):
    print(*a, flush=True)


def get(url, tries=3, timeout=120, **kw):
    last = None
    for i in range(tries):
        try:
            r = S.get(url, timeout=timeout, **kw)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(str(r.status_code))
            return r
        except Exception as e:
            last = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"{url} : {last}")


def modele(cle):
    r = S.get(f"{GEM}/models", params={"pageSize": 200}, headers={"x-goog-api-key": cle}, timeout=30)
    r.raise_for_status()
    ok = [m["name"].split("/", 1)[1] for m in r.json().get("models", [])
          if "generateContent" in m.get("supportedGenerationMethods", []) and "flash" in m["name"]
          and not re.search(r"lite|image|tts|live|audio|thinking|exp", m["name"])]
    ver = lambda n: float((re.search(r"gemini-(\d+(?:\.\d+)?)", n) or [0, 0])[1])
    ok.sort(key=lambda n: ("preview" in n, -ver(n), "latest" not in n))
    if not ok:
        raise RuntimeError("Aucun modèle Gemini Flash disponible avec cette clé")
    return ok[0]


def champ(desc):
    return {"type": "OBJECT", "nullable": True, "properties": {
        "valeur": {"type": "NUMBER", "nullable": True, "description": desc}, "article": {"type": "STRING"},
        "page": {"type": "INTEGER"}, "extrait": {"type": "STRING"}, "condition": {"type": "STRING"}}}


SCHEMA = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "zone": {"type": "STRING"}, "zone_trouvee": {"type": "BOOLEAN"},
    "ces": champ("Emprise au sol maximale en % du terrain (100 si non réglementée)"),
    "h": champ("Hauteur maximale en mètres à l'égout ou à l'acrotère (sinon totale ou au faîtage)"),
    "recul": champ("Recul minimal par rapport à la voie, en mètres (0 si à l'alignement)"),
    "ret": champ("Retrait minimal des limites séparatives, en mètres (minimum absolu si formule H/2)"),
    "pt": champ("Pleine terre ou espaces verts de pleine terre minimum, en % du terrain"),
    "stat": champ("Places de stationnement voiture par logement collectif (pour un logement de 60 m² si la règle est par m²)"),
    "remarque": {"type": "STRING"}}, "required": ["zone", "zone_trouvee"]}}


def consigne(zones, commune):
    return (f"Voici le règlement écrit du PLU {commune}, avec les numéros de page entre crochets.\n"
            f"Pour CHACUNE des zones suivantes : {', '.join(zones)}, trouve les règles applicables aux constructions de LOGEMENTS "
            "(un secteur suit les règles de sa zone mère sauf mention contraire). Pour chaque règle : valeur chiffrée, article, page "
            "(numéro entre crochets), extrait exact, et en « condition » les cas particuliers ou la conversion faite. "
            "Si une règle n'est pas trouvée, mets null. N'invente jamais de valeur. Hauteur donnée en niveaux : 3 m par niveau, dis-le dans condition. "
            "Renvoie un élément par zone demandée, avec zone_trouvee = false si le règlement ne traite pas cette zone.")


def demander(cle, mod, texte, zones, commune):
    body = {"contents": [{"role": "user", "parts": [{"text": consigne(zones, commune) + "\n\n" + texte}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "responseSchema": SCHEMA}}
    for essai in range(5):
        r = S.post(f"{GEM}/models/{mod}:generateContent", json=body, headers={"x-goog-api-key": cle}, timeout=300)
        if r.status_code == 429:
            msg = r.text
            if "PerDay" in msg or "per day" in msg.lower():
                raise QuotaJour()
            time.sleep(60 * (essai + 1)); continue
        if r.status_code >= 500:
            time.sleep(20 * (essai + 1)); continue
        if r.status_code != 200:
            raise RuntimeError(f"Gemini {r.status_code} : {r.text[:300]}")
        parts = (r.json().get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        txt = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        return json.loads(txt)
    raise QuotaJour()


class QuotaJour(Exception):
    pass


def reglement(doc_id, part):
    files = get(f"{GPU}/document/{doc_id}/files").json()
    c = [f["name"] for f in files if re.search(r"r[eè]glement", f["name"] + " " + str(f.get("path") or ""), re.I)
         and not re.search(r"graphique|prescription|zonage|plan|annexe", f["name"], re.I) and f["name"].lower().endswith(".pdf")]
    if not c:
        return None, None
    nom = sorted(c, key=len)[0]
    return nom, f"https://data.geopf.fr/annexes/gpu/documents/{part}/{doc_id}/{nom}"


def pages_texte(url):
    r = get(url, timeout=300)
    r.raise_for_status()
    pdf = PdfReader(io.BytesIO(r.content))
    out = []
    for p in pdf.pages:
        try:
            out.append(re.sub(r"[ \t]+", " ", p.extract_text() or ""))
        except Exception:
            out.append("")
    return out


def selection(pages, zones):
    """Texte envoyé : tout le règlement s'il tient, sinon les pages qui citent ces zones et le stationnement."""
    tout = "".join(f"[page {i + 1}]\n{t}\n" for i, t in enumerate(pages))
    if len(tout) <= MAX_CAR:
        return tout
    codes = set()
    for z in zones:
        codes.add(z); b = z.split("-")[0]; codes.add(b); codes.add(re.sub(r"[a-z]+\d*$", "", b))
    res = [re.compile(rf"(?<![A-Za-z0-9]){re.escape(c)}(?![A-Za-z0-9])") for c in codes if c]
    score = [(sum(len(r.findall(t)) for r in res) + (3 if re.search("stationnement", t, re.I) else 0), i) for i, t in enumerate(pages)]
    garde = sorted(i for s, i in sorted(score, reverse=True) if s > 0)
    out, n = [], 0
    for i in sorted(garde, key=lambda i: -score[i][0]):
        t = f"[page {i + 1}]\n{pages[i]}\n"
        if n + len(t) > MAX_CAR:
            continue
        out.append((i, t)); n += len(t)
    return "".join(t for _, t in sorted(out))


def convertit(x):
    o = {"source": "ia", "citations": {}, "zoneTrouvee": bool(x.get("zone_trouvee")), "remarque": x.get("remarque") or ""}
    for k in CHAMPS:
        c = x.get(k) or {}
        v = c.get("valeur")
        v = v if isinstance(v, (int, float)) and v >= 0 else None
        o[k] = None if v is None else (min(1, v / 100) if k in ("ces", "pt") else v)
        if v is not None or c.get("extrait"):
            o["citations"][k] = {"value": v, "status": "extrait" if v is not None else "non_trouve", "article": c.get("article") or "",
                                 "page": c.get("page"), "citation": c.get("extrait") or "", "condition": c.get("condition") or ""}
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plu", required=True)        # copie des PLU (index.json, p/<partition>/zones.json)
    ap.add_argument("--prev", required=True)       # lectures précédentes
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-docs", type=int, default=120)
    a = ap.parse_args()
    cle = os.environ.get("GEMINI_API_KEY", "").strip()
    plu, prev, out = Path(a.plu), Path(a.prev), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    # lectures déjà faites : reprises telles quelles
    for f in prev.glob("*.json"):
        (out / f.name).write_text(f.read_text())
    essai = os.environ.get("ESSAI") == "1"  # téléchargement et lecture des PDF seulement, sans Gemini
    if not cle and not essai:
        log("Pas de secret GEMINI_API_KEY : lectures précédentes gardées, rien de nouveau lu.")
        return
    mod = modele(cle) if not essai else "essai"
    log("Modèle :", mod)
    docs = json.loads((plu / "index.json").read_text())["documents"]
    faits = 0
    for part, d in sorted(docs.items()):
        if faits >= a.max_docs:
            log(f"Limite de {a.max_docs} documents atteinte : la suite au prochain passage."); break
        dest = out / f"{part}.json"
        if dest.exists():
            try:
                if json.loads(dest.read_text()).get("id") == d.get("id"):
                    continue
            except Exception:
                pass
        zf = plu / "p" / part / "zones.json"
        if not zf.exists() or d.get("type") == "CC":
            continue
        feats = json.loads(zf.read_text()).get("features", [])
        zones = sorted({f["properties"].get("libelle") for f in feats if f["properties"].get("libelle")
                        and re.match(r"^\d?(U|AU)", str(f["properties"].get("typezone") or "").upper())})
        if not zones:
            continue
        faits += 1
        try:
            nom, url = reglement(d["id"], part)
            if not url:
                dest.write_text(json.dumps({"id": d.get("id"), "erreur": "pas de règlement écrit publié", "zones": {}}, ensure_ascii=False)); continue
            pages = pages_texte(url)
            if sum(len(p) for p in pages) < 2000:
                dest.write_text(json.dumps({"id": d.get("id"), "document": url, "erreur": "règlement scanné (pas de texte)", "zones": {}}, ensure_ascii=False)); continue
            if essai:
                t = selection(pages, zones[:ZONES_PAR_APPEL])
                log(f"ESSAI {part} : {nom}, {len(pages)} pages, {sum(len(p) for p in pages)} caractères, {len(t)} envoyés, zones {zones[:8]}")
                continue
            res = {}
            for i in range(0, len(zones), ZONES_PAR_APPEL):
                lot = zones[i:i + ZONES_PAR_APPEL]
                rep = demander(cle, mod, selection(pages, lot), lot, d.get("nom") or part)
                for x in rep if isinstance(rep, list) else []:
                    if x.get("zone") in lot:
                        res[x["zone"]] = {**convertit(x), "document": url}
                time.sleep(8)
            dest.write_text(json.dumps({"id": d.get("id"), "document": url, "date": time.strftime("%Y-%m-%d"), "zones": res}, ensure_ascii=False))
            n = sum(1 for z in res.values() if any(z[k] is not None for k in CHAMPS))
            log(f"{part} : {n} / {len(zones)} zones avec des règles ({len(pages)} pages)")
        except QuotaJour:
            log("Quota du jour de Gemini atteint : la suite au prochain passage."); break
        except Exception as e:
            log(f"{part} : {e}")
    log(f"Documents lus ce passage : {faits}. Total : {len(list(out.glob('*.json')))} documents.")


if __name__ == "__main__":
    main()
