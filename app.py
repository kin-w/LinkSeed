import atexit
import base64
import copy
import hashlib
import hmac
import http.cookiejar
import io
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import socket
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse

from Crypto.Cipher import AES
from Crypto.Hash import SHA256
from Crypto.Protocol.KDF import PBKDF2
from Crypto.Random import get_random_bytes

from ed2k import ed2k_hash, make_ed2k_link, parse_ed2k_text, _MD4_BACKEND
from torrent import (
    TorrentError,
    create_torrent,
    edit_torrent,
    estimate_torrent,
    normalize_trackers,
    parse_torrent,
    parse_torrent_tree,
    supported_piece_size,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.realpath(os.path.join(BASE_DIR, "static"))

DATA_DIR = os.path.realpath(os.environ.get("ED2K_DATA", "/data"))
BLOB_DIR = os.path.join(DATA_DIR, "blobs")
TORRENT_DIR = os.path.join(DATA_DIR, "torrents")
INDEX_FILE = os.path.join(DATA_DIR, "files.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

HOST = os.environ.get("ED2K_HOST", "0.0.0.0")
PORT = int(os.environ.get("ED2K_PORT", "5566"))
HASH_WORKERS = max(1, int(os.environ.get("ED2K_HASH_WORKERS", "2")))
MAX_FILE_SIZE = int(os.environ.get("ED2K_MAX_FILE_SIZE", "0") or 0)
MAX_TOTAL_SIZE = int(os.environ.get("ED2K_MAX_TOTAL_SIZE", "0") or 0)
MAX_FILES = int(os.environ.get("ED2K_MAX_FILES", "0") or 0)
SECURE_COOKIE = os.environ.get("ED2K_HTTPS", "").strip().lower() in ("1", "true", "yes", "on")
QB_BLOCK_PRIVATE = os.environ.get("ED2K_QB_BLOCK_PRIVATE", "").strip().lower() in ("1", "true", "yes", "on")


_ROOTS_ENV = os.environ.get("ED2K_ROOTS", "").strip()
if not _ROOTS_ENV:
    _ROOTS_ENV = "/host" if os.path.isdir("/host") else os.path.abspath(os.sep)
ROOTS = []
for _item in _ROOTS_ENV.split(os.pathsep):
    _item = _item.strip()
    if not _item:
        continue
    try:
        _root = os.path.abspath(os.path.realpath(_item))
    except (OSError, ValueError):
        continue
    if os.path.isdir(_root) and _root not in ROOTS:
        ROOTS.append(_root)
ROOTS = ROOTS or [os.path.abspath(os.sep)]
MAX_SERVER_FILES = 20000


PASSWORD = os.environ.get("ED2K_PASSWORD", "")
SESSION_FILE = os.path.join(DATA_DIR, "sessions.json")
COOKIE_NAME = "ed2k_session"
REMEMBER_SECONDS = 30 * 86400
SESSION_SECONDS = 12 * 3600
LOGIN_MAX_FAILS = 5
LOGIN_WINDOW = 600

_sessions = {}
_sessions_lock = threading.Lock()
_login_state = {}
_login_lock = threading.Lock()
_reveal_state = {}
_reveal_lock = threading.Lock()


PUBLIC_STATIC = {"/login", "/style.css", "/logo.svg", "/favicon.ico", "/theme-init.js", "/login.js"}

MAX_CHUNK = 32 * 1024 * 1024
MAX_JSON_BODY = 2 * 1024 * 1024
MAX_TORRENT_BODY = 64 * 1024 * 1024
JOB_KEEP = 20


MODULES = ("ed2k", "make", "parse")


def _normalize_module(value):
    text = str(value or "").strip().lower()
    return text if text in MODULES else "ed2k"


def _is_hex32(value):
    return bool(re.fullmatch(r"[0-9a-f]{32}", str(value or "")))


TRACKER_LIST_URL = os.environ.get(
    "ED2K_TRACKER_URL", "https://trackerslist.com/all.txt"
).strip()
TRACKER_CACHE_SECONDS = max(60, int(os.environ.get("ED2K_TRACKER_TTL", "21600")))
TRACKER_MAX_BYTES = 512 * 1024
TRACKER_TIMEOUT = max(3, int(os.environ.get("ED2K_TRACKER_TIMEOUT", "12")))
_tracker_cache = {"time": 0, "trackers": [], "fetched": 0}
_tracker_lock = threading.Lock()

_lock = threading.RLock()
_files = {}
_jobs = {}
_history = []
_rev = 0
HISTORY_LIMIT = max(20, int(os.environ.get("ED2K_HISTORY_LIMIT", "300")))

hash_pool = ThreadPoolExecutor(max_workers=HASH_WORKERS, thread_name_prefix="ed2k-hash")
torrent_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="torrent")


class ApiError(Exception):
    def __init__(self, message, status=400, extra=None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


def _token_key(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _load_sessions():
    try:
        with open(SESSION_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return
    now = time.time()
    with _sessions_lock:
        for token, item in data.items():
            if not isinstance(item, dict) or item.get("exp", 0) <= now:
                continue
            if item.get("hashed"):
                key = token
            else:
                key = _token_key(token)
                item["hashed"] = True
            _sessions[key] = item


def _save_sessions():
    payload = {}
    with _sessions_lock:
        now = time.time()
        for token, item in list(_sessions.items()):
            if item.get("exp", 0) > now:
                item["hashed"] = True
                payload[token] = item
            else:
                _sessions.pop(token, None)
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = SESSION_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, SESSION_FILE)
    except OSError:
        pass


def _within_roots(path):
    if not path:
        return False
    try:
        real = os.path.realpath(path)
    except (OSError, ValueError):
        return False
    for root in ROOTS:
        if real == root or real.startswith(root.rstrip(os.sep) + os.sep):
            return True
    return False


def _blob_id(record):
    return str(record.get("blob") or record["id"])


def _file_path(record):
    if record.get("source") == "server":
        return record.get("path") or ""
    return os.path.join(BLOB_DIR, _blob_id(record) + ".bin")


def _bump():
    global _rev
    _rev += 1


_index_event = threading.Event()
_index_writer_lock = threading.Lock()
_index_writer_started = False


def _index_snapshot():
    with _lock:
        return {
            "version": 1,
            "files": copy.deepcopy(list(_files.values())),
            "history": copy.deepcopy(_history),
        }


def _index_writer_loop():
    while True:
        _index_event.wait()
        _index_event.clear()

        time.sleep(0.15)
        _write_index(_index_snapshot())


def _ensure_index_writer():
    global _index_writer_started
    if _index_writer_started:
        return
    with _index_writer_lock:
        if _index_writer_started:
            return
        threading.Thread(target=_index_writer_loop, name="index-writer", daemon=True).start()
        _index_writer_started = True


def _flush_index():
    _write_index(_index_snapshot())


atexit.register(_flush_index)


def _save_index_locked():
    _ensure_index_writer()
    _index_event.set()


def _write_index(payload):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = INDEX_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp, INDEX_FILE)
        return True
    except OSError as exc:
        print("[warn] 无法保存索引: %s" % exc, flush=True)


def _load_index():
    try:
        with open(INDEX_FILE, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return

    records = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        records = []
    history = payload.get("history") if isinstance(payload, dict) else None

    with _lock:
        _load_history(history if isinstance(history, list) else [])
        for raw in records:
            if not isinstance(raw, dict) or not raw.get("id"):
                continue
            fid = str(raw["id"])
            if not _is_hex32(fid):
                continue
            source = "server" if raw.get("source") == "server" else "upload"
            stored_blob = ""
            if source == "server":
                stored = str(raw.get("path") or "")
                if not stored or not os.path.isfile(stored):
                    continue
            else:
                blob = str(raw.get("blob") or fid)
                if not _is_hex32(blob):
                    blob = fid
                stored_blob = blob
                stored = os.path.join(BLOB_DIR, blob + ".bin")
                if not os.path.isfile(stored):
                    continue
            size = int(raw.get("size") or 0)
            actual = os.path.getsize(stored)
            if size <= 0:
                continue
            complete = bool(raw.get("complete")) and actual == size
            ed2k = raw.get("ed2k") if isinstance(raw.get("ed2k"), dict) else {}
            ed2k.setdefault("status", "idle")
            ed2k.setdefault("progress", 0)
            ed2k.setdefault("hash", "")
            ed2k.setdefault("link", "")
            ed2k.setdefault("error", "")
            if ed2k["status"] in ("running", "queued"):
                ed2k["status"] = "idle"
                ed2k["progress"] = 0
            name = str(raw.get("name") or "file")
            if ed2k.get("hash"):
                ed2k["link"] = make_ed2k_link(name, size, ed2k["hash"])
            _files[fid] = {
                "id": fid,
                "name": name,
                "rel_path": str(raw.get("rel_path") or raw.get("name") or "file"),
                "size": size,
                "uploaded": min(actual, size),
                "complete": complete,
                "created": float(raw.get("created") or time.time()),
                "fingerprint": str(raw.get("fingerprint") or ""),
                "source": source,
                "path": stored if source == "server" else "",
                "blob": stored_blob if source == "upload" else "",
                "module": _normalize_module(raw.get("module")),
                "add_mode": str(raw.get("add_mode") or ("folder" if "/" in str(raw.get("rel_path") or "") else "file")),
                "ed2k": ed2k,
            }
        _bump()


def _load_history(items):
    _history.clear()
    for raw in items[-HISTORY_LIMIT:]:
        if not isinstance(raw, dict):
            continue
        job_id = str(raw.get("id") or "")
        if not _is_hex32(job_id):
            continue
        entry = copy.deepcopy(raw)
        entry["id"] = job_id
        if entry.get("type") == "ed2k":
            entry["status"] = "done"
            entry["available"] = True
            _history.append(entry)
            continue
        result = raw.get("result")
        if not isinstance(result, dict):
            continue
        entry["type"] = "torrent"
        entry["status"] = "done"
        entry["result"] = result
        entry["available"] = os.path.isfile(os.path.join(TORRENT_DIR, job_id + ".torrent"))
        _history.append(entry)


def _public_file(record):
    public = {
        "id": record["id"],
        "name": record["name"],
        "rel_path": record["rel_path"],
        "size": record["size"],
        "uploaded": record["uploaded"],
        "complete": record["complete"],
        "created": record["created"],
        "source": record.get("source") or "upload",
        "module": _normalize_module(record.get("module")),
        "add_mode": record.get("add_mode") or ("folder" if "/" in str(record.get("rel_path") or "") else "file"),
        "ed2k": copy.deepcopy(record["ed2k"]),
    }
    if public["source"] == "server":
        public["path"] = record.get("path") or ""
    return public


def _magnet_for(result):
    name = result.get("name") or result.get("file_name") or "torrent"
    magnet = "magnet:?xt=urn:btih:%s&dn=%s" % (
        result.get("info_hash") or "",
        _magnet_name(name),
    )
    for tracker in (result.get("trackers") or [])[:30]:
        magnet += "&tr=" + quote(str(tracker), safe="")
    return magnet


def _register_ed2k_history_locked(record, link):
    key = str(record.get("fingerprint") or record["id"])
    entry = {
        "id": uuid.uuid4().hex,
        "type": "ed2k",
        "status": "done",
        "created": time.time(),
        "key": key,
        "file_id": record["id"],
        "name": record["name"],
        "size": record["size"],
        "link": link,
        "ed2k_links": [link],
        "magnet": "",
        "available": True,
    }
    _history[:] = [
        item for item in _history
        if not (item.get("type") == "ed2k" and item.get("key") == key)
    ]
    _history.append(entry)
    del _history[:-HISTORY_LIMIT]


def _register_history_locked(job, ed2k_links):
    result = copy.deepcopy(job.get("result") or {})
    if not result.get("info_hash"):
        return
    entry = {
        "id": job["id"],
        "type": "torrent",
        "status": "done",
        "progress": 100,
        "message": "种子已生成",
        "error": "",
        "result": result,
        "created": job.get("created") or time.time(),
        "source_ids": list(job.get("source_ids") or []),
        "magnet": _magnet_for(result),
        "ed2k_links": list(ed2k_links or []),
        "available": True,
    }
    _history[:] = [item for item in _history if item.get("id") != entry["id"]]
    _history.append(entry)
    del _history[:-HISTORY_LIMIT]


def _public_job(job):
    return {
        "id": job["id"],
        "type": job["type"],
        "status": job["status"],
        "progress": job.get("progress", 0),
        "message": job.get("message", ""),
        "error": job.get("error", ""),
        "result": copy.deepcopy(job.get("result")),
        "created": job.get("created", 0),
    }


def _prune_jobs_locked():
    if len(_jobs) <= JOB_KEEP:
        return
    ordered = sorted(_jobs.values(), key=lambda j: j.get("created", 0))

    history_ids = {entry.get("id") for entry in _history}
    for job in ordered[:-JOB_KEEP]:
        _jobs.pop(job["id"], None)
        if job["id"] in history_ids:
            continue
        try:
            path = os.path.join(TORRENT_DIR, job["id"] + ".torrent")
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass


QB_MAX_SERVERS = 10


def _env_qb_servers():
    url = os.environ.get("ED2K_QB_URL", "").strip()
    if not url:
        return []
    return [{
        "id": "qb1",
        "name": os.environ.get("ED2K_QB_NAME", "qB").strip() or "qB",
        "url": url,
        "username": os.environ.get("ED2K_QB_USER", "").strip(),
        "password": os.environ.get("ED2K_QB_PASS", ""),
        "local_prefix": os.environ.get("ED2K_QB_LOCAL_PREFIX", "").strip(),
        "remote_prefix": os.environ.get("ED2K_QB_REMOTE_PREFIX", "").strip(),
    }]


_settings = {
    "qb_servers": _env_qb_servers(),
    "offline115": {
        "cookie": os.environ.get("ED2K_115_COOKIE", "").strip(),
        "cookie_enc": None,
        "cookie_key": b"",
        "save_cid": os.environ.get("ED2K_115_CID", "").strip(),
    },

    "torrent_options": {
        "trackers": "",
        "piece": 0,
        "private": False,
        "embed_ed2k": True,
    },
    "torrent_options_stored": False,

    "prefs": {
        "theme": "system",
        "browse_dir": "",
        "last_torrent_job": "",
        "imported": [],
    },
    "prefs_stored": False,
}


SECRET_KDF_ITERATIONS = 390000
SECRET_MIN_PASSWORD = 8
SECRET_FIELDS = ("salt", "nonce", "ct", "tag")


def _b64e(raw):
    return base64.b64encode(raw).decode("ascii")


def _b64d(value):
    return base64.b64decode(str(value).encode("ascii"), validate=True)


def _derive_secret_key(password, salt, iterations):
    return PBKDF2(
        password.encode("utf-8"), salt,
        dkLen=32, count=iterations, hmac_hash_module=SHA256,
    )


def _encrypt_secret(plaintext, password):
    salt = get_random_bytes(16)
    nonce = get_random_bytes(12)
    key = _derive_secret_key(password, salt, SECRET_KDF_ITERATIONS)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext.encode("utf-8"))
    blob = {
        "v": 1,
        "kdf": "pbkdf2-sha256",
        "iter": SECRET_KDF_ITERATIONS,
        "salt": _b64e(salt),
        "nonce": _b64e(nonce),
        "ct": _b64e(ciphertext),
        "tag": _b64e(tag),
    }
    return blob, key


def _reencrypt_secret(plaintext, blob, key):
    nonce = get_random_bytes(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext.encode("utf-8"))
    return {
        "v": 1,
        "kdf": "pbkdf2-sha256",
        "iter": int(blob.get("iter") or SECRET_KDF_ITERATIONS),
        "salt": blob.get("salt"),
        "nonce": _b64e(nonce),
        "ct": _b64e(ciphertext),
        "tag": _b64e(tag),
    }


def _decrypt_secret(blob, password):
    try:
        salt = _b64d(blob["salt"])
        nonce = _b64d(blob["nonce"])
        ciphertext = _b64d(blob["ct"])
        tag = _b64d(blob["tag"])
        iterations = int(blob.get("iter") or SECRET_KDF_ITERATIONS)
        key = _derive_secret_key(password, salt, iterations)
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        plaintext = cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8")
    except (KeyError, TypeError, ValueError, UnicodeDecodeError):
        raise ApiError("解密失败，加密密码不正确", 400)
    return plaintext, key


def _valid_secret_blob(blob):
    return isinstance(blob, dict) and all(
        isinstance(blob.get(field), str) and blob[field] for field in SECRET_FIELDS
    )


def _normalize_qb_server(raw, fallback_password=""):
    server = {
        "id": str(raw.get("id") or "").strip(),
        "name": str(raw.get("name") or "").strip() or "qB",
        "url": str(raw.get("url") or "").strip().rstrip("/"),
        "username": str(raw.get("username") or "").strip(),
        "password": str(raw.get("password") or "") or fallback_password,
        "local_prefix": str(raw.get("local_prefix") or "").strip(),
        "remote_prefix": str(raw.get("remote_prefix") or "").strip(),

        "last_savepath": str(raw.get("last_savepath") or "").strip(),
    }
    if server["url"] and not re.match(r"^https?://", server["url"], re.I):
        raise ApiError("qBittorrent 地址必须以 http:// 或 https:// 开头", 400)
    if server["url"]:
        _validate_qb_target(server["url"])
    return server


def _normalize_torrent_options(raw):
    data = raw if isinstance(raw, dict) else {}
    trackers = data.get("trackers")
    if not isinstance(trackers, str):
        trackers = ""
    return {
        "trackers": trackers.strip()[:20000],
        "piece": supported_piece_size(data.get("piece")),
        "private": bool(data.get("private")),

        "embed_ed2k": bool(data.get("embed_ed2k", True)),
    }


def _normalize_prefs(raw):
    data = raw if isinstance(raw, dict) else {}
    theme = str(data.get("theme") or "system").strip().lower()
    if theme not in ("system", "light", "dark"):
        theme = "system"
    browse_dir = str(data.get("browse_dir") or "").strip()[:4096]
    job_id = str(data.get("last_torrent_job") or "").strip()
    if not _is_hex32(job_id):
        job_id = ""
    imported = []
    raw_imported = data.get("imported")
    if isinstance(raw_imported, list):
        for item in raw_imported[:800]:
            if not isinstance(item, dict):
                continue
            link = str(item.get("link") or "").strip()
            if not link.startswith("ed2k://"):
                continue
            try:
                size = max(0, int(item.get("size") or 0))
            except (TypeError, ValueError):
                size = 0
            imported.append({
                "name": str(item.get("name") or "")[:500],
                "size": size,
                "hash": str(item.get("hash") or "")[:64],
                "link": link[:4096],
            })
    return {
        "theme": theme,
        "browse_dir": browse_dir,
        "last_torrent_job": job_id,
        "imported": imported,
    }


def _load_settings():
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return
    if not isinstance(data, dict):
        return
    with _lock:
        stored_servers = data.get("qb_servers")
        if isinstance(stored_servers, list):
            servers = []
            for raw in stored_servers[:QB_MAX_SERVERS]:
                if not isinstance(raw, dict):
                    continue
                try:
                    servers.append(_normalize_qb_server(raw))
                except ApiError:
                    continue
            _settings["qb_servers"] = servers
        else:
            legacy = data.get("qb")
            if isinstance(legacy, dict) and str(legacy.get("url") or "").strip():
                try:
                    server = _normalize_qb_server(legacy)
                except ApiError:
                    server = None
                if server:
                    server["id"] = "qb1"
                    _settings["qb_servers"] = [server]
        stored = data.get("offline115")
        if isinstance(stored, dict):
            target = _settings["offline115"]
            enc = stored.get("cookie_enc")
            if _valid_secret_blob(enc):
                target["cookie_enc"] = enc

                target["cookie"] = ""
                target["cookie_key"] = b""
            legacy_cookie = stored.get("cookie")
            if isinstance(legacy_cookie, str) and legacy_cookie.strip():
                target["cookie"] = legacy_cookie.strip()
            if isinstance(stored.get("save_cid"), str):
                target["save_cid"] = stored["save_cid"].strip()
        stored_options = data.get("torrent_options")
        if isinstance(stored_options, dict):
            _settings["torrent_options"] = _normalize_torrent_options(stored_options)
            _settings["torrent_options_stored"] = True
        stored_prefs = data.get("prefs")
        if isinstance(stored_prefs, dict):
            _settings["prefs"] = _normalize_prefs(stored_prefs)
            _settings["prefs_stored"] = True


def _save_settings():
    with _lock:
        payload = copy.deepcopy(_settings)
        offline = payload["offline115"]
        offline.pop("cookie_key", None)
        encrypted = offline.pop("cookie_enc", None)
        plaintext = offline.pop("cookie", "")
        if encrypted:
            offline["cookie_enc"] = encrypted
        elif plaintext:
            offline["cookie"] = plaintext
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, SETTINGS_FILE)
    except OSError:
        raise ApiError("保存推送设置失败，请检查数据目录权限", 500)


def _public_integrations():
    with _lock:
        servers = copy.deepcopy(_settings["qb_servers"])
        offline = copy.deepcopy(_settings["offline115"])
    return {
        "qb_servers": [{
            "id": item["id"],
            "name": item["name"],
            "url": item.get("url", ""),
            "username": item.get("username", ""),
            "has_password": bool(item.get("password")),
            "local_prefix": item.get("local_prefix", ""),
            "remote_prefix": item.get("remote_prefix", ""),
        } for item in servers],
        "offline115": {
            "has_cookie": bool(offline.get("cookie") or offline.get("cookie_enc")),
            "cookie": "",
            "cookie_locked": bool(offline.get("cookie_enc")) and not offline.get("cookie"),
            "cookie_encrypted": bool(offline.get("cookie_enc")),
            "cookie_unencrypted": bool(offline.get("cookie")) and not offline.get("cookie_enc"),
            "cookie_length": len(offline.get("cookie", "")),
            "save_cid": offline.get("save_cid", ""),
        },
    }


def _update_integrations(payload):
    raw_servers = payload.get("qb_servers")
    if isinstance(raw_servers, list):
        with _lock:
            existing = {item["id"]: item for item in _settings["qb_servers"]}
        incoming = []
        for raw in raw_servers[:QB_MAX_SERVERS]:
            if not isinstance(raw, dict):
                continue
            url = str(raw.get("url") or "").strip().rstrip("/")
            if not url:
                continue
            server_id = str(raw.get("id") or "").strip()
            if not server_id or server_id not in existing:
                server_id = uuid.uuid4().hex[:8]
            fallback = existing[server_id]["password"] if server_id in existing else ""
            server = _normalize_qb_server(raw, fallback_password=fallback)
            server["id"] = server_id

            if server_id in existing:
                server["last_savepath"] = existing[server_id].get("last_savepath", "")
            incoming.append(server)
        with _lock:
            _settings["qb_servers"] = incoming
    offline = payload.get("offline115")
    if isinstance(offline, dict):
        raw_password = offline.get("cookie_password")
        password = raw_password.strip() if isinstance(raw_password, str) else ""
        raw_cookie = offline.get("cookie")
        new_cookie = raw_cookie.strip() if isinstance(raw_cookie, str) else ""
        with _lock:
            target = _settings["offline115"]
            enc = target.get("cookie_enc")
            current = str(target.get("cookie") or "").strip()
            key = target.get("cookie_key") or b""
            if offline.get("clear_cookie"):
                target["cookie"] = ""
                target["cookie_enc"] = None
                target["cookie_key"] = b""
            elif password or new_cookie:
                if password and len(password) < SECRET_MIN_PASSWORD:
                    raise ApiError("加密密码至少需要 %d 位" % SECRET_MIN_PASSWORD, 400)
                if new_cookie:
                    plaintext = new_cookie
                elif current:
                    plaintext = current
                elif enc and password:
                    plaintext, key = _decrypt_secret(enc, password)
                else:
                    raise ApiError("请先粘贴 115 Cookie，再设置加密密码", 400)
                if password:
                    blob, key = _encrypt_secret(plaintext, password)
                elif key and _valid_secret_blob(enc):
                    blob = _reencrypt_secret(plaintext, enc, key)
                else:
                    raise ApiError("115 Cookie 需要设置加密密码后才能保存", 400)
                target["cookie"] = plaintext
                target["cookie_enc"] = blob
                target["cookie_key"] = key
            if "save_cid" in offline:
                target["save_cid"] = _normalize_115_cid(offline.get("save_cid"))
    _save_settings()
    return _public_integrations()


def _unlock_115_integrations(payload):
    password = payload.get("password")
    password = password.strip() if isinstance(password, str) else ""
    if not password:
        raise ApiError("请输入加密密码", 400)
    with _lock:
        blob = _settings["offline115"].get("cookie_enc")
    if not _valid_secret_blob(blob):
        raise ApiError("尚未保存加密的 115 Cookie", 400)
    plaintext, key = _decrypt_secret(blob, password)
    with _lock:
        _settings["offline115"]["cookie"] = plaintext
        _settings["offline115"]["cookie_key"] = key
    return _public_integrations()


def _reveal_115_cookie(payload, ip=""):
    now = time.time()
    with _reveal_lock:
        history = [t for t in _reveal_state.get(ip, []) if now - t < LOGIN_WINDOW]
        _reveal_state[ip] = history
        if len(history) >= LOGIN_MAX_FAILS:
            raise ApiError("密码尝试次数过多，请 10 分钟后再试", 429)
    password = payload.get("password")
    password = password.strip() if isinstance(password, str) else ""
    if not password:
        raise ApiError("请输入加密密码", 400)
    with _lock:
        offline = copy.deepcopy(_settings["offline115"])
    blob = offline.get("cookie_enc")
    if not _valid_secret_blob(blob):
        raise ApiError("Cookie 尚未加密保存，请先设置加密密码并保存", 400)
    try:
        plaintext, _ = _decrypt_secret(blob, password)
    except ApiError:
        plaintext = ""
    if not plaintext:
        with _reveal_lock:
            _reveal_state.setdefault(ip, []).append(time.time())
        time.sleep(0.3)
        raise ApiError("解密失败，加密密码不正确", 400)
    with _reveal_lock:
        _reveal_state.pop(ip, None)
    return {"cookie": plaintext}


def _qb_config(server_id=None):
    with _lock:
        servers = copy.deepcopy(_settings["qb_servers"])
    sid = str(server_id or "").strip()
    server = None
    if sid:
        server = next((item for item in servers if item["id"] == sid), None)
    elif len(servers) == 1:
        server = servers[0]
    if server is None:
        if not servers:
            raise ApiError("未配置 qBittorrent 服务器，请先在「设置」中添加", 400)
        raise ApiError("请指定要推送的 qBittorrent 服务器", 400)
    url = str(server.get("url") or "").strip().rstrip("/")
    if not url:
        raise ApiError("qBittorrent 服务器地址为空，请在「设置」中填写", 400)
    if not re.match(r"^https?://", url, re.I):
        raise ApiError("qBittorrent 地址必须以 http:// 或 https:// 开头", 400)
    return server, url


def _validate_qb_target(url):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ApiError("qBittorrent 地址无效", 400)
    host = parsed.hostname.lower()
    if host in ("metadata.google.internal", "metadata"):
        raise ApiError("不允许访问云元数据地址", 400)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
            raise ApiError("不允许访问该 qBittorrent 地址", 400)
        if QB_BLOCK_PRIVATE and (ip.is_private or ip.is_loopback):
            raise ApiError("已禁止访问内网 qBittorrent 地址（ED2K_QB_BLOCK_PRIVATE）", 400)


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_qb_target(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _qb_login(url, username, password):
    _validate_qb_target(url)
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar), _SafeRedirectHandler()
    )
    body = urlencode({"username": username, "password": password}).encode("utf-8")
    request = urllib.request.Request(
        url + "/api/v2/auth/login",
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": url,
            "User-Agent": "LinkSeed",
        },
        method="POST",
    )
    try:
        with opener.open(request, timeout=15) as response:
            text = response.read(2048).decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as exc:
        raise ApiError("qBittorrent 登录失败（HTTP %s）" % exc.code, 502)
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError("无法连接 qBittorrent：%s" % exc, 502)
    if text != "Ok.":
        raise ApiError("qBittorrent 登录失败，请检查用户名和密码", 401)
    return opener


