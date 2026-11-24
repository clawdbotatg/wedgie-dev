"""Receives one signed pair into a fixed, unapproved staging directory."""

import binascii
import gc
import hashlib
import json
import os
import time

import paired_bridge as bridge
from paired_update_boot import HASH_BUFFER, _digest, _exists, _flash_replace, _sum


MAX_CHUNK = 1024
MAX_META = 8192
MAX_FILES = 96
IDLE_MS = 15000
KEYS = {
    "paired_stage_begin": {"release_size", "shelf_size", "sizes_size", "sig"},
    "paired_stage_meta": {"offset", "data"},
    "paired_stage_put": {"name", "offset", "data"},
    "paired_stage_abort": set(),
}
_active = None


def _drop():
    global _active
    owns_flash = (_active is not None and _active.get("durable")) or _exists(bridge.OFFER)
    _active = None
    if owns_flash:
        bridge.clear_stage()


def expire():
    if _active is not None and time.ticks_diff(time.ticks_ms(), _active["last"]) >= IDLE_MS:
        _drop()


def _append(path, content, offset):
    mode = "ab" if offset else "wb"
    with open(path, mode) as stream:
        if stream.write(content) != len(content):
            raise OSError("short stage write")


def _reply(W, mid, kind, **fields):
    W.send(dict(fields, id=mid, type=kind))


