"""Render the opt-in stock migration boot gate for a reviewed local image."""

import re
from textwrap import indent

DORMANT_WORKERS = (
    "pair_activate.mpy", "paired_bridge.mpy", "paired_staging.mpy",
    "paired_update_boot.mpy", "pair_verify.mpy", "pair_policy.mpy",
)
MEASURED = DORMANT_WORKERS + ("wedgie.mpy", "slot.mpy", "main.py")
START = b"# An isolated image may provision"
END = b"try:                                    # ship mode"
DIAGNOSTIC_MAIN_SHA256 = "8f6e1da0c8ca2be6d8b82cf7fe6218013eb74221a521abecef8893d8b24fe536"

GATE = '''
def _paired_activate_boot():
    import binascii
    import hashlib
    import os
    import sys

    with open("/serial", "rb") as stream:
        raw = stream.read(19)
    if not 0 < len(raw) <= 18 or any(c < 48 or c > 57 for c in raw):
        raise ValueError("invalid installed release serial")
    serial = int(raw)
    if raw != str(serial).encode():
        raise ValueError("noncanonical installed release serial")
    if serial == _paired_dormant_serial:
        # Activation files can be copied before the stock job writes its
        # serial. Leave the stock path in charge only at its exact prior
        # serial, before this board has published a paired state or receipt.
        for marker in ("installed.json", "approved.json", "active-release.json"):
            try:
                os.stat("/._paired/" + marker)
            except OSError as error:
                if error.args[0] != 2:
                    raise
            else:
                raise ValueError("stock fallback after paired activation")
        return
    if serial < _paired_activation_serial:
        raise ValueError("uncommitted or rolled-back paired bootstrap")

    buffer = bytearray(512)
    view = memoryview(buffer)
    for name, expected in _paired_measured:
        digest = hashlib.sha256()
        with open("/" + name, "rb") as stream:
            while True:
                length = stream.readinto(buffer)
                if not length:
                    break
                digest.update(view[:length])
        if binascii.hexlify(digest.digest()).decode() != expected:
            raise ValueError("paired bootstrap content changed: " + name)
        if name.endswith(".mpy"):
            try:
                os.stat("/" + name[:-4] + ".py")
            except OSError as error:
                if error.args[0] != 2:
                    raise
            else:
                raise ValueError("source shadows measured bootstrap: " + name)

    # Restrict the worker imports to the files measured above. The stock
    # import search path is restored before ordinary app startup.
    paths = sys.path
    sys.path = ["/"]
    try:
        for module in ("pair_activate", "paired_bridge", "paired_staging", "paired_update_boot",
                       "pair_verify", "pair_policy", "wedgie", "slot"):
            if module in sys.modules:
                raise ValueError("paired bootstrap module imported before measurement")
        import pair_activate
        checked_core = pair_activate.activate()
        if checked_core:
            import wedgie
            wedgie.VERSION = checked_core
    finally:
        sys.path = paths
        sys.modules.pop("pair_activate", None)


try:
    _paired_activate_boot()
except BaseException as e:
    import time
    print("PAIR SEALED RECOVERY", e)
    while True:
        time.sleep_ms(100)
del _paired_activate_boot, _paired_measured, _paired_dormant_serial, _paired_activation_serial

'''


RECOVERY_ON_FAILURE = '''
_paired_recovery = None
try:
    _paired_activate_boot()
except BaseException:
    _recovery_trusted = False
    try:
        import binascii, hashlib
        _digest = hashlib.sha256()
        with open("/main.py", "rb") as _stream:
            for _ in range(32):
                _chunk = _stream.read(512)
                if not _chunk:
                    _recovery_trusted = binascii.hexlify(_digest.digest()).decode() == _paired_recovery_digest
                    break
                _digest.update(_chunk)
    except BaseException:
        pass
    if not _recovery_trusted:
        while True:
            try:
                import time
                time.sleep_ms(100)
            except BaseException:
                pass
    _paired_recovery = "integrity_check_failed"
del _paired_activate_boot, _paired_measured, _paired_dormant_serial, _paired_activation_serial
del _paired_recovery_digest

'''


def activation_boot(original_boot_bytes, hashes, dormant_serial, activation_serial, *, diagnostics=False) -> bytes:
    if set(hashes) != set(MEASURED) or any(not re.fullmatch(r"[0-9a-f]{64}", sha) for sha in hashes.values()):
        raise ValueError("Supply exact SHA-256 digests for every verified bootstrap file")
    if (type(dormant_serial) is not int or type(activation_serial) is not int
            or not 0 < dormant_serial < activation_serial < 10**18):
        raise ValueError("Dormant and activation serials must be distinct increasing positive integers")
    if (original_boot_bytes.count(START) != 1 or original_boot_bytes.count(END) != 1
            or b"PAIRED_UPDATE_BENCH = False\n" not in original_boot_bytes):
        raise ValueError("Unexpected stock/bench boot layout")
    first, last = original_boot_bytes.index(START), original_boot_bytes.index(END)
    if first >= last:
        raise ValueError("Unexpected stock/bench boot layout")
    config = f"_paired_dormant_serial = {dormant_serial}\n_paired_activation_serial = {activation_serial}\n"
    config += f"_paired_measured = {tuple((n, hashes[n]) for n in MEASURED)!r}\n"
    continuation = original_boot_bytes[last:]
    gate = GATE
    if diagnostics:
        if hashes["main.py"] != DIAGNOSTIC_MAIN_SHA256:
            raise ValueError("Diagnostics require the exact reviewed recovery main.py")
        config += f"_paired_recovery_digest = {DIAGNOSTIC_MAIN_SHA256!r}\n"
        gate = GATE[:GATE.index("\n\ntry:\n    _paired_activate_boot()")] + "\n\n" + RECOVERY_ON_FAILURE
        # Only built-in CDC and the pinned main may run after an integrity error.
        continuation = b"if _paired_recovery is None:\n" + indent(continuation.decode(), "    ").encode()
    return original_boot_bytes[:first] + (config + gate).encode() + continuation
