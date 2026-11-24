"""Build a disposable signed pair around the reviewed v77/v78 cartridges."""
import argparse
from base64 import b64encode
from hashlib import sha256
import json
from pathlib import Path
import tempfile

from littlefs import LittleFS
from paired_bootstrap_gate import MEASURED, activation_boot
from test_paired_staged_bridge_image import BENCH_MODULES, FW, HERE, PINNED, compile_text, reserved_modules, stock_files
from test_paired_update import p256, release_pair, wedgie


def address(byte):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = int.from_bytes(bytes((byte,)) * 32, "big")
    out = ""
    while n:
        n, digit = divmod(n, 58)
        out = alphabet[digit] + out
    return out


def profile(network, start, scalar):
    x, y = p256.pubkey(scalar)
    return {"network": network, "swig": address(start), "wallet": address(start + 1),
            "mint": address(start + 2), "key": "%02x%064x" % (2 + (y & 1), x)}


def load_app(directory):
    desc = json.loads((directory / "wedgie.json").read_text())["apps"][0]
    files = {name: (directory / name).read_bytes() for name in desc["files"]}
    app = {key: desc[key] for key in ("mod", "name", "entry", "usb") if key in desc}
    fingerprint = sha256("\n".join(sha256(data).hexdigest() for data in files.values()).encode()).hexdigest()[:12]
    app.update(chipuse=True, files=list(files), v=fingerprint)
    return app, files, str(desc["version"])


