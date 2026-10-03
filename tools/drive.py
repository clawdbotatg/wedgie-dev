#!/usr/bin/env python3
# Builds firmware/drive.bin: the read-only WEDGIE drive a wedgie shows when plugged in (wedgiedrive.py).
# A tiny FAT12 volume, written from scratch here so it's reproducible anywhere:
#   Open wedgie.app         Mac: opens wedgie.dev/connect in Chrome (or the default browser), underwear icon
#   Open wedgie (Windows).url  Windows: an internet shortcut to wedgie.dev/connect
#   README.txt              what this is
#   SKILL.md                everything about a wedgie, for an AI: public/skill.md + code.md + trustm.md
#   ANSWER.TXT              the wedgie's answers to requests dropped on the drive (inbox.py fills it in RAM)
#   .VolumeIcon.icns        the underwear as the drive icon on macOS          (hidden)
#   autorun.inf + wedgie.ico  the underwear as the drive icon on Windows      (hidden)
#   .fseventsd/no_log, .metadata_never_index  macOS: no event log, no Spotlight on it (hidden; RAM, below)
# Stored sparse: only the sectors that aren't all zeros.   python3 tools/drive.py [--img out.img]
# Needs macOS (osacompile, codesign) and pngquant to build; the output (firmware/drive.bin) is committed.
import io, struct, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
SECTOR, TOTAL, RESERVED, NFATS, ROOT_ENTRIES, SPC = 512, 2048, 1, 2, 64, 1     # 1 MB volume
FAT_SECTORS = 6                                                                # 2046 clusters x 1.5 B
ROOT_SECTORS = ROOT_ENTRIES * 32 // SECTOR
DATA0 = RESERVED + NFATS * FAT_SECTORS + ROOT_SECTORS
LABEL = b"WEDGIE     "
ANSWER_SIZE = 2048      # ANSWER.TXT: zeros in the image (free: stored sparse); the wedgie serves it from RAM

# ---- the files ------------------------------------------------------------------------------------
URL = "https://wedgie.dev/connect"
url_win = f"[InternetShortcut]\r\nURL={URL}\r\n".encode()
readme = b"""This is a wedgie.

Double-click "Open wedgie", or go to https://wedgie.dev/connect in Chrome or Edge.

Using an AI (Claude, Codex, ...)? Point it at SKILL.md on this drive: everything about a wedgie, and how
to talk to it over USB.
"""


def skill():
    """The three guides on wedgie.dev as one file: the first one's frontmatter, then each body."""
    out = "\n".join(open(root / "public" / n).read().split("\n---\n", 1)[1] if i else open(root / "public" / n).read()
                    for i, n in enumerate(("skill.md", "code.md", "trustm.md")))
    head = ("> You're reading SKILL.md from a WEDGIE drive: a wedgie is plugged into this computer right now.\n"
            "> Its serial port is the one to talk to (\"Talk to it directly\" below). This file is skill.md, then code.md,\n"
            "> then trustm.md: links to those three point to parts further down. Newest copies: https://wedgie.dev/skill.md\n")
    fm_end = out.index("\n---\n", 4) + 5
    return (out[:fm_end] + "\n" + head + out[fm_end:]).encode()
autorun = b"[autorun]\r\nicon=wedgie.ico\r\nlabel=wedgie\r\n"

