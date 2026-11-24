"""Build an isolated stage image for the RP2040 emulator. No board access."""

import ast
from base64 import b64encode
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from littlefs import LittleFS
import mpy_cross

from test_paired_update import release_pair, wedgie

HERE = Path(__file__).resolve().parent
FW = HERE.parent / "firmware"
PINNED = ("boot.py", "main.py", "wedgie.mpy", "slot.mpy")
BENCH_MODULES = ("paired_bridge", "paired_update_boot", "paired_staging", "pair_verify", "pair_policy")


def compile_text(name, text, work):
    source, out = work / (name + ".py"), work / (name + ".mpy")
    source.write_text(text)
    subprocess.run([mpy_cross.mpy_cross, "-s", source.name, "-o", str(out), str(source)], check=True)
    return out.read_bytes()


def stock_files():
    claimed = {n for app in json.loads((FW / "carts.json").read_text()) for n in app["files"]}
    excluded = claimed | {"apps.json", "carts.json"}
    return {
        p.name: p.read_bytes() for p in FW.iterdir()
        if p.is_file() and p.suffix in (".mpy", ".py", ".bin", ".json") and p.name not in excluded
        and (p.suffix != ".py" or not p.with_suffix(".mpy").exists())
    }


def reserved_modules():
    tree = ast.parse((FW / "job.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "SHADOW" for t in node.targets):
            return tuple(ast.literal_eval(node.value.func.value).split())
    raise ValueError("stock reserved module names unavailable")


def main(mode, out):
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        core = stock_files()
        if mode != "disabled":
            old = b"PAIRED_UPDATE_BENCH = False"
            assert core["boot.py"].count(old) == 1
            core["boot.py"] = core["boot.py"].replace(old, b"PAIRED_UPDATE_BENCH = True")
        verifier = (FW / "wedgie.py").read_text() + "\nRELEASE_KEYS = " + repr(wedgie.RELEASE_KEYS) + "\n"
        core["wedgie.mpy"] = compile_text("wedgie", verifier, work)
        apps = {"mod": "safe", "name": "Safe Signer", "entry": "run", "files": ["safe.py"], "chipuse": False}
        app_v70 = dict((key, value) for key, value in apps.items() if key != "files")
        app_v70["v"] = "70"
        old_app = b"def run():\n    print('PAIR APP OLD')\n"
        baseline = {"core": "0.3.91", "serial": 5, "app": app_v70}
        upload = mode.startswith("upload-")
        receipt_lost = mode == "upload-same-core-receipt-lost"
        numeric_transition = mode in ("upload-core", "upload-core-mismatch")
        versioned = numeric_transition or receipt_lost
        core_version = "0.3.92" if numeric_transition or mode == "wrong-core" else "0.3.91"
        marker = "pair_stamp.bin"
        new_core = dict(core)
        prefix = b"paired core update fixture"
        new_core[marker] = prefix + (bytes(range(256)) * 12 if upload else b"")
        new_app = ("def run():\n    print('PAIR APP', open('/pair_stamp.bin', 'rb').read(" + str(len(prefix)) + "))\n").encode()
        if versioned:
            runtime = "0.3.93" if mode == "upload-core-mismatch" else core_version
            core["pair_core.py"] = b'VERSION = "0.3.91"\ndef status():\n    return "compiled old core behavior"\n'
            new_core["pair_core.py"] = ('VERSION = "%s"\ndef status():\n    return "executed new core " + VERSION\n' % runtime).encode()
            new_app += b"    import pair_core\n    print('PAIR EXECUTABLE', pair_core.status())\n"
        if mode == "upload-recover":
            # A non-entry app remains running while the main slot loop
            # handles USB and the blocking physical question.
            del apps["entry"], app_v70["entry"]
            old_app = b"print('PAIR APP OLD')\n"
            new_app = b"print('PAIR APP', open('/pair_stamp.bin', 'rb').read(%d))\n" % len(prefix)
        if receipt_lost:
            # The signed test app simulates storage corruption after the first
            # successful activation, before an independent reboot.
            new_app += (b"    import os\n    os.remove('/._paired/active-release.json')\n"
                        b"    os.sync()\n    print('PAIR TEST RECEIPT LOST')\n")
        target_files = {**new_core, "safe.py": new_app}
        sizes = "".join("%d  %s\n" % (len(data), name)
                        for name, data in sorted(target_files.items()))
        sizes_line = "@sizes  " + sha256(sizes.encode()).hexdigest() + "\n" if upload else ""
        release, signature, shelf = release_pair(new_core, apps, {"safe.py": new_app},
                                                version=core_version,
                                                extra=sizes_line)

        policy = ("RELEASE_KEYS = " + repr(wedgie.RELEASE_KEYS) + "\nPINNED = " + repr(PINNED)
                  + "\nNO_WRITE = " + repr(tuple(m + ext for m in BENCH_MODULES for ext in (".py", ".mpy")))
                  + "\nSHADOW = " + repr(reserved_modules())
                  + "\nVERSIONED = " + repr(versioned)
                  + "\ndef checkpoint(name):\n    pass\n")
        if versioned:
            baseline_hashes = {name: sha256(data).hexdigest() for name, data in {**core, "safe.py": old_app}.items()}
            policy += "\nBASELINE_STATE = " + repr(baseline) + "\nBASELINE_HASHES = " + repr(baseline_hashes) + "\n"
        if mode in ("recover", "upload-recover", "upload-core"):
            policy += (
                "\ndef checkpoint(name):\n"
                "    if name != " + repr(marker) + ":\n"
                "        return\n"
                "    import os, machine, time\n"
                "    try:\n"
                "        os.remove('/._paired/test_reset')\n"
                "    except OSError:\n"
                "        return\n"
                "    os.sync()\n"
                "    print('PAIR CUT', name)\n"
                "    time.sleep_ms(250)\n"
                "    machine.reset()\n"
            )
        bridge_modules = {
            "paired_bridge": (HERE / "fixtures" / "paired_bridge.py").read_text(),
            "paired_update_boot": (HERE / "paired_update_boot.py").read_text(),
            "paired_staging": (HERE / "fixtures" / "paired_staging.py").read_text(),
            "pair_verify": (FW / "p256.py").read_text(),
            "pair_policy": policy,
        }
        files = dict(core)
        if mode != "disabled":
            for name, content in bridge_modules.items():
                files[name + ".mpy"] = compile_text(name, content, work)
        files.update({
            "serial": b"5",
            "apps.json": json.dumps([app_v70]).encode(),
            "safe.py": old_app,
            "saves/safe/pair-fixture.json": b"fixture: leave intact",
            "saves/safe/solana_profile.json": b'{"wallet":"fixture-local"}',
            "saves/safe/solana_devnet_profile.json": b'{"wallet":"fixture-devnet"}',
            "._paired/installed.json": json.dumps(baseline).encode(),
        })
        envelope = {"release": release.decode(), "sig": signature, "shelf": shelf.decode()}
        if upload:
            envelope.update(sizes=sizes, payload={name: b64encode(data).decode() for name, data in target_files.items()})
            Path(out + ".host.json").write_text(json.dumps(envelope))
        else:
            files.update({
                "._paired/stage/" + marker: new_core[marker],
                "._paired/stage/safe.py": b"tampered" if mode == "damaged" else new_app,
                "._paired/offer.json": json.dumps(envelope).encode(),
            })
        if mode in ("recover", "upload-recover", "upload-core"):
            files["._paired/test_reset"] = b"1"
        fs = LittleFS(block_size=4096, block_count=352, prog_size=256)
        added = set()
        for name, content in files.items():
            for parent in reversed(Path(name).parents):
                if str(parent) not in (".", "/") and parent not in added:
                    fs.mkdir(str(parent))
                    added.add(parent)
            with fs.open(name, "wb") as stream:
                stream.write(content)
        if mode == "low-space":
            # Leave 44 KiB (including metadata headroom) on this disposable
            # image, below the paired staging reserve.
            with fs.open("space-test.bin", "wb") as stream:
                stream.write(bytes(832 * 1024))
        Path(out).write_bytes(fs.context.buffer)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
