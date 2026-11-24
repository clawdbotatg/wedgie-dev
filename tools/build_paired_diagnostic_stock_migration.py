"""Make a disposable two-job migration fixture with stock installer input."""
import argparse
from base64 import b64encode
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import tempfile

from littlefs import LittleFS

from build_signer_upload_image import load_app, profile
from paired_bootstrap_gate import DORMANT_WORKERS, activation_boot
from test_paired_staged_bridge_image import FW, HERE, PINNED, compile_text, reserved_modules, stock_files
from test_paired_update import files_text, release_pair, sign, wedgie


STOCK = "ff7608b4"
WORKERS = tuple(name[:-4] for name in DORMANT_WORKERS)
APP = {"mod": "safe", "name": "Safe Signer", "files": ["safe.py"], "chipuse": False}
CART = {"mod": "safe", "name": "Safe Signer", "chipuse": False, "v": "70"}
APP_BYTES = b"print('MIGRATION APP READY')\n"
SAVE = b'{"id":"disposable-stock-migration-fixture"}'


def stock_file(name):
    return subprocess.check_output(["git", "show", f"{STOCK}:firmware/{name}"], cwd=FW.parent)


def hashes(files):
    return {name: sha256(body).hexdigest() for name, body in files.items()}


def signed_stock(target, serial, app, cartridge):
    shelf = ("@app  " + json.dumps(app) + "\n" + files_text(cartridge)).encode()
    release = ("wedgie-release 1\nversion 0.3.91\n" + files_text(dict(sorted(target.items())))
               + "@apps  " + sha256(shelf).hexdigest() + "\n@serial  " + str(serial) + "\n").encode()
    return {"release": release.decode(), "shelf": shelf.decode(), "sig": sign(release),
            "hashes": hashes(target), "serial": serial}


