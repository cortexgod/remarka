"""Сборка Report и валидация по docs/report.schema.json (jsonschema)."""

from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

SCHEMA_NAMES = {
    "report": "report.schema.json",
    "baseline": "baseline.schema.json",
    "patterns": "patterns.schema.json",
    "prep": "prep.schema.json",
}


def docs_dir() -> Path | None:
    env = os.environ.get("REMARKA_DOCS_DIR")
    candidates = [Path(env)] if env else []
    here = Path(__file__).resolve()
    candidates += [here.parents[2] / "docs", Path.cwd() / "docs", Path.cwd().parent / "docs"]
    for c in candidates:
        if (c / SCHEMA_NAMES["report"]).exists():
            return c
    return None


@lru_cache(maxsize=4)
def load_schema(kind: str) -> dict[str, Any] | None:
    d = docs_dir()
    if d is None:
        return None
    with open(d / SCHEMA_NAMES[kind], encoding="utf-8") as f:
        return json.load(f)


def validate(obj: dict[str, Any], kind: str = "report") -> list[str]:
    """Список ошибок валидации (пусто = валидно). Если схемы нет — пусто + отдельное предупреждение снаружи."""
    schema = load_schema(kind)
    if schema is None:
        return []
    import jsonschema

    validator = jsonschema.Draft7Validator(schema)
    errors = []
    for err in sorted(validator.iter_errors(obj), key=lambda e: list(e.absolute_path)):
        path = "/".join(str(p) for p in err.absolute_path) or "<root>"
        errors.append(f"{path}: {err.message}")
    return errors


def sanitize(obj: Any) -> Any:
    """NaN/inf → null, numpy → python, tuple → list."""
    if isinstance(obj, dict):
        return {str(k): sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, (int,)):
        return int(obj)
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    try:
        import numpy as np

        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            f = float(obj)
            return None if (math.isnan(f) or math.isinf(f)) else f
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, np.ndarray):
            return sanitize(obj.tolist())
    except ImportError:
        pass
    return obj


def write_json(obj: dict[str, Any], out: str | Path) -> str:
    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, out_path)
    return str(out_path.resolve())


def read_json(path: str | Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)
