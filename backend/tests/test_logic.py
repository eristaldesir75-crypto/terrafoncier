"""Tests de la logique pure (sélection des pages, contrôle des citations), sans réseau ni clé API."""
import sys, types

# Modules lourds remplacés par des bouchons pour tester sans dépendances réseau
for name in ("fitz", "httpx", "anthropic", "fastapi", "fastapi.middleware", "fastapi.middleware.cors", "pydantic"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["anthropic"].Anthropic = lambda: None
class _App:
    def __init__(self, **k): pass
    def add_middleware(self, *a, **k): pass
    def get(self, *a, **k): return lambda f: f
    def post(self, *a, **k): return lambda f: f
sys.modules["fastapi"].FastAPI = _App
sys.modules["fastapi"].HTTPException = type("HTTPException", (Exception,), {"__init__": lambda s, c, d="": Exception.__init__(s, d)})
sys.modules["fastapi.middleware.cors"].CORSMiddleware = object
sys.modules["pydantic"].BaseModel = object

sys.path.insert(0, ".")
from app.main import select_pages, verify, norm, _gemini_schema, _parse_json, TOOL  # noqa: E402

PAGES = [
    "TITRE I - DISPOSITIONS GÉNÉRALES\nLexique : emprise au sol...",
    "Sommaire",
    "CHAPITRE 2 - DISPOSITIONS APPLICABLES À LA ZONE UB\nArticle UB 1 ...",
    "Article UB 9 - Emprise au sol\nL'emprise au sol des constructions ne peut excé-\nder 40 % de la superficie du terrain.\nArticle UB 10 - Hauteur\nLa hauteur maximale est fixée à 9 m au faîtage.",
    "CHAPITRE 3 - DISPOSITIONS APPLICABLES À LA ZONE A\nArticle A 1",
]

def test_select_pages():
    idx = select_pages(PAGES, "UBa")
    assert 0 in idx and 2 in idx and 3 in idx and 4 not in idx, idx

def test_verify_found_with_hyphenation():
    raw = {"ces": {"value": 40, "citation": "L'emprise au sol des constructions ne peut excéder 40 % de la superficie du terrain.", "page": 4, "article": "Article UB 9", "condition": None},
           "h": {"value": 9, "citation": "La hauteur maximale est fixée à 9 m au faîtage.", "page": 4, "article": "Article UB 10", "condition": "faîtage"}}
    out = verify(raw, PAGES)
    assert out["ces"]["status"] == "extrait" and out["ces"]["value"] == 0.4, out["ces"]
    assert out["h"]["status"] == "extrait" and out["h"]["value"] == 9

def test_verify_invented_citation_rejected():
    raw = {"h": {"value": 12, "citation": "La hauteur maximale est fixée à 12 m.", "page": 4, "article": "UB 10", "condition": None}}
    out = verify(raw, PAGES)
    assert out["h"]["status"] == "a_verifier" and out["h"]["value"] is None and out["h"]["proposed"] == 12

def test_missing_rule():
    out = verify({}, PAGES)
    assert all(v["status"] == "non_trouve" for v in out.values())

def test_gemini_schema():
    g = _gemini_schema(TOOL["input_schema"])
    assert g["type"] == "OBJECT"
    assert g["properties"]["ces"]["properties"]["value"] == {"type": "NUMBER", "nullable": True, "description": g["properties"]["ces"]["properties"]["value"]["description"]}

def test_parse_json():
    assert _parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert _parse_json('Voici : {"a": 2} fin') == {"a": 2}

if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f(); print("ok", n)
