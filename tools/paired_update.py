"""Offline reference for a checked firmware + active app update.

This module only models a directory-backed flash. It has no device transport,
production signing keys, or entry point for installation on hardware.
"""

import json
import os
from pathlib import Path
import shutil
from typing import Callable, Mapping

from paired_update_boot import Pair, _check_files, _digest, _json, _sum, resume


CheckSignature = Callable[[bytes, str], bool]


def _sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write(path, data):
    with open(path, "wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def _write_json(path, value):
    _write(path, json.dumps(value, separators=(",", ":"), sort_keys=True).encode())


def _replace(source, dest):
    os.replace(source, dest)
    _sync_dir(os.path.dirname(dest))
    if os.path.dirname(source) != os.path.dirname(dest):
        _sync_dir(os.path.dirname(source))


class CheckedPairUpdate:
    """Directory-backed reference of one device. Its OS directory is trusted.

    The real port must authenticate and durably record its physical decision
    inside a bootstrap unavailable to USB writes. The caller supplies that
    physical decision here. A SHA-256 value alone never constitutes approval.
    """

    def __init__(self, root: Path, verify: CheckSignature):
        self.root = root
        self.stage = root / "stage"
        self.live = root / "live"
        self.state = root / "installed.json"
        self.journal = root / "approved.json"
        self.verify = verify

    def approve(self, release: bytes, signature: str, shelf: bytes, uploads: Mapping[str, bytes], ask):
        """Stage the exact signed pair and ask once. False leaves live state intact.

        Ask receives immutable display fields, in order: core version, app name,
        app version, release serial, release digest. It returns True only for a
        timely green press. Failure before the durable journal never commits.
        """
        if self.journal.exists():
            raise ValueError("finish the approved update before asking again")
        pair = Pair.parse(release, signature, shelf, self.verify)
        previous = _json(self.state.read_bytes())
        pair.check_upgrade(previous)
        if uploads.keys() - pair.files.keys():
            raise ValueError("file is outside the signed pair")
        shutil.rmtree(self.stage, ignore_errors=True)
        self.stage.mkdir()
        try:
            for name, expected in pair.files.items():
                if name in uploads:
                    body = uploads[name]
                    if _digest(body) != expected:
                        raise ValueError("incorrect uploaded file: " + name)
                    _write(self.stage / name, body)
                elif _sum(self.live / name) != expected:
                    raise ValueError("missing file: " + name)
            _sync_dir(self.stage)
            _sync_dir(self.root)
            if ask(pair.core, pair.app["name"], pair.app["v"], pair.serial, pair.digest) is not True:
                return False
            # The payload was staged before the press: the host never changes
            # the envelope or staged payload after it.
            _check_files(pair, str(self.stage), str(self.live))
            receipt = {"digest": pair.digest, "release": release.decode(), "sig": signature,
                       "shelf": shelf.decode(), "previous": previous}
            temp = self.root / "approved.tmp"
            _write_json(temp, receipt)
            _replace(temp, self.journal)
            return True
        finally:
            if not self.journal.exists():
                shutil.rmtree(self.stage, ignore_errors=True)

    def resume(self, checkpoint=None):
        """Recheck approval and roll forward before enabling the app."""
        result = resume(str(self.root), self.verify, _replace, _write_json, _sync_dir, checkpoint)
        shutil.rmtree(self.stage, ignore_errors=True)
        return result