def build(output, partial=False, same_serial_dormant=False, reviewed_v77=None, reviewed_v78=None, retain_v78=False):
    initial_serial, advancing_serial, active_serial = (102, 103, 104) if retain_v78 else (5, 6, 7)
    dormant_serial = initial_serial if same_serial_dormant else advancing_serial
    actual = reviewed_v78 is not None
    if actual:
        old_dir = reviewed_v78 if retain_v78 else reviewed_v77
        old_app, before, old_version = load_app(old_dir)
        new_app, after, new_version = load_app(reviewed_v78)
        assert (old_version, new_version) == (("78" if retain_v78 else "77"), "78")
        assert (before == after) if retain_v78 else (before["safe.mpy"] != after["safe.mpy"])
        cart = {k: v for k, v in old_app.items() if k != "files"}
        if retain_v78:
            desc = json.loads((old_dir / "wedgie.json").read_text())["apps"][0]
            cart["about"] = str(desc.get("about") or "")[:100]
        old_app = {k: v for k, v in old_app.items() if k != "v"}
        target = {k: new_app[k] for k in ("mod", "name", "v")}
        new_app = {k: v for k, v in new_app.items() if k != "v"}
    else:
        old_app = new_app = APP
        before = after = {"safe.py": APP_BYTES}
        cart = CART
        target = {k: CART[k] for k in ("mod", "name", "v")}
    profiles = {"local": profile("local", 11, 19), "devnet": profile("devnet", 31, 23)} if actual else {}
    saves = {"migration.json": SAVE}
    if actual:
        saves.update({"solana_profile.json": json.dumps(profiles["local"]).encode(),
                      "solana_devnet_profile.json": json.dumps(profiles["devnet"]).encode()})
    with tempfile.TemporaryDirectory(prefix="paired-stock-migration-") as directory:
        work = Path(directory)
        initial = stock_files()
        gate_input = initial["boot.py"]
        paired_slot = initial["slot.mpy"]
        initial["boot.py"], initial["slot.mpy"] = stock_file("boot.py"), stock_file("slot.mpy")
        override = (FW / "wedgie.py").read_text() + "\nRELEASE_KEYS = " + repr(wedgie.RELEASE_KEYS) + "\n"
        if actual:
            override += ("\n_bench_hello = hello\ndef hello(mid=None, **extra):\n"
                         "    out = _bench_hello(mid, **extra)\n    core = sys.modules.get('pair_core')\n"
                         "    if core:\n        out['bench_runtime'] = core.status()\n    return out\n")
        initial["wedgie.mpy"] = compile_text("wedgie", override, work)
        diagnostic_main = (HERE / "fixtures" / "paired_recovery_main.py").read_bytes()
        ordinary = {**initial, "slot.mpy": paired_slot, "main.py": diagnostic_main}
        state = {"core": "0.3.91", "serial": active_serial, "app": cart}
        baseline_hashes = hashes({**ordinary, **before})
        baseline_hashes.pop("boot.py")
        policy = (
            "RELEASE_KEYS = " + repr(wedgie.RELEASE_KEYS) + "\nPINNED = " + repr(PINNED)
            + "\nNO_WRITE = " + repr(tuple(module + ext for module in WORKERS for ext in (".py", ".mpy")))
            + "\nSHADOW = " + repr(reserved_modules()) + "\nVERSIONED = True"
            + "\nBASELINE_STATE = " + repr(state) + "\nBASELINE_HASHES = " + repr(baseline_hashes)
            + "\ndef checkpoint(name):\n    pass\n"
        )
        if actual:
            policy += ("\ndef checkpoint(name):\n    if name != 'pair_core.py':\n        return\n"
                       "    import os, machine, time\n    try:\n        os.remove('/._paired/test_reset')\n"
                       "    except OSError:\n        return\n    os.sync()\n    time.sleep_ms(250)\n    machine.reset()\n")
        module_sources = {
            "pair_activate": (HERE / "fixtures" / "pair_activate.py").read_text(),
            "paired_bridge": (HERE / "fixtures" / "paired_bridge.py").read_text(),
            "paired_staging": (HERE / "fixtures" / "paired_staging.py").read_text(),
            "paired_update_boot": (HERE / "paired_update_boot.py").read_text(),
            "pair_verify": (FW / "p256.py").read_text(),
            "pair_policy": policy,
        }
        workers = {name + ".mpy": compile_text(name, module_sources[name], work) for name in WORKERS}
        dormant = {**initial, **workers, "main.py": diagnostic_main}
        active = {**ordinary, **workers}
        boot_hashes = hashes({**workers, **{name: ordinary[name] for name in ("wedgie.mpy", "slot.mpy", "main.py")}})
        active["boot.py"] = activation_boot(gate_input, boot_hashes, dormant_serial, active_serial, diagnostics=True)

        partial_core = {**dormant, "boot.py": active["boot.py"]}
        starting_core, starting_serial = (partial_core, dormant_serial) if partial else (initial, initial_serial)
        image = {**starting_core, **before, "apps.json": json.dumps([cart]).encode(),
                 "serial": str(starting_serial).encode(), **{"saves/safe/" + k: v for k, v in saves.items()}}
        fs = LittleFS(block_size=4096, block_count=352, prog_size=256)
        fs.mkdir("saves")
        fs.mkdir("saves/safe")
        if actual:
            fs.mkdir("._paired")
            image["._paired/test_reset"] = b"1"
        for name, content in image.items():
            with fs.open(name, "wb") as stream:
                stream.write(content)
        output.write_bytes(fs.context.buffer)

        probe_core = {name: active[name] for name in ordinary}
        version = "0.3.92" if actual else "0.3.91"
        probe_code = ('VERSION = "%s"\ndef status():\n    return "executed signed core " + VERSION\n' % version).encode()
        probe_core["pair_core.py"] = probe_code
        payload = {**probe_core, **after}
        sizes = "".join("%d  %s\n" % (len(body), name) for name, body in sorted(payload.items()))
        release, sig, shelf = release_pair(probe_core, new_app, after, serial=active_serial + 1, target=target,
                                          version=version, extra="@sizes  " + sha256(sizes.encode()).hexdigest() + "\n")
        metadata = {"start": "partial" if partial else "stock",
                    "initial": {"serial": starting_serial, "hashes": hashes(starting_core)},
                    "dormant": signed_stock(dormant, dormant_serial, old_app, before),
                    "active": signed_stock(active, active_serial, old_app, before),
                    "dormant_payload": {name: b64encode(dormant[name]).decode() for name in (*workers, "main.py")},
                    "activation_payload": {name: b64encode(active[name]).decode() for name in ("boot.py", "slot.mpy")},
                    "save": b64encode(SAVE).decode(),
                    "probe": {"release": release.decode(), "sig": sig, "shelf": shelf.decode(), "sizes": sizes,
                              "payload": b64encode(probe_code).decode()}}
        if actual:
            prior = {**active, **before}
            changed = {k: v for k, v in payload.items() if prior.get(k) != v}
            active_hashes = metadata["active"]["hashes"]
            metadata.update(actual=True, old_app_version=old_version, new_app_version=new_version, old_cart={k: cart[k] for k in ("mod", "v")},
                            new_cart={k: target[k] for k in ("mod", "v")}, profiles=profiles,
                            saves={k: b64encode(v).decode() for k, v in saves.items()},
                            pinned={k: active_hashes[k] for k in (*PINNED, *workers)},
                            old_cartridge=hashes(before), new_cartridge=hashes(after))
            metadata["probe"].update(payload={k: b64encode(v).decode() for k, v in changed.items()},
                                     hashes=hashes(payload), serial=active_serial + 1)
        Path(str(output) + ".host.json").write_text(json.dumps(metadata))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--partial", action="store_true", help="Start with activation boot copied and the dormant serial")
    parser.add_argument("--same-serial-dormant", action="store_true",
                        help="test the policy option that keeps the initial dormant serial")
    parser.add_argument("--reviewed-v77", type=Path)
    parser.add_argument("--reviewed-v78", type=Path)
    parser.add_argument("--retain-v78", action="store_true",
                        help="start with reviewed v78 and preserve its exact app bytes through the paired update")
    args = parser.parse_args()
    if args.retain_v78:
        if not args.reviewed_v78 or args.reviewed_v77:
            parser.error("--retain-v78 requires only the reviewed v78 cartridge")
    elif bool(args.reviewed_v77) != bool(args.reviewed_v78):
        parser.error("both reviewed cartridge folders are required for a v77 to v78 upgrade")
    build(args.output, args.partial, args.same_serial_dormant, args.reviewed_v77, args.reviewed_v78, args.retain_v78)
