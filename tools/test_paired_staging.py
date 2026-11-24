#!/usr/bin/env python3
"""Offline staging transport checks, with all flash paths in a temporary folder."""

from base64 import b64encode
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_paired_update import APP, APP_FILES, CORE, release_pair, wedgie
import paired_update_boot
from paired_update_boot import Pair

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
import paired_bridge as bridge
import paired_staging as stage


class StageChecks(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.live = self.root / "live"
        self.live.mkdir()
        private = self.root / "private"
        private.mkdir()
        self.paths = dict(ROOT=str(private), LIVE=str(self.live), STAGE=str(private / "stage"),
                          META=str(private / "metadata.tmp"), OFFER=str(private / "offer.json"),
                          OFFER_TMP=str(private / "offer.tmp"), STATE=str(private / "installed.json"),
                          VERSION_RECEIPT=str(private / "active-release.json"),
                          APPROVED=str(private / "approved.json"))
        change = patch.multiple(bridge, **self.paths)
        change.start()
        self.addCleanup(change.stop)
        clock = [0]
        self.clock = clock
        for module, name, target in [(time, "ticks_ms", lambda: clock[0]), (time, "ticks_diff", lambda a, b: a - b),
                                     (os, "sync", lambda: None), (bridge, "_verify", wedgie.release_ok)]:
            edit = patch.object(module, name, target, create=True)
            edit.start()
            self.addCleanup(edit.stop)
        previous = {"core": "0.3.91", "serial": 5, "app": {"mod": "safe", "name": "Safe Signer", "v": "70"}}
        self.policy = SimpleNamespace(RELEASE_KEYS=wedgie.RELEASE_KEYS, PINNED=("boot.py",), NO_WRITE=(),
                                      SHADOW=("json",), VERSIONED=False, BASELINE_STATE=previous,
                                      BASELINE_HASHES={"boot.py": sha256(CORE["boot.py"]).hexdigest()})
        files = patch.dict(sys.modules, pair_policy=self.policy)
        files.start()
        self.addCleanup(files.stop)
        stage._active = None
        Path(bridge.STATE).write_text(json.dumps(previous))
        (self.live / "serial").write_text("5")
        (self.live / "boot.py").write_bytes(CORE["boot.py"])
        self.out = []
        self.w = SimpleNamespace(SEALED=True, is_open=lambda: False, RELEASE_KEYS=wedgie.RELEASE_KEYS, VERSION=previous["core"],
                                 serial=lambda: previous["serial"], active=lambda: previous["app"], send=self.out.append)
        self.target = {**CORE, **APP_FILES}
        self.target["main.py"] = b"x" * (stage.MAX_CHUNK + 9)
        self.envelope()

    def envelope(self, alter_sizes=None, version="0.3.91"):
        sizes = "".join("%d  %s\n" % (len(body), name) for name, body in sorted(self.target.items())).encode()
        if alter_sizes:
            sizes = alter_sizes(sizes)
        release, self.signature, shelf = release_pair({k: v for k, v in self.target.items() if k != "safe.mpy"},
                                                      APP, APP_FILES, version=version,
                                                      extra="@sizes  " + sha256(sizes).hexdigest() + "\n")
        self.metadata = release + shelf + sizes
        self.release_digest = sha256(release).hexdigest()
        self.begin_args = {"release_size": len(release), "shelf_size": len(shelf), "sizes_size": len(sizes)}
        return release, self.signature, shelf, sizes

    def run_stage(self, method, **fields):
        stage.handle(self.w, {"id": len(self.out), "type": "paired_stage_" + method, **fields})
        return self.out[-1]

    def begin(self, sig=None):
        return self.run_stage("begin", **self.begin_args, sig=sig or self.signature)

    def chunk(self, method, offset, part, **fields):
        return self.run_stage(method, offset=offset, data=b64encode(part).decode(), **fields)

    def metadata_done(self, sig=None):
        self.assertEqual(self.begin(sig)["type"], "paired_stage_meta")
        for pos in range(0, len(self.metadata), 113):
            last = self.chunk("meta", pos, self.metadata[pos:pos + 113])
        return last

    def assert_cleared(self):
        self.assertFalse(Path(bridge.META).exists())
        self.assertFalse(Path(bridge.OFFER).exists())
        self.assertFalse(Path(bridge.APPROVED).exists())
        self.assertFalse(list(Path(bridge.STAGE).glob("*")))
        self.assertIsNone(stage._active)

    def test_valid_delta_is_staged_and_never_approved(self):
        cursor = self.metadata_done()
        for name in sorted(set(self.target) - {"boot.py"}):
            data = self.target[name]
            for offset in range(0, len(data), stage.MAX_CHUNK):
                self.assertEqual((cursor["name"], cursor["offset"], cursor["size"], cursor["digest"]),
                                 (name, offset, len(data), sha256(data).hexdigest()))
                cursor = self.chunk("put", offset, data[offset:offset + stage.MAX_CHUNK], name=name)
        self.assertEqual(cursor["type"], "paired_staged")
        self.assertEqual(cursor["digest"], self.release_digest)
        self.assertTrue(Path(bridge.OFFER).exists())
        self.assertFalse(Path(bridge.APPROVED).exists())
        self.assertFalse((self.live / "safe.mpy").exists())
        with self.assertRaisesRegex(ValueError, "already pending"):
            self.begin()
        self.assertEqual(self.run_stage("abort")["type"], "paired_stage_aborted")
        self.assert_cleared()

    def test_signed_but_inconsistent_core_never_creates_an_offer(self):
        self.policy.VERSIONED = True
        self.target[bridge.RUNTIME_FILE] = b'VERSION = "0.3.93"\n'
        self.envelope(version="0.3.92")
        self.metadata_done()
        with self.assertRaisesRegex(ValueError, "runtime version mismatch"):
            for name in sorted(set(self.target) - {"boot.py"}):
                data = self.target[name]
                for offset in range(0, len(data), stage.MAX_CHUNK):
                    self.chunk("put", offset, data[offset:offset + stage.MAX_CHUNK], name=name)
        self.assert_cleared()

    def test_active_receipt_reauthenticates_runtime_and_required_files(self):
        self.policy.VERSIONED = True
        self.target[bridge.RUNTIME_FILE] = b'VERSION = "0.3.92"\ndef status(): return VERSION\n'
        release, sig, shelf, sizes = self.envelope(version="0.3.92")
        pair = Pair.parse(release, sig, shelf, wedgie.release_ok)
        previous = json.loads(Path(bridge.STATE).read_text())
        for name, body in self.target.items():
            (self.live / name).write_bytes(body)
        Path(bridge.STATE).write_text(json.dumps(pair.state()))
        (self.live / "serial").write_text(str(pair.serial))
        (self.live / "apps.json").write_text(json.dumps([pair.app]))
        with self.assertRaisesRegex(ValueError, "missing active version"):
            bridge._stored_version()
        receipt = {"release": release.decode(), "sig": sig, "shelf": shelf.decode(), "sizes": sizes.decode(),
                   "previous": previous, "digest": pair.digest}
        Path(bridge.VERSION_RECEIPT).write_text(json.dumps(receipt))
        with patch.dict(sys.modules, pair_core=SimpleNamespace(VERSION="0.3.93")):
            with self.assertRaisesRegex(ValueError, "running core version differs"):
                bridge._stored_version()
        with patch.dict(sys.modules, pair_core=SimpleNamespace(VERSION="0.3.92")):
            self.assertEqual(bridge._stored_version(), "0.3.92")
            (self.live / "main.py").write_bytes(b"corrupted")
            with self.assertRaisesRegex(ValueError, "changed: main.py"):
                bridge._stored_version()

    def test_missing_active_receipt_allows_only_the_provisioned_baseline(self):
        self.policy.VERSIONED = True
        previous = self.policy.BASELINE_STATE
        metadata = self.live / "apps.json"
        metadata.write_text(json.dumps([previous["app"]]))
        self.assertIsNone(bridge.early_boot())

        metadata.write_text(json.dumps([dict(previous["app"], v="71")]))
        with self.assertRaisesRegex(ValueError, "outside the provisioned baseline"):
            bridge.early_boot()
        metadata.write_text(json.dumps([previous["app"]]))
        serial = self.live / "serial"
        serial.write_text("6")
        with self.assertRaisesRegex(ValueError, "changed baseline serial"):
            bridge.early_boot()
        serial.write_text("5")
        (self.live / "boot.py").write_bytes(b"changed fixture boot")
        with self.assertRaisesRegex(ValueError, "baseline content is missing or changed: boot.py"):
            bridge.early_boot()

    def test_same_core_activation_requires_its_receipt_after_reboot(self):
        self.policy.VERSIONED = True
        self.target[bridge.RUNTIME_FILE] = b'VERSION = "0.3.91"\n'
        release, sig, shelf, sizes = self.envelope(version="0.3.91")
        pair = Pair.parse(release, sig, shelf, wedgie.release_ok)
        previous = self.policy.BASELINE_STATE
        for name, body in self.target.items():
            (self.live / name).write_bytes(body)
        Path(bridge.STATE).write_text(json.dumps(pair.state()))
        (self.live / "serial").write_text(str(pair.serial))
        (self.live / "apps.json").write_text(json.dumps([pair.app]))
        signed = {"release": release.decode(), "sig": sig, "shelf": shelf.decode(), "sizes": sizes.decode(),
                  "previous": previous, "digest": pair.digest}
        receipt = Path(bridge.VERSION_RECEIPT)
        receipt.write_text(json.dumps(signed))
        with patch.dict(sys.modules, pair_core=SimpleNamespace(VERSION="0.3.91")):
            self.assertEqual(bridge.early_boot(), "0.3.91")
        receipt.unlink()
        with self.assertRaisesRegex(ValueError, "outside the provisioned baseline"):
            bridge.early_boot()

    def test_unsigned_or_modified_sizes_cannot_receive_payload(self):
        with self.assertRaisesRegex(ValueError, "signature"):
            self.metadata_done("0" * 64 + self.signature[64:])
        self.assert_cleared()
        self.metadata = self.metadata[:-2] + b"Z\n"
        with self.assertRaisesRegex(ValueError, "sizes hash"):
            self.metadata_done()
        self.assert_cleared()

    def test_duplicate_begin_does_not_replace_stream(self):
        self.begin()
        self.chunk("meta", 0, self.metadata[:50])
        with self.assertRaisesRegex(ValueError, "already pending"):
            self.begin()
        self.assertFalse(Path(bridge.META).exists())
        self.assertEqual(stage._active["metadata"][0][:50], self.metadata[:50])
        self.assertEqual(self.chunk("meta", 50, self.metadata[50:80])["offset"], 80)

    def test_noncanonical_base64_is_rejected_before_decoding(self):
        for value in ("Y=Jj", "YWJj\n", "YQ=/", "YR==", "YWJ=", "YWJj!"):
            with self.subTest(value=value), patch.object(stage.binascii, "a2b_base64", side_effect=AssertionError):
                with self.assertRaises(ValueError):
                    stage._chunk({"offset": 0, "data": value}, 0, stage.MAX_CHUNK)
        for value, expected in (("YQ==", b"a"), ("YWI=", b"ab"), ("YWJj", b"abc")):
            self.assertEqual(stage._chunk({"offset": 0, "data": value}, 0, stage.MAX_CHUNK), expected)

    def test_invalid_metadata_never_attempts_a_flash_write(self):
        with patch.object(stage, "_append", side_effect=AssertionError("unauthenticated flash write")), \
             patch.object(stage, "open", side_effect=AssertionError("unauthenticated offer write"), create=True):
            with self.assertRaisesRegex(ValueError, "signature"):
                self.metadata_done("0" * 64 + self.signature[64:])
        self.assert_cleared()

    def test_incomplete_payload_chunk_never_appends_flash(self):
        self.metadata_done()
        with patch.object(stage, "_append", side_effect=AssertionError("undersized flash write")):
            with self.assertRaisesRegex(ValueError, "fill the signed cursor"):
                self.chunk("put", 0, b"x", name="main.py")
        self.assert_cleared()

    def test_unauthorized_or_out_of_order_payload_aborts_session(self):
        self.begin()
        with self.assertRaisesRegex(ValueError, "manifest and reserve"):
            self.chunk("put", 0, b"raw", name="main.py")
        self.assert_cleared()
        self.metadata_done()
        with self.assertRaisesRegex(ValueError, "out-of-order"):
            self.chunk("put", 1, b"raw", name="main.py")
        self.assert_cleared()
        self.metadata_done()
        with self.assertRaisesRegex(ValueError, "current signed stage target"):
            self.chunk("put", 0, b"x", name="../main.py")
        self.assert_cleared()

    def test_exact_length_but_wrong_hash_is_refused(self):
        self.metadata_done()
        self.chunk("put", 0, b"x" * stage.MAX_CHUNK, name="main.py")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.chunk("put", stage.MAX_CHUNK, b"!" * 9, name="main.py")
        self.assert_cleared()

    def test_reservation_is_checked_after_signed_sizes(self):
        # Enough room for metadata and journal, but not for the full delta.
        with patch.object(os, "statvfs", lambda _: (4096, 4096, 0, 0, 19)):
            with self.assertRaisesRegex(ValueError, "insufficient free flash"):
                self.metadata_done()
        self.assert_cleared()

    def test_interruption_and_expiry_remove_partial_metadata(self):
        self.begin()
        self.chunk("meta", 0, self.metadata[:50])
        self.clock[0] = stage.IDLE_MS + 1
        stage.expire()
        self.assert_cleared()
        self.begin()
        self.chunk("meta", 0, self.metadata[:50])
        stage._active = None  # equivalent of reboot dropping RAM
        bridge.early_boot()
        self.assert_cleared()

    def test_no_changed_bytes_requires_no_put(self):
        for name, body in self.target.items():
            (self.live / name).write_bytes(body)
        self.assertEqual(self.metadata_done()["type"], "paired_staged")
        self.assertFalse(list(Path(bridge.STAGE).glob("*")))
        self.assertFalse(Path(bridge.APPROVED).exists())

    def test_signed_size_entries_are_unique_and_complete(self):
        release, sig, shelf, sizes = self.envelope(lambda raw: raw + raw.splitlines()[0] + b"\n")
        pair = Pair.parse(release, sig, shelf, wedgie.release_ok)
        with self.assertRaisesRegex(ValueError, "duplicate signed size"):
            pair.sizes(sizes)
        release, sig, shelf, sizes = self.envelope(lambda raw: raw[raw.index(b"\n") + 1:])
        pair = Pair.parse(release, sig, shelf, wedgie.release_ok)
        with self.assertRaisesRegex(ValueError, "do not cover"):
            pair.sizes(sizes)

    def test_file_hash_never_requests_a_large_read(self):
        body = bytes(range(256)) * 17 + b"tail"
        path = self.live / "real.bin"
        path.write_bytes(body)

        class StrictStream(BytesIO):
            def read(self, *args):
                raise AssertionError("hash must reuse a readinto buffer")

            def readinto(self, buffer):
                if len(buffer) > 512:
                    raise AssertionError("hash read exceeded heap budget")
                return super().readinto(buffer)

        with patch.object(paired_update_boot, "open", lambda *_: StrictStream(body), create=True):
            self.assertEqual(paired_update_boot._sum(path), sha256(body).hexdigest())


if __name__ == "__main__":
    unittest.main(verbosity=2)
