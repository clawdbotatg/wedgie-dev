"""Hosted checks for the paired boot and ordinary installer boundary."""
import ast
from base64 import b64decode
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

import test_paired_staging as fixtures


class InstallerGuardTests(unittest.TestCase):
    def test_slot_legacy_install_uses_stock_path_until_paired_activation(self):
        source = Path(__file__).resolve().parents[1] / "firmware" / "slot.py"
        module = ast.parse(source.read_text())
        handler = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "_handle")
        out, stock = [], []
        bridge = SimpleNamespace(versioned=lambda: True)
        def stock_job(*args):
            stock.append(args)
            return True

        namespace = {
            "W": SimpleNamespace(SEALED=True, is_open=lambda: False, send=out.append), "_q": False,
            "_asking": lambda run: run(), "_job": stock_job,
            "sys": SimpleNamespace(modules={"paired_bridge": bridge}),
        }
        exec(compile(ast.Module(body=[handler], type_ignores=[]), str(source), "exec"), namespace)
        request = {"type": "job", "id": 42}
        namespace["_handle"](request)
        self.assertEqual(out[0]["type"], "error")
        self.assertEqual(out[0]["id"], 42)
        self.assertEqual(stock, [])
        bridge.versioned = lambda: False
        namespace["_handle"](request)
        self.assertEqual(stock, [(42, request)])
        namespace["sys"].modules.clear()
        namespace["_handle"](request)
        self.assertEqual(len(stock), 2)

    def test_file_read_does_not_reserve_a_full_chunk_for_a_short_save(self):
        source = Path(__file__).resolve().parents[1] / "firmware" / "wedgie.py"
        tree = ast.parse(source.read_text())
        get = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "get")
        for size in (0, 26, 3072, 3099):
            with self.subTest(size=size):
                saved = bytes((i & 255 for i in range(size)))
                reads, output = [], []

                class BoundedStream(io.BytesIO):
                    def read(self, count):
                        if count > size - self.tell():
                            raise AssertionError("Read exceeds the remaining save bytes")
                        reads.append(count)
                        return super().read(count)

                namespace = {"os": SimpleNamespace(stat=lambda _: [None] * 6 + [size]), "json": json,
                             "open": lambda *_: BoundedStream(saved), "print": output.append}
                exec(compile(ast.Module(body=[get], type_ignores=[]), str(source), "exec"), namespace)
                namespace["get"]("/saves/safe/fixture.json", 7)
                entries = [json.loads(line) for line in output]
                self.assertEqual(reads, [min(3072, size - idx * 3072) for idx in range(len(entries))])
                self.assertEqual(b"".join(b64decode(item["data"]) for item in entries), saved)
                self.assertTrue(all(item["size"] == size and item["id"] == 7 and item["n"] == len(entries)
                                    for item in entries))

    def test_boot_blocks_pending_stock_job_before_any_paired_writes(self):
        hosted = fixtures.StageChecks()
        self.addCleanup(hosted.doCleanups)
        hosted.setUp()
        marker = hosted.live / "_job.json"
        marker.write_bytes(b"previous stock install")
        previous = Path(fixtures.bridge.STATE).read_bytes()
        hosted.policy.VERSIONED = True
        with self.assertRaisesRegex(ValueError, "conflicts with paired activation"):
            fixtures.bridge.early_boot()
        self.assertEqual(marker.read_bytes(), b"previous stock install")
        self.assertEqual(Path(fixtures.bridge.STATE).read_bytes(), previous)
        self.assertFalse(Path(fixtures.bridge.APPROVED).exists())
        hosted.policy.VERSIONED = False
        self.assertIsNone(fixtures.bridge.early_boot())


if __name__ == "__main__":
    unittest.main(verbosity=2)
