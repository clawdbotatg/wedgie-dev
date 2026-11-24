"""Opt-in staged integration fixture for a sealed Wedgie emulator image.

The fixture provisioner installs this module and pins the recovery verifier.
The stage cannot approve itself or select arbitrary paths.
"""

import os

ROOT = "/._paired"
LIVE = ""
OFFER = ROOT + "/offer.json"
APPROVED = ROOT + "/approved.json"
STATE = ROOT + "/installed.json"
STAGE = ROOT + "/stage"
META = ROOT + "/metadata.tmp"
OFFER_TMP = ROOT + "/offer.tmp"
VERSION_RECEIPT = ROOT + "/active-release.json"
RUNTIME_FILE = "pair_core.py"
MAX_OFFER = 16384
FREE_MARGIN = 65536


def versioned():
    import pair_policy
    return getattr(pair_policy, "VERSIONED", False)


def _verify(data, signature):
    import pair_verify
    from paired_update_boot import _hash
    from pair_policy import RELEASE_KEYS

    pieces = signature.split()
    if len(pieces) not in (2, 3):
        return False
    try:
        i = int(pieces[2]) if len(pieces) == 3 else 0
        if not 0 <= i < len(RELEASE_KEYS):
            return False
        x, y = (int(q, 16) for q in RELEASE_KEYS[i])
        r, s = (int(q, 16) for q in pieces[:2])
    except ValueError:
        return False
    return pair_verify.verify(x, y, _hash(data), r, s)


def _policy(pair, previous):
    from paired_update_boot import HASH_BUFFER, _sum
    from pair_policy import PINNED, NO_WRITE, SHADOW

    if not versioned() and pair.core != previous["core"]:
        raise ValueError("paired bench keeps the installed core version")
    runtime_token(pair)
    if any(n in pair.files for n in NO_WRITE):
        raise ValueError("pair would replace the recovery worker")
    if any(n.split(".")[0] in SHADOW for n in pair.files):
        raise ValueError("pair uses a reserved module name")
    buffer = bytearray(HASH_BUFFER)
    for name in PINNED:
        if pair.files.get(name) != _sum(LIVE + "/" + name, buffer):
            raise ValueError("pair would replace the stable bootstrap")
    with open(LIVE + "/serial") as stream:
        serial = int(stream.read())
    if serial not in (previous["serial"], pair.serial):
        raise ValueError("installed serial changed")


def _reserve(size, payload=0):
    fs = os.statvfs(ROOT)
    # Leave flash for the journal, its atomic replacement, and LittleFS
    # metadata. The complete payload was already written into staging.
    if fs[1] * fs[4] < FREE_MARGIN + 2 * size + payload:
        raise ValueError("insufficient free flash for paired update")


def _unlink(path):
    try:
        os.remove(path)
    except OSError as e:
        if e.args[0] != 2:
            raise


def clear_stage():
    for path in (OFFER, META, OFFER_TMP, ROOT + "/approval.tmp", ROOT + "/active-release.tmp"):
        _unlink(path)
    try:
        names = os.listdir(STAGE)
    except OSError as e:
        if e.args[0] != 2:
            raise
        return
    for name in names:
        _unlink(STAGE + "/" + name)
    os.sync()


def checked_offer(W, signed):
    from pair_policy import RELEASE_KEYS
    from paired_update_boot import _parse_offer, _read

    if tuple(W.RELEASE_KEYS) != tuple(RELEASE_KEYS):
        raise ValueError("installed release-key policy changed")
    if set(signed) not in ({"release", "sig", "shelf"}, {"release", "sig", "shelf", "sizes"}):
        raise ValueError("unexpected offer metadata")
    previous = {"core": W.VERSION, "serial": W.serial(), "app": W.active()}
    if not previous["app"] or previous != _read(STATE):
        raise ValueError("staged pair does not match installed firmware and app")
    pair = _parse_offer(signed, _verify)
    pair.check_upgrade(previous)
    _policy(pair, previous)
    return pair, previous


def runtime_token(pair):
    if not versioned():
        return None
    if RUNTIME_FILE not in pair.files or "pair_core.mpy" in pair.files:
        raise ValueError("missing signed executable core version module")
    return pair.core, pair.files[RUNTIME_FILE]


def check_runtime(token, staged=True):
    if token is None:
        return
    from paired_update_boot import _exists, _sum
    core, digest = token
    if _exists(LIVE + "/pair_core.mpy"):
        raise ValueError("unexpected runtime shadow")
    source = STAGE + "/" + RUNTIME_FILE
    if not staged or not _exists(source):
        source = LIVE + "/" + RUNTIME_FILE
    if not _exists(source) or os.stat(source)[6] > 1024 or _sum(source) != digest:
        raise ValueError("runtime module does not match the signed pair")
    with open(source, "rb") as stream:
        line = stream.read(64).split(b"\n", 1)[0]
    if line != ('VERSION = "%s"' % core).encode():
        raise ValueError("signed runtime version mismatch")


def _runtime_version(pair):
    check_runtime(runtime_token(pair), staged=False)
    # Version code is loaded only from the exact signed, installed bytes.
    import pair_core
    if pair_core.VERSION != pair.core:
        raise ValueError("running core version differs from signed release")
    return pair.core


