"""Build disposable cold-boot snapshots for the composed diagnostic path."""
from hashlib import sha256
import json
from pathlib import Path
import sys
import tempfile

from littlefs import LittleFS

from paired_bootstrap_gate import DORMANT_WORKERS, MEASURED, activation_boot
from test_paired_staged_bridge_image import FW, HERE, PINNED, compile_text, reserved_modules, stock_files
from test_paired_update import wedgie


def build(output):
    with tempfile.TemporaryDirectory(prefix="paired-activation-diagnostics-") as directory:
        work = Path(directory)
        core = stock_files()
        core["main.py"] = (HERE / "fixtures" / "paired_recovery_main.py").read_bytes()
        core["wedgie.mpy"] = compile_text("wedgie", (FW / "wedgie.py").read_text()
                                         + "\nRELEASE_KEYS = " + repr(wedgie.RELEASE_KEYS) + "\n", work)
        app = {"mod": "safe", "name": "Safe Signer", "v": "77", "chipuse": False}
        initial = {"core": "0.3.91", "serial": 7, "app": app}
        active = {**core, "safe.py": b"print('MEASURED APP READY')\n"}
        baseline = {n: sha256(data).hexdigest() for n, data in active.items() if n != "boot.py"}
        policy = ("RELEASE_KEYS = " + repr(wedgie.RELEASE_KEYS) + "\nPINNED = " + repr(PINNED)
                  + "\nNO_WRITE = " + repr(tuple(n for m in DORMANT_WORKERS for n in (m, m[:-4] + ".py")))
                  + "\nSHADOW = " + repr(reserved_modules()) + "\nVERSIONED = True\n"
                  + "BASELINE_STATE = " + repr(initial) + "\nBASELINE_HASHES = " + repr(baseline)
                  + "\ndef checkpoint(_):\n    pass\n")
        sources = {n: (HERE / "fixtures" / (n + ".py")).read_text()
                   for n in ("pair_activate", "paired_bridge", "paired_staging")}
        sources.update(paired_update_boot=(HERE / "paired_update_boot.py").read_text(),
                       pair_verify=(FW / "p256.py").read_text(), pair_policy=policy)
        active.update({n + ".mpy": compile_text(n, source, work) for n, source in sources.items()})
        pin = {n: sha256(active[n]).hexdigest() for n in MEASURED}
        active["boot.py"] = activation_boot(core["boot.py"], pin, 6, 7, diagnostics=True)
        active["apps.json"] = json.dumps([app]).encode()
        for kind, serial in (("dormant", b"6"), ("active", b"7"), ("missing-worker", b"7"),
                             ("pending-stock-job", b"7"), ("wrong-main", b"7")):
            files = {**active, "serial": serial}
            if kind == "missing-worker":
                del files["paired_staging.mpy"]
            if kind == "pending-stock-job":
                # Measurements succeed, then the worker refuses the stale
                # ordinary job before it can initialize paired state.
                files["_job.json"] = b"fixture: leave intact"
            if kind == "wrong-main":
                files["main.py"] = b"print('WRONG MAIN RAN')\n"
            fs = LittleFS(block_size=4096, block_count=352, prog_size=256)
            fs.mkdir("saves")
            fs.mkdir("saves/safe")
            with fs.open("saves/safe/fixture.json", "wb") as stream:
                stream.write(b'{"fixture":"unchanged"}')
            for name, data in files.items():
                with fs.open(name, "wb") as stream:
                    stream.write(data)
            fs.unmount()
            (output / (kind + ".img")).write_bytes(fs.context.buffer)


if __name__ == "__main__":
    build(Path(sys.argv[1]))
