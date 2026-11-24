"""Prototype resume worker shared by CPython and a sealed MicroPython test boot."""

import binascii
import gc
import hashlib
import json
import os
import sys


LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
DIGITS = "0123456789"
HEX = "0123456789abcdef"
HASH_BUFFER = 512


def _valid(s, alphabet, low, high):
    return isinstance(s, str) and low <= len(s) <= high and all(c in alphabet for c in s)


def _word(s, rest, limit):
    return _valid(s, LETTERS + rest, 1, limit) and s[0] in LETTERS + DIGITS


def _decimal(s, width):
    return _valid(s, DIGITS, 1, width) and (s == "0" or s[0] != "0")


def _version(v):
    parts = v.split(".")
    if len(parts) != 3 or not all(_decimal(p, 6) for p in parts):
        raise ValueError("invalid core version")
    return tuple(int(p) for p in parts)


def _hex(digest):
    return binascii.hexlify(digest).decode()


def _hash(data):
    if not isinstance(data, str):
        return hashlib.sha256(data).digest()
    digest = hashlib.sha256()
    for start in range(0, len(data), 256):
        digest.update(data[start:start + 256].encode())
    return digest.digest()


def _digest(data):
    return _hex(_hash(data))


def _json(data):
    if sys.implementation.name == "micropython":
        # Every release and shelf field is covered by the verified envelope.
        return json.loads(data)

    def strict(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ValueError("duplicate JSON key")
            out[key] = value
        return out

    return json.loads(data, object_pairs_hook=strict)


def _envelope_lines(raw):
    text = isinstance(raw, str)
    newline = "\n" if text else b"\n"
    if not raw.endswith(newline):
        raise ValueError("incomplete signed text")
    start = 0
    while start < len(raw):
        end = raw.find(newline, start)
        line = raw[start:end]
        yield line if text else line.decode()
        start = end + 1


def _file_line(line, files):
    digest, sep, name = line.partition("  ")
    stem, dot, ext = name.partition(".")
    if (not sep or not _valid(digest, HEX, 64, 64) or not _word(stem, DIGITS + "_-", 60)
            or stem[0] not in LETTERS or not dot or ext not in ("py", "mpy", "bin", "json")
            or name in files or name == "apps.json" or name.startswith("saves")):
        raise ValueError("invalid or duplicate payload name")
    if ((ext == "mpy" and stem + ".py" in files) or (ext == "py" and stem + ".mpy" in files)):
        raise ValueError("colliding payload module")
    files[name] = digest
    return name


def _app_record(shelf, mod, name, v, payload):
    selected = None
    app_files = set()
    seen = set()
    current = None
    for line in _envelope_lines(shelf):
        if line.startswith("@app  "):
            app = _json(line[6:])
            current = app["mod"]
            if current in seen:
                raise ValueError("duplicate app on shelf")
            seen.add(current)
            if current == mod:
                selected = app
        elif current == mod:
            app_files.add(_file_line(line, payload))
    if not selected or selected["name"] != name:
        raise ValueError("signed pair and shelf name disagree")
    files = selected["files"]
    if (not isinstance(files, list) or not all(isinstance(name, str) for name in files)
            or not files or len(files) != len(app_files) or set(files) != app_files):
        raise ValueError("signed app files are incomplete")
    # This prototype is for namespaced apps such as Safe Signer. Stock apps
    # that share top-level files need separate reviewed namespace rules.
    if any(n.split(".")[0] != mod and not n.startswith(mod + "_") for n in app_files):
        raise ValueError("file is outside the app namespace")
    record = {"mod": mod, "name": name, "v": v}
    for flag in ("usb", "chipuse"):
        if flag in selected:
            if type(selected[flag]) is not bool:
                raise ValueError("invalid signed app flag")
            record[flag] = selected[flag]
    if "entry" in selected:
        if not _word(selected["entry"], DIGITS + "_", 30):
            raise ValueError("invalid signed app entry")
        record["entry"] = selected["entry"]
    return record


class Pair:
    def __init__(self, core, serial, app, files, digest, sizes_hash=None):
        self.core = core
        self.serial = serial
        self.app = app
        self.files = files
        self.digest = digest
        self.sizes_hash = sizes_hash

    @classmethod
    def parse(cls, release, signature, shelf, verify):
        if not verify(release, signature):
            raise ValueError("release signature rejected")
        lines = _envelope_lines(release)
        if next(lines, None) != "wedgie-release 1":
            raise ValueError("invalid release header")
        prefix, _, core = next(lines, "").partition(" ")
        if prefix != "version":
            raise ValueError("invalid core version")
        _version(core)
        core_files, tags = {}, {}
        for line in lines:
            if line.startswith("@"):
                key, sep, value = line.partition("  ")
                if not sep or key in tags or key not in ("@apps", "@serial", "@pair", "@sizes"):
                    raise ValueError("invalid or duplicate release tag")
                tags[key] = value
            else:
                _file_line(line, core_files)
        if tags.get("@apps") != _digest(shelf):
            raise ValueError("app list hash mismatch")
        serial = tags.get("@serial")
        if not _decimal(serial, 18) or serial == "0":
            raise ValueError("invalid release serial")
        pair = _json(tags.get("@pair", "{}"))
        if (not isinstance(pair, dict) or set(pair) != {"mod", "name", "v"}
                or not _word(pair["mod"], DIGITS + "_", 30) or pair["mod"][0] not in LETTERS
                or not _word(pair["name"], DIGITS + " ._()+-", 32)
                or not _word(pair["v"], DIGITS + "._+-", 16)):
            raise ValueError("missing or invalid signed pair")
        if not all(name in core_files for name in ("boot.py", "main.py", "wedgie.mpy")):
            raise ValueError("incomplete core payload")
        app = _app_record(shelf, pair["mod"], pair["name"], pair["v"], core_files)
        sizes_hash = tags.get("@sizes")
        if sizes_hash is not None and not _valid(sizes_hash, HEX, 64, 64):
            raise ValueError("invalid sizes digest")
        return cls(core, int(serial), app, core_files, _digest(release), sizes_hash)

    def sizes(self, raw):
        if self.sizes_hash != _digest(raw):
            raise ValueError("signed sizes hash mismatch")
        expected = {}
        for line in _envelope_lines(raw):
            nbytes, sep, name = line.partition("  ")
            if not sep or name not in self.files or name in expected or not _decimal(nbytes, 7):
                raise ValueError("invalid or duplicate signed size")
            expected[name] = int(nbytes)
        if len(expected) != len(self.files):
            raise ValueError("signed sizes do not cover the pair")
        return expected

    def state(self):
        return {"core": self.core, "serial": self.serial, "app": self.app}

    def check_upgrade(self, previous):
        if _version(self.core) < _version(previous["core"]) or self.serial <= previous["serial"]:
            raise ValueError("older or replayed release")
        if self.app["mod"] != previous["app"]["mod"]:
            raise ValueError("pair can only upgrade the active app")


def _exists(path):
    try:
        os.stat(path)
        return True
    except OSError as e:
        if e.args[0] != 2:  # ENOENT
            raise
        return False


def _read(path):
    with open(path, "rb") as stream:
        if sys.implementation.name == "micropython":
            return json.load(stream)
        return _json(stream.read())


def _sum(path, buffer=None):
    if not _exists(path):
        return None
    # Like wedgie.sums, avoid a large contiguous allocation on an app heap.
    if buffer is None:
        buffer = bytearray(HASH_BUFFER)
    view = memoryview(buffer)
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        while True:
            length = stream.readinto(buffer)
            if not length:
                break
            h.update(view[:length])
    return _hex(h.digest())


def _check_files(pair, stage, live):
    buffer = bytearray(HASH_BUFFER)
    for name in pair.files:
        staged = stage + "/" + name
        candidate = staged if _exists(staged) else live + "/" + name
        if _sum(candidate, buffer) != pair.files[name]:
            raise ValueError("approved content is missing or changed: " + name)


def _parse_offer(receipt, verify):
    release, shelf = receipt["release"], receipt["shelf"]
    # The hosted verify hook is a byte-oriented API. On the board our
    # measured verifier hashes the stored text in bounded UTF-8 pieces.
    if sys.implementation.name != "micropython":
        release, shelf = release.encode(), shelf.encode()
    pair = Pair.parse(release, receipt["sig"], shelf, verify)
    if pair.sizes_hash is not None or "sizes" in receipt:
        pair.sizes(receipt.get("sizes", ""))
    return pair


def _flash_sync(_):
    os.sync()


def _flash_replace(src, dst):
    # LittleFS rename is a single metadata transaction. Both paths are on
    # the same volume. Never delete the existing destination as fallback.
    os.rename(src, dst)
    os.sync()


def _flash_write(path, data):
    with open(path, "w") as stream:
        json.dump(data, stream)
        stream.flush()
    os.sync()


def resume(root, verify, replace=_flash_replace, write=_flash_write, sync=_flash_sync, checkpoint=None,
           live=None, check_policy=None, update_serial=False, check_inputs=None, finalize=None):
    """Run before application imports. On exception the boot caller must stay sealed."""
    journal = root + "/approved.json"
    if not _exists(journal):
        return False
    receipt = _read(journal)
    pair = _parse_offer(receipt, verify)
    if receipt["digest"] != pair.digest:
        raise ValueError("release differs from the physical approval")
    previous = receipt["previous"]
    pair.check_upgrade(previous)
    state = root + "/installed.json"
    current = _read(state)
    target = pair.state()
    if current != previous and current != target:
        raise ValueError("installed state changed after approval")
    if check_policy:
        check_policy(pair, previous)
    del receipt
    gc.collect()

    stage = root + "/stage"
    live = root + "/live" if live is None else live.rstrip("/")
    _check_files(pair, stage, live)
    if check_inputs:
        check_inputs(pair)
    for name in sorted(pair.files, key=lambda n: (n == "main.py", n)):
        staged = stage + "/" + name
        if _exists(staged):
            replace(staged, live + "/" + name)
            if checkpoint:
                checkpoint(name)
    # A .py with the same stem can shadow the signed .mpy. As in
    # firmware/job.py, derive this cleanup from the signed file set.
    for name in sorted(pair.files):
        if name.endswith(".mpy") and name[:-4] + ".py" not in pair.files:
            source = live + "/" + name[:-4] + ".py"
            if _exists(source):
                os.remove(source)
                sync(live)
                if checkpoint:
                    checkpoint(name[:-4] + ".py")
    buffer = bytearray(HASH_BUFFER)
    if any(_sum(live + "/" + name, buffer) != pair.files[name] for name in pair.files):
        raise ValueError("installed file hashes differ from the signed pair")

    # These paths belong to the updater, never to the uploaded file list.
    metadata = [(live + "/apps.json", [pair.app]), (state, target)]
    if update_serial:
        metadata.append((live + "/serial", pair.serial))
    for dest, value in metadata:
        temp = root + "/metadata.tmp"
        write(temp, value)
        replace(temp, dest)
        if checkpoint:
            checkpoint(dest.rsplit("/", 1)[1])

    if finalize:
        finalize(pair, journal)
    os.remove(journal)
    sync(root)
    return True
