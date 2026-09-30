#!/usr/bin/env python3
"""One look for the wedgie (CLAUDE.md landmine 10-11, firmware/ui.py):
 - no firmware file but ui.py re-types a palette color (color(r, g, b) with ui.py's values);
 - no firmware file but loader.py loads bar.bin (the one progress bar);
 - src/ui/palette.ts has ui.py's values.
Apps with their own art (games) may use any other colors.   python3 tools/test_style.py"""
import os, re, sys

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
fw = os.path.join(root, "firmware")
ui = open(os.path.join(fw, "ui.py")).read()
pal = {m[0]: tuple(map(int, m[1:])) for m in re.findall(r"^([A-Z_]+) = L\.color\((\d+), (\d+), (\d+)\)", ui, re.M)}
bad = []
for n in sorted(os.listdir(fw)):
    if not n.endswith(".py") or n == "ui.py":
        continue
    s = open(os.path.join(fw, n)).read()
    for m in re.finditer(r"color\((\d+),\s*(\d+),\s*(\d+)\)", s):
        t = tuple(map(int, m.groups()))
        k = next((k for k, v in pal.items() if v == t), None)
        if k:
            bad.append("%s: color%s is ui.%s: use it" % (n, t, k))
    if n != "loader.py" and "bar.bin" in s:
        bad.append("%s: draws bar.bin itself: use ui.progress / loader.screen" % n)
ts = open(os.path.join(root, "src/ui/palette.ts")).read()
for k, (r, g, b) in pal.items():
    want = "#%02x%02x%02x" % (r, g, b)
    if not re.search(r"\b%s: \"%s\"" % (k, want), ts):
        bad.append("src/ui/palette.ts: %s should be %s (firmware/ui.py)" % (k, want))
for b in bad:
    print("FAIL", b)
print("%d palette colors; %s" % (len(pal), "%d FAILED" % len(bad) if bad else "all ok"))
sys.exit(1 if bad else 0)