def _qb_add_torrent(opener, url, torrent_bytes, filename, savepath, skip_checking, paused):
    boundary = "----ed2kstudio" + uuid.uuid4().hex
    fields = {
        "savepath": savepath,
        "skip_checking": "true" if skip_checking else "false",
        "paused": "true" if paused else "false",
        "stopped": "true" if paused else "false",
        "autoTMM": "false",
    }
    chunks = []
    for name, value in fields.items():
        chunks.append(
            ("--" + boundary + "\r\n"
             'Content-Disposition: form-data; name="' + name + '"\r\n\r\n'
             + value + "\r\n").encode("utf-8")
        )
    chunks.append(
        ("--" + boundary + "\r\n"
         'Content-Disposition: form-data; name="torrents"; filename="' + filename + '"\r\n'
         "Content-Type: application/x-bittorrent\r\n\r\n").encode("utf-8")
    )
    chunks.append(torrent_bytes)
    chunks.append(("\r\n--" + boundary + "--\r\n").encode("utf-8"))
    request = urllib.request.Request(
        url + "/api/v2/torrents/add",
        data=b"".join(chunks),
        headers={
            "Content-Type": "multipart/form-data; boundary=" + boundary,
            "Referer": url,
            "User-Agent": "ED2K-Studio",
        },
        method="POST",
    )
    try:
        with opener.open(request, timeout=60) as response:
            status = response.status
            text = response.read(2048).decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as exc:
        try:
            text = exc.read(2048).decode("utf-8", "replace").strip()
        except Exception:
            text = ""
        raise ApiError("qBittorrent 添加种子失败（HTTP %s）%s" % (exc.code, ("：" + text[:160]) if text else ""), 502)
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError("无法连接 qBittorrent：%s" % exc, 502)
    if status >= 400 or text.lower() not in ("ok.", "ok", ""):
        raise ApiError("qBittorrent 添加种子失败：%s" % (text[:160] or "未知错误"), 502)


