import base64
import hashlib
import os
import re
import time

MIN_PIECE = 16 * 1024
MAX_PIECE = 128 * 1024 * 1024


class TorrentError(ValueError):
    pass


def bencode(value):
    if isinstance(value, bool):
        value = int(value)
    if isinstance(value, bytes):
        return str(len(value)).encode("ascii") + b":" + value
    if isinstance(value, str):
        return bencode(value.encode("utf-8"))
    if isinstance(value, int):
        return b"i" + str(value).encode("ascii") + b"e"
    if isinstance(value, (list, tuple)):
        return b"l" + b"".join(bencode(item) for item in value) + b"e"
    if isinstance(value, dict):
        items = []
        for key, val in value.items():
            if isinstance(key, str):
                key = key.encode("utf-8")
            items.append((key, val))
        items.sort(key=lambda kv: kv[0])
        return b"d" + b"".join(bencode(k) + bencode(v) for k, v in items) + b"e"
    raise TorrentError("无法编码的类型: %r" % (type(value),))


class _Decoder:
    def __init__(self, data):
        self.data = data
        self.size = len(data)
        self.pos = 0
        self.info_span = None

    def parse(self, depth=0):
        if depth > 64:
            raise TorrentError("种子结构嵌套过深")
        if self.pos >= self.size:
            raise TorrentError("种子数据不完整")
        char = self.data[self.pos:self.pos + 1]

        if char == b"i":
            end = self.data.find(b"e", self.pos + 1)
            if end < 0:
                raise TorrentError("整数编码不完整")
            raw = self.data[self.pos + 1:end]
            if not re.fullmatch(rb"-?\d+", raw):
                raise TorrentError("非法整数编码")
            self.pos = end + 1
            return int(raw)

        if char == b"l":
            self.pos += 1
            items = []
            while self.pos < self.size and self.data[self.pos:self.pos + 1] != b"e":
                items.append(self.parse(depth + 1))
            if self.pos >= self.size:
                raise TorrentError("列表编码不完整")
            self.pos += 1
            return items

        if char == b"d":
            self.pos += 1
            result = {}
            while self.pos < self.size and self.data[self.pos:self.pos + 1] != b"e":
                key = self.parse(depth + 1)
                if not isinstance(key, bytes):
                    raise TorrentError("字典键必须是字符串")
                value_start = self.pos
                value = self.parse(depth + 1)
                if depth == 0 and key == b"info":
                    self.info_span = (value_start, self.pos)
                result[key] = value
            if self.pos >= self.size:
                raise TorrentError("字典编码不完整")
            self.pos += 1
            return result

        if char.isdigit():
            colon = self.data.find(b":", self.pos)
            if colon < 0:
                raise TorrentError("字符串长度缺失")
            raw_len = self.data[self.pos:colon]
            if not raw_len.isdigit():
                raise TorrentError("非法字符串长度")
            length = int(raw_len)
            start = colon + 1
            end = start + length
            if end > self.size:
                raise TorrentError("字符串内容不完整")
            self.pos = end
            return self.data[start:end]

        raise TorrentError("未知的 bencode 类型")


def bdecode(data):
    if not isinstance(data, (bytes, bytearray)):
        raise TorrentError("种子必须是二进制数据")
    decoder = _Decoder(bytes(data))
    value = decoder.parse()
    return value, decoder.info_span


def supported_piece_size(value):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return 0
    if value < MIN_PIECE or value > MAX_PIECE:
        return 0
    if value & (value - 1):
        return 0
    return value


def auto_piece_size(total_size):
    piece = MIN_PIECE
    while piece < MAX_PIECE and total_size // piece > 2048:
        piece *= 2
    return piece


def normalize_trackers(raw):
    if isinstance(raw, str):
        raw = re.split(r"[\r\n,]+", raw)
    trackers = []
    for item in raw or []:
        tracker = str(item or "").strip()
        if not tracker:
            continue
        if not re.match(r"^(https?|udp|wss?)://\S+$", tracker, re.I):
            continue
        if tracker not in trackers:
            trackers.append(tracker)
    return trackers


def _default_name():
    return "链种工坊_" + time.strftime("%Y-%m-%d_%H-%M-%S")


def _clean_name(value, fallback=None):
    text = str(value or "").replace("\\", "/").replace("/", "_")
    text = re.sub(r"[\x00-\x1f\x7f]", "", text).strip(" .")
    if not text:
        text = _default_name() if fallback is None else fallback
    return text[:200]


def _clean_component(value):
    text = re.sub(r"[\x00-\x1f\x7f/\\]", "_", str(value or "")).strip()
    if text in ("", ".", ".."):
        text = "_"
    return text[:200]


