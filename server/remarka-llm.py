#!/usr/bin/env python3
"""remarka-llm: маленький HTTPS-сервис, который принимает текст и возвращает ответ Claude.
Запускает claude -p (через /usr/local/bin/remarka-claude под пользователем assistant).
POST /v1/complete  {system, user, model?, timeout?} + X-Remarka-Token  →  {"ok": true, "result": "<текст>"}
GET  /v1/health                                                       →  {"ok": true, "claude": true|false}
"""
import json, os, ssl, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("REMARKA_TOKEN", "")
PORT = int(os.environ.get("REMARKA_PORT", "8787"))
CLAUDE = os.environ.get("REMARKA_CLAUDE", "/home/assistant/.local/bin/claude")
OAUTH_ENV = os.environ.get("REMARKA_OAUTH_ENV", "/home/assistant/.claude/oauth.env")
MAX_CONCURRENT = int(os.environ.get("REMARKA_MAX_CONCURRENT", "3"))
RATE_PER_HOUR = int(os.environ.get("REMARKA_RATE_PER_HOUR", "60"))
ALLOWED_MODELS = {"claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"}

_sem = threading.BoundedSemaphore(MAX_CONCURRENT)
_rate = {}
_rate_lock = threading.Lock()


def _env():
    env = dict(os.environ)
    try:
        for line in open(OAUTH_ENV, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    env.pop("CLAUDECODE", None)
    return env


def _allowed(ip):
    now = time.time()
    with _rate_lock:
        hist = [t for t in _rate.get(ip, []) if now - t < 3600]
        if len(hist) >= RATE_PER_HOUR:
            _rate[ip] = hist
            return False
        hist.append(now)
        _rate[ip] = hist
        return True


def run_claude(system, user, model, timeout):
    cmd = [CLAUDE, "-p", "--output-format", "json", "--model", model, "--no-session-persistence",
           "--system-prompt", system, "--tools", "", "--strict-mcp-config", "--setting-sources", ""]
    proc = subprocess.run(cmd, input=user, capture_output=True, text=True, timeout=timeout, env=_env(), cwd=os.path.expanduser("~"))
    out = proc.stdout.strip()
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return {"ok": False, "error": (proc.stderr or out or "пустой ответ claude")[:800]}
    if data.get("is_error") or proc.returncode != 0:
        return {"ok": False, "error": str(data.get("result") or proc.stderr or "claude вернул ошибку")[:800]}
    return {"ok": True, "result": data.get("result", ""), "cost_usd": data.get("total_cost_usd")}


class H(BaseHTTPRequestHandler):
    server_version = "remarka-llm/1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # без PII в журнале
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    def do_GET(self):
        if self.path == "/v1/health":
            return self._send(200, {"ok": True, "claude": os.path.exists(CLAUDE), "queue_free": _sem._value})
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/v1/complete":
            return self._send(404, {"ok": False, "error": "not found"})
        if TOKEN and self.headers.get("X-Remarka-Token", "") != TOKEN:
            return self._send(401, {"ok": False, "error": "unauthorized"})
        if not _allowed(self.client_address[0]):
            return self._send(429, {"ok": False, "error": "слишком много запросов, попробуйте позже"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 2_000_000:
                return self._send(413, {"ok": False, "error": "too large"})
            req = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            return self._send(400, {"ok": False, "error": f"bad json: {e}"})
        system = str(req.get("system") or "")
        user = str(req.get("user") or "")
        model = str(req.get("model") or "claude-opus-5")
        if model not in ALLOWED_MODELS:
            model = "claude-opus-5"
        timeout = min(float(req.get("timeout") or 240), 600.0)
        if not user:
            return self._send(400, {"ok": False, "error": "empty prompt"})
        if not _sem.acquire(timeout=120):
            return self._send(503, {"ok": False, "error": "сервис занят, попробуйте позже"})
        try:
            res = run_claude(system, user, model, timeout)
        except subprocess.TimeoutExpired:
            res = {"ok": False, "error": "claude не ответил вовремя"}
        except Exception as e:  # noqa: BLE001
            res = {"ok": False, "error": str(e)[:800]}
        finally:
            _sem.release()
        self._send(200 if res.get("ok") else 502, res)


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.environ.get("REMARKA_CERT", "/opt/remarka-llm/cert.pem"), os.environ.get("REMARKA_KEY", "/opt/remarka-llm/key.pem"))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"remarka-llm on :{PORT}", flush=True)
    httpd.serve_forever()
