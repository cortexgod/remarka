"""Бэкенды языковой модели для слоя смысла (CONTRACTS.md §5).

Три бэкенда:

* ``anthropic_api`` — anthropic SDK: ``client.messages.parse(..., output_format=PydanticModel)``
  и ``response.parsed_output``. Ключ — аргумент ``api_key`` или ``ANTHROPIC_API_KEY``.
  Параметр ``thinking`` не передаётся (адаптивный по умолчанию).
* ``claude_cli`` — ``claude -p --output-format json --model <model>`` через subprocess,
  промпт пользователя в stdin, системный промпт через ``--system-prompt``. Ответ — JSON
  с полем ``result`` (строка); из неё вырезается JSON-блок (первая ``{`` … последняя ``}``)
  и валидируется той же Pydantic-моделью; при ошибке разбора — один повтор с указанием
  «Ответь строго JSON по схеме». Таймаут 180 с.
* ``none`` — слой смысла выключен.

Всё логирование модуля — ТОЛЬКО в stderr: stdout движка занят протоколом JSON lines.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, TypeVar

import pydantic

try:  # SDK нужен только бэкенду anthropic_api
    import anthropic
except Exception:  # pragma: no cover - SDK отсутствует
    anthropic = None  # type: ignore[assignment]

__all__ = [
    "BACKENDS",
    "DEFAULT_MODEL",
    "MAX_TOKENS",
    "DEFAULT_TIMEOUT_S",
    "LlmError",
    "LlmUnavailableError",
    "LlmParseError",
    "LlmClient",
    "detect_backend",
    "is_available",
    "has_api_credentials",
    "find_cli",
    "extract_json_block",
    "load_prompt",
    "render_prompt",
    "log",
]

BACKENDS = ("remote", "anthropic_api", "claude_cli", "none")
RELAY_TIMEOUT_S = 300.0
DEFAULT_MODEL = "claude-opus-5"
MAX_TOKENS = 16000
DEFAULT_TIMEOUT_S = 180.0
PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
STRICT_JSON_HINT = (
    "ВАЖНО: предыдущий ответ не удалось разобрать. Ответь строго JSON по схеме — "
    "один JSON-объект, без markdown-обёртки, без текста до и после него."
)

ModelT = TypeVar("ModelT", bound=pydantic.BaseModel)


class LlmError(RuntimeError):
    """Ошибка обращения к модели: сеть, таймаут, отказ бэкенда, невалидный ответ."""


class LlmUnavailableError(LlmError):
    """Бэкенд недоступен: backend none, нет ключа или ``claude`` не найден в PATH."""


class LlmParseError(LlmError):
    """Ответ модели не удалось разобрать по Pydantic-схеме (после повтора)."""


def log(message: str, level: str = "info") -> None:
    """Лог в stderr (stdout — протокол движка)."""
    print(f"[llm:{level}] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Промпты
# ---------------------------------------------------------------------------

_PROMPT_CACHE: dict[str, str] = {}
_PLACEHOLDER_RE = re.compile(r"\{\{([a-zA-Z0-9_]+)\}\}")


def load_prompt(name: str) -> str:
    """Читает ``prompts/<name>.md`` (кэшируется)."""
    if name not in _PROMPT_CACHE:
        path = PROMPTS_DIR / f"{name}.md"
        _PROMPT_CACHE[name] = path.read_text(encoding="utf-8").strip() + "\n"
    return _PROMPT_CACHE[name]


GOAL_LABELS = {
    "layer1.wpm": "темп речи",
    "layer1.filled_pauses_per_min": "меньше «э-э» и «м-м»",
    "layer1.crutch_words_per_min": "меньше слов-паразитов",
    "layer2.pitch_range_st": "живее интонация",
    "layer1.hesitation_pauses_per_min": "меньше запинок внутри фраз",
    "layer1.talk_ratio": "баланс «говорю / слушаю»",
    "layer2.phrase_final_decay_db": "не проглатывать окончания",
    "layer2.rising_statements_share": "утверждать, а не спрашивать интонацией",
    "layer1.mean_sentence_len": "короче фразы",
}


def profile_text() -> str:
    """Блок «Кто говорит» для промптов: из REMARKA_PROFILE_JSON (Settings.profile), иначе пусто."""
    raw = os.environ.get("REMARKA_PROFILE_JSON", "").strip()
    if not raw:
        return "Нет данных о говорящем — обращайся на «ты», без имени."
    try:
        prof = json.loads(raw)
    except Exception:  # noqa: BLE001
        return "Нет данных о говорящем — обращайся на «ты», без имени."
    lines = []
    if prof.get("name"):
        lines.append(f"Имя: {prof['name']} (обращайся по имени, на «ты»)")
    if prof.get("role"):
        lines.append(f"Чем занимается: {prof['role']}")
    if prof.get("about"):
        lines.append(f"О себе и о встречах: {prof['about']}")
    kinds = prof.get("typical_meetings") or []
    if kinds:
        names = {"pitch": "питчи инвесторам", "demo": "демо клиентам", "sales": "продажи", "interview": "собеседования", "standup": "стендапы", "lecture": "лекции", "one_on_one": "встречи 1:1", "training": "тренировки", "other": "встречи"}
        lines.append("Обычные созвоны: " + ", ".join(names.get(k, k) for k in kinds))
    goal = prof.get("goal_metric")
    if goal:
        lines.append(f"Хочет улучшить в первую очередь: {GOAL_LABELS.get(goal, goal)} — учитывай это, выбирая три правки")
    return "\n".join(lines) if lines else "Нет данных о говорящем — обращайся на «ты», без имени."


def render_prompt(template: str, **values: Any) -> str:
    """Подставляет ``{{key}}`` в шаблон. Незаполненный плейсхолдер — ошибка программиста."""
    for key, value in values.items():
        template = template.replace("{{" + key + "}}", str(value))
    leftover = _PLACEHOLDER_RE.findall(template)
    if leftover:
        raise ValueError(f"в промпте остались незаполненные плейсхолдеры: {sorted(set(leftover))}")
    return template


# ---------------------------------------------------------------------------
# Доступность бэкендов
# ---------------------------------------------------------------------------


def relay_config() -> dict[str, str] | None:
    """Адрес, токен и сертификат LLM-ретранслятора (data/relay.json). None — не настроен."""
    p = Path(__file__).resolve().parent / "data" / "relay.json"
    env_url = os.environ.get("REMARKA_RELAY_URL")
    try:
        cfg = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except Exception:  # noqa: BLE001
        cfg = {}
    if env_url:
        cfg["url"] = env_url
    if os.environ.get("REMARKA_RELAY_TOKEN"):
        cfg["token"] = os.environ["REMARKA_RELAY_TOKEN"]
    return cfg if cfg.get("url") else None


def _relay_ssl_context(cfg: dict[str, str]):
    import ssl

    pem = cfg.get("cert_pem")
    if pem:
        ctx = ssl.create_default_context()
        ctx.load_verify_locations(cadata=pem)
        # самоподписанный сертификат сервера: проверяем именно его, не имя хоста
        ctx.check_hostname = False
        return ctx
    return ssl.create_default_context()


def relay_health(timeout_s: float = 8.0) -> tuple[bool, str]:
    """GET /v1/health у ретранслятора."""
    import urllib.request

    cfg = relay_config()
    if not cfg:
        return False, "сервер советов не настроен"
    try:
        req = urllib.request.Request(cfg["url"].rstrip("/") + "/v1/health")
        with urllib.request.urlopen(req, timeout=timeout_s, context=_relay_ssl_context(cfg)) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("ok"):
            return True, "сервер советов отвечает"
        return False, "сервер советов не готов"
    except Exception as exc:  # noqa: BLE001
        return False, f"сервер советов недоступен: {str(exc)[:120]}"


def has_api_credentials(api_key: str | None = None) -> bool:
    """Есть ли чем авторизоваться в Anthropic API (ключ аргументом или в окружении)."""
    return bool(api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def find_cli(cli_path: str | None = None) -> str | None:
    """Путь к ``claude`` (или None). Переопределяется ``REMARKA_CLAUDE_CLI``."""
    candidate = cli_path or os.environ.get("REMARKA_CLAUDE_CLI") or "claude"
    return shutil.which(candidate)


def is_available(backend: str, model: str = DEFAULT_MODEL, ping: bool = False) -> tuple[bool, str]:
    """Доступность бэкенда для ``doctor``: (ok, сообщение по-русски).

    По умолчанию проверяет только ключ / наличие ``claude`` в PATH. ``ping=True`` — короткий
    реальный вызов (проверяет авторизацию и сеть; для claude_cli без повторов, ~2 с при отказе).
    """
    if backend == "auto":
        backend = detect_backend("auto")
    if backend == "none":
        return True, "LLM выключен"
    if backend not in BACKENDS:
        return False, f"неизвестный LLM-бэкенд: {backend}"
    if backend == "remote":
        return relay_health()
    client = LlmClient(backend, model=model)
    if backend == "anthropic_api":
        if anthropic is None:
            return False, "пакет anthropic не установлен"
        if not client.available():
            return False, "нет ANTHROPIC_API_KEY для anthropic_api"
        message = f"Anthropic API: ключ задан, модель {model}"
    else:
        path = find_cli()
        if path is None:
            return False, "claude CLI не найден в PATH"
        message = f"claude CLI: {path}, модель {model}"
    if ping:
        if not client.ping(timeout_s=60):
            return False, f"{message} — не отвечает (для claude_cli: выполните `claude login`)"
        message += " — отвечает"
    return True, message


def detect_backend(preferred: str | None, api_key: str | None = None) -> str:
    """Выбирает бэкенд.

    ``preferred`` уважается, если он доступен (``none`` — всегда). Иначе автоопределение:
    ``anthropic_api`` при наличии ключа/кредов → ``claude_cli``, если ``claude`` в PATH → ``none``.
    """
    if preferred == "none":
        return "none"
    if preferred == "remote" and relay_config():
        return "remote"
    if preferred in (None, "auto") and relay_config():
        return "remote"
    if preferred == "anthropic_api" and anthropic is not None and has_api_credentials(api_key):
        return "anthropic_api"
    if preferred == "claude_cli" and find_cli():
        return "claude_cli"
    if anthropic is not None and has_api_credentials(api_key):
        return "anthropic_api"
    if find_cli():
        return "claude_cli"
    return "none"


# ---------------------------------------------------------------------------
# Разбор ответов
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", re.S)


def extract_json_block(text: str) -> str:
    """Вырезает JSON-объект из текста ответа: fenced-блок или первая ``{`` … последняя ``}``."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("пустой ответ модели")
    m = _FENCE_RE.search(text)
    if m:
        return m.group(1)
    i = text.find("{")
    j = text.rfind("}")
    if i == -1 or j == -1 or j < i:
        raise ValueError("в ответе модели нет JSON-объекта")
    return text[i : j + 1]


