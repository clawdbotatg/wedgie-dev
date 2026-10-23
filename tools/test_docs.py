#!/usr/bin/env python3
"""The guides stay true (part of tools/gate.mjs, so a release can't be signed with stale docs):
  - skill.md's and usb.md's "current firmware" is firmware/wedgie.py's VERSION, and so is usb.md's hello example;
  - the WEDGIE drive (firmware/drive.bin) carries exactly tools/drive_SKILL.md, and that copy is of this firmware
    (a new VERSION: python3 tools/drive.py --refresh);
  - every guide skill.md's index names is in public/, has frontmatter, and is in tools/skilldoc.py's PARTS;
  - every wedgie.py command and every USB request the slot answers is in usb.md.
    python3 tools/test_docs.py"""
import re, struct, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from skilldoc import drive_md, PARTS

root = Path(__file__).resolve().parent.parent
bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


skill = (root / "public/skill.md").read_text()
usb = (root / "public/usb.md").read_text()
version = re.search(r'^VERSION = "([^"]+)"', (root / "firmware/wedgie.py").read_text(), re.M).group(1)
for name, text in (("skill.md", skill), ("usb.md", usb), ("the drive's SKILL.md", drive_md().decode())):
    cur = re.search(r"current firmware is ([0-9]+\.[0-9]+\.[0-9]+)", text)
    check(cur and cur.group(1) == version, "%s says the current firmware is %s (firmware: %s)" % (name, cur and cur.group(1), version))
hv = re.findall(r'"version":"([0-9.]+)"', usb)
check(hv and all(v == version for v in hv), "usb.md's hello example says %s" % hv)

guides = sorted(set(re.findall(r"https://wedgie\.dev/([a-z0-9]+\.md)", skill.split("## Which guide")[0])))
bad_g = [g for g in guides if not (root / "public" / g).exists()
         or g != "lore.md" and not (root / "public" / g).read_text().startswith("---\nname: ")]   # lore.md: a story, from LORE.md
check(not bad_g, "every guide in skill.md's index is in public/ with frontmatter (%s)%s" % (" ".join(guides), ": bad " + " ".join(bad_g) if bad_g else ""))
off = [g for g in guides if g not in PARTS and g != "lore.md"]
check(not off, "every guide but lore.md goes on the next drive (skilldoc PARTS)%s" % (": missing " + " ".join(off) if off else ""))

# drive.bin: b"WDRV", u32 sectors, u32 n, n x u32 lba, then n x 512 bytes (firmware/wedgiedrive.py)
b = (root / "firmware/drive.bin").read_bytes()
magic, sectors, n = struct.unpack("<4sII", b[:12])
lbas = struct.unpack("<%dI" % n, b[12:12 + 4 * n])
img = bytearray(sectors * 512)
for i, lba in enumerate(lbas):
    o = 12 + 4 * n + i * 512
    img[lba * 512:(lba + 1) * 512] = b[o:o + 512]
check(magic == b"WDRV" and drive_md() in img, "the WEDGIE drive's SKILL.md is tools/drive_SKILL.md (if not: python3 tools/drive.py)")

usage = (root / "public/wedgie.py").read_text().split('"""')[1]
cmds = sorted(set(re.findall(r"python3 wedgie\.py (\w+)", usage)))
missing = [c for c in cmds if "wedgie.py " + c not in usb]
check(not missing, "every wedgie.py command is in usb.md (%d)%s" % (len(cmds), ": missing " + " ".join(missing) if missing else ""))

INTERNAL = {"home", "job", "sums"}      # 0.1.x compatibility, and installs (skill.md: "use wedgie.py")
slot = (root / "firmware/slot.py").read_text()
handler = slot[slot.index("def _handle"):slot.index("\ndef ", slot.index("def _handle") + 5)]
types = set(re.findall(r't == "(\w+)"', handler)) | {x for g in re.findall(r"t in \(([^)]*)\)", handler) for x in re.findall(r'"(\w+)"', g)}
missing = sorted(t for t in types - INTERNAL if '"type":"%s"' % t not in usb)
check(not missing, "every USB request the slot answers is in usb.md (%s)%s" % (" ".join(sorted(types - INTERNAL)), ": missing " + " ".join(missing) if missing else ""))

print("all ok" if not bad else "%d FAILED" % bad)
sys.exit(1 if bad else 0)
