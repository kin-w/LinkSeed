import hashlib
import os
import re
import struct
from urllib.parse import unquote

PART_SIZE = 9728000

_M32 = 0xFFFFFFFF


def _rol(value, bits):
    value &= _M32
    return ((value << bits) | (value >> (32 - bits))) & _M32


def _f(x, y, z):
    return (x & y) | (~x & z)


def _g(x, y, z):
    return (x & y) | (x & z) | (y & z)


def _h(x, y, z):
    return x ^ y ^ z


def _md4_compress(state, data):
    a, b, c, d = state
    for off in range(0, len(data), 64):
        x = struct.unpack("<16I", data[off:off + 64])
        aa, bb, cc, dd = a, b, c, d


        for i in range(0, 16, 4):
            a = _rol(a + _f(b, c, d) + x[i], 3)
            d = _rol(d + _f(a, b, c) + x[i + 1], 7)
            c = _rol(c + _f(d, a, b) + x[i + 2], 11)
            b = _rol(b + _f(c, d, a) + x[i + 3], 19)


        for i in range(4):
            a = _rol(a + _g(b, c, d) + x[i] + 0x5A827999, 3)
            d = _rol(d + _g(a, b, c) + x[i + 4] + 0x5A827999, 5)
            c = _rol(c + _g(d, a, b) + x[i + 8] + 0x5A827999, 9)
            b = _rol(b + _g(c, d, a) + x[i + 12] + 0x5A827999, 13)


        for i0, i1, i2, i3 in (
            (0, 8, 4, 12),
            (2, 10, 6, 14),
            (1, 9, 5, 13),
            (3, 11, 7, 15),
        ):
            a = _rol(a + _h(b, c, d) + x[i0] + 0x6ED9EBA1, 3)
            d = _rol(d + _h(a, b, c) + x[i1] + 0x6ED9EBA1, 9)
            c = _rol(c + _h(d, a, b) + x[i2] + 0x6ED9EBA1, 11)
            b = _rol(b + _h(c, d, a) + x[i3] + 0x6ED9EBA1, 15)

        a = (a + aa) & _M32
        b = (b + bb) & _M32
        c = (c + cc) & _M32
        d = (d + dd) & _M32

    state[0], state[1], state[2], state[3] = a, b, c, d


class _PureMD4:


    __slots__ = ("_state", "_buffer", "_count")

    def __init__(self):
        self._state = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476]
        self._buffer = b""
        self._count = 0

    def update(self, data):
        if not isinstance(data, (bytes, bytearray, memoryview)):
            data = bytes(data)
        data = bytes(data)
        if not data:
            return self
        self._count += len(data)
        buf = self._buffer + data
        n = len(buf) - (len(buf) % 64)
        if n:
            _md4_compress(self._state, buf[:n])
            self._buffer = buf[n:]
        else:
            self._buffer = buf
        return self

    def digest(self):
        state = list(self._state)
        count = self._count
        pad_len = (56 - (count + 1) % 64) % 64
        tail = self._buffer + b"\x80" + b"\x00" * pad_len
        tail += struct.pack("<Q", (count * 8) & 0xFFFFFFFFFFFFFFFF)
        _md4_compress(state, tail)
        return struct.pack("<4I", *state)

    def hexdigest(self):
        return self.digest().hex()


def _detect_md4():
    try:
        hashlib.new("md4")
        return "hashlib"
    except Exception:
        pass
    try:
        from Crypto.Hash import MD4 as _CryptoMD4

        _CryptoMD4.new().update(b"")
        return "crypto"
    except Exception:
        return "pure"


_MD4_BACKEND = _detect_md4()
if _MD4_BACKEND == "crypto":
    try:
        from Crypto.Hash import MD4 as _CryptoMD4
    except Exception:
        _MD4_BACKEND = "pure"


def md4():
    if _MD4_BACKEND == "hashlib":
        return hashlib.new("md4")
    if _MD4_BACKEND == "crypto":
        return _CryptoMD4.new()
    return _PureMD4()


def ed2k_hash(path, progress=None):
    size = os.path.getsize(path)
    if size <= PART_SIZE:
        h = md4()
        processed = 0
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
                processed += len(chunk)
                if progress:
                    progress(processed, size)
        return h.hexdigest().upper(), size

    root = md4()
    processed = 0
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(PART_SIZE)
            if not chunk:
                break
            part = md4()
            part.update(chunk)
            root.update(part.digest())
            processed += len(chunk)
            if progress:
                progress(processed, size)
    return root.hexdigest().upper(), size


ED2K_RE = re.compile(r"ed2k://\|file\|([^|\r\n]*)\|(\d+)\|([0-9a-fA-F]{32})\|", re.I)


def make_ed2k_link(name, size, hash_hex):
    safe_name = str(name).replace("\r", " ").replace("\n", " ")
    safe_name = safe_name.replace("%", "%25").replace("|", "%7C")
    return "ed2k://|file|{}|{}|{}|/".format(safe_name, int(size), str(hash_hex).upper())


def parse_ed2k_text(text, limit=5000):
    result = []
    seen = set()
    for match in ED2K_RE.finditer(text or ""):
        raw_name, size_raw, digest = match.groups()
        name = unquote(raw_name, errors="replace").replace("|", "_").strip()
        if not name or len(name) > 255:
            continue
        try:
            size = int(size_raw)
        except ValueError:
            continue
        if size <= 0:
            continue
        digest = digest.upper()
        key = (digest, size, name)
        if key in seen:
            continue
        seen.add(key)
        result.append({
            "name": name,
            "size": size,
            "hash": digest,
            "link": make_ed2k_link(name, size, digest),
        })
        if len(result) >= limit:
            break
    return result
