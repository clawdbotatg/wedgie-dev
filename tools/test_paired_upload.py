"""Exercise the local CLI's signed-byte and transport checks with a deterministic peer."""
import base64
import json
from pathlib import Path
import tempfile
import unittest

from paired_bundle import prepare
from paired_upload import Bundle, CHUNK, capture_signer, digest, healthy, offer, stage, verify_readback, wait_for_install

UID = "0000000000000000"
FILES = {"boot.py": b"boot", "main.py": b"main", "wedgie.mpy": b"core", "safe.mpy": b"S" * 2600}


def bundle_files(directory):
    shelf = ("@app  " + json.dumps({"mod": "safe", "name": "Safe Signer", "files": ["safe.mpy"]})
             + "\n" + digest(FILES["safe.mpy"]) + "  safe.mpy\n").encode()
    sizes = "".join(f"{len(value)}  {name}\n" for name, value in FILES.items()).encode()
    release = ("wedgie-release 1\nversion 0.3.91\n"
               + "".join(digest(FILES[name]) + "  " + name + "\n" for name in list(FILES)[:-1])
               + "@pair  " + json.dumps({"mod": "safe", "name": "Safe Signer", "v": "77"})
               + "\n@apps  " + digest(shelf) + "\n@sizes  " + digest(sizes) + "\n@serial  6\n").encode()
    # Fixture format only. The host requires a pinned digest; real signatures
    # are authenticated by firmware in the emulated USB integration test.
    inputs = {**FILES, "release.txt": release, "apps.txt": shelf, "sizes.txt": sizes,
              "release.sig": ("a" * 64 + " " + "b" * 64 + " 0\n").encode()}
    for name, data in inputs.items():
        (directory / name).write_bytes(data)
    return digest(release)


class Peer:
    def __init__(self, bundle, *, change=True, override=None):
        self.bundle, self.change, self.override = bundle, change, override
        self.meta = bytearray()
        self.payload = bytearray()
        self.calls = []
        self.sequence = ["paired_ready", "paired_accepted"]

    def request(self, message):
        kind = message["type"]
        self.calls.append(kind)
        stage = {"type": "paired_staged", "digest": self.bundle.pair.digest}
        cursor = {"type": "paired_stage_put", "name": "safe.mpy",
                  "offset": len(self.payload), "size": len(FILES["safe.mpy"]), "digest": digest(FILES["safe.mpy"])}
        if kind == "paired_stage_begin":
            if self.override == "refused_begin":
                return {"type": "error", "error": "busy"}
            reply = {"type": "paired_stage_meta", "offset": 0}
            if self.override == "bounded_chunk":
                reply["chunk"] = 512
            return reply
        if kind == "paired_stage_meta":
            assert message["offset"] == len(self.meta)
            self.meta.extend(base64.b64decode(message["data"], validate=True))
            if len(self.meta) < len(self.bundle.metadata):
                return {"type": "paired_stage_meta", "offset": len(self.meta)}
            assert self.meta == self.bundle.metadata
            if self.override == "unexpected_name":
                return dict(cursor, name="../saves")
            return cursor if self.change else stage
        if kind == "paired_stage_put":
            chunk = base64.b64decode(message["data"], validate=True)
            assert message["offset"] == len(self.payload) and 0 < len(chunk) <= CHUNK
            self.payload.extend(chunk)
            if self.override == "offset":
                return cursor
            if self.override == "incomplete":
                return stage
            if len(self.payload) == len(FILES["safe.mpy"]):
                assert self.payload == FILES["safe.mpy"]
                return dict(stage, digest="0" * 64) if self.override == "digest" else stage
            return dict(cursor, offset=len(self.payload))
        if kind == "paired_stage_abort":
            return {"type": "paired_stage_aborted"}
        if kind == "hello":
            return {"type": "hello", "sealed": True, "open": False, "uid": UID, "version": "0.3.91",
                    "running": None if self.override == "fallback" else "safe",
                    "carts": [{"mod": "safe", "v": "77"}], "solana_protocol": 1,
                    "safe_state": "ok", "signer": "changed" if self.override == "signer" else "fixture"}
        if kind == "sol_status":
            network = message["network"]
            return {"type": "sol_ok", "profile": {"network": network, "key":
                "changed" if self.override == "profile" else "fixture"}}
        if kind == "sums":
            hashes = dict(self.bundle.pair.files, serial=digest(b"6"))
            if self.override == "serial":
                hashes["serial"] = "bad"
            return {"type": "sums", "sums": {name: hashes[name] for name in message["names"]}}
        raise AssertionError(kind)

    def events(self, message, timeout):
        assert message == {"type": "paired_update"} and timeout > 60
        self.calls.append(message["type"])
        for tag in self.sequence:
            yield {"type": tag, "digest": self.bundle.pair.digest, "core": "0.3.91", "app": "Safe Signer",
                   "v": "70" if self.override == "prompt" else "77"}


class PairedUploadTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.release_hash = bundle_files(self.directory)
        self.bundle = Bundle(self.directory, self.release_hash)

    def test_staging_sends_bounded_chunks_and_no_button_request(self):
        peer = Peer(self.bundle)
        self.assertEqual(stage(peer, self.bundle)["digest"], self.release_hash)
        self.assertEqual(peer.calls.count("paired_stage_put"), 3)
        self.assertNotIn("paired_update", peer.calls)
        self.assertNotIn("press", peer.calls)

    def test_smaller_device_chunk_applies_to_metadata_and_payload(self):
        peer = Peer(self.bundle, override="bounded_chunk")
        self.assertEqual(stage(peer, self.bundle)["digest"], self.release_hash)
        self.assertEqual(peer.calls.count("paired_stage_put"), 6)

    def test_already_matching_pair_skips_payload(self):
        peer = Peer(self.bundle, change=False)
        self.assertEqual(stage(peer, self.bundle)["type"], "paired_staged")
        self.assertNotIn("paired_stage_put", peer.calls)

    def test_inconsistent_cursors_abort_owned_stage(self):
        for variant in ("unexpected_name", "offset", "incomplete", "digest"):
            with self.subTest(variant=variant):
                peer = Peer(self.bundle, override=variant)
                with self.assertRaises(ValueError):
                    stage(peer, self.bundle)
                self.assertEqual(peer.calls[-1], "paired_stage_abort")

    def test_rejected_begin_preserves_prior_session(self):
        peer = Peer(self.bundle, override="refused_begin")
        with self.assertRaisesRegex(ValueError, "busy"):
            stage(peer, self.bundle)
        self.assertEqual(peer.calls, ["paired_stage_begin"])

    def test_bundle_validation_rejects_wrong_hash_changed_file_and_symlink(self):
        with self.assertRaisesRegex(ValueError, "reviewed hash"):
            Bundle(self.directory, "0" * 64)
        file = self.directory / "safe.mpy"
        file.write_bytes(b"x" * len(FILES["safe.mpy"]))
        with self.assertRaisesRegex(ValueError, "signed bundle"):
            Bundle(self.directory, self.release_hash)
        file.unlink()
        file.symlink_to(self.directory / "boot.py")
        with self.assertRaisesRegex(ValueError, "regular bundle"):
            Bundle(self.directory, self.release_hash)

    def test_unsigned_preparation_keeps_the_stock_cart_fingerprint(self):
        release = self.directory / "release.txt"
        ordinary = b"".join(line for line in release.read_bytes().splitlines(keepends=True)
                            if not line.startswith((b"@pair  ", b"@sizes  ")))
        release.write_bytes(ordinary)
        destination = self.directory / "new"
        result = prepare(self.directory, destination, digest(ordinary), "safe")
        expected = digest(digest(FILES["safe.mpy"]).encode())[:12]
        self.assertEqual(result["cart_fingerprint"], expected)
        self.assertEqual(result["type"], "unsigned_pair")
        self.assertFalse((destination / "release.sig").exists())
        self.assertEqual(result["release_sha256"], digest((destination / "release.txt").read_bytes()))
        with self.assertRaisesRegex(ValueError, "must be new"):
            prepare(self.directory, destination, digest(ordinary), "safe")

    def test_unsigned_preparation_writes_nothing_if_reviewed_bytes_change(self):
        release = self.directory / "release.txt"
        ordinary = b"".join(line for line in release.read_bytes().splitlines(keepends=True)
                            if not line.startswith((b"@pair  ", b"@sizes  ")))
        release.write_bytes(ordinary)
        (self.directory / "safe.mpy").write_bytes(b"changed")
        destination = self.directory / "new"
        with self.assertRaisesRegex(ValueError, "differs from reviewed release"):
            prepare(self.directory, destination, digest(ordinary), "safe")
        self.assertFalse(destination.exists())

    def test_offer_requires_matching_preview_before_acceptance(self):
        peer = Peer(self.bundle)
        ready = []
        self.assertTrue(offer(peer, self.bundle, ready.append))
        self.assertEqual([report["v"] for report in ready], ["77"])
        peer.sequence = ["refused"]
        self.assertFalse(offer(peer, self.bundle, ready.append))
        peer.sequence = ["paired_accepted"]
        with self.assertRaisesRegex(ValueError, "verified device preview"):
            offer(peer, self.bundle, ready.append)
        peer.override = "prompt"
        peer.sequence = ["paired_ready"]
        with self.assertRaisesRegex(ValueError, "preview differs"):
            offer(peer, self.bundle, ready.append)
        self.assertEqual(len(ready), 1)

    def test_wait_for_reconnect_only_observes_matching_board_and_revision(self):
        new = Peer(self.bundle).request({"type": "hello"})
        old = dict(new, carts=[{"mod": "safe", "v": "70"}])

        class Port:
            def __init__(self, responses):
                self.responses = iter(responses)
                self.opens = 0

            def reopen(self, timeout):
                self.opens += 1
                return True

            def hello(self, timeout):
                return next(self.responses)

        port = Port([None, old, new])
        wait_for_install(port, self.bundle, UID, seconds=1)
        self.assertEqual(port.opens, 3)
        with self.assertRaisesRegex(ValueError, "selected sealed"):
            wait_for_install(Port([dict(new, uid="1" * 16)]), self.bundle, UID, seconds=1)

    def test_recovery_status_stops_normal_host_operations(self):
        status = {"type": "paired_recovery_status", "sealed": True, "open": False,
                  "writes": False, "reason": "paired_replay_incomplete"}
        with self.assertRaisesRegex(ValueError, "sealed read-only recovery"):
            healthy(status, UID)
        with self.assertRaisesRegex(ValueError, "Invalid Wedgie recovery"):
            healthy({**status, "writes": True}, UID)

    def test_readback_refuses_app_crash_with_unchanged_cart_record(self):
        peer = Peer(self.bundle, override="fallback")
        with self.assertRaisesRegex(ValueError, "running the approved"):
            verify_readback(peer, self.bundle, UID)
        self.assertNotIn("sums", peer.calls)

    def test_readback_compares_existing_signer_and_both_profiles(self):
        peer = Peer(self.bundle)
        before = capture_signer(peer, peer.request({"type": "hello"}))
        self.assertEqual(verify_readback(peer, self.bundle, UID, before), len(FILES))
        peer.override = "signer"
        with self.assertRaisesRegex(ValueError, "signer identity"):
            verify_readback(peer, self.bundle, UID, before)
        peer.override = "profile"
        with self.assertRaisesRegex(ValueError, "Solana profiles"):
            verify_readback(peer, self.bundle, UID, before)

    def test_readback_checks_seal_selected_uid_and_release_serial(self):
        peer = Peer(self.bundle)
        self.assertEqual(verify_readback(peer, self.bundle, UID), len(FILES))
        with self.assertRaisesRegex(ValueError, "selected sealed"):
            healthy(peer.request({"type": "hello"}), "1111111111111111")
        peer.override = "serial"
        with self.assertRaisesRegex(ValueError, "signed file"):
            verify_readback(peer, self.bundle, UID)


if __name__ == "__main__":
    unittest.main(verbosity=2)
