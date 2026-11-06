"""Serveur d'extraction IA des règlements de PLU.

POST /extract  {partition, zone, url}  →  règles de la zone, chacune avec sa citation contrôlée.
Principe : l'IA propose, le code vérifie. Une valeur dont la citation n'est pas retrouvée
dans le texte du PDF est rétrogradée « à vérifier » et n'est jamais utilisée dans un calcul.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sqlite3
import unicodedata
import zipfile
from contextlib import closing

import fitz  # PyMuPDF
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Fournisseur d'IA : "gemini" (gratuit, Google AI Studio), "mistral" (gratuit, offre Experiment) ou "anthropic" (payant)
PROVIDER = os.getenv("LLM_PROVIDER", "gemini").lower()
DEFAULT_MODELS = {"gemini": "gemini-2.5-flash", "mistral": "mistral-small-latest", "anthropic": "claude-sonnet-5-5"}
MODEL = os.getenv("LLM_MODEL") or os.getenv("ANTHROPIC_MODEL") or DEFAULT_MODELS.get(PROVIDER, "")
DB_PATH = os.getenv("CACHE_DB", "cache.sqlite3")
MAX_PDF_MB = int(os.getenv("MAX_PDF_MB", "60"))
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "180000"))
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
ALLOWED_HOSTS = ("geoportail-urbanisme.gouv.fr", "data.geopf.fr", "wxs-gpu.mongeoportail.ign.fr")

app = FastAPI(title="TerraFoncier — extraction des règlements")
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])


# ---------- Cache ----------
def db():
    con = sqlite3.connect(DB_PATH)
    con.execute("CREATE TABLE IF NOT EXISTS extraction (k TEXT PRIMARY KEY, partition TEXT, zone TEXT, pdf_sha TEXT, result TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP)")
    con.execute("CREATE TABLE IF NOT EXISTS pdf (sha TEXT PRIMARY KEY, url TEXT, pages TEXT)")
    return con


# ---------- Téléchargement et lecture ----------
def gpu_urls(partition: str | None) -> set[str]:
    """URLs de règlements déclarées au GPU pour ce document (beaucoup sont hébergées par les collectivités)."""
    if not partition:
        return set()
    urls, start = set(), 0
    with httpx.Client(timeout=60) as h:
        while start < 20000:
            r = h.get("https://apicarto.ign.fr/api/gpu/zone-urba", params={"partition": partition, "_limit": 1000, "_start": start})
            r.raise_for_status()
            feats = r.json().get("features", [])
            urls |= {f["properties"].get("urlfic") for f in feats if f["properties"].get("urlfic")}
            if len(feats) != 1000:
                break
            start += 1000
    return urls


def check_url(url: str, partition: str | None) -> None:
    """Protection contre les téléchargements arbitraires : hôte du GPU, ou URL déclarée au GPU pour ce document."""
    u = httpx.URL(url)
    if u.scheme != "https":
        raise HTTPException(400, "Seules les URL https sont acceptées")
    host = u.host
    if any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS):
        return
    if url in gpu_urls(partition):
        return
    raise HTTPException(400, f"URL non reconnue par le Géoportail de l'Urbanisme pour ce document : {host}")


def download(url: str, partition: str | None = None) -> bytes:
    check_url(url, partition)
    with httpx.Client(follow_redirects=True, timeout=120) as h:
        r = h.get(url)
        if r.status_code == 404:
            raise HTTPException(404, "Document introuvable au Géoportail de l'Urbanisme")
        r.raise_for_status()
        if len(r.content) > MAX_PDF_MB * 1_000_000:
            raise HTTPException(413, "Document trop volumineux")
        return r.content


def pick_reglement(data: bytes) -> bytes:
    """Un PDF direct, ou l'archive CNIG du GPU dont on extrait le règlement écrit."""
    if data[:4] == b"%PDF":
        return data
    if data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            pdfs = [n for n in z.namelist() if n.lower().endswith(".pdf")]
            score = lambda n: (("reglement" in strip_accents(n.lower())) * 2 + ("ecrit" in strip_accents(n.lower())) - ("graphique" in n.lower()) * 3, -len(n))
            pdfs.sort(key=score, reverse=True)
            if pdfs:
                return z.read(pdfs[0])
    raise HTTPException(422, "Aucun règlement PDF trouvé dans le document")