def _unique_components(components, used):
    candidate = [_clean_component(part) for part in components]
    if not candidate:
        candidate = ["_"]
    key = tuple(candidate)
    if key not in used:
        used.add(key)
        return candidate
    stem = candidate[-1]
    base, dot, ext = stem.rpartition(".")
    if not dot:
        base, ext = stem, ""
    index = 2
    while True:
        new_name = "%s (%d)%s" % (base, index, ("." + ext) if ext else "")
        candidate[-1] = new_name
        key = tuple(candidate)
        if key not in used:
            used.add(key)
            return candidate
        index += 1


def build_layout(records, name_hint=""):
    records = sorted(records, key=lambda r: r.get("rel_path") or r.get("name") or "")
    hint = str(name_hint or "").strip()

    if len(records) == 1:
        record = records[0]
        name = _clean_name(hint or record.get("name") or "file")
        return {
            "name": name,
            "single": True,
            "files": [{"id": record["id"], "path": [], "size": int(record["size"])}],
            "total_size": int(record["size"]),
        }

    parts = []
    for record in records:
        rel = (record.get("rel_path") or record.get("name") or "").replace("\\", "/")
        parts.append([item for item in rel.split("/") if item not in ("", ".", "..")])

    common_top = parts[0][0] if parts and parts[0] else ""
    strip_root = bool(common_top) and all(len(p) > 1 and p[0] == common_top for p in parts)

    if hint:
        root = _clean_name(hint)
    elif strip_root:
        root = _clean_name(common_top)
    else:
        root = _default_name()

    used = set()
    files = []
    total = 0
    for record, path_parts in zip(records, parts):
        components = path_parts[1:] if strip_root else path_parts
        if not components:
            components = [record.get("name") or "file"]
        components = _unique_components(components, used)
        size = int(record["size"])
        total += size
        files.append({"id": record["id"], "path": components, "size": size})

    return {"name": root, "single": False, "files": files, "total_size": total}


def _iter_stream(records_by_id, blob_dir, layout):
    for entry in layout["files"]:
        record = records_by_id.get(entry["id"])
        path = (record.get("path") if record else "") or os.path.join(
            blob_dir, str((record or {}).get("blob") or entry["id"]) + ".bin"
        )
        expected = entry["size"]
        if not record or not os.path.isfile(path):
            raise TorrentError("文件不存在或已被删除：%s" % (entry["path"][-1] if entry["path"] else "file"))
        actual = os.path.getsize(path)
        if actual != expected:
            raise TorrentError("文件大小发生变化：%s" % os.path.basename(path))
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk


def _build_meta(layout, piece, pieces_blob, trackers, private, comment, embedded_links):
    info = {
        "name": layout["name"].encode("utf-8"),
        "piece length": piece,
        "pieces": pieces_blob,
    }
    if private:
        info["private"] = 1
    if layout["single"]:
        info["length"] = layout["total_size"]
    else:
        info["files"] = [
            {
                "length": entry["size"],
                "path": [part.encode("utf-8") for part in entry["path"]],
            }
            for entry in layout["files"]
        ]

    meta = {
        "info": info,
        "creation date": int(time.time()),
        "created by": "LinkSeed 1.0",
        "encoding": "UTF-8",
    }
    if trackers:
        meta["announce"] = trackers[0]
        meta["announce-list"] = [[tracker] for tracker in trackers]
    if comment:
        meta["comment"] = str(comment)[:1000]

    embedded = []
    if embedded_links:
        seen_links = set()
        for link in embedded_links:
            text = str(link or "").strip()
            if not text.startswith("ed2k://|file|") or text in seen_links:
                continue
            seen_links.add(text)
            embedded.append(text)
            if len(embedded) >= 500:
                break
    if embedded:
        meta["ed2k-links"] = "\r\n".join(embedded).encode("utf-8")
    return meta, embedded


