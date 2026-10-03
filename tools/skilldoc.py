"""SKILL.md for the WEDGIE drive: public/skill.md + code.md + trustm.md as one file (tools/drive.py puts it
on the drive; tools/test_docs.py checks the drive has this exact text). One source: edit public/*.md."""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
PARTS = ("skill.md", "code.md", "trustm.md")


def skill_md():
    """The three guides as one file: the first one's frontmatter, a note, then each body. bytes."""
    texts = [(root / "public" / n).read_text() for n in PARTS]
    out = "\n".join(t if i == 0 else t.split("\n---\n", 1)[1] for i, t in enumerate(texts))
    head = ("> You're reading SKILL.md from a WEDGIE drive: a wedgie is plugged into this computer right now.\n"
            "> Its serial port is the one to talk to (\"Talk to it directly\" below). This file is skill.md, then code.md,\n"
            "> then trustm.md: links to those three point to parts further down. Newest copies: https://wedgie.dev/skill.md\n")
    fm_end = out.index("\n---\n", 4) + 5
    return (out[:fm_end] + "\n" + head + out[fm_end:]).encode()