def pdf_pages(pdf: bytes) -> list[str]:
    with fitz.open(stream=pdf, filetype="pdf") as doc:
        pages = [p.get_text("text") for p in doc]
    if sum(len(p.strip()) for p in pages) < 200 * max(1, len(pages)) * 0.1:
        raise HTTPException(422, "Le règlement semble scanné (pas de texte) : OCR nécessaire, non pris en charge par ce serveur")
    return pages


# ---------- Sélection des pages utiles ----------
def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm(s: str) -> str:
    s = strip_accents(s).lower().replace("’", "'").replace(" ", " ")
    s = re.sub(r"-\s*\n\s*", "", s)  # césures
    return re.sub(r"[^a-z0-9%,.']+", " ", s).strip()


def select_pages(pages: list[str], zone: str) -> list[int]:
    """Pages de la zone (et de sa famille : UB pour UBa) + dispositions générales."""
    base = re.match(r"\d*[A-Z]+", zone)
    family = re.escape(base.group(0) if base else zone)
    # la famille (UB) suivie d'un sous-secteur en minuscules (UBa) ou d'une fin de mot, jamais d'une autre majuscule
    fam = rf"{family}(?![A-Z0-9])[a-z0-9]*"
    pat_zone_i = re.compile(rf"\b(zone|secteur)\s+{fam}\b".replace("(zone|secteur)", "(?i:zone|secteur)"))
    pat_art = re.compile(rf"\b{fam}\s*[-.]?\s*\d+\b")
    pat_gen = re.compile(r"dispositions g[ée]n[ée]rales|dispositions communes|lexique|d[ée]finitions", re.I)
    hits = set()
    for i, p in enumerate(pages):
        head = p[:600]
        if pat_zone_i.search(head) or len(pat_art.findall(p)) >= 2:
            hits.add(i)
        if pat_gen.search(head) and i < len(pages) * 0.35:
            hits.add(i)
    # Prolonger chaque bloc de pages de zone tant que la zone ne change pas
    sel = sorted(hits)
    return sel or list(range(min(len(pages), 40)))


def build_context(pages: list[str], idx: list[int]) -> str:
    out, total = [], 0
    for i in idx:
        chunk = f"\n=== PAGE {i + 1} ===\n{pages[i]}"
        if total + len(chunk) > MAX_CONTEXT_CHARS:
            break
        out.append(chunk)
        total += len(chunk)
    return "".join(out)


# ---------- Appel au modèle ----------
THEMES = {
    "ces": "Emprise au sol maximale, en FRACTION du terrain (40 % → 0.4)",
    "h": "Hauteur maximale en mètres (préciser égout, acrotère ou faîtage dans condition)",
    "recul": "Recul minimal par rapport aux voies et emprises publiques, en mètres (0 si alignement obligatoire)",
    "ret": "Retrait minimal par rapport aux limites séparatives, en mètres (pour H/2 min 3 m, value = 3 et condition = 'H/2')",
    "pt": "Part minimale de pleine terre ou d'espaces verts de pleine terre, en FRACTION du terrain",
    "stat": "Nombre de places de stationnement exigées par logement",
}
RULE_SCHEMA = {
    "type": "object",
    "properties": {
        "value": {"type": ["number", "null"], "description": "Valeur numérique normalisée, null si absente"},
        "condition": {"type": ["string", "null"], "description": "Condition ou exception attachée, mot pour mot résumée"},
        "citation": {"type": ["string", "null"], "description": "Phrase EXACTE du règlement, copiée sans modification, 300 caractères max"},
        "page": {"type": ["integer", "null"], "description": "Numéro de PAGE indiqué par === PAGE n ==="},
        "article": {"type": ["string", "null"], "description": "Article, ex. 'Article UB 9'"},
    },
    "required": ["value", "condition", "citation", "page", "article"],
}
TOOL = {
    "name": "enregistrer_regles",
    "description": "Enregistre les règles de la zone extraites du règlement.",
    "input_schema": {
        "type": "object",
        "properties": {**{k: {**RULE_SCHEMA, "description": d} for k, d in THEMES.items()},
                       "destinations": {"type": ["string", "null"], "description": "Destinations autorisées, résumé court"},
                       "remarques": {"type": ["string", "null"], "description": "Renvois à d'autres pièces (plan des hauteurs, OAP…)"}},
        "required": list(THEMES) + ["destinations", "remarques"],
    },
}
SYSTEM = """Tu es un urbaniste qui lit un règlement de PLU français.
Règles absolues :
- N'utilise QUE le texte fourni. N'invente jamais une valeur, ne la déduis pas d'un autre PLU ni du code de l'urbanisme.
- Pour chaque thème, copie dans 'citation' la phrase exacte qui fixe la valeur, et indique la page '=== PAGE n ==='.
- Si la règle est absente, ou si le texte renvoie à un document non fourni (plan des hauteurs, OAP), mets value = null et explique le renvoi dans 'condition'.
- Si la zone a des sous-secteurs avec des valeurs différentes, donne la valeur de la zone demandée et mets les autres dans 'condition'.
- Valeur la plus contraignante applicable au cas général d'une construction d'habitation neuve."""