def schema_hint(schema_model: type[pydantic.BaseModel]) -> str:
    """Компактная JSON-схема модели для текста промпта."""
    return json.dumps(schema_model.model_json_schema(), ensure_ascii=False, separators=(",", ":"))


def _validate(schema_model: type[ModelT], structured: Any, text: str) -> ModelT:
    if isinstance(structured, dict):
        return schema_model.model_validate(structured)
    return schema_model.model_validate_json(extract_json_block(text))


def _parse_cli_envelope(stdout: str) -> dict[str, Any]:
    """Разбирает stdout ``claude -p --output-format json`` в объект результата."""
    raw = (stdout or "").strip()
    if not raw:
        raise LlmError("claude CLI вернул пустой stdout")
    data: Any = None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        for line in reversed(raw.splitlines()):
            line = line.strip()
            if line.startswith("{") or line.startswith("["):
                try:
                    data = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
    if data is None:
        raise LlmError(f"claude CLI: stdout не JSON: {raw[:200]!r}")
    if isinstance(data, list):  # --verbose: массив сообщений, результат — последний
        results = [d for d in data if isinstance(d, dict) and d.get("type") == "result"]
        data = results[-1] if results else (data[-1] if data else None)
    if not isinstance(data, dict):
        raise LlmError("claude CLI: неожиданный формат ответа")
    return data


