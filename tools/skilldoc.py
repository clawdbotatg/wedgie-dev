"""SKILL.md for the WEDGIE drive. The drive is part of the signed firmware, so it carries a frozen copy,
tools/drive_SKILL.md, made at a firmware release; the guides in public/*.md change any time without one.
  skill_md()   the guides as one file today (public/skill.md + PARTS), what the next release's drive gets
  drive_md()   the frozen copy on the drive now (tools/drive.py builds the drive from it; tools/test_docs.py checks)
At a release: python3 tools/drive.py --refresh (rewrites the frozen copy from skill_md(), then the drive)."""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
PARTS = ("skill.md", "usb.md", "build.md", "safe.md", "security.md", "virtual.md", "shop.md", "code.md", "trustm.md")
FROZEN = root / "tools/drive_SKILL.md"


def skill_md():
    """The guides as one file: the first one's frontmatter, a note, then each body. bytes."""
    texts = [(root / "public" / n).read_text() for n in PARTS]
    out = "\n".join(t if i == 0 else t.split("\n---\n", 1)[1] for i, t in enumerate(texts))
    head = ("> You're reading SKILL.md from a WEDGIE drive: a wedgie is plugged into this computer right now.\n"
            "> Its serial port is the one to talk to (usb.md's part, below). This file is " + ", ".join(PARTS) + ",\n"
            "> one after another: links to those point to parts further down. Newest copies: https://wedgie.dev/skill.md\n")
    fm_end = out.index("\n---\n", 4) + 5
    return (out[:fm_end] + "\n" + head + out[fm_end:]).encode()


def drive_md():
    """The SKILL.md on the drive now. bytes."""
    return FROZEN.read_bytes()