def _prompt(context: str, zone: str) -> str:
    return f"Zone demandée : {zone}\n\nExtraits du règlement :\n{context}"


def _json_schema() -> dict:
    return TOOL["input_schema"]


def _parse_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
        raise HTTPException(502, "Réponse du modèle inexploitable (JSON invalide)")


def _gemini_schema(schema):
    """Le schéma de Gemini n'accepte pas les types multiples : ["number","null"] devient number + nullable."""
    if isinstance(schema, dict):
        out = {}
        for k, v in schema.items():
            if k == "type" and isinstance(v, list):
                types = [t for t in v if t != "null"]
                out["type"] = types[0].upper() if types else "STRING"
                if "null" in v:
                    out["nullable"] = True
            elif k == "type":
                out["type"] = v.upper()
            else:
                out[k] = _gemini_schema(v)
        return out
    if isinstance(schema, list):
        return [_gemini_schema(x) for x in schema]
    return schema


def call_gemini(context: str, zone: str) -> dict:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(500, "GEMINI_API_KEY manquante sur le serveur")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": _prompt(context, zone)}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "responseSchema": _gemini_schema(_json_schema())},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    with httpx.Client(timeout=180) as h:
        r = h.post(url, params={"key": key}, json=body)
    if r.status_code == 429:
        raise HTTPException(429, "Quota gratuit Gemini atteint : réessayez dans une minute ou demain")
    if r.status_code >= 400:
        raise HTTPException(502, f"Gemini a répondu {r.status_code} : {r.text[:300]}")
    try:
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise HTTPException(502, "Réponse Gemini vide ou bloquée")
    return _parse_json(text)


def call_mistral(context: str, zone: str) -> dict:
    key = os.getenv("MISTRAL_API_KEY")
    if not key:
        raise HTTPException(500, "MISTRAL_API_KEY manquante sur le serveur")
    schema_txt = json.dumps(_json_schema(), ensure_ascii=False)
    body = {
        "model": MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM + "\nRéponds uniquement par un objet JSON conforme à ce schéma : " + schema_txt},
            {"role": "user", "content": _prompt(context, zone)},
        ],
    }
    with httpx.Client(timeout=180) as h:
        r = h.post("https://api.mistral.ai/v1/chat/completions", headers={"Authorization": f"Bearer {key}"}, json=body)
    if r.status_code == 429:
        raise HTTPException(429, "Quota gratuit Mistral atteint : réessayez plus tard")
    if r.status_code >= 400:
        raise HTTPException(502, f"Mistral a répondu {r.status_code} : {r.text[:300]}")
    return _parse_json(r.json()["choices"][0]["message"]["content"])