def _chunk(message, offset, remaining, require_full=False):
    if type(message["offset"]) is not int or message["offset"] != offset:
        raise ValueError("out-of-order stage offset")
    coded = message["data"]
    if not isinstance(coded, str) or len(coded) > 4 * ((MAX_CHUNK + 2) // 3):
        raise ValueError("staged chunk too large")
    try:
        raw = binascii.a2b_base64(coded.encode())
    except Exception:
        raise ValueError("invalid staged base64")
    if binascii.b2a_base64(raw).strip().decode() != coded:
        raise ValueError("invalid staged base64")
    size = min(MAX_CHUNK, remaining)
    if not 0 < len(raw) <= size:
        raise ValueError("staged chunk exceeds signed length")
    if require_full and len(raw) != size:
        raise ValueError("payload chunk must fill the signed cursor")
    return raw


def _begin(W, mid, message):
    global _active
    if _active is not None or _exists(bridge.OFFER) or _exists(bridge.APPROVED):
        raise ValueError("paired upload or approval already pending")
    lengths = [message[name] for name in ("release_size", "shelf_size", "sizes_size")]
    if not all(type(n) is int and 0 < n <= MAX_META for n in lengths) or sum(lengths) > MAX_META:
        raise ValueError("invalid staged metadata lengths")
    signature = message["sig"]
    if not isinstance(signature, str) or not 129 <= len(signature) <= 136:
        raise ValueError("invalid staged signature length")
    bridge._reserve(sum(lengths))
    _active = {"metadata": [bytearray(n) for n in lengths], "total": sum(lengths),
               "sig": signature, "offset": 0, "last": time.ticks_ms()}
    _reply(W, mid, "paired_stage_meta", offset=0)


def _cursor(W, mid, state):
    global _active
    pending = state["pending"]
    digest = state["digest"]
    while pending:
        name, nbytes, want = pending[0]
        if nbytes:
            _reply(W, mid, "paired_stage_put", name=name, offset=state["offset"], size=nbytes, digest=want)
            return
        if want != _digest(b""):
            raise ValueError("signed zero-length file hash mismatch")
        _append(bridge.STAGE + "/" + name, b"", 0)
        pending.pop(0)
    bridge.check_runtime(state["runtime"])
    # The offer becomes visible to the review command only after all files
    # and the signed envelope are durable. Nothing adds an approval here.
    os.sync()
    _flash_replace(bridge.OFFER_TMP, bridge.OFFER)
    _active = None
    _reply(W, mid, "paired_staged", digest=digest)


def _meta(W, mid, state, message):
    if "metadata" not in state:
        raise ValueError("signed stage metadata already received")
    total = state["total"]
    offset = state["offset"]
    part = memoryview(_chunk(message, offset, total - offset))
    used = 0
    for field in state["metadata"]:
        if offset >= len(field):
            offset -= len(field)
            continue
        size = min(len(part) - used, len(field) - offset)
        field[offset:offset + size] = part[used:used + size]
        used += size
        if used == len(part):
            break
        offset = 0
    state["offset"] += used
    if state["offset"] < total:
        _reply(W, mid, "paired_stage_meta", offset=state["offset"])
        return

    buffers = state.pop("metadata")
    del part, field
    signed = {name: bytes(buffers.pop(0)).decode() for name in ("release", "shelf", "sizes")}
    signed["sig"] = state["sig"]
    gc.collect()
    pair, _ = bridge.checked_offer(W, signed)
    sizes = pair.sizes(signed["sizes"].encode())
    if len(sizes) > MAX_FILES:
        raise ValueError("too many signed files")
    pending = []
    block = os.statvfs(bridge.ROOT)[1]
    allocated = 0
    buffer = bytearray(HASH_BUFFER)
    for name in sorted(sizes):
        nbytes = sizes[name]
        live = bridge.LIVE + "/" + name
        if _exists(live) and os.stat(live)[6] == nbytes and _sum(live, buffer) == pair.files[name]:
            continue
        pending.append((name, nbytes, pair.files[name]))
        allocated += ((nbytes + block - 1) // block + 1) * block
    # Signed metadata and installed policy are known before any stage
    # contents reach flash. Keep cleanup active if a durable write fails.
    bridge.clear_stage()
    state["durable"] = True
    with open(bridge.OFFER_TMP, "w") as stream:
        json.dump(signed, stream)
    offer_size = os.stat(bridge.OFFER_TMP)[6]
    if offer_size > bridge.MAX_OFFER:
        raise ValueError("stage metadata cannot fit the approval record")
    bridge._reserve(offer_size, allocated)
    if not _exists(bridge.STAGE):
        os.mkdir(bridge.STAGE)
    runtime = bridge.runtime_token(pair)
    state.clear()
    state.update(pending=pending, digest=pair.digest, offset=0, last=time.ticks_ms(),
                 runtime=runtime, durable=True)
    del signed, sizes, pair
    gc.collect()
    _cursor(W, mid, state)


def _put(W, mid, state, message):
    if not state.get("pending"):
        raise ValueError("signed manifest and reserve required before payload")
    name, size, want = state["pending"][0]
    if message["name"] != name:
        raise ValueError("file is not the current signed stage target")
    offset = state["offset"]
    part = _chunk(message, offset, size - offset, require_full=True)
    path = bridge.STAGE + "/" + name
    _append(path, part, offset)
    offset += len(part)
    if offset == size:
        if _sum(path) != want:
            raise ValueError("staged file hash mismatch")
        state["pending"].pop(0)
        offset = 0
    state["offset"] = offset
    _cursor(W, mid, state)


def handle(W, message):
    expire()
    mid, kind = message.get("id"), message["type"]
    if not W.SEALED or W.is_open():
        raise ValueError("paired staging requires sealed mode")
    if set(message) != KEYS[kind] | {"id", "type"} or type(mid) is not int:
        raise ValueError("unexpected staging request fields")
    if kind == "paired_stage_begin":
        _begin(W, mid, message)
        return
    if kind == "paired_stage_abort":
        if _exists(bridge.APPROVED):
            raise ValueError("a physically approved update cannot be cancelled via USB")
        _drop()
        _reply(W, mid, "paired_stage_aborted")
        return
    state = _active
    if state is None:
        raise ValueError("no paired upload in progress")
    try:
        if kind == "paired_stage_meta":
            _meta(W, mid, state, message)
        else:
            _put(W, mid, state, message)
        if _active is state:
            state["last"] = time.ticks_ms()
    except Exception:
        _drop()
        raise
