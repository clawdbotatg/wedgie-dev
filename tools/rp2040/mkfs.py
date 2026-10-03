#!/usr/bin/env python3
"""A MicroPython littlefs image for the virtual RP2040 (tools/rp2040/chip.mjs): the same layout a Pico's
flash has (4 KB blocks, 352 of them, at 0xa0000).
    uv run --with littlefs-python python3 tools/rp2040/mkfs.py out.img name=path [name=path ...]"""
import sys
from littlefs import LittleFS

fs = LittleFS(block_size=4096, block_count=352, prog_size=256)
for a in sys.argv[2:]:
    name, path = a.split("=", 1)
    with open(path, "rb") as src, fs.open(name, "wb") as dst:
        dst.write(src.read())
with open(sys.argv[1], "wb") as f:
    f.write(fs.context.buffer)