src = Image.open(root / "public/img/sticker.webp").convert("RGBA")
def square(n):
    s = Image.new("RGBA", (max(src.size),) * 2, (0, 0, 0, 0))
    s.paste(src, ((s.width - src.width) // 2, (s.height - src.height) // 2), src)
    return s.resize((n, n), Image.LANCZOS)
# Every byte here is flash on every wedgie, so the icons are tiny: 64-color PNGs from pngquant (its
# dithering keeps the white fabric smooth where Pillow's own palette bands it; fewer colors get grainy).
# The drive icon stops at 128 px, what a Mac desktop shows at its default icon size on Retina; the app's
# icon, seen in a Finder list, at 64. Smaller sizes are scaled down from these.   brew install pngquant
def png(px):
    b = io.BytesIO(); square(px).save(b, "PNG")
    return subprocess.run(["pngquant", "--speed", "1", "--strip", "64", "-"], input=b.getvalue(), capture_output=True, check=True).stdout
# .icns and .ico written directly, each a list of those PNGs (iconutil re-encodes them to full color).
ICNS_TYPES = {32: [b"icp5", b"ic11"], 64: [b"ic12"], 128: [b"ic07"]}   # 32 is also 16@2x, 64 is 32@2x
def make_icns(sizes):
    chunks = b""
    for px in sizes:
        data = png(px)
        for tag in ICNS_TYPES[px]:
            chunks += tag + struct.pack(">I", 8 + len(data)) + data
    return b"icns" + struct.pack(">I", 8 + len(chunks)) + chunks
def make_ico(sizes):
    pngs = [png(px) for px in sizes]
    head, off = struct.pack("<HHH", 0, 1, len(sizes)), 6 + 16 * len(sizes)
    for px, data in zip(sizes, pngs):
        head += struct.pack("<BBBBHHII", px, px, 0, 0, 1, 32, len(data), off); off += len(data)
    return head + b"".join(pngs)
icns, app_icns, ico = make_icns((32, 64, 128)), make_icns((32, 64)), make_ico((16, 32, 48))
with tempfile.TemporaryDirectory() as t:
    # The Mac opener: an AppleScript applet that prefers Chrome (Web Serial) and falls back to the default
    # browser. Its icon is the underwear; ad-hoc signed so Apple Silicon runs it.
    app = Path(t) / "Open wedgie.app"
    script = f'do shell script "open -a \\"Google Chrome\\" \\"{URL}\\" || open \\"{URL}\\""'
    subprocess.run(["osacompile", "-o", str(app), "-e", script], check=True)
    res = app / "Contents/Resources"
    (res / "Assets.car").unlink(missing_ok=True)
    (res / "applet.icns").write_bytes(app_icns)
    plist = app / "Contents/Info.plist"
    subprocess.run(["/usr/libexec/PlistBuddy", "-c", "Delete :CFBundleIconName", str(plist)], capture_output=True)
    subprocess.run(["/usr/libexec/PlistBuddy", "-c", "Add :CFBundleIdentifier string dev.wedgie.open", str(plist)], capture_output=True)
    subprocess.run(["codesign", "--force", "--deep", "-s", "-", str(app)], check=True, capture_output=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    def tree(d):
        return [(c.name, tree(c) if c.is_dir() else c.read_bytes(), 0) for c in sorted(d.iterdir())]
    app_tree = tree(app)

# macOS shows .VolumeIcon.icns as the drive icon only if the volume root has the "custom icon" Finder
# flag. On FAT that flag lives in a hidden AppleDouble file named "._." at the root (what macOS itself
# writes after `SetFile -a C`). Captured from macOS once; its one extended attribute (provenance) removed.
appledouble = (root / "art/volume-appledouble.bin").read_bytes()   # macOS's own, custom-icon flag set, provenance xattr removed

HIDDEN, READONLY, ARCHIVE, VOLUME = 0x02, 0x01, 0x20, 0x08
files = [("Open wedgie.app", app_tree, READONLY), ("Open wedgie (Windows).url", url_win, READONLY), ("README.txt", readme, READONLY), ("SKILL.md", skill(), READONLY),
         ("ANSWER.TXT", bytes(ANSWER_SIZE), READONLY),
         (".VolumeIcon.icns", icns, READONLY | HIDDEN), ("autorun.inf", autorun, READONLY | HIDDEN),
         ("wedgie.ico", ico, READONLY | HIDDEN), ("._.", appledouble, READONLY | HIDDEN),
         # the drive takes writes into a few KB of RAM: tell macOS not to keep its event log or Spotlight index on it
         (".fseventsd", [("no_log", b"", HIDDEN)], HIDDEN), (".metadata_never_index", b"", HIDDEN)]

# ---- FAT12 ------------------------------------------------------------------------------------------
img = bytearray(TOTAL * SECTOR)
bs = bytearray(SECTOR)
bs[0:3] = b"\xEB\x3C\x90"; bs[3:11] = b"WEDGIE  "
struct.pack_into("<HBHBHHBHHHII", bs, 11, SECTOR, SPC, RESERVED, NFATS, ROOT_ENTRIES, TOTAL, 0xF8, FAT_SECTORS, 32, 2, 0, 0)
struct.pack_into("<BBBI", bs, 36, 0x80, 0, 0x29, 0x57ED61E0)
bs[43:54] = LABEL; bs[54:62] = b"FAT12   "; bs[510:512] = b"\x55\xAA"
img[0:SECTOR] = bs

fat = {0: 0xFF8, 1: 0xFFF}
next_cluster = 2
DIRATTR = 0x10
CL = SECTOR * SPC

def short_name(name, n):
    base, _, ext = name.upper().lstrip(".").rpartition(".")
    base = "".join(c for c in (base or ext) if c.isalnum())[:6] or "FILE"
    ext = "".join(c for c in (ext if base else "") if c.isalnum())[:3]
    tail = f"~{n}"
    return (f"{base[:8 - len(tail)]}{tail}".ljust(8) + ext.ljust(3)).encode()

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

def alloc(nbytes):
    global next_cluster
    n = max(1, (nbytes + CL - 1) // CL)
    first = next_cluster
    for c in range(first, first + n):
        fat[c] = c + 1 if c < first + n - 1 else 0xFFF
    next_cluster += n
    return first

def put(cluster, data):
    off = (DATA0 + (cluster - 2) * SPC) * SECTOR
    img[off:off + len(data)] = data

def dirent(sfn, attr, cluster, size):
    d = bytearray(32)
    d[0:11] = sfn; d[11] = attr
    struct.pack_into("<HHHHHHHI", d, 14, 0x6000, 0x5D3A, 0x5D3A, 0, 0x6000, 0x5D3A, cluster, size)  # 2026-09-26 12:00
    return bytes(d)

def name_entries(name, n):
    """(lfn entries, short name) for one child."""
    if fits_83(name):
        b, _, e = name.partition(".")
        return [], (b.ljust(8) + e.ljust(3)).encode()
    if name == "._.":
        # exactly what macOS writes: a FAT name can't end in ".", so the last dot is stored as U+F029
        sfn = b"~13        "
        return lfn_entries("._\uf029", sfn), sfn
    sfn = short_name(name, n)
    return lfn_entries(name, sfn), sfn

def write_dir(children, parent):
    """Directory entries for children (files get data clusters; subdirs recurse). parent: its cluster or None (root)."""
    out = []
    for n, (name, data, attr) in enumerate(children, 1):
        lfn, sfn = name_entries(name, n)
        if name == "._.":
            attr = HIDDEN
        if isinstance(data, list):
            count = 2 + sum(1 + len(name_entries(c[0], i)[0]) for i, c in enumerate(data, 1))
            me = alloc(count * 32)
            body = [dirent(b".          ", DIRATTR, me, 0), dirent(b"..         ", DIRATTR, parent or 0, 0)] + write_dir(data, me)
            put(me, b"".join(body))
            out += lfn + [dirent(sfn, DIRATTR | (attr & HIDDEN), me, 0)]
        else:
            c = alloc(len(data)) if data else 0
            if data:
                put(c, data)
            out += lfn + [dirent(sfn, attr | ARCHIVE, c, len(data))]
    return out

entries = [LABEL + bytes([VOLUME]) + bytes(20)] + write_dir(files, None)
root_dir = bytearray(ROOT_SECTORS * SECTOR)
assert len(entries) <= ROOT_ENTRIES and next_cluster - 2 <= (TOTAL - DATA0) // SPC, (len(entries), next_cluster)
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
print(f"firmware/drive.bin: {len(out)} bytes ({len(used)} of {TOTAL} sectors); top level: " + ", ".join(n for n, d, _ in files))