class _Ping(pydantic.BaseModel):
    ok: bool


# ---------------------------------------------------------------------------
# Клиент
# ---------------------------------------------------------------------------


class LlmClient:
    """Единый клиент для ``anthropic_api`` / ``claude_cli`` / ``none``."""

    def __init__(
        self,
        backend: str,
        model: str = DEFAULT_MODEL,
        api_key: str | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        cli_path: str | None = None,
    ) -> None:
        if backend not in BACKENDS:
            raise ValueError(f"неизвестный LLM-бэкенд: {backend!r} (ожидается один из {BACKENDS})")
        self.backend = backend
        self.model = model or DEFAULT_MODEL
        self.api_key = api_key
        self.timeout_s = float(timeout_s)
        self.cli_path = cli_path
        # Опционально: структурированный вывод CLI через --json-schema (результат в structured_output).
        self.cli_use_json_schema = False
        # Сколько раз CLI сам повторяет запрос к API (CLAUDE_CODE_MAX_RETRIES); None — не трогать окружение.
        self.cli_max_retries: int | None = 3
        self._api_client: Any = None  # тесты подменяют
        self.last_raw: str | None = None  # последний сырой ответ бэкенда (отладка)
        self.calls = 0

    # -- служебное ---------------------------------------------------------

    def describe(self) -> dict[str, str]:
        return {"backend": self.backend, "model": self.model}

    def available(self) -> bool:
        if self.backend == "remote":
            return relay_config() is not None
        if self.backend == "anthropic_api":
            return anthropic is not None and has_api_credentials(self.api_key)
        if self.backend == "claude_cli":
            return find_cli(self.cli_path) is not None
        return False

    def ping(self, timeout_s: float = 60.0) -> bool:
        """Короткий реальный вызов: проверка, что бэкенд отвечает (авторизация, сеть)."""
        if not self.available():
            return False
        saved = (self.timeout_s, self.cli_max_retries)
        self.timeout_s, self.cli_max_retries = float(timeout_s), 0
        try:
            out = self.complete_json(
                "Отвечай только JSON.",
                'Верни ровно такой объект: {"ok": true}',
                _Ping,
            )
            return bool(out.ok)
        except LlmError as exc:
            log(f"ping не прошёл: {exc}", "warn")
            return False
        finally:
            self.timeout_s, self.cli_max_retries = saved

    # -- основной вызов ----------------------------------------------------

    def complete_json(self, system: str, user: str, schema_model: type[ModelT]) -> ModelT:
        """Запрос → экземпляр ``schema_model``. Бросает ``LlmError`` (и подклассы)."""
        if self.backend == "none":
            raise LlmUnavailableError("LLM-бэкенд выключен (none)")
        self.calls += 1
        if self.backend == "remote":
            return self._complete_remote(system, user, schema_model)
        if self.backend == "anthropic_api":
            return self._complete_api(system, user, schema_model)
        return self._complete_cli(system, user, schema_model)

    # -- remote (ретранслятор на сервере) -----------------------------------

    def _run_remote(self, system: str, user_text: str) -> str:
        import urllib.error
        import urllib.request

        cfg = relay_config()
        if not cfg:
            raise LlmUnavailableError("сервер советов не настроен")
        body = json.dumps({"system": system, "user": user_text, "model": self.model, "timeout": min(self.timeout_s, RELAY_TIMEOUT_S)}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(cfg["url"].rstrip("/") + "/v1/complete", data=body, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        if cfg.get("token"):
            req.add_header("X-Remarka-Token", cfg["token"])
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s + 30, context=_relay_ssl_context(cfg)) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("error")
            except Exception:  # noqa: BLE001
                detail = None
            raise LlmError(f"сервер советов: {detail or exc.reason} (HTTP {exc.code})") from exc
        except Exception as exc:  # noqa: BLE001
            raise LlmError(f"сервер советов недоступен: {str(exc)[:200]}") from exc
        self.last_raw = raw
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LlmError("сервер советов вернул не JSON") from exc
        if not data.get("ok"):
            raise LlmError(f"сервер советов: {str(data.get('error') or 'ошибка')[:300]}")
        return str(data.get("result") or "")

    def _complete_remote(self, system: str, user: str, schema_model: type[ModelT]) -> ModelT:
        user_text = user
        last_error: Exception | None = None
        for attempt in (1, 2):
            result_text = self._run_remote(system, user_text)
            try:
                return _validate(schema_model, None, result_text)
            except (pydantic.ValidationError, json.JSONDecodeError, ValueError) as exc:
                last_error = exc
                log(f"remote: ответ не по схеме (попытка {attempt}): {str(exc)[:300]}", "warn")
                user_text = f"{user}\n\n{STRICT_JSON_HINT}\n{schema_hint(schema_model)}"
        raise LlmParseError(f"remote: ответ модели не по схеме {schema_model.__name__}: {last_error}")

    # -- anthropic_api ------------------------------------------------------

    def _get_api_client(self) -> Any:
        if self._api_client is None:
            if anthropic is None:
                raise LlmUnavailableError("пакет anthropic не установлен")
            if not has_api_credentials(self.api_key):
                raise LlmUnavailableError("нет ANTHROPIC_API_KEY для бэкенда anthropic_api")
            kwargs: dict[str, Any] = {"timeout": self.timeout_s, "max_retries": 2}
            if self.api_key:
                kwargs["api_key"] = self.api_key
            self._api_client = anthropic.Anthropic(**kwargs)
        return self._api_client

    def _complete_api(self, system: str, user: str, schema_model: type[ModelT]) -> ModelT:
        client = self._get_api_client()
        user_text = user
        last_error: Exception | None = None
        for attempt in (1, 2):
            try:
                response = client.messages.parse(
                    model=self.model,
                    max_tokens=MAX_TOKENS,
                    system=system,
                    messages=[{"role": "user", "content": user_text}],
                    output_format=schema_model,
                )
            except (pydantic.ValidationError, json.JSONDecodeError, ValueError) as exc:
                last_error = exc  # SDK не смог разобрать ответ по схеме
                log(f"anthropic_api: ответ не по схеме (попытка {attempt}): {exc}", "warn")
                user_text = f"{user}\n\n{STRICT_JSON_HINT}\n{schema_hint(schema_model)}"
                continue
            except Exception as exc:  # APIError, таймауты, сеть
                raise LlmError(f"anthropic_api: {exc}") from exc
            parsed = getattr(response, "parsed_output", None)
            if isinstance(parsed, schema_model):
                self.last_raw = parsed.model_dump_json()
                return parsed
            text = "".join(
                getattr(block, "text", "") for block in (getattr(response, "content", None) or [])
                if getattr(block, "type", "") == "text"
            )
            self.last_raw = text
            try:
                return _validate(schema_model, parsed if isinstance(parsed, dict) else None, text)
            except (pydantic.ValidationError, json.JSONDecodeError, ValueError) as exc:
                last_error = exc
                log(f"anthropic_api: ответ не по схеме (попытка {attempt}): {exc}", "warn")
                user_text = f"{user}\n\n{STRICT_JSON_HINT}\n{schema_hint(schema_model)}"
        raise LlmParseError(f"anthropic_api: ответ модели не по схеме {schema_model.__name__}: {last_error}")

    # -- claude_cli ---------------------------------------------------------

    def _cli_env(self) -> dict[str, str]:
        env = dict(os.environ)
        # Вложенный запуск из-под Claude Code не должен считаться «сессией внутри сессии».
        env.pop("CLAUDECODE", None)
        if self.cli_max_retries is not None:
            env.setdefault("CLAUDE_CODE_MAX_RETRIES", str(self.cli_max_retries))
        return env

    def _cli_command(self, exe: str, system: str, schema_model: type[pydantic.BaseModel]) -> list[str]:
        cmd = [
            exe,
            "-p",
            "--output-format",
            "json",
            "--model",
            self.model,
            "--no-session-persistence",
            "--system-prompt",
            system,
        ]
        if self.cli_use_json_schema:
            cmd += ["--json-schema", schema_hint(schema_model)]
        # Модели не нужны инструменты, MCP-серверы и пользовательские плагины/хуки:
        # без этого каждый вызов поднимал бы MCP-серверы из ~/.claude (например, Telegram-бота).
        cmd += ["--tools", "", "--strict-mcp-config", "--setting-sources", ""]
        return cmd

    def _run_cli(self, exe: str, system: str, user_text: str, schema_model: type[pydantic.BaseModel]) -> dict[str, Any]:
        cmd = self._cli_command(exe, system, schema_model)
        try:
            proc = subprocess.run(
                cmd,
                input=user_text,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout_s,
                env=self._cli_env(),
            )
        except FileNotFoundError as exc:
            raise LlmUnavailableError(f"claude CLI не найден: {exe}") from exc
        except subprocess.TimeoutExpired as exc:
            raise LlmError(f"claude CLI не ответил за {self.timeout_s:.0f} с") from exc
        self.last_raw = proc.stdout
        if not (proc.stdout or "").strip():
            tail = (proc.stderr or "").strip()[-500:]
            raise LlmError(f"claude CLI завершился с кодом {proc.returncode} без ответа: {tail or 'stderr пуст'}")
        data = _parse_cli_envelope(proc.stdout)
        subtype = str(data.get("subtype") or "")
        if data.get("is_error") or subtype.startswith("error"):
            detail = data.get("result") or data.get("error") or subtype or "неизвестная ошибка"
            raise LlmError(f"claude CLI: {str(detail)[:500]}")
        return data

    def _complete_cli(self, system: str, user: str, schema_model: type[ModelT]) -> ModelT:
        exe = find_cli(self.cli_path)
        if exe is None:
            raise LlmUnavailableError("claude CLI не найден в PATH")
        user_text = user
        last_error: Exception | None = None
        for attempt in (1, 2):
            data = self._run_cli(exe, system, user_text, schema_model)
            structured = data.get("structured_output")
            result_text = data.get("result") if isinstance(data.get("result"), str) else ""
            try:
                return _validate(schema_model, structured, result_text)
            except (pydantic.ValidationError, json.JSONDecodeError, ValueError) as exc:
                last_error = exc
                log(f"claude_cli: ответ не по схеме (попытка {attempt}): {str(exc)[:300]}", "warn")
                user_text = f"{user}\n\n{STRICT_JSON_HINT}\n{schema_hint(schema_model)}"
        raise LlmParseError(f"claude_cli: ответ модели не по схеме {schema_model.__name__}: {last_error}")
