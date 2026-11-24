"""Validate the measured boot gate and restartable paired state initialization."""

import ast
import binascii
from hashlib import sha256
import hashlib
from io import BytesIO
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from paired_bootstrap_gate import DIAGNOSTIC_MAIN_SHA256, MEASURED, activation_boot
import test_paired_staging as staging_tests
import pair_activate


class BootGateTests(unittest.TestCase):
    def setUp(self):
        stock = (Path(__file__).resolve().parents[1] / "firmware/boot.py").read_bytes()
        self.inputs = {name: ("reviewed " + name).encode() for name in MEASURED}
        self.hashes = {name: sha256(data).hexdigest() for name, data in self.inputs.items()}
        self.stock = stock
        self.files = {"/" + name: data for name, data in self.inputs.items()}
        self.loaded = []
        self.paths = ["/", "/lib"]
        self.sys = SimpleNamespace(path=self.paths, modules={})
        self.wedgie = SimpleNamespace(VERSION="0.3.91")
        self.activation = SimpleNamespace(activate=lambda: "0.3.92")

    def gate(self):
        boot = activation_boot(self.stock, self.hashes, 6, 7)
        parsed = ast.parse(boot)
        relevant = []
        for item in parsed.body:
            if isinstance(item, ast.Assign) and item.targets[0].id.startswith("_paired_"):
                relevant.append(item)
            elif isinstance(item, ast.FunctionDef) and item.name == "_paired_activate_boot":
                relevant.append(item)
        self.assertEqual(len(relevant), 4)
        def opener(path, mode):
            if path not in self.files:
                raise OSError(2, "not found")
            return BytesIO(self.files[path])

        def stat(path):
            if path not in self.files:
                raise OSError(2, "not found")

        def imported(key, *args):
            self.loaded.append(key)
            return {"binascii": binascii, "hashlib": hashlib, "os": SimpleNamespace(stat=stat),
                    "sys": self.sys, "pair_activate": self.activation, "wedgie": self.wedgie}[key]

        namespace = {"__builtins__": dict(vars(__import__("builtins")), __import__=imported, open=opener)}
        exec(compile(ast.Module(body=relevant, type_ignores=[]), "boot.py", "exec"), namespace)
        return namespace["_paired_activate_boot"]

    def test_uncommitted_activation_stays_stock_without_importing_worker(self):
        self.files["/serial"] = b"6"
        del self.files["/paired_bridge.mpy"]
        self.gate()()
        self.assertNotIn("pair_activate", self.loaded)
        self.assertEqual(self.wedgie.VERSION, "0.3.91")

    def test_activated_matching_code_wraps_verified_worker_only(self):
        self.files["/serial"] = b"7"

        def verify_path():
            self.assertEqual(self.sys.path, ["/"])
            self.assertNotEqual(self.sys.path, self.paths)
            return "0.3.92"

        self.activation.activate = verify_path
        self.gate()()
        self.assertIn("pair_activate", self.loaded)
        self.assertIs(self.sys.path, self.paths)
        self.assertEqual(self.wedgie.VERSION, "0.3.92")

    def test_incomplete_post_commit_and_shadow_never_import_worker(self):
        self.files["/serial"] = b"7"
        for name in MEASURED:
            with self.subTest(name=name):
                body = self.files.pop("/" + name)
                with self.assertRaises(OSError):
                    self.gate()()
                self.files["/" + name] = body
                self.files["/" + name] = b"altered"
                with self.assertRaisesRegex(ValueError, "content changed"):
                    self.gate()()
                self.files["/" + name] = body
        self.files["/paired_bridge.py"] = b"untrusted"
        with self.assertRaisesRegex(ValueError, "shadows"):
            self.gate()()
        self.assertNotIn("pair_activate", self.loaded)

    def test_serial_loss_noncanonical_and_old_activated_state_fail_sealed(self):
        for invalid in (None, b"", b"5", b"06", b"6\n", b"+7", b"9"*19):
            with self.subTest(invalid=invalid):
                if invalid is None:
                    self.files.pop("/serial", None)
                else:
                    self.files["/serial"] = invalid
                with self.assertRaises((OSError, ValueError)):
                    self.gate()()
        self.files["/serial"] = b"6"
        self.files["/._paired/installed.json"] = b"activated"
        with self.assertRaisesRegex(ValueError, "fallback"):
            self.gate()()
        self.assertNotIn("pair_activate", self.loaded)

    def test_import_search_path_restored_on_worker_failure(self):
        self.files["/serial"] = b"7"
        def fail():
            raise ValueError("scratch failure")
        self.activation.activate = fail
        with self.assertRaisesRegex(ValueError, "scratch failure"):
            self.gate()()
        self.assertIs(self.sys.path, self.paths)

    def test_diagnostics_require_the_reviewed_main_and_gate_ordinary_boot(self):
        with self.assertRaisesRegex(ValueError, "exact reviewed recovery"):
            activation_boot(self.stock, self.hashes, 6, 7, diagnostics=True)
        main = (Path(__file__).resolve().parent / "fixtures/paired_recovery_main.py").read_bytes()
        self.assertEqual(sha256(main).hexdigest(), DIAGNOSTIC_MAIN_SHA256)
        rendered = activation_boot(self.stock, {**self.hashes, "main.py": DIAGNOSTIC_MAIN_SHA256},
                                   6, 7, diagnostics=True)
        tree = ast.parse(rendered)
        guard = next(item for item in tree.body if isinstance(item, ast.If))
        self.assertEqual(ast.unparse(guard.test), "_paired_recovery is None")
        self.assertIn(b'import wedgiedrive', rendered)
        self.assertIn(DIAGNOSTIC_MAIN_SHA256.encode(), rendered)

    def test_builder_requires_exact_hash_inventory_and_ordered_serials(self):
        with self.assertRaisesRegex(ValueError, "every verified"):
            activation_boot(self.stock, {}, 6, 7)
        with self.assertRaisesRegex(ValueError, "increasing"):
            activation_boot(self.stock, self.hashes, 7, 7)