def _archive(journal):
    from paired_update_boot import HASH_BUFFER, _flash_replace
    path = ROOT + "/active-release.tmp"
    buffer = bytearray(HASH_BUFFER)
    view = memoryview(buffer)
    with open(journal, "rb") as source, open(path, "wb") as destination:
        while True:
            length = source.readinto(buffer)
            if not length:
                break
            if destination.write(view[:length]) != length:
                raise OSError("short active release write")
    os.sync()
    _flash_replace(path, VERSION_RECEIPT)


def _reject_source_shadows(files):
    from paired_update_boot import _exists
    if any(n.endswith(".mpy") and n[:-4] + ".py" not in files and _exists(LIVE + "/" + n[:-4] + ".py")
           for n in files):
        raise ValueError("unsigned source shadows the active release")


def _check_baseline(state):
    from pair_policy import BASELINE_HASHES, BASELINE_STATE
    from paired_update_boot import HASH_BUFFER, _read, _sum

    if not BASELINE_HASHES or state != BASELINE_STATE or _read(LIVE + "/apps.json") != [BASELINE_STATE["app"]]:
        raise ValueError("missing active version receipt outside the provisioned baseline")
    with open(LIVE + "/serial") as stream:
        if stream.read() != str(BASELINE_STATE["serial"]):
            raise ValueError("missing active version receipt with changed baseline serial")
    buffer = bytearray(HASH_BUFFER)
    for name in BASELINE_HASHES:
        if _sum(LIVE + "/" + name, buffer) != BASELINE_HASHES[name]:
            raise ValueError("provisioned baseline content is missing or changed: " + name)
    _reject_source_shadows(BASELINE_HASHES)


def _stored_version():
    if not versioned():
        return None
    from paired_update_boot import _check_files, _exists, _parse_offer, _read
    state = _read(STATE)
    if not _exists(VERSION_RECEIPT):
        _check_baseline(state)
        return None
    receipt = _read(VERSION_RECEIPT)
    pair = _parse_offer(receipt, _verify)
    previous = receipt["previous"]
    pair.check_upgrade(previous)
    if pair.digest != receipt["digest"] or state != pair.state() or _read(LIVE + "/apps.json") != [pair.app]:
        raise ValueError("active release, core or app identity changed")
    with open(LIVE + "/serial") as state_file:
        if int(state_file.read()) != pair.serial:
            raise ValueError("active release serial changed")
    _policy(pair, previous)
    _check_files(pair, LIVE, LIVE)
    _reject_source_shadows(pair.files)
    return _runtime_version(pair)


def early_boot():
    from paired_update_boot import _exists

    # The stock installer mutates the app and serial outside the paired
    # receipt. On an enrolled image only the paired writer may do that.
    if versioned() and _exists(LIVE + "/_job.json"):
        raise ValueError("Pending stock install conflicts with paired activation")
    # Reuse the previous stock boot path when nothing was approved.
    try:
        os.stat(APPROVED)
    except OSError as e:
        if e.args[0] != 2:
            raise
        try:
            os.stat(OFFER)
        except OSError as missing:
            if missing.args[0] != 2:
                raise
            clear_stage()              # an interrupted USB upload never approved anything
        return _stored_version()
    from paired_update_boot import resume
    from pair_policy import checkpoint
    running = [None]

    def finalize(pair, journal):
        running[0] = _runtime_version(pair)
        _archive(journal)

    use_runtime = versioned()
    if resume(ROOT, _verify, checkpoint=checkpoint, live="/", check_policy=_policy, update_serial=True,
              check_inputs=lambda pair: check_runtime(runtime_token(pair)), finalize=finalize if use_runtime else None):
        clear_stage()
        print("PAIR RESUMED")
    return running[0]


def offer(W, display, request):
    import gc
    import time
    import ui
    from paired_update_boot import _check_files, _exists, _flash_replace, _flash_write, _read

    mid = request.get("id")
    if set(request) - {"id", "type"} or not W.SEALED or W.is_open():
        raise ValueError("sealed staged request with no arguments required")
    if _exists(APPROVED) or not _exists(OFFER):
        raise ValueError("no staged pair available")
    length = os.stat(OFFER)[6]
    if not (0 < length <= MAX_OFFER):
        raise ValueError("staged offer exceeds size limit")
    _reserve(length)
    # The offer only exists after the upload is durable. Its RAM-only
    # transport can be loaded again for a later upload.
    import sys
    sys.modules.pop("paired_staging", None)
    gc.collect()
    signed = _read(OFFER)
    pair, previous = checked_offer(W, signed)
    _check_files(pair, STAGE, LIVE)
    check_runtime(runtime_token(pair))
    gc.collect()

    def ready(_):
        # ui.ask calls this after drawing the sheet. It alone reads physical
        # buttons, and this notification does not carry an approval token.
        W.send({"id": mid, "type": "paired_ready", "core": pair.core, "app": pair.app["name"],
                "v": pair.app["v"], "digest": pair.digest})
        return True

    if not ui.ask(display, "Update both?", ["Core " + pair.core, "App v" + pair.app["v"]],
                  big=pair.app["name"], sig=ready):
        clear_stage()
        W.send({"id": mid, "type": "refused"})
        time.sleep_ms(200)
        return True

    _reserve(length)
    _check_files(pair, STAGE, LIVE)
    check_runtime(runtime_token(pair))
    signed["digest"] = pair.digest
    signed["previous"] = previous
    temp = ROOT + "/approval.tmp"
    _flash_write(temp, signed)
    _flash_replace(temp, APPROVED)
    W.send({"id": mid, "type": "paired_accepted", "digest": pair.digest})
    time.sleep_ms(200)
    import machine
    machine.reset()