def _map_qb_path(local_path, server=None):
    if server is None:
        server, _ = _qb_config()
    local_prefix = str(server.get("local_prefix") or "").strip()
    remote_prefix = str(server.get("remote_prefix") or "").strip()
    if not local_prefix:
        return remote_prefix or local_path
    if not remote_prefix:
        raise ApiError("已填写本工具路径前缀，但未填写 qBittorrent 路径前缀", 400)
    if os.name != "nt" and re.match(r"^[A-Za-z]:[\\/]", local_prefix):
        raise ApiError(
            "「本工具路径前缀」应填写容器/NAS 内的路径（例如 /downloads），"
            "不能填写 Windows 路径（%s）；Windows 的 qB 路径请填到「qBittorrent 路径前缀」" % local_prefix,
            400,
        )
    normalized = os.path.realpath(local_path).replace("\\", "/")
    local_norm = os.path.realpath(local_prefix).replace("\\", "/").rstrip("/")
    if normalized != local_norm and not normalized.startswith(local_norm + "/"):
        raise ApiError("做种路径不在映射范围内：%s，请检查该 qBittorrent 服务器的路径映射" % local_path, 400)
    tail = normalized[len(local_norm):]
    remote = remote_prefix.rstrip("/\\")
    if re.match(r"^[A-Za-z]:[\\/]", remote_prefix) or "\\" in remote_prefix:
        return remote + tail.replace("/", "\\")
    return remote + tail