class PairSeedTests(unittest.TestCase):
    def setUp(self):
        hosted = staging_tests.StageChecks()
        self.addCleanup(hosted.doCleanups)
        hosted.setUp()
        self.fx = hosted
        self.bridge = staging_tests.bridge
        self.state_file = Path(self.bridge.STATE)
        self.baseline = json.loads(self.state_file.read_text())
        self.state_file.unlink()
        hosted.policy.VERSIONED = True
        hosted.policy.BASELINE_STATE = self.baseline
        hosted.policy.BASELINE_HASHES = {"boot.py": sha256((hosted.live / "boot.py").read_bytes()).hexdigest()}
        (hosted.live / "apps.json").write_text(json.dumps([self.baseline["app"]]))

    def test_verified_stock_state_initializes_and_subsequent_boot_resumes(self):
        self.assertIsNone(pair_activate.activate())
        self.assertEqual(json.loads(self.state_file.read_text()), self.baseline)
        with patch.object(self.bridge, "early_boot", return_value="0.3.92") as later:
            self.assertEqual(pair_activate.activate(), "0.3.92")
            later.assert_called_once_with()

    def test_cut_during_atomic_state_commit_can_retry_same_exact_baseline(self):
        def cut(*_):
            raise RuntimeError("simulated interrupted seed rename")
        with patch.object(staging_tests.paired_update_boot, "_flash_replace", side_effect=cut):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                pair_activate.activate()
        self.assertFalse(self.state_file.exists())
        self.assertTrue((self.state_file.parent / "installed.tmp").is_file())
        self.assertIsNone(pair_activate.activate())
        self.assertEqual(json.loads(self.state_file.read_text()), self.baseline)

    def test_changed_app_serial_or_files_cannot_seed(self):
        target = self.fx.live / "serial"
        target.write_text("6")
        with self.assertRaisesRegex(ValueError, "changed baseline serial"):
            pair_activate.activate()
        target.write_text("5")
        apps = self.fx.live / "apps.json"
        apps.write_text("[]")
        with self.assertRaisesRegex(ValueError, "provisioned baseline"):
            pair_activate.activate()
        apps.write_text(json.dumps([self.baseline["app"]]))
        (self.fx.live / "boot.py").write_bytes(b"different")
        with self.assertRaisesRegex(ValueError, "missing or changed"):
            pair_activate.activate()
        self.assertFalse(self.state_file.exists())

    def test_orphaned_receipt_or_pending_stock_job_cannot_seed(self):
        for marker in (self.bridge.APPROVED, self.bridge.OFFER, self.bridge.VERSION_RECEIPT, self.fx.live / "_job.json"):
            with self.subTest(marker=marker):
                path = Path(marker)
                path.write_bytes(b"pending")
                with self.assertRaises(ValueError):
                    pair_activate.activate()
                self.assertFalse(self.state_file.exists())
                path.unlink()


if __name__ == "__main__":
    unittest.main(verbosity=2)
