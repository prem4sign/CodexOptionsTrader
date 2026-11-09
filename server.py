"""Local FYERS OAuth callback and static app server.

This server is intentionally bound to loopback. FYERS secrets and access tokens
stay on this machine; request logs omit query strings because callbacks contain
short-lived authorization codes.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
PORT = 8001
CALLBACK_PATH = "/fyers/callback"
FYERS_API = "https://api-t1.fyers.in/api/v3"
FYERS_LOGIN = f"{FYERS_API}/generate-authcode"
FYERS_VALIDATE = f"{FYERS_API}/validate-authcode"
FYERS_DATA = "https://api-t1.fyers.in/data"
FYERS_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
ALLOWED_UNDERLYINGS = {"NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"}

_pending_state: str | None = None
_access_token: str | None = None
_state_lock = threading.Lock()
_news_cache: dict | None = None
_news_cache_time = 0.0
_news_cache_lock = threading.Lock()

NEWS_SEARCHES = (
    "India (Nifty OR Bank Nifty OR stock market OR RBI OR banks OR inflation OR GDP)",
    "India (war OR geopolitical OR election OR government OR budget OR crude oil OR tariff) economy market",
)
NEWS_UPSIDE_TERMS = (
    "rally", "rallies", "gains", "surge", "surges", "inflow", "rate cut", "cuts rates",
    "easing inflation", "eases inflation", "beats estimates", "upgrade", "record high",
    "falling oil", "oil slides", "ceasefire", "peace deal", "strong growth", "positive outlook",
)
NEWS_DOWNSIDE_TERMS = (
    "war", "attack", "escalat", "crisis", "tariff", "sanction", "crude jumps", "oil prices rise",
    "inflation rises", "rate hike", "rate hikes", "selloff", "sell-off", "decline", "drops", "plunge",
    "losses", "weak outlook", "outflow", "downgrade", "default", "political turmoil", "uncertainty",
)


def classify_news(title: str) -> tuple[list[str], str]:
    normalized = title.lower()
    bank_related = any(term in normalized for term in (
        "bank", "banking", "rbi", "lender", "credit", "interest rate", "loan", "nbfc", "financial sector",
    ))
    broad_market = any(term in normalized for term in (
        "war", "geopolit", "election", "government", "budget", "crude", "oil", "tariff", "india market",
        "indian stocks", "inflation", "gdp", "rupee", "global market", "trade deal",
    ))
    if bank_related:
        indices = ["NIFTY", "BANK NIFTY"]
    elif broad_market:
        indices = ["NIFTY", "BANK NIFTY"]
    elif "nifty" in normalized:
        indices = ["NIFTY"]
    else:
        indices = ["NIFTY", "BANK NIFTY"]

    upside = sum(term in normalized for term in NEWS_UPSIDE_TERMS)
    downside = sum(term in normalized for term in NEWS_DOWNSIDE_TERMS)
    if upside > downside:
        direction = "Upside"
    elif downside > upside:
        direction = "Downside"
    else:
        direction = "Mixed / unclear"
    return indices, direction


def fetch_news_feed(search: str) -> list[dict]:
    query = urlencode({"q": search, "hl": "en-IN", "gl": "IN", "ceid": "IN:en"})
    request = Request(
        f"https://news.google.com/rss/search?{query}",
        headers={"Accept": "application/rss+xml, application/xml, text/xml", "User-Agent": FYERS_USER_AGENT},
    )
    try:
        with urlopen(request, timeout=12) as response:
            root = ET.fromstring(response.read())
    except (URLError, TimeoutError, ET.ParseError, OSError):
        return []

    items = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not link or not link.startswith(("https://", "http://")):
            continue
        published = item.findtext("pubDate") or ""
        try:
            published_at = parsedate_to_datetime(published).astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError, OverflowError):
            published_at = ""
        source = (item.findtext("source") or "").strip()
        if not source and " - " in title:
            title, source = title.rsplit(" - ", 1)
        indices, direction = classify_news(title)
        items.append({
            "title": title.strip(),
            "url": link,
            "source": source or "Google News",
            "publishedAt": published_at,
            "indices": indices,
            "direction": direction,
        })
    return items


def latest_news(force: bool = False) -> dict:
    global _news_cache, _news_cache_time
    with _news_cache_lock:
        if not force and _news_cache is not None and time.monotonic() - _news_cache_time < 300:
            return _news_cache
    with ThreadPoolExecutor(max_workers=len(NEWS_SEARCHES)) as executor:
        batches = list(executor.map(fetch_news_feed, NEWS_SEARCHES))
    seen = set()
    items = []
    for item in sorted((item for batch in batches for item in batch), key=lambda entry: entry["publishedAt"], reverse=True):
        key = item["title"].casefold()
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
    response = {
        "items": items[:40],
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "error": "News feeds could not be reached. Check your internet connection and retry." if not items else "",
    }
    with _news_cache_lock:
        _news_cache = response
        _news_cache_time = time.monotonic()
    return response


def load_local_env() -> None:
    """Load the ignored .env file without adding a package dependency."""
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip("\"'")
        if key:
            os.environ[key] = value


def config() -> dict[str, str]:
    load_local_env()
    app_id = os.environ.get("FYERS_APP_ID", "").strip()
    app_secret = os.environ.get("FYERS_APP_SECRET", "").strip()
    redirect_uri = os.environ.get("FYERS_REDIRECT_URI", "").strip()
    redirect = urlsplit(redirect_uri)
    configured = bool(
        app_id
        and app_secret
        and not app_id.lower().startswith("your_")
        and not app_secret.lower().startswith("your_")
        and redirect.scheme == "http"
        and redirect.hostname == "localhost"
        and redirect.port == PORT
        and redirect.path == CALLBACK_PATH
    )
    return {
        "app_id": app_id,
        "app_secret": app_secret,
        "redirect_uri": redirect_uri,
        "configured": configured,
    }


def fyers_data_get(endpoint: str, params: dict[str, str]) -> tuple[dict | None, int, str | None]:
    """Call a read-only FYERS market-data endpoint without logging credentials."""
    settings = config()
    with _state_lock:
        token = _access_token
    if not token:
        return None, 401, "FYERS session expired or disconnected. Reconnect to FYERS."

    url = f"{FYERS_DATA}/{endpoint}?{urlencode(params)}"
    request = Request(
        url,
        headers={
            "Authorization": f"{settings['app_id']}:{token}",
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
        api_code = result.get("code", "unknown")
        print(f"FYERS {endpoint} reported API code {api_code}")
        if api_code in (-8, -15, -16, -17):
            return None, 401, "FYERS session expired or disconnected. Reconnect to FYERS."
        return None, 502, f"FYERS reported an error for {endpoint} (code {api_code})."
    return result, 200, None


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, _format: str, *_args) -> None:
        # Never log the query string: FYERS sends auth_code and state there.
        print(f"{self.log_date_time_string()} {self.client_address[0]} {self.command} {urlsplit(self.path).path}")

    def end_headers(self) -> None:
        # The UI changes alongside the backend; avoid serving stale JS or HTML.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_page(self, status: int, title: str, message: str) -> None:
        body = (
            "<!doctype html><html lang='en'><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>FYERS connection</title><body style='font:16px system-ui;background:#0b111b;color:#e8edf4;"
            "min-height:90vh;display:grid;place-items:center'><main style='max-width:520px;padding:32px;background:#101a27;"
            "border:1px solid #1b2939;border-radius:14px'><div style='color:#86b3f8;font-size:12px;letter-spacing:1px'>OPTIONS DESK</div>"
            f"<h1 style='font-size:22px'>{title}</h1><p style='color:#a5b1c1;line-height:1.6'>{message}</p>"
            "<a href='/' style='color:#8db9ff'>Return to app</a></main></body></html>"
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        global _pending_state, _access_token
        if urlsplit(self.path).path == "/api/disconnect":
            with _state_lock:
                _access_token = None
                _pending_state = None
            self.send_json(200, {"connected": False})
            return
        self.send_json(404, {"error": "Not found."})

    def do_GET(self) -> None:
        global _pending_state, _access_token
        parsed = urlsplit(self.path)

        if parsed.path == "/api/news":
            force = parse_qs(parsed.query).get("refresh", [""])[0] == "1"
            self.send_json(200, latest_news(force=force))
            return

        if parsed.path == "/api/status":
            self.send_json(200, {"configured": config()["configured"], "connected": _access_token is not None})
            return

        if parsed.path == "/api/market/option-chain":
            query = parse_qs(parsed.query)
            symbol = query.get("symbol", ["NSE:NIFTY50-INDEX"])[0]
            try:
                strike_count = int(query.get("strikecount", ["5"])[0])
            except ValueError:
                self.send_json(400, {"error": "strikecount must be an integer from 1 to 50."})
                return
            if symbol not in ALLOWED_UNDERLYINGS or not 1 <= strike_count <= 50:
                self.send_json(400, {"error": "Unsupported underlying or strike count."})
                return
            params = {"symbol": symbol, "strikecount": str(strike_count), "greeks": "1"}
            timestamp = query.get("timestamp", [""])[0]
            if timestamp:
                params["timestamp"] = timestamp
            payload, status, error = fyers_data_get("options-chain-v3", params)
            if error:
                self.send_json(status, {"error": error})
            else:
                self.send_json(200, payload or {})
            return

        if parsed.path == "/api/market/quote":
            query = parse_qs(parsed.query)
            symbol = query.get("symbol", ["NSE:NIFTY50-INDEX"])[0]
            is_index_option = (
                len(symbol) <= 64
                and symbol.startswith(("NSE:NIFTY", "NSE:BANKNIFTY"))
                and symbol.endswith(("CE", "PE"))
                and all(character.isalnum() or character in ":-_" for character in symbol)
            )
            if symbol not in ALLOWED_UNDERLYINGS and not is_index_option:
                self.send_json(400, {"error": "Unsupported symbol."})
                return
            payload, status, error = fyers_data_get("quotes", {"symbols": symbol})
            if error:
                self.send_json(status, {"error": error})
            else:
                self.send_json(200, payload or {})
            return

        if parsed.path == "/api/market/history":
            query = parse_qs(parsed.query)
            symbol = query.get("symbol", ["NSE:NIFTY50-INDEX"])[0]
            resolution = query.get("resolution", ["5"])[0]
            allowed_resolutions = {"1", "5", "15", "30", "60", "1D", "1W", "1M"}
            if (
                len(symbol) > 64
                or not symbol.startswith("NSE:")
                or not all(character.isalnum() or character in ":-_" for character in symbol)
                or resolution not in allowed_resolutions
            ):
                self.send_json(400, {"error": "Unsupported symbol or resolution."})
                return
            # The UI uses explicit labels (1D/1W/1M), while FYERS history
            # expects D/W/M for calendar intervals.
            fyers_resolution = {"1D": "D", "1W": "W", "1M": "M"}.get(resolution, resolution)
            if resolution in {"1D", "1W", "1M"}:
                # IST has no daylight-saving changes; use its fixed UTC+05:30
                # offset so daily history also works on Windows without tzdata.
                ist = timezone(timedelta(hours=5, minutes=30))
                now = datetime.now(ist)
                market_close = now.replace(hour=15, minute=30, second=0, microsecond=0)
                if now < market_close:
                    market_close = (now - timedelta(days=1)).replace(hour=15, minute=30, second=0, microsecond=0)
                range_to = int(market_close.timestamp())
                range_from = int((market_close - timedelta(days=365 * 5)).timestamp())
                candles_by_timestamp = {}
                chunk_start = range_from
                chunk_days = 365
                while chunk_start < range_to:
                    chunk_end = min(
                        chunk_start + chunk_days * 24 * 60 * 60,
                        range_to,
                    )
                    params = {
                        "symbol": symbol,
                        "resolution": fyers_resolution,
                        "date_format": "0",
                        "range_from": str(chunk_start),
                        "range_to": str(chunk_end),
                        "cont_flag": "1" if symbol.endswith(("CE", "PE")) else "0",
                    }
                    payload, status, error = fyers_data_get("history", params)
                    if error:
                        self.send_json(status, {"error": error})
                        return
                    for candle in (payload or {}).get("candles", []):
                        if isinstance(candle, list) and candle:
                            candles_by_timestamp[int(candle[0])] = candle
                    chunk_start = chunk_end
                candles = [candles_by_timestamp[key] for key in sorted(candles_by_timestamp)]
                self.send_json(200, {"s": "ok", "candles": candles})
                return
            else:
                interval_seconds = int(resolution) * 60
                include_partial = parse_qs(parsed.query).get("include_partial", [""])[0] == "1"
                range_to = int(time.time()) - (0 if include_partial else interval_seconds)
                # Keep more intraday candles available so chart panning can
                # reveal history beyond the initially visible window.
                range_from = range_to - 30 * 24 * 60 * 60
            params = {
                "symbol": symbol,
                "resolution": fyers_resolution,
                "date_format": "0",
                "range_from": str(range_from),
                "range_to": str(range_to),
                "cont_flag": "1" if symbol.endswith(("CE", "PE")) else "0",
            }
            payload, status, error = fyers_data_get("history", params)
            if error:
                self.send_json(status, {"error": error})
            else:
                self.send_json(200, payload or {})
            return

        if parsed.path == "/auth/login":
            settings = config()
            if not settings["configured"]:
                self.send_page(
                    503,
                    "Finish local setup first",
                    "Add your App ID and newly rotated Secret ID to the ignored .env file, and set the matching localhost redirect URL in the FYERS dashboard.",
                )
                return
            state = secrets.token_urlsafe(32)
            with _state_lock:
                _pending_state = state
            query = urlencode(
                {
                    "client_id": settings["app_id"],
                    "redirect_uri": settings["redirect_uri"],
                    "response_type": "code",
                    "state": state,
                }
            )
            self.send_response(302)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Location", f"{FYERS_LOGIN}?{query}")
            self.end_headers()
            return

        if parsed.path == CALLBACK_PATH:
            query = parse_qs(parsed.query)
            returned_state = query.get("state", [""])[0]
            auth_code = query.get("auth_code", [""])[0]
            with _state_lock:
                expected_state = _pending_state
                valid_state = bool(expected_state) and hmac.compare_digest(returned_state, expected_state or "")
                if valid_state:
                    _pending_state = None
            if not valid_state:
                self.send_page(400, "Login could not be verified", "The login state did not match. Return to the app and start the FYERS connection again.")
                return
            if not auth_code:
                self.send_page(400, "FYERS did not return an authorization code", "Return to the app and try the connection again.")
                return

            settings = config()
            app_id_hash = hashlib.sha256(
                f"{settings['app_id']}:{settings['app_secret']}".encode("utf-8")
            ).hexdigest()
            payload = json.dumps(
                {"grant_type": "authorization_code", "appIdHash": app_id_hash, "code": auth_code}
            ).encode("utf-8")
            request = Request(
                FYERS_VALIDATE,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/131.0.0.0 Safari/537.36"
                    ),
                },
                method="POST",
            )
            try:
                with urlopen(request, timeout=20) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except HTTPError as error:
                print(f"FYERS token exchange returned HTTP {error.code}")
                self.send_page(
                    502,
                    "FYERS rejected the token exchange",
                    f"FYERS returned HTTP {error.code}. Return to the app and start a fresh login. If it happens again, check that the app credentials and redirect URL match the dashboard.",
                )
                return
            except (URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
                print(f"FYERS token exchange transport error: {type(error).__name__}")
                self.send_page(502, "Could not connect to FYERS", "Token exchange failed. No authorization code or secret was saved in the app logs. Return to the app and start a fresh login.")
                return

            if result.get("s") == "ok" and result.get("access_token"):
                _access_token = result["access_token"]
                self.send_response(303)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Location", "/?fyers=connected")
                self.end_headers()
            else:
                self.send_page(502, "FYERS did not issue an access token", "Check that the App ID, rotated Secret ID, and redirect URL match the FYERS dashboard, then try again.")
            return

        super().do_GET()


if __name__ == "__main__":
    if not (ROOT / "index.html").exists():
        raise SystemExit("index.html is missing from the app folder")
    print(f"Options Desk is available at http://localhost:{PORT}/")
    print("FYERS credentials are read locally from .env; callback query values are not logged.")
    ThreadingHTTPServer(("127.0.0.1", PORT), AppHandler).serve_forever()