def main(old_dir, new_dir, output, versioned_core=False, stock_activation=False):
    old_app, before, old_version = load_app(old_dir)
    new_app, after, new_version = load_app(new_dir)
    assert old_version == "77" and new_version == "78"
    assert before["safe.mpy"] != after["safe.mpy"]
    profiles = {"local": profile("local", 11, 19), "devnet": profile("devnet", 31, 23)}
    with tempfile.TemporaryDirectory(prefix="paired-actual-signer-") as directory:
        work = Path(directory)
        core = stock_files()
        if not stock_activation:
            core["boot.py"] = core["boot.py"].replace(b"PAIRED_UPDATE_BENCH = False", b"PAIRED_UPDATE_BENCH = True")
            assert b"PAIRED_UPDATE_BENCH = True" in core["boot.py"]
        modules_to_pin = BENCH_MODULES + (("pair_activate",) if stock_activation else ())
        trust_override = (FW / "wedgie.py").read_text() + "\nRELEASE_KEYS = " + repr(wedgie.RELEASE_KEYS) + "\n"
        if versioned_core:
            trust_override += (
                "\n_bench_hello = hello\n"
                "def hello(mid=None, **extra):\n"
                "    result = _bench_hello(mid, **extra)\n"
                "    core = sys.modules.get('pair_core')\n"
                "    if core:\n"
                "        result['bench_runtime'] = core.status()\n"
                "    return result\n"
            )
        core["wedgie.mpy"] = compile_text("wedgie", trust_override, work)
        marker = "pair_stamp.bin"
        new_core = {**core, marker: b"bench marker for actual signer staging\n" * 95}
        version = "0.3.92" if versioned_core else "0.3.91"
        if versioned_core:
            core["pair_core.py"] = b'VERSION = "0.3.91"\ndef status():\n    return "original core " + VERSION\n'
            new_core["pair_core.py"] = b'VERSION = "0.3.92"\ndef status():\n    return "executed new core " + VERSION\n'
        old_record = {key: value for key, value in old_app.items() if key != "files"}
        initial = {"core": "0.3.91", "serial": 120, "app": old_record}
        policy = ("RELEASE_KEYS = " + repr(wedgie.RELEASE_KEYS) + "\nPINNED = " + repr(PINNED)
                  + "\nNO_WRITE = " + repr(tuple(m + ext for m in modules_to_pin for ext in (".py", ".mpy")))
                  + "\nSHADOW = " + repr(reserved_modules())
                  + "\nVERSIONED = " + repr(versioned_core)
                  + "\ndef checkpoint(name):\n    pass\n")
        if versioned_core:
            baseline = {name: sha256(body).hexdigest() for name, body in {**core, **before}.items()
                        if not stock_activation or name != "boot.py"}
            policy += "\nBASELINE_STATE = " + repr(initial) + "\nBASELINE_HASHES = " + repr(baseline) + "\n"
            policy += (
                "\ndef checkpoint(name):\n"
                "    if name != 'pair_stamp.bin':\n"
                "        return\n"
                "    import os, machine, time\n"
                "    try:\n"
                "        os.remove('/._paired/test_reset')\n"
                "    except OSError:\n"
                "        return\n"
                "    os.sync()\n"
                "    time.sleep_ms(250)\n"
                "    machine.reset()\n"
            )
        modules = {"paired_bridge": (HERE / "fixtures/paired_bridge.py").read_text(),
                   "paired_update_boot": (HERE / "paired_update_boot.py").read_text(),
                   "paired_staging": (HERE / "fixtures/paired_staging.py").read_text(),
                   "pair_verify": (FW / "p256.py").read_text(), "pair_policy": policy}
        if stock_activation:
            modules["pair_activate"] = (HERE / "fixtures/pair_activate.py").read_text()
        files = {**core, **before, **{name + ".mpy": compile_text(name, source, work) for name, source in modules.items()}}
        if stock_activation:
            hashes = {name: sha256(files[name]).hexdigest() for name in MEASURED}
            active_boot = activation_boot(core["boot.py"], hashes, 119, 120)
            files["boot.py"] = new_core["boot.py"] = active_boot
        payload = {**new_core, **after}
        sizes = "".join(f"{len(content)}  {name}\n" for name, content in sorted(payload.items()))
        requested = {n: new_app[n] for n in ("mod", "name", "v")}
        shelf_app = {n: value for n, value in new_app.items() if n != "v"}
        release, sig, shelf = release_pair(
            new_core, shelf_app, after, serial=121, target=requested, version=version,
            extra="@sizes  " + sha256(sizes.encode()).hexdigest() + "\n")
        files.update({
            "serial": b"120", "apps.json": json.dumps([old_record]).encode(),
            "saves/safe/solana_profile.json": json.dumps(profiles["local"]).encode(),
            "saves/safe/solana_devnet_profile.json": json.dumps(profiles["devnet"]).encode(),
            "saves/safe/pair-fixture.json": b"fixture: leave intact",
        })
        if not stock_activation:
            files["._paired/installed.json"] = json.dumps(initial).encode()
        if versioned_core:
            files["._paired/test_reset"] = b"1"
        fs = LittleFS(block_size=4096, block_count=352, prog_size=256)
        parents = set()
        for name, content in files.items():
            for parent in reversed(Path(name).parents):
                if parent != Path(".") and parent not in parents:
                    fs.mkdir(str(parent))
                    parents.add(parent)
            with fs.open(name, "wb") as stream:
                stream.write(content)
        output.write_bytes(fs.context.buffer)
        Path(str(output) + ".host.json").write_text(json.dumps({
            "fixture": "actual-signer-core" if versioned_core else "actual-signer",
            "release": release.decode(), "sig": sig, "shelf": shelf.decode(), "sizes": sizes,
            "payload": {key: b64encode(content).decode() for key, content in payload.items()},
            "profiles": profiles, "old_cart": {"mod": "safe", "v": old_app["v"]},
            "new_app_version": new_version,
            "initial_paired_state_seeded_by_boot": stock_activation,
            "pinned": {name: sha256(files[name]).hexdigest()
                       for name in (*PINNED, *(module + ".mpy" for module in modules_to_pin))},
            "old_cartridge_files": {name: sha256(data).hexdigest() for name, data in before.items()},
            "new_cartridge_files": {name: sha256(data).hexdigest() for name, data in after.items()},
        }))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("old_dir", type=Path)
    parser.add_argument("new_dir", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--versioned-core", action="store_true")
    parser.add_argument("--stock-activation", action="store_true", help="boot from an exact committed stock activation snapshot")
    args = parser.parse_args()
    if args.stock_activation and not args.versioned_core:
        parser.error("--stock-activation requires --versioned-core")
    main(args.old_dir, args.new_dir, args.output, args.versioned_core, args.stock_activation)