def estimate_torrent(records, name_hint="", trackers=None, piece_size=0,
                     private=False, comment="", embedded_links=None):
    if not records:
        raise TorrentError("没有可用的文件")
    trackers = normalize_trackers(trackers)
    layout = build_layout(records, name_hint)
    total = layout["total_size"]
    if total <= 0:
        raise TorrentError("文件总大小为 0")
    piece = supported_piece_size(piece_size) or auto_piece_size(total)
    piece_count = max(1, (total + piece - 1) // piece)
    meta, embedded = _build_meta(
        layout, piece, b"\0" * (20 * piece_count), trackers, private, comment, embedded_links
    )
    return {
        "size": len(bencode(meta)),
        "piece_length": piece,
        "piece_count": piece_count,
        "total_size": total,
        "file_count": len(layout["files"]),
        "embedded_count": len(embedded),
    }


def create_torrent(records, blob_dir, out_path, name_hint="", trackers=None,
                   piece_size=0, private=False, comment="", embedded_links=None,
                   progress=None):
    if not records:
        raise TorrentError("没有可用的文件")

    trackers = normalize_trackers(trackers)
    layout = build_layout(records, name_hint)
    total = layout["total_size"]
    if total <= 0:
        raise TorrentError("文件总大小为 0")

    piece = supported_piece_size(piece_size) or auto_piece_size(total)
    records_by_id = {record["id"]: record for record in records}

    pieces = []
    buffer = bytearray()
    processed = 0
    last_report = [0.0]

    def report(force=False):
        now = time.time()
        if progress and (force or now - last_report[0] >= 0.35):
            progress(processed, total)
            last_report[0] = now

    report(force=True)
    for chunk in _iter_stream(records_by_id, blob_dir, layout):
        buffer.extend(chunk)
        while len(buffer) >= piece:
            pieces.append(hashlib.sha1(buffer[:piece]).digest())
            del buffer[:piece]
            processed += piece
            report()
    if buffer:
        pieces.append(hashlib.sha1(bytes(buffer)).digest())
        processed += len(buffer)
    report(force=True)

    meta, embedded = _build_meta(
        layout, piece, b"".join(pieces), trackers, private, comment, embedded_links
    )
    info = meta["info"]
    info_encoded = bencode(info)
    info_hash = hashlib.sha1(info_encoded).hexdigest()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp_path = out_path + ".tmp"
    encoded = bencode(meta)
    with open(tmp_path, "wb") as fh:
        fh.write(encoded)
    os.replace(tmp_path, out_path)

    return {
        "name": layout["name"],
        "file_name": layout["name"] + ".torrent",
        "size": len(encoded),
        "files": [
            {"path": "/".join(entry["path"]) or layout["name"], "size": entry["size"]}
            for entry in layout["files"]
        ],
        "total_size": total,
        "piece_length": piece,
        "piece_count": len(pieces),
        "file_count": len(layout["files"]),
        "single_file": layout["single"],
        "info_hash": info_hash,
        "trackers": trackers,
        "private": bool(private),
        "embedded_count": len(embedded),
    }


def _decode_text(value, fallback=""):
    if isinstance(value, bytes):
        for encoding in ("utf-8", "gbk", "latin-1"):
            try:
                return value.decode(encoding)
            except UnicodeDecodeError:
                continue
        return value.decode("utf-8", "replace")
    if isinstance(value, str):
        return value
    return fallback


def parse_torrent(data):
    try:
        meta, info_span = bdecode(data)
    except TorrentError:
        raise
    except Exception as exc:
        raise TorrentError("无法解析种子文件: %s" % exc)

    if not isinstance(meta, dict) or not isinstance(meta.get(b"info"), dict):
        raise TorrentError("不是有效的 BT 种子文件")

    info = meta[b"info"]
    name = _decode_text(info.get(b"name"), "torrent")
    piece_length = info.get(b"piece length")
    pieces = info.get(b"pieces")
    if not isinstance(piece_length, int) or piece_length <= 0:
        raise TorrentError("种子缺少分块大小")
    if not isinstance(pieces, bytes):
        raise TorrentError("种子缺少分块哈希")

    files = []
    if isinstance(info.get(b"files"), list):
        for item in info[b"files"]:
            if not isinstance(item, dict):
                continue
            path_parts = item.get(b"path") or []
            path = "/".join(_decode_text(part) for part in path_parts if isinstance(part, bytes))
            length = item.get(b"length")
            if not path or not isinstance(length, int) or length < 0:
                continue
            files.append({"path": path, "size": length})
    else:
        length = info.get(b"length")
        if not isinstance(length, int) or length < 0:
            raise TorrentError("种子缺少文件大小")
        files.append({"path": name, "size": length})

    if not files:
        raise TorrentError("种子中没有文件")

    trackers = []
    announce = meta.get(b"announce")
    if isinstance(announce, bytes):
        trackers.append(_decode_text(announce))
    announce_list = meta.get(b"announce-list")
    if isinstance(announce_list, list):
        for tier in announce_list:
            if isinstance(tier, list):
                for item in tier:
                    tracker = _decode_text(item)
                    if tracker and tracker not in trackers:
                        trackers.append(tracker)
            elif isinstance(tier, bytes):
                tracker = _decode_text(tier)
                if tracker and tracker not in trackers:
                    trackers.append(tracker)

    if info_span:
        info_hash = hashlib.sha1(data[info_span[0]:info_span[1]]).hexdigest()
    else:
        info_hash = hashlib.sha1(bencode(info)).hexdigest()

    return {
        "name": name,
        "info_hash": info_hash,
        "piece_length": piece_length,
        "piece_count": len(pieces) // 20,
        "total_size": sum(item["size"] for item in files),
        "file_count": len(files),
        "files": files,
        "trackers": trackers,
        "comment": _decode_text(meta.get(b"comment")),
        "created_by": _decode_text(meta.get(b"created by")),
        "private": bool(info.get(b"private")),
        "source": _decode_text(info.get(b"source")),
    }


def edit_torrent(data, options):
    if options.get("tree") is not None:
        meta = tree_to_bencode(options.get("tree"))
        if not isinstance(meta, dict) or not isinstance(meta.get(b"info"), dict):
            raise TorrentError("树形结构缺少 info 字段，无法生成有效种子")
        return bencode(meta)

    try:
        meta, _ = bdecode(data)
    except TorrentError:
        raise
    except Exception as exc:
        raise TorrentError("无法解析种子文件: %s" % exc)
    if not isinstance(meta, dict) or not isinstance(meta.get(b"info"), dict):
        raise TorrentError("不是有效的 BT 种子文件")
    info = meta[b"info"]

    if "trackers" in options:
        trackers = normalize_trackers(options.get("trackers") or [])
        if trackers:
            meta[b"announce"] = trackers[0].encode("utf-8")
            meta[b"announce-list"] = [[tracker.encode("utf-8")] for tracker in trackers]
        else:
            meta.pop(b"announce", None)
            meta.pop(b"announce-list", None)

    if not options.get("batch"):
        name = str(options.get("name") or "").strip()
        if name:
            info[b"name"] = _clean_name(name).encode("utf-8")
        comment = str(options.get("comment") or "").strip()
        if comment:
            meta[b"comment"] = comment.encode("utf-8")
        else:
            meta.pop(b"comment", None)
        source = str(options.get("source") or "").strip()
        if source:
            info[b"source"] = source.encode("utf-8")
        else:
            info.pop(b"source", None)
        if "private" in options:
            if options.get("private"):
                info[b"private"] = 1
            else:
                info.pop(b"private", None)

        files = options.get("files")
        if isinstance(files, list) and files:
            entries = info.get(b"files")
            if not isinstance(entries, list) or len(entries) != len(files):
                raise TorrentError("文件列表与种子中的文件数量不一致")
            for entry, raw_path in zip(entries, files):
                parts = [part for part in str(raw_path or "").replace("\\", "/").split("/")
                         if part not in ("", ".", "..")]
                if not parts:
                    raise TorrentError("文件路径不能为空")
                if not isinstance(entry, dict):
                    raise TorrentError("种子文件列表结构无效")
                entry[b"path"] = [_clean_component(part).encode("utf-8") for part in parts]

        meta[b"created by"] = b"LinkSeed"

    return bencode(meta)


def to_tree(value):
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return {"$b64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, (list, tuple)):
        return [to_tree(item) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            result[_decode_text(key)] = to_tree(item)
        return result
    raise TorrentError("无法转换的种子数据类型")


def tree_to_bencode(value, depth=0):
    if depth > 64:
        raise TorrentError("种子结构嵌套过深")
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, list):
        return [tree_to_bencode(item, depth + 1) for item in value]
    if isinstance(value, dict):
        if set(value.keys()) == {"$b64"}:
            try:
                return base64.b64decode(str(value["$b64"]), validate=True)
            except (ValueError, TypeError):
                raise TorrentError("二进制字段的 Base64 内容无效")
        result = {}
        for key, item in value.items():
            name = str(key)
            if name in ("", "$b64"):
                raise TorrentError("种子树中存在无效的键名")
            result[name.encode("utf-8")] = tree_to_bencode(item, depth + 1)
        return result
    raise TorrentError("种子树中存在不支持的值类型")


def parse_torrent_tree(data):
    try:
        meta, info_span = bdecode(data)
    except TorrentError:
        raise
    except Exception as exc:
        raise TorrentError("无法解析种子文件: %s" % exc)
    if not isinstance(meta, dict) or not isinstance(meta.get(b"info"), dict):
        raise TorrentError("不是有效的 BT 种子文件")
    info = meta[b"info"]
    if info_span:
        info_hash = hashlib.sha1(data[info_span[0]:info_span[1]]).hexdigest()
    else:
        info_hash = hashlib.sha1(bencode(info)).hexdigest()
    return {
        "tree": to_tree(meta),
        "info_hash": info_hash,
        "encoding": _decode_text(meta.get(b"encoding")),
        "created_by": _decode_text(meta.get(b"created by")),
        "creation_date": meta.get(b"creation date") if isinstance(meta.get(b"creation date"), int) else 0,
    }
