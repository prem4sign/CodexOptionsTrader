"""Stateless FYERS backend used only by Vercel Functions.

The local app continues to use server.py and its in-memory session. Vercel
requests instead carry an encrypted, HttpOnly cookie so function instances do
not need shared process memory.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

from cryptography.fernet import Fernet, InvalidToken

from server import (
    ALLOWED_UNDERLYINGS,
    FYERS_LOGIN,
    FYERS_USER_AGENT,
    FYERS_VALIDATE,
    latest_news,
)

CALLBACK_PATH = "/fyers/callback"
SESSION_COOKIE = "__Host-fyers-session"
STATE_COOKIE = "__Host-fyers-state"
SESSION_TTL = 60 * 60 * 24
STATE_TTL = 60 * 10


def _settings() -> dict[str, str]:
    app_id = os.environ.get("FYERS_APP_ID", "").strip()
    app_secret = os.environ.get("FYERS_APP_SECRET", "").strip()
    redirect_uri = os.environ.get("FYERS_REDIRECT_URI", "").strip()
    key = os.environ.get("FYERS_SESSION_KEY", "").strip()
    parsed = urlsplit(redirect_uri)
    try:
        Fernet(key.encode("ascii"))
        valid_key = True
    except (ValueError, UnicodeEncodeError):
        valid_key = False
    configured = bool(
        app_id and app_secret and valid_key
        and parsed.scheme == "https" and parsed.path == CALLBACK_PATH
        and parsed.hostname and parsed.hostname.endswith("vercel.app")
    )
    return {
        "app_id": app_id,
        "app_secret": app_secret,
        "redirect_uri": redirect_uri,
        "session_key": key,
        "configured": configured,
    }


def _fernet(settings: dict[str, str]) -> Fernet:
    return Fernet(settings["session_key"].encode("ascii"))


def _cookies(handler) -> SimpleCookie:
    cookies = SimpleCookie()
    try:
        cookies.load(handler.headers.get("Cookie", ""))
    except Exception:
        pass
    return cookies


def _cookie_header(name: str, value: str, max_age: int) -> str:
    return f"{name}={value}; Path=/; Max-Age={max_age}; Secure; HttpOnly; SameSite=Lax"


def _clear_cookie_header(name: str) -> str:
    return _cookie_header(name, "", 0)


def _session_token(handler, settings: dict[str, str]) -> str | None:
    morsel = _cookies(handler).get(SESSION_COOKIE)
    if morsel is None or not settings["configured"]:
        return None
    try:
        decoded = _fernet(settings).decrypt(morsel.value.encode("ascii"), ttl=SESSION_TTL)
        data = json.loads(decoded.decode("utf-8"))
        return data.get("access_token") if isinstance(data, dict) else None
    except (InvalidToken, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _json(handler, status: int, payload: dict, extra_headers: list[str] | None = None) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    for value in extra_headers or []:
        handler.send_header("Set-Cookie", value)
    handler.end_headers()
    handler.wfile.write(body)


def _page(handler, status: int, title: str, message: str, cookies: list[str] | None = None) -> None:
    body = (
        "<!doctype html><html lang='en'><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>FYERS connection</title><body style='font:16px system-ui;background:#0b111b;color:#e8edf4;"
        "min-height:90vh;display:grid;place-items:center'><main style='max-width:520px;padding:32px;background:#101a27;"
        "border:1px solid #1b2939;border-radius:14px'><div style='color:#86b3f8;font-size:12px;letter-spacing:1px'>OPTIONS DESK</div>"
        f"<h1 style='font-size:22px'>{title}</h1><p style='color:#a5b1c1;line-height:1.6'>{message}</p>"
        "<a href='/' style='color:#8db9ff'>Return to app</a></main></body></html>"
    ).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    for value in cookies or []:
        handler.send_header("Set-Cookie", value)
    handler.end_headers()
    handler.wfile.write(body)


def _fyers_get(endpoint: str, params: dict[str, str], token: str, app_id: str) -> tuple[dict | None, int, str | None]:
    request = Request(
        f"https://api-t1.fyers.in/data/{endpoint}?{urlencode(params)}",
        headers={
            "Authorization": f"{app_id}:{token}",
            "Accept": "application/json",
            "User-Agent": FYERS_USER_AGENT,
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        print(f"FYERS {endpoint} returned HTTP {error.code}")
        if error.code == 401:
            return None, 401, "FYERS session expired or disconnected. Reconnect to FYERS."
        return None, 502, f"FYERS returned HTTP {error.code} for {endpoint}."
    except (URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        print(f"FYERS {endpoint} transport error: {type(error).__name__}")
        return None, 502, f"Could not retrieve {endpoint} from FYERS."
    if result.get("s") != "ok":
        code = result.get("code", "unknown")
        if code in (-8, -15, -16, -17):
            return None, 401, "FYERS session expired or disconnected. Reconnect to FYERS."
        return None, 502, f"FYERS reported an error for {endpoint} (code {code})."
    return result, 200, None


def _market_request(handler, route: str, query: dict[str, list[str]], settings: dict[str, str]) -> None:
    token = _session_token(handler, settings)
    if not token:
        _json(handler, 401, {"error": "Connect to FYERS to load market data."})
        return

    if route == "/api/market/option-chain":
        symbol = query.get("symbol", ["NSE:NIFTY50-INDEX"])[0]
        try:
            count = int(query.get("strikecount", ["5"])[0])
        except ValueError:
            _json(handler, 400, {"error": "strikecount must be an integer from 1 to 50."})
            return
        if symbol not in ALLOWED_UNDERLYINGS or not 1 <= count <= 50:
            _json(handler, 400, {"error": "Unsupported underlying or strike count."})
            return
        params = {"symbol": symbol, "strikecount": str(count), "greeks": "1"}
        timestamp = query.get("timestamp", [""])[0]
        if timestamp:
            params["timestamp"] = timestamp
        result, status, error = _fyers_get("options-chain-v3", params, token, settings["app_id"])
    elif route == "/api/market/quote":
        symbol = query.get("symbol", ["NSE:NIFTY50-INDEX"])[0]
        is_option = (
            len(symbol) <= 64 and symbol.startswith(("NSE:NIFTY", "NSE:BANKNIFTY"))
            and symbol.endswith(("CE", "PE"))
            and all(char.isalnum() or char in ":-_" for char in symbol)
        )
        if symbol not in ALLOWED_UNDERLYINGS and not is_option:
            _json(handler, 400, {"error": "Unsupported symbol."})
            return
        result, status, error = _fyers_get("quotes", {"symbols": symbol}, token, settings["app_id"])
    elif route == "/api/market/history":
        symbol = query.get("symbol", ["NSE:NIFTY50-INDEX"])[0]
        resolution = query.get("resolution", ["5"])[0]
        allowed = {"1", "5", "15", "30", "60", "1D", "1W", "1M"}
        if (
            len(symbol) > 64 or not symbol.startswith("NSE:")
            or not all(char.isalnum() or char in ":-_" for char in symbol)
            or resolution not in allowed
        ):
            _json(handler, 400, {"error": "Unsupported symbol or resolution."})
            return
        fyers_resolution = {"1D": "D", "1W": "W", "1M": "M"}.get(resolution, resolution)
        if resolution in {"1D", "1W", "1M"}:
            ist = timezone(timedelta(hours=5, minutes=30))
            now = datetime.now(ist)
            close = now.replace(hour=15, minute=30, second=0, microsecond=0)
            if now < close:
                close = (now - timedelta(days=1)).replace(hour=15, minute=30, second=0, microsecond=0)
            range_to = int(close.timestamp())
            range_from = int((close - timedelta(days=365 * 5)).timestamp())
            candles: dict[int, list] = {}
            start = range_from
            while start < range_to:
                end = min(start + 365 * 86400, range_to)
                params = {
                    "symbol": symbol, "resolution": fyers_resolution, "date_format": "0",
                    "range_from": str(start), "range_to": str(end),
                    "cont_flag": "1" if symbol.endswith(("CE", "PE")) else "0",
                }
                result, status, error = _fyers_get("history", params, token, settings["app_id"])
                if error:
                    _json(handler, status, {"error": error})
                    return
                for candle in (result or {}).get("candles", []):
                    if isinstance(candle, list) and candle:
                        candles[int(candle[0])] = candle
                start = end
            _json(handler, 200, {"s": "ok", "candles": [candles[key] for key in sorted(candles)]})
            return
        seconds = int(resolution) * 60
        include_partial = query.get("include_partial", [""])[0] == "1"
        range_to = int(time.time()) - (0 if include_partial else seconds)
        params = {
            "symbol": symbol, "resolution": fyers_resolution, "date_format": "0",
            "range_from": str(range_to - 30 * 86400), "range_to": str(range_to),
            "cont_flag": "1" if symbol.endswith(("CE", "PE")) else "0",
        }
        result, status, error = _fyers_get("history", params, token, settings["app_id"])
    else:
        _json(handler, 404, {"error": "Not found."})
        return

    if error:
        _json(handler, status, {"error": error})
    else:
        _json(handler, 200, result or {})


def handle(handler) -> None:
    parsed = urlsplit(handler.path)
    query = parse_qs(parsed.query)
    route = query.get("route", [parsed.path])[0]
    settings = _settings()

    if route == "/api/status" and handler.command == "GET":
        _json(handler, 200, {
            "configured": settings["configured"],
            "connected": _session_token(handler, settings) is not None,
        })
        return

    if route == "/api/disconnect" and handler.command == "POST":
        _json(handler, 200, {"connected": False}, [
            _clear_cookie_header(SESSION_COOKIE), _clear_cookie_header(STATE_COOKIE),
        ])
        return

    if route == "/api/news" and handler.command == "GET":
        force = query.get("refresh", [""])[0] == "1"
        _json(handler, 200, latest_news(force=force))
        return

    if route.startswith("/api/market/") and handler.command == "GET":
        _market_request(handler, route, query, settings)
        return

    if route == "/auth/login" and handler.command == "GET":
        if not settings["configured"]:
            _page(handler, 503, "Cloud setup is incomplete", "Check the FYERS credentials, HTTPS callback URL, and FYERS_SESSION_KEY in Vercel.")
            return
        state = secrets.token_urlsafe(32)
        login_url = f"{FYERS_LOGIN}?" + urlencode({
            "client_id": settings["app_id"],
            "redirect_uri": settings["redirect_uri"],
            "response_type": "code",
            "state": state,
        })
        state_cookie = _fernet(settings).encrypt(state.encode("utf-8")).decode("ascii")
        handler.send_response(302)
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Location", login_url)
        handler.send_header("Set-Cookie", _cookie_header(STATE_COOKIE, state_cookie, STATE_TTL))
        handler.end_headers()
        return

    if route == CALLBACK_PATH and handler.command == "GET":
        if not settings["configured"]:
            _page(handler, 503, "Cloud setup is incomplete", "Check the FYERS credentials, HTTPS callback URL, and FYERS_SESSION_KEY in Vercel.")
            return
        returned_state = query.get("state", [""])[0]
        auth_code = query.get("auth_code", [""])[0]
        state_morsel = _cookies(handler).get(STATE_COOKIE)
        try:
            expected_state = _fernet(settings).decrypt(
                state_morsel.value.encode("ascii"), ttl=STATE_TTL,
            ).decode("utf-8") if state_morsel else ""
        except (InvalidToken, ValueError, UnicodeDecodeError):
            expected_state = ""
        if not expected_state or not secrets.compare_digest(returned_state, expected_state):
            _page(handler, 400, "Login could not be verified", "The login state did not match. Return to the app and start the FYERS connection again.", [_clear_cookie_header(STATE_COOKIE)])
            return
        if not auth_code:
            _page(handler, 400, "FYERS did not return an authorization code", "Return to the app and try the connection again.", [_clear_cookie_header(STATE_COOKIE)])
            return
        import hashlib
        app_id_hash = hashlib.sha256(
            f"{settings['app_id']}:{settings['app_secret']}".encode("utf-8")
        ).hexdigest()
        body = json.dumps({
            "grant_type": "authorization_code", "appIdHash": app_id_hash, "code": auth_code,
        }).encode("utf-8")
        request = Request(FYERS_VALIDATE, data=body, headers={
            "Content-Type": "application/json", "User-Agent": FYERS_USER_AGENT,
        }, method="POST")
        try:
            with urlopen(request, timeout=20) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            print(f"FYERS token exchange returned HTTP {error.code}")
            _page(handler, 502, "FYERS rejected the token exchange", f"FYERS returned HTTP {error.code}. Check the App ID, Secret ID, and redirect URL, then try again.", [_clear_cookie_header(STATE_COOKIE)])
            return
        except (URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
            print(f"FYERS token exchange transport error: {type(error).__name__}")
            _page(handler, 502, "Could not connect to FYERS", "Token exchange failed. Return to the app and start a fresh login.", [_clear_cookie_header(STATE_COOKIE)])
            return
        if result.get("s") != "ok" or not result.get("access_token"):
            _page(handler, 502, "FYERS did not issue an access token", "Check that the App ID, Secret ID, and redirect URL match the FYERS dashboard, then try again.", [_clear_cookie_header(STATE_COOKIE)])
            return
        session_cookie = _fernet(settings).encrypt(json.dumps({
            "access_token": result["access_token"],
        }).encode("utf-8")).decode("ascii")
        handler.send_response(303)
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Location", "/?fyers=connected")
        handler.send_header("Set-Cookie", _cookie_header(SESSION_COOKIE, session_cookie, SESSION_TTL))
        handler.send_header("Set-Cookie", _clear_cookie_header(STATE_COOKIE))
        handler.end_headers()
        return

    _json(handler, 404, {"error": "Not found."})
