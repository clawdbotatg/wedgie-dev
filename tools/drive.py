#!/usr/bin/env python3
# Builds firmware/drive.bin: the read-only WEDGIE drive a wedgie shows when plugged in (wedgiedrive.py).
# A tiny FAT12 volume, written from scratch here so it's reproducible anywhere:
#   Open wedgie.dev.html    double-click: opens wedgie.dev in the browser (any OS)
#   README.txt              what this is
#   .VolumeIcon.icns        the underwear as the drive icon on macOS          (hidden)
#   autorun.inf + wedgie.ico  the underwear as the drive icon on Windows      (hidden)
# Stored sparse: only the sectors that aren't all zeros.   python3 tools/drive.py [--img out.img]
import io, struct, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
SECTOR, TOTAL, RESERVED, NFATS, ROOT_ENTRIES, SPC = 512, 2048, 1, 2, 64, 1     # 1 MB volume
FAT_SECTORS = 6                                                                # 2046 clusters x 1.5 B
ROOT_SECTORS = ROOT_ENTRIES * 32 // SECTOR
DATA0 = RESERVED + NFATS * FAT_SECTORS + ROOT_SECTORS
LABEL = b"WEDGIE     "

# ---- the files ------------------------------------------------------------------------------------
html = b"""<!doctype html><meta charset="utf-8"><title>wedgie.dev</title>
<meta http-equiv="refresh" content="0; url=https://wedgie.dev/connect">
<p>Opening <a href="https://wedgie.dev/connect">wedgie.dev</a>...</p>
"""
readme = b"""This is a wedgie.

Open "Open wedgie.dev.html" (or go to https://wedgie.dev/connect in Chrome or Edge) to see it,
install apps, test it, and give it to your agent.

This drive is read-only and tiny; it's just the front door. The wedgie itself talks to wedgie.dev
over USB serial. Hold Y while plugging in to start without this drive.

MIT. https://github.com/clawdbotatg/wedgie-dev
"""
autorun = b"[autorun]\r\nicon=wedgie.ico\r\nlabel=wedgie\r\n"

