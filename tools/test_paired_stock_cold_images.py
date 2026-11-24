"""Create disposable post-commit and interrupted activation images."""
from base64 import b64decode
import json
from pathlib import Path
import sys

from littlefs import LittleFS, UserContext


def build(source, output):
    meta = json.loads(Path(str(source) + ".host.json").read_text())
    modes = ("committed", "missing-worker", "torn-serial")
    for mode in modes:
        fs = LittleFS(context=UserContext(buffer=bytearray(source.read_bytes())), block_size=4096,
                      block_count=352, prog_size=256)
        for group in ("dormant_payload", "activation_payload"):
            for name, content in meta[group].items():
                if Path(name).name != name or name in (".", ".."):
                    raise ValueError("Unexpected path in the disposable stock fixture")
                with fs.open(name, "wb") as stream:
                    stream.write(b64decode(content, validate=True))
        with fs.open("serial", "wb") as stream:
            stream.write(b"0" if mode == "torn-serial" else str(meta["active"]["serial"]).encode())
        if mode == "missing-worker":
            fs.remove("paired_staging.mpy")
        fs.unmount()
        (output / (mode + ".img")).write_bytes(bytes(fs.context.buffer))


if __name__ == "__main__":
    build(*map(Path, sys.argv[1:]))
