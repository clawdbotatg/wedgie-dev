"""Build an emulated Pico's LittleFS image. No authorization of a real device."""

from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile

from littlefs import LittleFS

from paired_update import CheckedPairUpdate, Pair
from test_paired_update import CORE, APP, APP_FILES, PAYLOAD, recorded_v77, release_pair, wedgie

HERE = Path(__file__).resolve().parent


def image(case, output):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        update = CheckedPairUpdate(root, wedgie.release_ok)
        update.live.mkdir()
        update.state.write_text(json.dumps({"core": "0.3.77", "serial": 5,
                                            "app": {"mod": "safe", "name": "Safe Signer", "v": "70"}}))
        if os.environ.get("WEDGIE_PAIRED_V77_FIXTURE"):
            envelope, expected, baseline, payload = recorded_v77(Path(os.environ["WEDGIE_PAIRED_V77_FIXTURE"]))
        else:
            envelope = release_pair(CORE, APP, APP_FILES)
            expected = Pair.parse(*envelope, wedgie.release_ok)
            baseline = {name: b"old " + name.encode() for name in PAYLOAD}
            payload = PAYLOAD
        for name, data in baseline.items():
            (update.live / name).write_bytes(data)
        (update.live / "safe.py").write_bytes(b"would shadow the signed bytecode")
        (update.live / "saves").mkdir()
        (update.live / "saves" / "test.json").write_bytes(b"local/devnet test fixture")
        prompts = []

        def approve_once(*fields):
            prompts.append(fields)
            return True

        assert update.approve(*envelope, payload, approve_once)
        assert len(prompts) == 1
        if case == "damaged":
            (update.stage / "safe.mpy").write_bytes(b"damaged after approval")
        fs = LittleFS(block_size=4096, block_count=352, prog_size=256)
        fs.mkdir("pair")
        for path in sorted(root.rglob("*")):
            name = "pair/" + str(path.relative_to(root))
            if path.is_dir():
                fs.mkdir(name)
            else:
                with fs.open(name, "wb") as file:
                    file.write(path.read_bytes())
        config = {"public": wedgie.RELEASE_KEYS, "old_main": sha256(baseline["main.py"]).hexdigest(),
                  "staged_bytes": sum(map(len, payload.values())), "state": expected.state(), "files": expected.files}
        for name, data in {
            "boot.py": b"import micropython\nmicropython.kbd_intr(-1)\n",
            "main.py": (HERE / "fixtures" / "paired_update_boot_main.py").read_bytes(),
            "paired_update_boot.py": (HERE / "paired_update_boot.py").read_bytes(),
            "wedgie.py": (HERE.parent / "firmware" / "wedgie.py").read_bytes(),
            "p256.py": (HERE.parent / "firmware" / "p256.py").read_bytes(),
            "fixture.json": json.dumps(config).encode(),
        }.items():
            with fs.open(name, "wb") as file:
                file.write(data)
        if case == "reset":
            with fs.open("cut", "wb") as file:
                file.write(b"safe.mpy")
        Path(output).write_bytes(fs.context.buffer)


if __name__ == "__main__":
    image(sys.argv[1], sys.argv[2])
