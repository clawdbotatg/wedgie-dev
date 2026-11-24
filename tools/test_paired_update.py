#!/usr/bin/env python3
"""Run on a Mac or Linux with python3 -B tools/test_paired_update.py."""

from hashlib import sha256
import json
import os
from pathlib import Path
from secrets import randbelow
import sys
import tempfile
import types
import unittest

from paired_update import CheckedPairUpdate, Pair

# Use the firmware's actual release verification, with a process-local
# throwaway identity in place of the vendor/owner release keys.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "firmware"))
sys.modules["machine"] = types.ModuleType("machine")
import p256
import wedgie

PRIVATE = randbelow(p256.N - 1) + 1
wedgie.RELEASE_KEYS = (tuple("%064x" % point for point in p256.pubkey(PRIVATE)),)


def sign(data):
    nonce = randbelow(p256.N - 1) + 1
    digest = int.from_bytes(sha256(data).digest(), "big")
    r = p256._affine(p256._mul(nonce, (p256.GX, p256.GY, 1)))[0] % p256.N
    s = p256.inv(nonce, p256.N) * (digest + r * PRIVATE) % p256.N
    return "%064x %064x" % (r, min(s, p256.N - s))


def files_text(files):
    return "".join(sha256(body).hexdigest() + "  " + name + "\n" for name, body in files.items())


def release_pair(core, app, files, serial=6, version="0.3.91", extra="", target=None):
    shelf = ("@app  " + json.dumps(app) + "\n" + files_text(files)).encode()
    target = target or {"mod": app["mod"], "name": app["name"], "v": "77"}
    release = ("wedgie-release 1\nversion " + version + "\n" + files_text(core)
               + "@apps  " + sha256(shelf).hexdigest() + "\n@serial  " + str(serial)
               + "\n@pair  " + json.dumps(target) + "\n" + extra).encode()
    return release, sign(release), shelf


CORE = {"boot.py": b"target boot", "main.py": b"target main", "wedgie.mpy": b"target core"}
APP = {"mod": "safe", "name": "Safe Signer", "files": ["safe.mpy"], "chipuse": True}
APP_FILES = {"safe.mpy": b"target app"}
PAYLOAD = {**CORE, **APP_FILES}


def recorded_v77(root):
    candidate = root / "test-only-v77" / "fw"
    old = root / "emulator-old-v70" / "fw"
    shelf = (candidate / "apps.txt").read_bytes()
    release = (candidate / "release.txt").read_bytes()
    # Bind the reviewed file hashes into a test-only pair envelope.
    assert b"@pair " not in release
    release += b'@pair  {"mod":"safe","name":"Safe Signer","v":"77"}\n'
    envelope = (release, sign(release), shelf)
    manifest = json.loads((old / "manifest.json").read_bytes())
    baseline = {row["name"]: (old / row["name"]).read_bytes() for row in manifest["files"]}
    pair = Pair.parse(*envelope, wedgie.release_ok)
    touched = {}
    for name in pair.files:
        new = (candidate / name).read_bytes()
        if baseline.get(name) != new:
            touched[name] = new
    return envelope, pair, baseline, touched


class PowerCut(BaseException):
    pass


class PairedUpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.update = CheckedPairUpdate(self.root, wedgie.release_ok)
        self.green_presses = []
        self.previous = {"app": {"mod": "safe", "name": "Safe Signer", "v": "70"},
                         "core": "0.3.77", "serial": 5}
        self.reset_flash()
        self.release = release_pair(CORE, APP, APP_FILES)

    def reset_flash(self):
        self.update.live.mkdir(exist_ok=True)
        self.update.state.write_text(json.dumps(self.previous))
        (self.update.live / "apps.json").write_text(json.dumps([self.previous["app"]]))
        (self.update.live / "boot.py").write_bytes(CORE["boot.py"])
        (self.update.live / "main.py").write_bytes(b"old main")
        (self.update.live / "safe.mpy").write_bytes(b"old app")
        (self.update.live / "safe.py").write_bytes(b"old source override")
        (self.update.live / "saves").mkdir(exist_ok=True)
        (self.update.live / "saves" / "wallet.json").write_bytes(b"untouched fixture")

    def confirm(self, *screen):
        self.green_presses.append(screen)
        return True

    def approve(self, envelope=None, payload=None, ask=None):
        return self.update.approve(*(envelope or self.release), payload if payload is not None else PAYLOAD,
                                   ask if ask is not None else self.confirm)

    def assert_unmodified(self):
        self.assertEqual(json.loads(self.update.state.read_bytes()), self.previous)
        self.assertEqual((self.update.live / "main.py").read_bytes(), b"old main")
        self.assertEqual((self.update.live / "safe.mpy").read_bytes(), b"old app")

    def assert_current(self):
        for name, content in PAYLOAD.items():
            self.assertEqual((self.update.live / name).read_bytes(), content)
        self.assertEqual((self.update.live / "saves" / "wallet.json").read_bytes(), b"untouched fixture")
        self.assertFalse((self.update.live / "safe.py").exists())
        state = json.loads(self.update.state.read_bytes())
        self.assertEqual((state["core"], state["serial"], state["app"]["v"]), ("0.3.91", 6, "77"))
        self.assertEqual(json.loads((self.update.live / "apps.json").read_bytes()), [state["app"]])
        self.assertFalse(self.update.journal.exists())

    def test_exact_signed_pair_one_prompt(self):
        payload = PAYLOAD.copy()
        payload.pop("boot.py")  # reuse already-installed exact bytes
        self.assertTrue(self.approve(payload=payload))
        self.assertEqual(self.green_presses, [("0.3.91", "Safe Signer", "77", 6,
                                               sha256(self.release[0]).hexdigest())])
        self.assert_unmodified()
        self.assertTrue(self.update.resume())
        self.assert_current()
        self.assertFalse(self.update.resume())
        self.assertEqual(len(self.green_presses), 1)

    def test_declined_or_expired_prompt(self):
        for result in (False, None):
            self.assertFalse(self.approve(ask=lambda *screen: result))
            self.assertFalse(self.update.journal.exists())
            self.assertFalse(self.update.resume())
            self.assert_unmodified()

    def test_invalid_signature_or_shelf(self):
        release, sig, shelf = self.release
        with self.assertRaisesRegex(ValueError, "signature"):
            self.approve((release + b"# change\n", sig, shelf))
        with self.assertRaisesRegex(ValueError, "list hash"):
            self.approve((release, sig, shelf + b"extra\n"))
        self.assertEqual(self.green_presses, [])
        self.assert_unmodified()

    def test_missing_wrong_or_extra_content_blocks_before_prompt(self):
        for files, error in [
            ({**PAYLOAD, "sidecar.py": b"unlisted"}, "outside"),
            ({**PAYLOAD, "main.py": b"substitution"}, "incorrect"),
            ({name: data for name, data in PAYLOAD.items() if name != "safe.mpy"}, "missing"),
        ]:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                self.approve(payload=files)
        self.assertEqual(self.green_presses, [])
        self.assert_unmodified()

    def test_refuses_downgrade_and_replay(self):
        for serial, version in [(4, "0.3.91"), (5, "0.3.91"), (6, "0.3.76")]:
            with self.subTest(serial=serial, version=version), self.assertRaisesRegex(ValueError, "older"):
                self.approve(release_pair(CORE, APP, APP_FILES, serial, version))
        self.assertEqual(self.green_presses, [])

    def test_refuses_replacing_active_app(self):
        other = dict(APP, mod="other", name="Other Signer", files=["other.mpy"])
        with self.assertRaisesRegex(ValueError, "active app"):
            self.approve(release_pair(CORE, other, {"other.mpy": b"other"}))
        self.assertEqual(self.green_presses, [])

    def test_refuses_malformed_signed_targets(self):
        bad_envelopes = [
            (release_pair(CORE, APP, APP_FILES, extra="@serial  7\n"), "duplicate"),
            (release_pair(CORE, APP, APP_FILES, target={"mod": "safe", "name": "Wallet", "v": "77"}), "name"),
            (release_pair(CORE, dict(APP, files=["off.mpy"]), {"off.mpy": b"other"}), "namespace"),
            (release_pair({**CORE, "safe.py": b"shadow"}, APP, APP_FILES), "colliding"),
            (release_pair({**CORE, "../boot.py": b"escape"}, APP, APP_FILES), "payload name"),
            (release_pair({**CORE, "apps.json": b"override"}, APP, APP_FILES), "payload name"),
        ]
        for envelope, error in bad_envelopes:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                self.approve(envelope)
        self.assertEqual(self.green_presses, [])

    def test_unapproved_stage_is_discarded_after_reboot(self):
        self.update.stage.mkdir()
        (self.update.stage / "safe.mpy").write_bytes(PAYLOAD["safe.mpy"])
        self.assertFalse(self.update.resume())
        self.assertFalse(self.update.stage.exists())
        self.assert_unmodified()

    def test_no_second_approval_or_manifest_substitution(self):
        self.assertTrue(self.approve())
        second = release_pair(CORE, APP, APP_FILES, serial=7)
        with self.assertRaisesRegex(ValueError, "finish"):
            self.approve(second)
        journal = json.loads(self.update.journal.read_bytes())
        journal.update(release=second[0].decode(), sig=second[1], shelf=second[2].decode())
        self.update.journal.write_text(json.dumps(journal))
        with self.assertRaisesRegex(ValueError, "physical approval"):
            self.update.resume()
        self.assertEqual(len(self.green_presses), 1)
        self.assert_unmodified()

    def test_unchanged_disk_file_is_rechecked_after_approval(self):
        payload = PAYLOAD.copy()
        payload.pop("boot.py")
        self.assertTrue(self.approve(payload=payload))
        (self.update.live / "boot.py").write_bytes(b"bad boot")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.update.resume()
        self.assertTrue(self.update.journal.exists())
        self.assert_unmodified()

    def test_lost_or_damaged_staging_holds_recovery(self):
        self.assertTrue(self.approve())
        (self.update.stage / "safe.mpy").write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.update.resume()
        self.assertTrue(self.update.journal.exists())
        self.assert_unmodified()

    def test_roll_forward_at_each_durable_boundary(self):
        for point in (*PAYLOAD, "safe.py", "apps.json", "installed.json"):
            with self.subTest(power_cut_after=point):
                self.reset_flash()
                self.green_presses.clear()
                self.assertTrue(self.approve())

                def cut(name):
                    if name == point:
                        raise PowerCut(name)

                with self.assertRaises(PowerCut):
                    self.update.resume(cut)
                after_power_on = CheckedPairUpdate(self.root, wedgie.release_ok)
                self.assertTrue(after_power_on.resume())
                self.assert_current()
                self.assertEqual(len(self.green_presses), 1)

    @unittest.skipUnless(os.environ.get("WEDGIE_PAIRED_V77_FIXTURE"), "local v77 fixture not supplied")
    def test_recorded_v77_payload(self):
        envelope, pair, baseline, touched = recorded_v77(Path(os.environ["WEDGIE_PAIRED_V77_FIXTURE"]))
        for name, body in baseline.items():
            (self.update.live / name).write_bytes(body)
        self.assertTrue(self.approve(envelope, touched))
        self.assertTrue(self.update.resume())
        self.assertEqual(len(self.green_presses), 1)
        self.assertEqual(len(pair.files), 47)
        for name, digest in pair.files.items():
            self.assertEqual(sha256((self.update.live / name).read_bytes()).hexdigest(), digest)
        self.assertEqual((self.update.live / "saves" / "wallet.json").read_bytes(), b"untouched fixture")


if __name__ == "__main__":
    unittest.main(verbosity=2)