def _test_qb_server(payload):
    server_id = str(payload.get("server_id") or "").strip()
    raw = payload.get("server") if isinstance(payload.get("server"), dict) else {}
    with _lock:
        servers = copy.deepcopy(_settings["qb_servers"])
    existing = next((item for item in servers if item["id"] == server_id), None)
    merged = dict(existing or {})
    for key in ("url", "username", "password", "local_prefix", "remote_prefix"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            merged[key] = value.strip()
    url = str(merged.get("url") or "").strip().rstrip("/")
    if not url:
        raise ApiError("请填写 qBittorrent 地址", 400)
    if not re.match(r"^https?://", url, re.I):
        raise ApiError("qBittorrent 地址必须以 http:// 或 https:// 开头", 400)
    opener = _qb_login(url, merged.get("username", ""), merged.get("password", ""))
    version = ""
    save_path = ""
    try:
        request = urllib.request.Request(
            url + "/api/v2/app/version",
            headers={"Referer": url, "User-Agent": "ED2K-Studio"},
        )
        with opener.open(request, timeout=15) as response:
            version = response.read(128).decode("utf-8", "replace").strip()
        request = urllib.request.Request(
            url + "/api/v2/app/preferences",
            headers={"Referer": url, "User-Agent": "ED2K-Studio"},
        )
        with opener.open(request, timeout=15) as response:
            preferences = json.loads(response.read(65536).decode("utf-8", "replace"))
        if isinstance(preferences, dict):
            save_path = str(preferences.get("save_path") or "")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print("[warn] qB 测试读取信息失败: %s" % exc, flush=True)
    return {
        "ok": True,
        "version": version,
        "save_path": save_path,
        "message": "连接成功" + ("（qB " + version + "）" if version else ""),
    }


def _get_done_job(job_id):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            job = next((item for item in _history if item.get("id") == job_id), None)
        if not job:
            raise ApiError("种子任务不存在或已过期", 404)
        if job.get("status") != "done" or not job.get("result"):
            raise ApiError("种子尚未生成完成，无法推送", 400)
        return copy.deepcopy(job)


def _job_source_records(job):
    ids = list(job.get("source_ids") or [])
    if not ids:
        raise ApiError("该种子没有记录源文件，请重新生成", 400)
    with _lock:
        records = [copy.deepcopy(_files[fid]) for fid in ids if fid in _files]
    if len(records) != len(ids):
        raise ApiError("部分源文件已被删除，无法推送到 qBittorrent；请重新添加并生成种子", 400)
    bad = [record for record in records if record.get("source") != "server" or not record.get("path")]
    if bad:
        raise ApiError(
            "种子包含上传文件，工具侧没有可用于映射的服务器路径；"
            "推送时请手动填写 qB 所在机器的保存路径，并确认 qB 上已有这些文件",
            400,
        )
    missing = [record["path"] for record in records if not os.path.isfile(record["path"])]
    if missing:
        raise ApiError("源文件已不在服务器磁盘上：%s" % missing[0], 400)
    return records


def _qb_default_savepath(server, url):
    try:
        opener = _qb_login(url, server.get("username", ""), server.get("password", ""))
        request = urllib.request.Request(
            url + "/api/v2/app/getPreferences",
            headers={"Referer": url, "User-Agent": "LinkSeed"},
            method="GET",
        )
        with opener.open(request, timeout=15) as response:
            prefs = json.loads(response.read().decode("utf-8", "replace"))
    except Exception:
        return ""
    if not isinstance(prefs, dict):
        return ""
    for key in ("save_path", "savePath", "download_path"):
        value = str(prefs.get(key) or "").strip()
        if value:
            return value
    return ""


def _remember_qb_savepath(server_id, savepath):
    path = str(savepath or "").strip()
    if not path or not server_id:
        return
    changed = False
    with _lock:
        for server in _settings["qb_servers"]:
            if server.get("id") != server_id:
                continue
            if server.get("last_savepath") != path:
                server["last_savepath"] = path
                changed = True
            break
    if changed:
        try:
            _save_settings()
        except ApiError:
            pass


def _records_savepath(records):
    dirs = [os.path.dirname(os.path.normpath(record["path"])) for record in records]
    if len(dirs) == 1:
        return dirs[0]
    try:
        return os.path.commonpath(dirs)
    except ValueError:
        raise ApiError("所选文件不在同一磁盘，无法确定做种目录", 400)


def _magnet_name(name):
    out = []
    for ch in str(name):
        if ch.isascii():
            out.append(ch if (ch.isalnum() or ch in "-._~") else "%%%02X" % ord(ch))
        else:
            out.append(ch)
    return "".join(out)


def _magnet_for_job(job):
    result = job["result"]
    info_hash = str(result.get("info_hash") or "")
    if not info_hash:
        raise ApiError("种子缺少 Info Hash", 400)
    name = str(result.get("name") or result.get("file_name") or "torrent")
    magnet = "magnet:?xt=urn:btih:" + info_hash + "&dn=" + _magnet_name(name)
    for tracker in (result.get("trackers") or [])[:30]:
        magnet += "&tr=" + quote(str(tracker), safe="")
    return magnet


def _normalize_115_cid(raw):
    value = str(raw or "").strip()
    if not value or value in ("云下载", "默认", "默认云下载"):
        return ""
    if value.lower() in ("根目录", "root"):
        return "0"
    match = re.search(r"\d+", value)
    return match.group(0) if match else ""


def _offline115_credentials():
    with _lock:
        cookie = str(_settings["offline115"].get("cookie") or "").strip()
        encrypted = _settings["offline115"].get("cookie_enc")
        default_cid = _settings["offline115"].get("save_cid", "")
    if cookie:
        return cookie, default_cid
    if encrypted:
        raise ApiError("115 Cookie 已加密锁定，请先在「设置」中输入加密密码解锁", 400)
    raise ApiError("未配置 115 Cookie，请先在「设置」中粘贴", 400)


def _submit_115_offline(job, save_cid):
    cookie, default_cid = _offline115_credentials()
    magnet = _magnet_for_job(job)
    cid = _normalize_115_cid(save_cid or default_cid)
    outcome = _call_115_offline(cookie, magnet, cid)
    outcome.update({"magnet": magnet, "save_cid": cid})
    return outcome


def _call_115_offline(cookie, target, cid=""):
    url = "https://115.com/web/lixian/?ct=lixian&ac=add_task_url&url=" + quote(target, safe="")
    if cid:
        url += "&wp_path_id=" + cid
    request = urllib.request.Request(
        url,
        headers={
            "Cookie": cookie,
            "Referer": "https://115.com/web/lixian/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            text = response.read(65536).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise ApiError("115 请求失败（HTTP %s），Cookie 可能已失效" % exc.code, 502)
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError("无法连接 115：%s" % exc, 502)
    try:
        data = json.loads(text)
    except ValueError:
        raise ApiError("115 返回了非 JSON 内容，Cookie 可能已失效或需要重新登录", 502)
    state = data.get("state") is True
    errno = data.get("errno")
    code = data.get("code")
    inner = data.get("data") if isinstance(data.get("data"), dict) else {}
    ok = state or errno == 0 or code == 0 or inner.get("state") is True
    message = (
        data.get("message") or data.get("msg") or data.get("error")
        or data.get("errmsg") or inner.get("errmsg") or ""
    )
    error_code = errno if isinstance(errno, (int, float)) else (code if isinstance(code, (int, float)) else None)
    raw_text = message + " " + text
    duplicate = bool(
        re.search(r"(已存在|已经存在|已添加|重复|已提交过|exist|exists|already)", raw_text, re.I)
        or data.get("exists") is True or inner.get("exists") is True
        or error_code in (911, 10008, 10009, 10010)
    )
    if duplicate:
        return {"ok": True, "duplicate": True, "message": "115 中已存在该离线任务"}
    if not ok:
        raise ApiError("115 离线推送失败：%s" % (str(message or text)[:160],), 502)
    return {"ok": True, "duplicate": False, "message": str(message or "已提交 115 离线任务")}


def _call_115_api(cookie, path, form=None, params=None):
    url = "https://webapi.115.com" + path
    if params:
        url += "?" + urlencode(params)
    data = urlencode(form).encode("utf-8") if form is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method="POST" if data is not None else "GET",
        headers={
            "Cookie": cookie,
            "Referer": "https://115.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            text = response.read(262144).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise ApiError("115 接口请求失败（HTTP %s）" % exc.code, 502)
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError("无法连接 115：%s" % exc, 502)
    try:
        return json.loads(text)
    except ValueError:
        raise ApiError("115 接口返回了非 JSON 内容，Cookie 可能已失效", 502)


def _clean_115_folder_name(name):
    value = re.sub(r"[\x00-\x1f]", "", str(name or "").replace("\\", "/")).strip().strip("/")
    if value in ("", ".", ".."):
        return ""
    return value[:120]


def _115_list_folders(cookie, parent_cid):
    payload = _call_115_api(
        cookie, "/files/list",
        params={
            "aid": 1, "cid": parent_cid or "0", "show_dir": 1,
            "limit": 1000, "offset": 0, "o": "user_ptime", "asc": 0,
        },
    )
    folders = {}
    if payload.get("state") is not True:
        raise ApiError("无法读取 115 目录，Cookie 可能已失效", 502)
    items = payload.get("data") if isinstance(payload.get("data"), list) else []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("n") or item.get("name") or "").strip()
        is_dir = item.get("is_dir")
        if is_dir is None:
            is_dir = not item.get("fid") and not item.get("sha")
        cid = item.get("cid")
        if is_dir and name and cid not in (None, "", 0):
            folders[name] = str(cid)
    return folders


def _115_create_folder(cookie, parent_cid, name):
    payload = _call_115_api(
        cookie, "/files/add",
        form={"pid": parent_cid or "0", "cname": name},
    )
    if payload.get("state") is not True:
        message = payload.get("error") or payload.get("message") or "创建文件夹失败"
        raise ApiError("115 创建文件夹失败：%s" % str(message)[:120], 502)
    cid = payload.get("cid") or payload.get("category_id")
    if not cid and isinstance(payload.get("data"), dict):
        cid = payload["data"].get("cid")
    if cid in (None, ""):
        raise ApiError("115 创建文件夹未返回目录 ID", 502)
    return str(cid)


def _resolve_115_folder(cookie, base_cid, parts, list_cache, cid_cache, created):
    current = base_cid or "0"
    for part in parts:
        name = _clean_115_folder_name(part)
        if not name:
            continue
        key = (current, name)
        if key in cid_cache:
            current = cid_cache[key]
            continue
        if current not in list_cache:
            list_cache[current] = _115_list_folders(cookie, current)
        listing = list_cache[current]
        cid = listing.get(name)
        if not cid:
            cid = _115_create_folder(cookie, current, name)
            listing[name] = cid
            created[0] += 1
        cid_cache[key] = cid
        current = cid
    return current


def _push_115_items(items, save_cid, keep_structure):
    cookie, default_cid = _offline115_credentials()
    base_cid = _normalize_115_cid(save_cid or default_cid)
    if not isinstance(items, list) or not items:
        raise ApiError("请选择要推送的链接", 400)
    if len(items) > 50:
        raise ApiError("一次最多推送 50 条 ED2K 链接，请减少选择数量", 400)
    submitted = duplicate = failed = folder_failed = 0
    created = [0]
    first_error = ""
    list_cache = {}
    cid_cache = {}
    for raw in items:
        if not isinstance(raw, dict):
            failed += 1
            continue
        link = str(raw.get("url") or "").strip()
        if not link.startswith("ed2k://|file|"):
            failed += 1
            first_error = first_error or "存在非法的 ED2K 链接"
            continue
        target_cid = base_cid
        if keep_structure:
            path = str(raw.get("path") or "")
            dirname = path.rsplit("/", 1)[0] if "/" in path else ""
            parts = [part for part in dirname.split("/") if part.strip()]
            if parts:
                try:
                    target_cid = _resolve_115_folder(
                        cookie, base_cid, parts, list_cache, cid_cache, created
                    )
                except ApiError as exc:
                    folder_failed += 1
                    first_error = first_error or str(exc)
                    target_cid = base_cid
        try:
            outcome = _call_115_offline(cookie, link, target_cid)
            if outcome.get("duplicate"):
                duplicate += 1
            else:
                submitted += 1
        except ApiError as exc:
            failed += 1
            first_error = first_error or str(exc)
        time.sleep(0.12)
    return {
        "total": len(items),
        "submitted": submitted,
        "duplicate": duplicate,
        "failed": failed,
        "folders_created": created[0],
        "folder_failed": folder_failed,
        "error": first_error,
    }


def _push_115_links(file_ids):
    cookie, default_cid = _offline115_credentials()
    with _lock:
        records = [copy.deepcopy(_files[fid]) for fid in file_ids if fid in _files]
    links = []
    for record in records:
        ed2k = record.get("ed2k") or {}
        if ed2k.get("status") == "done" and ed2k.get("link"):
            links.append(ed2k["link"])
    if not links:
        raise ApiError("选中的文件还没有生成 ED2K 链接", 400)
    if len(links) > 50:
        raise ApiError("一次最多推送 50 条 ED2K 链接，请减少选择数量", 400)
    cid = _normalize_115_cid(default_cid)
    submitted = 0
    duplicate = 0
    failed = 0
    first_error = ""
    for link in links:
        if not link.startswith("ed2k://|file|"):
            failed += 1
            first_error = first_error or "存在非法的 ED2K 链接"
            continue
        try:
            outcome = _call_115_offline(cookie, link, cid)
            if outcome.get("duplicate"):
                duplicate += 1
            else:
                submitted += 1
        except ApiError as exc:
            failed += 1
            first_error = first_error or str(exc)
        time.sleep(0.12)
    return {
        "total": len(links),
        "submitted": submitted,
        "duplicate": duplicate,
        "failed": failed,
        "error": first_error,
        "save_cid": cid,
    }


def _queue_hash(file_id, force=False):
    with _lock:
        record = _files.get(file_id)
        if not record or not record.get("complete"):
            return False
        status = record["ed2k"].get("status")
        if status in ("queued", "running"):
            return False
        if not force and status == "done":
            return False
        record["ed2k"] = {
            "status": "queued",
            "progress": 0,
            "hash": "",
            "link": "",
            "error": "",
        }
        _bump()
        _save_index_locked()
    hash_pool.submit(_hash_task, file_id)
    return True


def _hash_task(file_id):
    with _lock:
        record = _files.get(file_id)
        if not record or not record.get("complete"):
            return
        record["ed2k"]["status"] = "running"
        record["ed2k"]["progress"] = 0
        name = record["name"]
        expected_size = record["size"]
        path = _file_path(record)
        _bump()

    last_report = [0.0]

    def on_progress(done, total):
        now = time.time()
        if done < total and now - last_report[0] < 0.35:
            return
        last_report[0] = now
        pct = round((done / total * 100.0) if total else 100.0, 1)
        with _lock:
            current = _files.get(file_id)
            if not current:
                return
            current["ed2k"]["progress"] = min(pct, 99.9 if done < total else 100)
            _bump()

    try:
        digest, size = ed2k_hash(path, on_progress)
        if size != expected_size:
            raise OSError("文件大小与记录不一致")
        link = make_ed2k_link(name, size, digest)
        with _lock:
            current = _files.get(file_id)
            if current:
                current["ed2k"].update(
                    status="done", progress=100, hash=digest, link=link, error=""
                )
                _register_ed2k_history_locked(current, link)
                _bump()
                _save_index_locked()
    except Exception as exc:
        with _lock:
            current = _files.get(file_id)
            if current:
                current["ed2k"].update(
                    status="error", progress=0, error=str(exc)[:300]
                )
                _bump()
                _save_index_locked()


def _set_job_progress(job_id, done, total):
    pct = round((done / total * 100.0) if total else 0.0, 1)
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        if pct >= 100 or pct - job.get("progress", 0) >= 0.5:
            job["progress"] = min(pct, 100)
            _bump()


def _torrent_task(job_id, file_ids, options):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(status="running", progress=0, message="正在计算分块哈希")
        records = [
            copy.deepcopy(_files[fid])
            for fid in file_ids
            if fid in _files and _files[fid].get("complete")
        ]
        _bump()

    try:
        out_path = os.path.join(TORRENT_DIR, job_id + ".torrent")
        embedded = []
        if options.get("embed_ed2k", True):
            for record in records:
                ed2k = record.get("ed2k") or {}
                if ed2k.get("status") == "done" and ed2k.get("link"):
                    embedded.append(ed2k["link"])
        result = create_torrent(
            records,
            BLOB_DIR,
            out_path,
            name_hint=options.get("name", ""),
            trackers=options.get("trackers", []),
            piece_size=options.get("piece_size", 0),
            private=options.get("private", False),
            comment=options.get("comment", ""),
            embedded_links=embedded,
            progress=lambda done, total: _set_job_progress(job_id, done, total),
        )
        result["download"] = "/api/torrent/download/%s" % job_id
        with _lock:
            job = _jobs.get(job_id)
            if job:
                job.update(
                    status="done",
                    progress=100,
                    message="种子已生成",
                    result=result,
                )
                _register_history_locked(job, embedded)
                _bump()
                _prune_jobs_locked()
                _save_index_locked()
    except Exception as exc:
        with _lock:
            job = _jobs.get(job_id)
            if job:
                job.update(status="error", message="生成失败", error=str(exc)[:300])
                _bump()


def _clean_display_name(value):
    name = str(value or "").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip().strip(".")
    if not name:
        name = "file"
    return name[:200]


def _clean_rel_path(value, name):
    parts = []
    for part in str(value or "").replace("\\", "/").split("/"):
        part = re.sub(r"[\x00-\x1f\x7f]", "", part).strip()
        if part in ("", ".", ".."):
            continue
        parts.append(part[:200])
    if not parts or parts[-1] != name:
        parts.append(name)
    return "/".join(parts[-40:])


def _parse_ids(value):
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        item = str(item)
        if _is_hex32(item) and item not in result:
            result.append(item)
    return result


def _embedded_torrent_links(data, files):
    try:
        text = data.decode("utf-8", "ignore")
    except Exception:
        return []
    text = (
        text.replace("%7C", "|").replace("%7c", "|")
        .replace("&#124;", "|").replace("&#x7c;", "|").replace("&#x7C;", "|")
    )
    variants = [text]
    decoded = unquote(text, encoding="utf-8", errors="ignore")
    if decoded != text:
        variants.append(decoded)
    links = []
    seen = set()
    for variant in variants:
        for entry in parse_ed2k_text(variant, limit=500):
            key = (entry["hash"], entry["size"], entry["name"])
            if key in seen:
                continue
            seen.add(key)
            links.append(entry)
    if not links:
        return []
    by_size = {}
    for item in files or []:
        try:
            size = int(item.get("size") or 0)
        except (TypeError, ValueError):
            continue
        by_size.setdefault(size, []).append(item)

    result = []
    for entry in links:
        name = entry["name"]
        base = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        candidates = by_size.get(int(entry["size"]), [])
        in_torrent = any(
            item.get("path") == name
            or str(item.get("path") or "").endswith("/" + name)
            or str(item.get("path") or "").rsplit("/", 1)[-1] == base
            for item in candidates
        )
        item = dict(entry)
        item["in_torrent"] = in_torrent
        result.append(item)
    result.sort(key=lambda item: (not item["in_torrent"], item["name"]))
    return result


def _match_torrent_files(parsed):
    with _lock:
        candidates = [
            copy.deepcopy(record)
            for record in _files.values()
            if record.get("complete")
            and _normalize_module(record.get("module")) == "parse"
        ]

    by_size = {}
    for record in candidates:
        by_size.setdefault(record["size"], []).append(record)

    matched = []
    for item in parsed["files"]:
        path = item["path"]
        size = item["size"]
        pool = by_size.get(size, [])
        record = None
        how = None

        for candidate in pool:
            if candidate["rel_path"] == path:
                record, how = candidate, "path"
                break
        if record is None:
            suffix = "/" + path
            for candidate in pool:
                if candidate["rel_path"].endswith(suffix):
                    record, how = candidate, "path"
                    break
        if record is None:
            base = path.rsplit("/", 1)[-1]
            for candidate in pool:
                if candidate["name"] == base:
                    record, how = candidate, "name"
                    break

        entry = {
            "path": path,
            "size": size,
            "match": how,
            "file_id": record["id"] if record else "",
            "file": _public_file(record) if record else None,
        }
        matched.append(entry)
    return matched


def _public_trackers(force=False):
    now = time.time()
    with _tracker_lock:
        cached = list(_tracker_cache["trackers"])
        fetched = float(_tracker_cache["fetched"] or 0)
    if cached and not force and now - fetched < TRACKER_CACHE_SECONDS:
        return {
            "trackers": cached,
            "count": len(cached),
            "cached": True,
            "updated": int(fetched),
            "source": TRACKER_LIST_URL,
        }
    if not TRACKER_LIST_URL:
        raise ApiError("未配置公共 Tracker 列表地址", 400)

    def fallback(reason):
        return {
            "trackers": cached,
            "count": len(cached),
            "cached": True,
            "stale": True,
            "updated": int(fetched),
            "source": TRACKER_LIST_URL,
            "warning": reason,
        }

    request = urllib.request.Request(
        TRACKER_LIST_URL,
        headers={
            "User-Agent": "ED2K-Studio/1.0",
            "Accept": "text/plain,*/*",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TRACKER_TIMEOUT) as response:
            raw = response.read(TRACKER_MAX_BYTES + 1)
        trackers = normalize_trackers(raw[:TRACKER_MAX_BYTES].decode("utf-8", "ignore"))
    except Exception as exc:
        if cached:
            return fallback("更新失败，已返回缓存列表：%s" % exc)
        raise ApiError("获取公共 Tracker 列表失败：%s" % exc, 502)

    if not trackers:
        if cached:
            return fallback("公共 Tracker 列表暂无有效条目，已返回缓存列表")
        raise ApiError("公共 Tracker 列表为空", 502)

    fetched_at = time.time()
    with _tracker_lock:
        _tracker_cache["time"] = fetched_at
        _tracker_cache["trackers"] = trackers
        _tracker_cache["fetched"] = fetched_at
    return {
        "trackers": trackers,
        "count": len(trackers),
        "cached": False,
        "updated": int(fetched_at),
        "source": TRACKER_LIST_URL,
    }


def _bootstrap():
    os.makedirs(BLOB_DIR, exist_ok=True)
    os.makedirs(TORRENT_DIR, exist_ok=True)
    _load_settings()
    _load_index()
    _load_sessions()
    cutoff = time.time() - 24 * 3600
    stale = []
    with _lock:
        for fid, record in list(_files.items()):
            if record.get("complete") or float(record.get("created") or 0) > cutoff:
                continue
            _files.pop(fid, None)
            stale.append(fid)
    for fid in stale:
        try:
            os.remove(os.path.join(BLOB_DIR, fid + ".bin"))
        except OSError:
            pass
    if stale:
        _save_index_locked()
    with _lock:
        pending = [
            fid
            for fid, record in _files.items()
            if record.get("complete")
            and (not record["ed2k"].get("link") or record["ed2k"].get("status") == "idle")
        ]
    for fid in pending:
        _queue_hash(fid)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LinkSeed/1.0"
    timeout = 60


    def _common_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=()",
        )
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        )

    def _send_json(self, payload, status=200, headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._common_headers()
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, data, content_type, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self._common_headers()
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self, limit):
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ApiError("缺少 Content-Length", 411)
        try:
            length = int(raw_length)
        except ValueError:
            raise ApiError("无效的 Content-Length", 400)
        if length < 0 or length > limit:
            raise ApiError("请求体过大", 413)
        if length == 0:
            return b""
        data = self.rfile.read(length)
        if len(data) != length:
            raise ApiError("请求体不完整", 400)
        return data

    def _read_json(self, limit=MAX_JSON_BODY):
        body = self._read_body(limit)
        if not body:
            return {}
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError("无效的 JSON 请求体", 400)
        if not isinstance(payload, dict):
            raise ApiError("JSON 请求体必须是对象", 400)
        return payload

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()


    def _cookies(self):
        result = {}
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            if "=" in part:
                key, value = part.split("=", 1)
                result[key.strip()] = value.strip()
        return result

    def _session_sig(self, token):
        return hmac.new(
            PASSWORD.encode("utf-8"), token.encode("utf-8"), "sha256"
        ).hexdigest()

    def _authed(self):
        if not PASSWORD:
            return True
        token = self._cookies().get(COOKIE_NAME)
        if not token:
            return False
        with _sessions_lock:
            session = _sessions.get(_token_key(token))
            if not session:
                return False
            if not hmac.compare_digest(session.get("sig", ""), self._session_sig(token)):
                _sessions.pop(_token_key(token), None)
                need_save = True
            elif session.get("exp", 0) <= time.time():
                _sessions.pop(_token_key(token), None)
                need_save = True
            else:
                need_save = False
        if need_save:
            _save_sessions()
            return False
        return True

    def _login_allowed(self, ip):
        now = time.time()
        with _login_lock:
            history = [t for t in _login_state.get(ip, []) if now - t < LOGIN_WINDOW]
            _login_state[ip] = history
            return len(history) < LOGIN_MAX_FAILS

    def _login_fail(self, ip):
        with _login_lock:
            _login_state.setdefault(ip, []).append(time.time())

    def _login(self):
        payload = self._read_json()
        if not PASSWORD:
            return self._send_json({"ok": True, "required": False})
        ip = self.client_address[0]
        if not self._login_allowed(ip):
            return self._send_json({"error": "尝试次数过多，请 10 分钟后再试"}, 429)
        password = str(payload.get("password") or "")
        if not hmac.compare_digest(password.encode("utf-8"), PASSWORD.encode("utf-8")):
            self._login_fail(ip)
            time.sleep(0.3)
            return self._send_json({"error": "密码错误"}, 401)
        token = secrets.token_urlsafe(32)
        remember = bool(payload.get("remember"))
        ttl = REMEMBER_SECONDS if remember else SESSION_SECONDS
        with _sessions_lock:
            _sessions[_token_key(token)] = {"exp": time.time() + ttl, "sig": self._session_sig(token), "hashed": True}
        _save_sessions()
        with _login_lock:
            _login_state.pop(ip, None)
        cookie = "%s=%s; Path=/; HttpOnly; SameSite=Lax" % (COOKIE_NAME, token)
        if SECURE_COOKIE:
            cookie += "; Secure"
        if remember:
            cookie += "; Max-Age=%d" % REMEMBER_SECONDS
        return self._send_json({"ok": True}, headers={"Set-Cookie": cookie})

    def _logout(self):
        token = self._cookies().get(COOKIE_NAME)
        if token:
            with _sessions_lock:
                _sessions.pop(token, None)
            _save_sessions()
        cookie = "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % COOKIE_NAME
        return self._send_json({"ok": True}, headers={"Set-Cookie": cookie})


    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/"):
                self._handle_api(method, path, parse_qs(parsed.query))
            elif method in ("GET", "HEAD"):
                if path == "/login" and PASSWORD and self._authed():
                    return self._redirect("/")
                if path in PUBLIC_STATIC or self._authed():
                    self._serve_static(path, head=(method == "HEAD"))
                else:
                    self._redirect("/login")
            else:
                raise ApiError("Not Found", 404)
        except ApiError as exc:
            try:
                self._send_json(dict({"error": str(exc)}, **exc.extra), exc.status)
            except (BrokenPipeError, ConnectionResetError):
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            traceback.print_exc()
            try:
                self._send_json({"error": "服务器内部错误: %s" % exc}, 500)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _handle_api(self, method, path, query):
        if method == "GET" and path == "/api/health":
            return self._send_json({"ok": True, "md4": _MD4_BACKEND})

        if method == "GET" and path == "/api/auth":
            return self._send_json({"required": bool(PASSWORD), "authed": self._authed()})
        if method == "POST" and path == "/api/login":
            return self._login()
        if method == "POST" and path == "/api/logout":
            return self._logout()

        if not self._authed():
            raise ApiError("未登录", 401, {"auth_required": True})

        if method == "GET" and path == "/api/state":
            rev_param = (query.get("rev") or [""])[0]
            with _lock:
                active = any(
                    job.get("status") in ("queued", "running") for job in _jobs.values()
                )
                if rev_param and rev_param == str(_rev) and not active:
                    jobs = [
                        _public_job(job)
                        for job in sorted(_jobs.values(), key=lambda j: j.get("created", 0))
                    ][-JOB_KEEP:]
                    return self._send_json({"rev": _rev, "unchanged": True, "jobs": jobs})
                files = [
                    _public_file(record)
                    for record in sorted(_files.values(), key=lambda r: r["created"])
                ]
                jobs = [
                    _public_job(job)
                    for job in sorted(_jobs.values(), key=lambda j: j.get("created", 0))
                ][-JOB_KEEP:]
                return self._send_json({"rev": _rev, "files": files, "jobs": jobs})

        if method == "GET" and path == "/api/browse":
            return self._browse(query)

        if method == "GET" and path == "/api/torrent/raw":
            return self._raw_torrent(query)

        if method == "GET" and path == "/api/trackers":
            force = str((query.get("refresh") or ["0"])[0]).lower() in ("1", "true", "yes")
            return self._send_json(_public_trackers(force))

        if method == "POST" and path == "/api/add-path":
            return self._add_paths()

        if method == "POST" and path == "/api/uploads/init":
            return self._init_upload()

        match = re.fullmatch(r"/api/uploads/([0-9a-f]{32})/chunk", path)
        if method == "PUT" and match:
            return self._upload_chunk(match.group(1), query)

        match = re.fullmatch(r"/api/uploads/([0-9a-f]{32})/complete", path)
        if method == "POST" and match:
            return self._complete_upload(match.group(1))

        if method == "DELETE" and path == "/api/files":
            return self._delete_files()

        if method == "POST" and path == "/api/history/promote":
            return self._promote_history()

        if method == "GET" and path == "/api/history":
            return self._history_list()

        if method == "POST" and path == "/api/history/delete":
            return self._delete_history()

        if method == "POST" and path == "/api/ed2k/hash":
            return self._hash_files()

        if method == "POST" and path == "/api/ed2k/parse":
            payload = self._read_json()
            links = parse_ed2k_text(str(payload.get("text") or ""))
            return self._send_json({"links": links, "count": len(links)})

        if method == "GET" and path == "/api/integrations":
            return self._send_json(_public_integrations())
        if method == "GET" and path == "/api/torrent/options":
            return self._get_torrent_options()
        if method == "POST" and path == "/api/torrent/options":
            return self._update_torrent_options()
        if method == "GET" and path == "/api/prefs":
            return self._get_prefs()
        if method == "POST" and path == "/api/prefs":
            return self._update_prefs()
        if method == "POST" and path == "/api/integrations":
            return self._send_json(_update_integrations(self._read_json()))
        if method == "POST" and path == "/api/integrations/unlock":
            return self._send_json(_unlock_115_integrations(self._read_json()))
        if method == "POST" and path == "/api/integrations/reveal":
            return self._send_json(_reveal_115_cookie(self._read_json(), self.client_address[0]))

        if method == "POST" and path == "/api/qb/prepare":
            return self._prepare_qb()
        if method == "POST" and path == "/api/qb/test":
            return self._send_json(_test_qb_server(self._read_json()))
        if method == "POST" and path == "/api/qb/push":
            return self._push_qb()
        if method == "POST" and path == "/api/qb/push-torrent":
            return self._push_qb_torrent()
        if method == "POST" and path == "/api/115/push":
            return self._push_115()
        if method == "POST" and path == "/api/115/push-links":
            return self._push_115_links_api()
        if method == "POST" and path == "/api/115/push-items":
            return self._push_115_items_api()

        if method == "POST" and path == "/api/torrent/create":
            return self._create_torrent()

        if method == "POST" and path == "/api/torrent/estimate":
            return self._estimate_torrent()

        if method == "POST" and path == "/api/torrent/parse":
            return self._parse_torrent(query)

        if method == "POST" and path == "/api/torrent/edit":
            return self._edit_torrent()

        match = re.fullmatch(r"/api/torrent/download/([0-9a-f]{32})", path)
        if method == "GET" and match:
            return self._download_torrent(match.group(1))

        raise ApiError("接口不存在", 404)


    def _raw_torrent(self, query):
        raw = (query.get("path") or [""])[0].strip()
        if not raw:
            raise ApiError("缺少文件路径", 400)
        path = os.path.realpath(raw)
        if not _within_roots(path) or not os.path.isfile(path):
            raise ApiError("文件不存在或不在允许范围内", 404)
        if not path.lower().endswith(".torrent"):
            raise ApiError("只能读取 .torrent 文件", 400)
        if os.path.getsize(path) > MAX_TORRENT_BODY:
            raise ApiError("种子文件过大", 400)
        with open(path, "rb") as fh:
            data = fh.read()
        return self._send_bytes(
            data,
            "application/x-bittorrent",
            extra={"Cache-Control": "no-store"},
        )

    def _browse(self, query):
        raw = (query.get("path") or [""])[0].strip()
        path = ROOTS[0] if not raw else os.path.realpath(raw)
        if not _within_roots(path):
            raise ApiError("目录不在允许范围内", 403)
        if not os.path.isdir(path):
            raise ApiError("目录不存在或无法访问", 404)

        dirs = []
        files = []
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    name = entry.name
                    if name.startswith("."):
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            dirs.append({"name": name, "path": entry.path})
                        elif entry.is_file(follow_symlinks=False):
                            files.append({
                                "name": name,
                                "path": entry.path,
                                "size": entry.stat(follow_symlinks=False).st_size,
                            })
                    except OSError:
                        continue
        except OSError as exc:
            raise ApiError("无法读取目录: %s" % exc, 400)

        dirs.sort(key=lambda item: item["name"].lower())
        files.sort(key=lambda item: item["name"].lower())
        parent = os.path.dirname(path)
        if not parent or parent == path or not _within_roots(parent):
            parent = ""

        return self._send_json({
            "path": path,
            "parent": parent,
            "roots": ROOTS,
            "dirs": dirs,
            "files": files,
        })

    def _add_paths(self):
        payload = self._read_json()
        module = _normalize_module(payload.get("module"))
        raw_paths = payload.get("paths")
        if isinstance(raw_paths, str):
            raw_paths = [raw_paths]
        if not isinstance(raw_paths, list) or not raw_paths:
            raise ApiError("请选择文件或文件夹", 400)

        candidates = []
        missing = []
        truncated = False
        for raw in raw_paths[:50]:
            target = os.path.realpath(str(raw or ""))
            if not _within_roots(target):
                raise ApiError("路径不在允许范围内: %s" % raw, 403)
            if not os.path.exists(target):
                missing.append(str(raw))
                continue
            if os.path.isdir(target):
                base = os.path.dirname(target)
                if not _within_roots(base):
                    base = target
                for current, dirnames, filenames in os.walk(target):
                    dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
                    for name in sorted(filenames):
                        if name.startswith("."):
                            continue
                        full = os.path.join(current, name)
                        if not os.path.isfile(full):
                            continue
                        candidates.append((full, os.path.relpath(full, base), "folder"))
                        if len(candidates) >= MAX_SERVER_FILES:
                            truncated = True
                            break
                    if truncated:
                        break
            elif os.path.isfile(target):
                candidates.append((target, os.path.basename(target), "file"))
            if truncated:
                break

        added = 0
        skipped = 0
        new_ids = []
        with _lock:
            known_all = {}
            for record in _files.values():
                if record.get("source") != "server" or not record.get("path"):
                    continue
                known_all.setdefault(record["path"], record)
            for full, rel, add_mode in candidates:
                try:
                    real = os.path.realpath(full)
                    stat = os.stat(real)
                except OSError:
                    skipped += 1
                    continue
                if not _within_roots(real):
                    skipped += 1
                    continue
                if stat.st_size <= 0 or (MAX_FILE_SIZE and stat.st_size > MAX_FILE_SIZE):
                    skipped += 1
                    continue
                existing = known_all.get(real)
                if existing:
                    if _normalize_module(existing.get("module")) == module:
                        skipped += 1
                        continue

                    name = _clean_display_name(os.path.basename(real))
                    file_id = uuid.uuid4().hex
                    _files[file_id] = {
                        "id": file_id,
                        "name": name,
                        "rel_path": _clean_rel_path(rel, name),
                        "size": existing["size"],
                        "uploaded": existing["size"],
                        "complete": True,
                        "created": time.time(),
                        "fingerprint": existing.get("fingerprint", ""),
                        "source": "server",
                        "path": real,
                        "module": module,
                        "add_mode": add_mode,
                        "ed2k": copy.deepcopy(existing["ed2k"]),
                    }
                    if existing["ed2k"].get("status") != "done":
                        new_ids.append(file_id)
                    added += 1
                    continue
                name = _clean_display_name(os.path.basename(real))
                file_id = uuid.uuid4().hex
                _files[file_id] = {
                    "id": file_id,
                    "name": name,
                    "rel_path": _clean_rel_path(rel, name),
                    "size": stat.st_size,
                    "uploaded": stat.st_size,
                    "complete": True,
                    "created": time.time(),
                    "fingerprint": "server|%s|%d|%d" % (real, stat.st_size, int(stat.st_mtime)),
                    "source": "server",
                    "path": real,
                    "module": module,
                    "add_mode": add_mode,
                    "ed2k": {
                        "status": "idle",
                        "progress": 0,
                        "hash": "",
                        "link": "",
                        "error": "",
                    },
                }
                known_all[real] = _files[file_id]
                new_ids.append(file_id)
                added += 1
            if added:
                _bump()
                _save_index_locked()

        for file_id in new_ids:
            _queue_hash(file_id)

        return self._send_json({
            "added": added,
            "skipped": skipped,
            "missing": missing,
            "truncated": truncated,
        })


    def _init_upload(self):
        payload = self._read_json()
        module = _normalize_module(payload.get("module"))
        name = _clean_display_name(payload.get("name") or "file")
        rel_path = _clean_rel_path(payload.get("rel_path") or name, name)
        try:
            size = int(payload.get("size") or 0)
            mtime = int(float(payload.get("mtime") or 0))
        except (TypeError, ValueError):
            raise ApiError("文件大小无效", 400)
        if size <= 0:
            raise ApiError("空文件无需上传", 400)
        if MAX_FILE_SIZE and size > MAX_FILE_SIZE:
            raise ApiError("文件超过大小限制", 413)

        fingerprint = "%s|%d|%d" % (rel_path, size, mtime)
        add_mode = "folder" if "/" in rel_path else "file"
        with _lock:
            same_module = None
            shared = None
            for record in _files.values():
                if record.get("fingerprint") != fingerprint or record["size"] != size:
                    continue
                if _normalize_module(record.get("module")) == module:
                    same_module = same_module or record
                elif record.get("complete"):
                    shared = shared or record
            if same_module:
                record = same_module
                if record.get("complete"):
                    return self._send_json({
                        "id": record["id"],
                        "offset": record["size"],
                        "complete": True,
                        "name": record["name"],
                        "rel_path": record["rel_path"],
                    })
                actual = 0
                blob = _file_path(record)
                if os.path.isfile(blob):
                    actual = min(os.path.getsize(blob), size)
                    record["uploaded"] = actual
                return self._send_json({
                    "id": record["id"],
                    "offset": actual,
                    "complete": False,
                    "name": record["name"],
                    "rel_path": record["rel_path"],
                })


            if shared and shared.get("complete"):
                file_id = uuid.uuid4().hex
                _files[file_id] = {
                    "id": file_id,
                    "name": shared["name"],
                    "rel_path": shared["rel_path"],
                    "size": shared["size"],
                    "uploaded": shared["size"],
                    "complete": True,
                    "created": time.time(),
                    "fingerprint": shared.get("fingerprint") or fingerprint,
                    "source": shared.get("source") or "upload",
                    "path": shared.get("path") or "",
                    "blob": _blob_id(shared) if shared.get("source") != "server" else "",
                    "module": module,
                    "add_mode": add_mode,
                    "ed2k": copy.deepcopy(shared["ed2k"]),
                }
                _bump()
                _save_index_locked()
                if _files[file_id]["ed2k"].get("status") != "done":
                    _queue_hash(file_id)
                return self._send_json({
                    "id": file_id,
                    "offset": shared["size"],
                    "complete": True,
                    "name": shared["name"],
                    "rel_path": shared["rel_path"],
                    "reused": True,
                })

            file_id = uuid.uuid4().hex
            if MAX_FILES and len(_files) >= MAX_FILES:
                raise ApiError("文件数量已达上限（%d）" % MAX_FILES, 413)
            if MAX_TOTAL_SIZE:
                used = sum(int(record.get("size") or 0) for record in _files.values())
                if used + size > MAX_TOTAL_SIZE:
                    raise ApiError("存储总量已达上限（%d 字节）" % MAX_TOTAL_SIZE, 413)
            blob = os.path.join(BLOB_DIR, file_id + ".bin")
            try:
                with open(blob, "wb"):
                    pass
            except OSError as exc:
                raise ApiError("无法创建上传文件: %s" % exc, 500)

            _files[file_id] = {
                "id": file_id,
                "name": name,
                "rel_path": rel_path,
                "size": size,
                "uploaded": 0,
                "complete": False,
                "created": time.time(),
                "fingerprint": fingerprint,
                "source": "upload",
                "path": "",
                "module": module,
                "add_mode": add_mode,
                "ed2k": {
                    "status": "idle",
                    "progress": 0,
                    "hash": "",
                    "link": "",
                    "error": "",
                },
            }
            _bump()
            _save_index_locked()
            return self._send_json({
                "id": file_id,
                "offset": 0,
                "complete": False,
                "name": name,
                "rel_path": rel_path,
            })

    def _upload_chunk(self, file_id, query):
        try:
            offset = int((query.get("offset") or ["0"])[0])
        except ValueError:
            raise ApiError("无效的 offset", 400)
        body = self._read_body(MAX_CHUNK)

        with _lock:
            record = _files.get(file_id)
            if not record:
                raise ApiError("上传任务不存在", 404)
            if record.get("complete"):
                raise ApiError("文件已上传完成", 409, {"offset": record["size"]})
            if offset != record["uploaded"]:
                raise ApiError("上传偏移不匹配", 409, {"offset": record["uploaded"]})
            if offset + len(body) > record["size"]:
                raise ApiError("写入长度超过文件大小", 400)
            blob = _file_path(record)
            try:
                with open(blob, "r+b") as fh:
                    fh.seek(offset)
                    fh.write(body)
            except OSError as exc:
                raise ApiError("写入失败: %s" % exc, 500)
            record["uploaded"] = offset + len(body)
            _bump()
            _save_index_locked()
            return self._send_json({
                "uploaded": record["uploaded"],
                "size": record["size"],
                "complete": record["uploaded"] >= record["size"],
            })

    def _complete_upload(self, file_id):
        self._read_body(MAX_JSON_BODY)
        with _lock:
            record = _files.get(file_id)
            if not record:
                raise ApiError("上传任务不存在", 404)
            blob = _file_path(record)
            actual = os.path.getsize(blob) if os.path.isfile(blob) else 0
            if actual != record["size"]:
                record["uploaded"] = min(actual, record["size"])
                _bump()
                raise ApiError(
                    "文件尚未上传完整", 409,
                    {"offset": record["uploaded"], "size": record["size"]},
                )
            record["uploaded"] = actual
            record["complete"] = True
            _bump()
            _save_index_locked()
            public = _public_file(record)
        _queue_hash(file_id)
        return self._send_json({"file": public})

    def _get_torrent_options(self):
        with _lock:
            options = copy.deepcopy(_settings["torrent_options"])
            stored = bool(_settings.get("torrent_options_stored"))
        return self._send_json({"options": options, "stored": stored})

    def _update_torrent_options(self):
        payload = self._read_json()
        raw = payload.get("options") if isinstance(payload.get("options"), dict) else payload
        options = _normalize_torrent_options(raw)
        with _lock:
            _settings["torrent_options"] = options
            _settings["torrent_options_stored"] = True
        _save_settings()
        return self._send_json({"options": options, "stored": True})

    def _get_prefs(self):
        with _lock:
            prefs = copy.deepcopy(_settings["prefs"])
            stored = bool(_settings.get("prefs_stored"))
        return self._send_json({"prefs": prefs, "stored": stored})

    def _update_prefs(self):
        payload = self._read_json()
        raw = payload.get("prefs") if isinstance(payload.get("prefs"), dict) else payload
        with _lock:
            merged = copy.deepcopy(_settings["prefs"])
            if isinstance(raw, dict):
                for key in ("theme", "browse_dir", "last_torrent_job", "imported"):
                    if key in raw:
                        merged[key] = raw[key]
            _settings["prefs"] = _normalize_prefs(merged)
            _settings["prefs_stored"] = True
            prefs = copy.deepcopy(_settings["prefs"])
        _save_settings()
        return self._send_json({"prefs": prefs, "stored": True})

    def _history_list(self):
        with _lock:
            items = []
            for entry in reversed(_history):
                if entry.get("type") == "ed2k":
                    link = str(entry.get("link") or "")
                    items.append({
                        "id": entry["id"],
                        "type": "ed2k",
                        "created": entry.get("created") or 0,
                        "name": entry.get("name") or "",
                        "torrent_name": "",
                        "dir": "",
                        "file_count": 1,
                        "total_size": entry.get("size") or 0,
                        "torrent_size": 0,
                        "piece_length": 0,
                        "piece_count": 0,
                        "info_hash": "",
                        "private": False,
                        "trackers": [],
                        "embedded_count": 0,
                        "magnet": "",
                        "ed2k_links": [link] if link else [],
                        "file_id": entry.get("file_id") or "",
                        "files": [],
                        "available": True,
                    })
                    continue
                result = entry.get("result") or {}
                items.append({
                    "id": entry["id"],
                    "type": "torrent",
                    "created": entry.get("created") or 0,
                    "name": result.get("name") or "",
                    "torrent_name": result.get("file_name") or "",
                    "dir": result.get("name") or "",
                    "file_count": result.get("file_count") or 0,
                    "total_size": result.get("total_size") or 0,
                    "torrent_size": result.get("size") or 0,
                    "piece_length": result.get("piece_length") or 0,
                    "piece_count": result.get("piece_count") or 0,
                    "info_hash": result.get("info_hash") or "",
                    "private": bool(result.get("private")),
                    "trackers": list(result.get("trackers") or []),
                    "embedded_count": result.get("embedded_count") or 0,
                    "magnet": entry.get("magnet") or "",
                    "ed2k_links": list(entry.get("ed2k_links") or []),
                    "files": [
                        {"path": item.get("path"), "size": item.get("size")}
                        for item in (result.get("files") or [])
                    ],
                    "available": os.path.isfile(os.path.join(TORRENT_DIR, entry["id"] + ".torrent")),
                })
        return self._send_json({"items": items})

    def _delete_history(self):
        payload = self._read_json()
        wanted = []
        for item in payload.get("ids") or []:
            text = str(item)
            if _is_hex32(text) and text not in wanted:
                wanted.append(text)
        if not wanted:
            raise ApiError("未选择要移除的历史记录", 400)
        removed = 0
        with _lock:
            targets = [entry for entry in _history if entry.get("id") in wanted]
            if targets:
                _history[:] = [entry for entry in _history if entry.get("id") not in wanted]
                removed = len(targets)
                _bump()
                _save_index_locked()
        for entry in targets:
            with _lock:
                _jobs.pop(entry["id"], None)
            path = os.path.join(TORRENT_DIR, entry["id"] + ".torrent")
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except OSError:
                pass
        return self._send_json({"removed": removed})

    def _promote_history(self):
        payload = self._read_json()
        module = _normalize_module(payload.get("module"))
        ids = _parse_ids(payload.get("ids"))
        if not ids:
            raise ApiError("未选择历史文件", 400)
        created = 0
        skipped = 0
        new_ids = []
        with _lock:
            existing = {}
            for record in _files.values():
                if _normalize_module(record.get("module")) != module:
                    continue
                key = (record.get("fingerprint") or record["name"] + "|" + str(record["size"]))
                existing[key] = record
            for file_id in ids:
                record = _files.get(file_id)
                if not record or not record.get("complete"):
                    skipped += 1
                    continue
                key = (record.get("fingerprint") or record["name"] + "|" + str(record["size"]))
                if key in existing:
                    skipped += 1
                    continue
                if MAX_FILES and len(_files) >= MAX_FILES:
                    raise ApiError("文件数量已达上限（%d）" % MAX_FILES, 413)
                new_id = uuid.uuid4().hex
                _files[new_id] = {
                    "id": new_id,
                    "name": record["name"],
                    "rel_path": record["rel_path"],
                    "size": record["size"],
                    "uploaded": record["size"],
                    "complete": True,
                    "created": time.time(),
                    "fingerprint": record.get("fingerprint") or "",
                    "source": record.get("source") or "upload",
                    "path": record.get("path") or "",
                    "blob": _blob_id(record) if record.get("source") != "server" else "",
                    "module": module,
                    "add_mode": record.get("add_mode") or ("folder" if "/" in str(record.get("rel_path") or "") else "file"),
                    "ed2k": copy.deepcopy(record["ed2k"]),
                }
                existing[key] = _files[new_id]
                if record["ed2k"].get("status") != "done":
                    new_ids.append(new_id)
                created += 1
            if created:
                _bump()
                _save_index_locked()
        for file_id in new_ids:
            _queue_hash(file_id)
        return self._send_json({"created": created, "skipped": skipped})

    def _delete_files(self):
        payload = self._read_json()
        ids = _parse_ids(payload.get("ids"))
        if not ids:
            raise ApiError("未选择文件", 400)
        removed = []
        removed_records = []
        with _lock:
            for file_id in ids:
                record = _files.pop(file_id, None)
                if record:
                    removed.append(file_id)
                    removed_records.append(record)
            if removed:
                _bump()
                _save_index_locked()
        for record in removed_records:
            if record.get("source") == "server":
                continue
            blob_id = _blob_id(record)
            with _lock:
                shared = any(
                    other.get("source") != "server" and _blob_id(other) == blob_id
                    for other in _files.values()
                )
            if shared:
                continue
            try:
                path = os.path.join(BLOB_DIR, blob_id + ".bin")
                if os.path.isfile(path):
                    os.remove(path)
            except OSError:
                pass
        return self._send_json({"deleted": len(removed)})

    def _hash_files(self):
        payload = self._read_json()
        ids = _parse_ids(payload.get("ids"))
        if not ids:
            with _lock:
                ids = [
                    file_id
                    for file_id, record in _files.items()
                    if record.get("complete")
                ]
        queued = 0
        for file_id in ids:
            if _queue_hash(file_id, force=True):
                queued += 1
        return self._send_json({"queued": queued})


    def _torrent_options(self, payload):
        raw_trackers = payload.get("trackers")
        if isinstance(raw_trackers, str):
            raw_trackers = re.split(r"[\r\n,]+", raw_trackers)
        if not isinstance(raw_trackers, list):
            raw_trackers = []
        trackers = normalize_trackers(raw_trackers)
        if raw_trackers and [str(t).strip() for t in raw_trackers if str(t).strip()] and not trackers:
            raise ApiError("Tracker 地址格式无效，请使用 udp:// 或 http(s):// 地址", 400)
        try:
            piece_size = int(payload.get("piece_size") or 0)
        except (TypeError, ValueError):
            piece_size = 0
        if piece_size and (piece_size < 16384 or piece_size > 134217728 or piece_size & (piece_size - 1)):
            raise ApiError("分块大小必须是 16 KiB 到 128 MiB 之间的 2 的幂", 400)
        return {
            "name": str(payload.get("name") or "").strip()[:200],
            "trackers": trackers,
            "piece_size": piece_size,
            "private": bool(payload.get("private")),
            "embed_ed2k": bool(payload.get("embed_ed2k", True)),
            "comment": str(payload.get("comment") or "").strip()[:1000],
        }

    def _estimate_torrent(self):
        payload = self._read_json()
        ids = _parse_ids(payload.get("ids"))
        if not ids:
            raise ApiError("请选择用于生成种子的文件", 400)
        with _lock:
            records = [
                _files[fid]
                for fid in ids
                if fid in _files and _files[fid].get("complete")
            ]
            if not records:
                raise ApiError("所选文件尚未上传完成", 400)
            embedded = []
            if bool(payload.get("embed_ed2k", True)):
                for record in records:
                    ed2k = record.get("ed2k") or {}
                    if ed2k.get("status") == "done" and ed2k.get("link"):
                        embedded.append(ed2k["link"])
        options = self._torrent_options(payload)
        try:
            result = estimate_torrent(
                records,
                name_hint=options["name"],
                trackers=options["trackers"],
                piece_size=options["piece_size"],
                private=options["private"],
                comment=options["comment"],
                embedded_links=embedded,
            )
        except TorrentError as exc:
            raise ApiError(str(exc), 400)
        return self._send_json(result)

    def _prepare_qb(self):
        payload = self._read_json()
        job = _get_done_job(str(payload.get("job_id") or ""))
        server, url = _qb_config(payload.get("server_id"))

        remembered = str(server.get("last_savepath") or "").strip()

        qb_default = "" if remembered else _qb_default_savepath(server, url)
        records = []
        local_path = ""
        try:
            records = _job_source_records(job)
            local_path = _records_savepath(records)
            try:
                savepath = _map_qb_path(local_path, server)
                mapping_error = ""
            except ApiError as exc:
                savepath = ""
                mapping_error = str(exc)
        except ApiError as exc:
            savepath = ""
            mapping_error = str(exc)

        if remembered:
            savepath = remembered
        elif not savepath:
            savepath = qb_default or str(server.get("remote_prefix") or "").strip()
        return self._send_json({
            "server_id": server["id"],
            "server_name": server["name"],
            "savepath": savepath,
            "qb_default": qb_default,
            "remembered": remembered,
            "mapping_error": mapping_error,
            "local_savepath": local_path,
            "file_count": job["result"].get("file_count") or len(records),
            "name": job["result"].get("name") or "",
        })

    def _push_qb(self):
        payload = self._read_json()
        job = _get_done_job(str(payload.get("job_id") or ""))
        server, url = _qb_config(payload.get("server_id"))
        savepath = str(payload.get("savepath") or "").strip()
        if not savepath:
            try:
                records = _job_source_records(job)
            except ApiError:
                raise ApiError("请填写 qBittorrent 保存路径后再推送", 400)
            savepath = _map_qb_path(_records_savepath(records), server)
        skip_checking = bool(payload.get("skip_checking", True))
        paused = bool(payload.get("paused", False))
        torrent_path = os.path.join(TORRENT_DIR, job["id"] + ".torrent")
        if not os.path.isfile(torrent_path):
            raise ApiError("种子文件已被清理，请重新生成", 400)
        try:
            with open(torrent_path, "rb") as fh:
                torrent_bytes = fh.read()
        except OSError as exc:
            raise ApiError("读取种子文件失败：%s" % exc, 500)
        opener = _qb_login(url, server.get("username", ""), server.get("password", ""))
        _qb_add_torrent(
            opener, url, torrent_bytes, job["id"] + ".torrent",
            savepath, skip_checking, paused,
        )
        _remember_qb_savepath(server["id"], savepath)
        return self._send_json({
            "ok": True,
            "message": "已推送到 " + server["name"],
            "server_id": server["id"],
            "server_name": server["name"],
            "savepath": savepath,
            "skip_checking": skip_checking,
            "paused": paused,
        })

    def _push_qb_torrent(self):
        query = parse_qs(urlparse(self.path).query)
        get = lambda name, default="": (query.get(name) or [default])[0]
        server, url = _qb_config(get("server_id"))
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ApiError("种子内容为空", 400)
        if length > MAX_TORRENT_BODY:
            raise ApiError("种子文件过大", 413)
        torrent_bytes = self.rfile.read(length)
        try:
            parse_torrent(torrent_bytes)
        except TorrentError as exc:
            raise ApiError("不是有效的 BT 种子：%s" % exc, 400)
        savepath = get("savepath").strip()
        filename = get("filename").strip() or "upload.torrent"
        filename = os.path.basename(filename.replace("\\", "/")) or "upload.torrent"
        skip_checking = get("skip_checking").lower() in ("1", "true", "yes")
        paused = get("paused").lower() in ("1", "true", "yes")
        opener = _qb_login(url, server.get("username", ""), server.get("password", ""))
        _qb_add_torrent(
            opener, url, torrent_bytes, filename,
            savepath, skip_checking, paused,
        )
        _remember_qb_savepath(server["id"], savepath)
        return self._send_json({
            "ok": True,
            "message": "已推送到 " + server["name"],
            "server_id": server["id"],
            "server_name": server["name"],
            "savepath": savepath,
        })

    def _push_115(self):
        payload = self._read_json()
        job = _get_done_job(str(payload.get("job_id") or ""))
        return self._send_json(_submit_115_offline(job, payload.get("save_cid")))

    def _push_115_links_api(self):
        payload = self._read_json()
        ids = payload.get("ids")
        if not isinstance(ids, list) or not ids:
            raise ApiError("请选择要推送的文件", 400)
        if len(ids) > 50:
            raise ApiError("一次最多推送 50 条 ED2K 链接", 400)
        return self._send_json(_push_115_links([str(fid) for fid in ids]))

    def _push_115_items_api(self):
        payload = self._read_json()
        return self._send_json(_push_115_items(
            payload.get("items"),
            payload.get("save_cid"),
            bool(payload.get("keep_structure", True)),
        ))

    def _create_torrent(self):
        payload = self._read_json()
        ids = _parse_ids(payload.get("ids"))
        if not ids:
            raise ApiError("请选择用于生成种子的文件", 400)

        with _lock:
            records = [
                _files[fid]
                for fid in ids
                if fid in _files and _files[fid].get("complete")
            ]
            total = sum(record["size"] for record in records)
            if not records:
                raise ApiError("所选文件尚未上传完成", 400)

        options = self._torrent_options(payload)
        if options["embed_ed2k"]:
            pending = sum(
                1 for record in records
                if (record.get("ed2k") or {}).get("status") in ("idle", "queued", "running")
            )
            if pending:
                raise ApiError("有 %d 个文件的 ED2K 仍在计算，请计算完成后再生成种子" % pending, 409)

        job_id = uuid.uuid4().hex
        job = {
            "id": job_id,
            "type": "torrent",
            "status": "queued",
            "progress": 0,
            "message": "等待处理",
            "error": "",
            "result": None,
            "created": time.time(),
            "total_size": total,
            "source_ids": list(ids),
        }
        with _lock:
            _jobs[job_id] = job
            _bump()
        torrent_pool.submit(_torrent_task, job_id, ids, options)
        return self._send_json({
            "job_id": job_id,
            "total_size": total,
            "trackers": options["trackers"],
        })

    def _parse_torrent(self, query=None):
        data = self._read_body(MAX_TORRENT_BODY)
        if not data:
            raise ApiError("种子内容为空", 400)
        try:
            parsed = parse_torrent(data)
        except TorrentError as exc:
            raise ApiError(str(exc), 400)
        parsed["matched_files"] = _match_torrent_files(parsed)
        parsed["matched_count"] = sum(
            1 for item in parsed["matched_files"] if item["file_id"]
        )
        parsed["embedded_links"] = _embedded_torrent_links(data, parsed.get("files"))
        parsed["torrent_size"] = len(data)
        want_tree = bool(query) and str((query.get("tree") or ["0"])[0]).lower() in ("1", "true", "yes")
        if want_tree:
            try:
                parsed.update(parse_torrent_tree(data))
            except TorrentError as exc:
                raise ApiError(str(exc), 400)
        return self._send_json(parsed)

    def _edit_torrent(self):
        payload = self._read_json(MAX_TORRENT_BODY)
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            raise ApiError("请先导入种子文件", 400)
        if len(items) > 200:
            raise ApiError("一次最多编辑 200 个种子", 400)
        batch = bool(payload.get("batch")) or len(items) > 1
        options = {
            "batch": batch,
            "trackers": payload.get("trackers") if "trackers" in payload else None,
        }
        if not batch:
            options.update({
                "name": payload.get("name") or "",
                "comment": payload.get("comment") or "",
                "source": payload.get("source") or "",
                "private": bool(payload.get("private")),
                "files": payload.get("files") if isinstance(payload.get("files"), list) else None,
                "tree": payload.get("tree") if isinstance(payload.get("tree"), dict) else None,
            })
            if options["files"] is None:
                options.pop("files")
            if options["tree"] is None:
                options.pop("tree")
        if options["trackers"] is None:
            options.pop("trackers")
        elif not normalize_trackers(options["trackers"]):
            raw = options["trackers"]
            if isinstance(raw, str):
                raw = re.split(r"[\r\n,]+", raw)
            if any(str(item).strip() for item in (raw or [])):
                raise ApiError("Tracker 地址格式无效，请使用 udp:// 或 http(s):// 地址", 400)

        edited = []
        total_bytes = 0
        for entry in items:
            if not isinstance(entry, dict):
                continue
            try:
                data = base64.b64decode(str(entry.get("data") or ""), validate=True)
            except (ValueError, TypeError):
                raise ApiError("种子数据无效", 400)
            if not data:
                continue
            total_bytes += len(data)
            if total_bytes > MAX_TORRENT_BODY:
                raise ApiError("种子总大小超出限制", 413)
            try:
                result = edit_torrent(data, options)
                info = parse_torrent(result)
            except TorrentError as exc:
                raise ApiError(str(exc), 400)
            file_name = str(info.get("name") or entry.get("name") or "torrent")
            file_name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", file_name).strip() or "torrent"
            if not file_name.lower().endswith(".torrent"):
                file_name += ".torrent"
            edited.append((file_name, result, info.get("info_hash", "")))

        if not edited:
            raise ApiError("没有可编辑的种子", 400)

        if not batch:
            file_name, data, info_hash = edited[0]
            ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", file_name) or "torrent.torrent"
            disposition = "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (
                ascii_name, quote(file_name, safe="")
            )
            return self._send_bytes(
                data,
                "application/x-bittorrent",
                extra={"Content-Disposition": disposition, "X-Info-Hash": info_hash},
            )

        buffer = io.BytesIO()
        used = set()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for file_name, data, _ in edited:
                stem = file_name[:-8] if file_name.lower().endswith(".torrent") else file_name
                candidate = file_name
                index = 2
                while candidate in used:
                    candidate = "%s (%d).torrent" % (stem, index)
                    index += 1
                used.add(candidate)
                archive.writestr(candidate, data)
        return self._send_bytes(
            buffer.getvalue(),
            "application/zip",
            extra={"Content-Disposition": "attachment; filename=\"edited-torrents.zip\""},
        )

    def _download_torrent(self, job_id):
        with _lock:
            job = _jobs.get(job_id)
            if not job:
                job = next((item for item in _history if item.get("id") == job_id), None)
            result = copy.deepcopy(job.get("result")) if job else None
        if not job or job.get("status") != "done" or not result:
            raise ApiError("种子不存在或尚未生成", 404)
        path = os.path.join(TORRENT_DIR, job_id + ".torrent")
        if not os.path.isfile(path):
            raise ApiError("种子文件已过期", 404)
        with open(path, "rb") as fh:
            data = fh.read()
        file_name = result.get("file_name") or "linkseed.torrent"
        ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", file_name) or "torrent.torrent"
        disposition = "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (
            ascii_name,
            quote(file_name, safe=""),
        )
        return self._send_bytes(
            data,
            "application/x-bittorrent",
            extra={
                "Content-Disposition": disposition,
                "Cache-Control": "no-store",
            },
        )


    def _serve_static(self, path, head=False):
        rel = path.lstrip("/") or "index.html"
        if rel == "favicon.ico":
            rel = "logo.svg"
        elif rel == "login":
            rel = "login.html"
        target = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if target != STATIC_DIR and not target.startswith(STATIC_DIR + os.sep):
            raise ApiError("Forbidden", 403)
        if not os.path.isfile(target):
            raise ApiError("Not Found", 404)

        content_type = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in (
            "application/javascript",
            "application/json",
            "image/svg+xml",
        ):
            content_type += "; charset=utf-8"
        try:
            stat = os.stat(target)
        except OSError:
            raise ApiError("Not Found", 404)
        etag = '"%x-%x"' % (int(stat.st_mtime_ns), stat.st_size)

        cache = "no-cache" if (
            rel in ("index.html", "login.html") or rel.endswith((".js", ".css"))
        ) else "public, max-age=3600"
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self._common_headers()
            self.end_headers()
            return
        with open(target, "rb") as fh:
            data = fh.read()

        if head:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache)
            self.send_header("ETag", etag)
            self._common_headers()
            self.end_headers()
            return
        self._send_bytes(
            data, content_type,
            extra={"Cache-Control": cache, "ETag": etag},
        )

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def log_message(self, fmt, *args):
        print("[http] %s %s" % (self.address_string(), fmt % args), flush=True)


def main():
    _bootstrap()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print("链种工坊 LinkSeed 已启动: http://%s:%d  (MD4: %s)" % (HOST, PORT, _MD4_BACKEND), flush=True)
    print(
        "登录鉴权: %s" % ("已开启" if PASSWORD else "未开启（设置 ED2K_PASSWORD 可开启）"),
        flush=True,
    )
    print("可浏览目录: %s" % os.pathsep.join(ROOTS), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在退出…", flush=True)
    finally:
        server.server_close()
        hash_pool.shutdown(wait=False)
        torrent_pool.shutdown(wait=False)


if __name__ == "__main__":
    main()