src = Image.open(root / "public/img/sticker.webp").convert("RGBA")
def square(n):
    s = Image.new("RGBA", (max(src.size),) * 2, (0, 0, 0, 0))
    s.paste(src, ((s.width - src.width) // 2, (s.height - src.height) // 2), src)
    return s.resize((n, n), Image.LANCZOS)
ico = io.BytesIO(); square(256).save(ico, "ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128)])
with tempfile.TemporaryDirectory() as t:
    iconset = Path(t) / "w.iconset"; iconset.mkdir()
    for n in (16, 32, 128):
        square(n).save(iconset / f"icon_{n}x{n}.png"); square(n * 2).save(iconset / f"icon_{n}x{n}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(Path(t) / "w.icns")], check=True)
    icns = (Path(t) / "w.icns").read_bytes()

HIDDEN, READONLY, ARCHIVE, VOLUME = 0x02, 0x01, 0x20, 0x08
files = [("Open wedgie.dev.html", html, READONLY), ("README.txt", readme, READONLY),
         (".VolumeIcon.icns", icns, READONLY | HIDDEN), ("autorun.inf", autorun, READONLY | HIDDEN),
         ("wedgie.ico", ico.getvalue(), READONLY | HIDDEN)]

# ---- FAT12 ------------------------------------------------------------------------------------------
img = bytearray(TOTAL * SECTOR)
bs = bytearray(SECTOR)
bs[0:3] = b"\xEB\x3C\x90"; bs[3:11] = b"WEDGIE  "
struct.pack_into("<HBHBHHBHHHII", bs, 11, SECTOR, SPC, RESERVED, NFATS, ROOT_ENTRIES, TOTAL, 0xF8, FAT_SECTORS, 32, 2, 0, 0)
struct.pack_into("<BBBI", bs, 36, 0x80, 0, 0x29, 0x57ED61E0)
bs[43:54] = LABEL; bs[54:62] = b"FAT12   "; bs[510:512] = b"\x55\xAA"
img[0:SECTOR] = bs

fat = {0: 0xFF8, 1: 0xFFF}
root_dir = bytearray(ROOT_SECTORS * SECTOR)
entries = []
entries.append(LABEL + bytes([VOLUME]) + bytes(20))
next_cluster = 2

def short_name(name, n):
    base, _, ext = name.upper().lstrip(".").rpartition(".")
    base = "".join(c for c in (base or ext) if c.isalnum())[:6] or "FILE"
    ext = "".join(c for c in (ext if base else "") if c.isalnum())[:3]
    return (f"{base}~{n}".ljust(8) + ext.ljust(3)).encode()

def lfn_entries(name, sfn):
    csum = 0
    for b in sfn:
        csum = (((csum & 1) << 7) + (csum >> 1) + b) & 0xFF
    u = name.encode("utf-16-le") + b"\x00\x00"
    u += b"\xFF\xFF" * ((26 - len(u) % 26) % 26 // 2)
    parts = [u[i:i + 26] for i in range(0, len(u), 26)]
    out = []
    for i, p in enumerate(parts, 1):
        e = bytearray(32)
        e[0] = i | (0x40 if i == len(parts) else 0)
        e[1:11] = p[0:10]; e[11] = 0x0F; e[13] = csum; e[14:26] = p[10:22]; e[28:32] = p[22:26]
        out.append(bytes(e))
    return list(reversed(out))

def fits_83(name):
    b, _, e = name.rpartition(".")
    return name == name.upper() and b and 1 <= len(b) <= 8 and len(e) <= 3 and name.replace(".", "", 1).isalnum()

for n, (name, data, attr) in enumerate(files, 1):
    clusters = (len(data) + SECTOR * SPC - 1) // (SECTOR * SPC)
    first = next_cluster
    for c in range(first, first + clusters):
        fat[c] = c + 1 if c < first + clusters - 1 else 0xFFF
    off = (DATA0 + (first - 2) * SPC) * SECTOR
    img[off:off + len(data)] = data
    next_cluster += clusters
    if fits_83(name):
        b, _, e = name.partition(".")
        sfn = (b.ljust(8) + e.ljust(3)).encode()
    else:
        sfn = short_name(name, n)
        entries += lfn_entries(name, sfn)
    d = bytearray(32)
    d[0:11] = sfn; d[11] = attr | ARCHIVE
    struct.pack_into("<HHHHHHHI", d, 14, 0x6000, 0x5D3A, 0x5D3A, 0, 0x6000, 0x5D3A, first, len(data))  # 2026-09-26 12:00
    entries.append(bytes(d))

assert len(entries) <= ROOT_ENTRIES and next_cluster - 2 <= (TOTAL - DATA0) // SPC
for i, e in enumerate(entries):
    root_dir[i * 32:(i + 1) * 32] = e
fatb = bytearray(FAT_SECTORS * SECTOR)
for c, v in fat.items():
    o = c * 3 // 2
    if c & 1:
        fatb[o] = (fatb[o] & 0x0F) | ((v & 0x0F) << 4); fatb[o + 1] = v >> 4
    else:
        fatb[o] = v & 0xFF; fatb[o + 1] = (fatb[o + 1] & 0xF0) | (v >> 8)
for k in range(NFATS):
    o = (RESERVED + k * FAT_SECTORS) * SECTOR
    img[o:o + len(fatb)] = fatb
o = (RESERVED + NFATS * FAT_SECTORS) * SECTOR
img[o:o + len(root_dir)] = root_dir

# ---- sparse ------------------------------------------------------------------------------------------
used = [i for i in range(TOTAL) if any(img[i * SECTOR:(i + 1) * SECTOR])]
out = struct.pack("<4sII", b"WDRV", TOTAL, len(used)) + struct.pack("<%dI" % len(used), *used)
out += b"".join(bytes(img[i * SECTOR:(i + 1) * SECTOR]) for i in used)
(root / "firmware/drive.bin").write_bytes(out)
if "--img" in sys.argv:
    Path(sys.argv[sys.argv.index("--img") + 1]).write_bytes(img)
print(f"firmware/drive.bin: {len(out)} bytes ({len(used)} of {TOTAL} sectors); files: " + ", ".join(f"{n} {len(d)}B" for n, d, _ in files))
