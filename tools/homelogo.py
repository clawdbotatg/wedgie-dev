#!/usr/bin/env python3
# The home screen's underwear (slot.empty): firmware/home.bin, the boot logo's picture bigger, in logo.bin's
# format (x, y, w, h as big-endian u16, the background as RGB565, then RGB565 rows, panel byte order).
#   python3 tools/homelogo.py
import struct
from pathlib import Path
from PIL import Image, ImageChops

root = Path(__file__).resolve().parent.parent
W, Y = 150, 78                                    # under "wedgie.dev" (y 30, size 3), on a 240x240 screen
u = Image.open(root / "art/underwear.jpg").convert("RGB")
u = u.crop(ImageChops.difference(u, Image.new("RGB", u.size, "white")).convert("L").point(lambda v: 255 if v > 6 else 0).getbbox())
u = u.resize((W, round(u.height * W / u.width)), Image.LANCZOS)
rgb = lambda r, g, b: (r & 0xF8) << 8 | (g & 0xFC) << 3 | b >> 3
out = struct.pack(">4HH", (240 - W) // 2, Y, W, u.height, 0xFFFF)
out += b"".join(struct.pack(">H", rgb(*u.getpixel((x, y)))) for y in range(u.height) for x in range(W))
(root / "firmware/home.bin").write_bytes(out)
print("firmware/home.bin", W, "x", u.height, len(out), "bytes")