def call_anthropic(context: str, zone: str) -> dict:
    from anthropic import Anthropic  # importé seulement si ce fournisseur est choisi
    msg = Anthropic().messages.create(
        model=MODEL,
        max_tokens=4000,
        system=SYSTEM,
        tools=[TOOL],
        tool_choice={"type": "tool", "name": "enregistrer_regles"},
        messages=[{"role": "user", "content": _prompt(context, zone)}],
    )
    for block in msg.content:
        if block.type == "tool_use":
            return block.input
    raise HTTPException(502, "Réponse du modèle inexploitable")


def call_model(context: str, zone: str) -> dict:
    fn = {"gemini": call_gemini, "mistral": call_mistral, "anthropic": call_anthropic}.get(PROVIDER)
    if not fn:
        raise HTTPException(500, f"LLM_PROVIDER inconnu : {PROVIDER}")
    return fn(context, zone)


# ---------- Contrôle des citations ----------
def verify(rules: dict, pages: list[str]) -> dict:
    npages = [norm(p) for p in pages]
    out = {}
    for k in THEMES:
        r = rules.get(k) or {}
        val, cit, page = r.get("value"), (r.get("citation") or "").strip(), r.get("page")
        status = "non_trouve"
        if val is not None and cit:
            c = norm(cit)
            cands = [page - 1, page - 2, page] if isinstance(page, int) else []
            found = any(0 <= i < len(npages) and c in npages[i] for i in cands)
            if not found and len(c) > 40:  # tolérance : 85 % de la citation, découpée en fenêtres
                parts = [c[i:i + 40] for i in range(0, len(c) - 40, 20)]
                found = any(0 <= i < len(npages) and sum(p in npages[i] for p in parts) >= 0.85 * len(parts) for i in cands)
            status = "extrait" if found else "a_verifier"
        if k in ("ces", "pt") and val is not None and val > 1:
            val = val / 100  # le modèle a donné un pourcentage
        out[k] = {"value": val if status == "extrait" else None, "proposed": val, "condition": r.get("condition"),
                  "citation": cit or None, "page": page, "article": r.get("article"), "status": status}
    return out


# ---------- API ----------
class ExtractIn(BaseModel):
    partition: str | None = None
    zone: str
    url: str | None = None


@app.get("/health")
def health():
    return {"ok": True, "provider": PROVIDER, "model": MODEL}


@app.post("/extract")
def extract(body: ExtractIn):
    if not body.url and not body.partition:
        raise HTTPException(400, "Indiquez l'URL du règlement ou la partition GPU")
    url = body.url or f"https://www.geoportail-urbanisme.gouv.fr/document/download-by-partition/{body.partition}"
    zone = body.zone.strip()
    if not re.fullmatch(r"[\w\-]{1,30}", zone):
        raise HTTPException(400, "Libellé de zone invalide")
    with closing(db()) as con:
        k = hashlib.sha256(f"{url}|{zone}".encode()).hexdigest()
        row = con.execute("SELECT result FROM extraction WHERE k=?", (k,)).fetchone()
        if row:
            return {**json.loads(row[0]), "cache": True}
        pdf = pick_reglement(download(url, body.partition))
        sha = hashlib.sha256(pdf).hexdigest()
        prow = con.execute("SELECT pages FROM pdf WHERE sha=?", (sha,)).fetchone()
        pages = json.loads(prow[0]) if prow else pdf_pages(pdf)
        if not prow:
            con.execute("INSERT OR REPLACE INTO pdf VALUES (?,?,?)", (sha, url, json.dumps(pages)))
        idx = select_pages(pages, zone)
        raw = call_model(build_context(pages, idx), zone)
        result = {"zone": zone, "partition": body.partition, "document": {"url": url, "sha256": sha, "pages_lues": [i + 1 for i in idx]},
                  "rules": verify(raw, pages), "destinations": raw.get("destinations"), "remarques": raw.get("remarques"), "model": f"{PROVIDER}:{MODEL}"}
        con.execute("INSERT OR REPLACE INTO extraction (k, partition, zone, pdf_sha, result) VALUES (?,?,?,?,?)",
                    (k, body.partition, zone, sha, json.dumps(result, ensure_ascii=False)))
        con.commit()
        return {**result, "cache": False}
