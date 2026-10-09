#!/usr/bin/env python3
"""The style guide, enforced (docs/STYLE.md; CLAUDE.md landmines 10-11). Fails when:
 firmware
 - a file but ui.py re-types a palette color (color(r, g, b) with ui.py's values);
 - a file but loader.py loads bar.bin (the one progress bar);
 - a screen says it's busy in words ("WORKING", "loading...", "please wait", a trailing "...") instead
   of showing the boot loader (ui.progress, titled with what it's doing);
 - a file but lcd.py uses lcd's raw colors (L.WHITE, L.RED, L.BLUE...) for anything (they aren't the palette);
 - an app file that draws text doesn't use the kit (import ui);
 - a screen names a button by its letter ("A  try again", "Press Y"): the case has no letters, show {g} {r} {k};
 the site and wedgie.py
 - src/ui/palette.ts drifts from ui.py;
 - anything but files.ts writeFile / wedgie.py Wedgie.put writes a file on a wedgie (those two move its
   bar and refuse to write without the busy screen up);
 - takeOver / take_over is called without the job (the wedgie's screen and question say it);
 - the two copies of BUSY_PY (files.ts, wedgie.py) differ;
 - the site or wedgie.py tells a person to press a button by its letter ("Press A"): say "the green button".
KNOWN lists what isn't on the guide yet. It may only shrink: fix one, take it off.
Game art (sprites, levels, backgrounds) may use any colors of its own.   python3 tools/test_style.py"""
import json, os, re, sys

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
fw = os.path.join(root, "firmware")
read = lambda *p: open(os.path.join(root, *p)).read()

# Not on the guide yet: (file, rule). Each is a real debt; the run prints them.
KNOWN = set()

bad, seen = [], set()


def fail(f, rule, msg):
    if (f, rule) in KNOWN:
        seen.add((f, rule))
    else:
        bad.append("%s: %s" % (f, msg))


def code(s):
    """Python source without comments and docstrings (strings that are drawn stay)."""
    s = re.sub(r'"""[\s\S]*?"""', '""', s)
    return "\n".join(l.split("  #")[0] if not l.lstrip().startswith("#") else "" for l in s.splitlines())


ui = read("firmware/ui.py")
pal = {m[0]: tuple(map(int, m[1:])) for m in re.findall(r"^([A-Z_]+) = L\.color\((\d+), (\d+), (\d+)\)", ui, re.M)}
carts = json.loads(read("firmware/carts.json"))
app_files = {f.replace(".mpy", ".py") for c in carts for f in c["files"] if f.endswith((".py", ".mpy"))}
DRAWS = re.compile(r"(center_text|\.text|big_text|_band|draw_msg|page|ask|progress|screen|what|show|title)\(")
# Busy in words: a line that is only "working" / "loading" / "please wait" / "busy" (any case, any dots),
# or any line ending "..." ("Loading level 3" says what, so it's a fine title for ui.progress).
# A button by its letter in drawn text: "A  yes", "Press Y", "Y no". The case has no letters.
LETTER = re.compile(r"""["'](?:[ABXY] |[^"'\n]*\b(?:[Pp]ress|[Hh]old)\s+[ABXY]\b|[^"'\n]*\b[ABXY]\s+(?:yes|no|to)\b)""")
BUSY = re.compile(r"""["'](\s*(working|loading|please wait|busy|wait)\W*|[^"'\n]*\.\.\.)["']""", re.I)

for n in sorted(os.listdir(fw)):
    if not n.endswith(".py"):
        continue
    f, s = "firmware/" + n, open(os.path.join(fw, n)).read()
    c = code(s)
    if n != "ui.py":
        for m in re.finditer(r"color\((\d+),\s*(\d+),\s*(\d+)\)", s):
            t = tuple(map(int, m.groups()))
            k = next((k for k, v in pal.items() if v == t), None)
            if k:
                fail(f, "palette", "color%s is ui.%s: use it" % (t, k))
    if n != "loader.py" and "bar.bin" in s:
        fail(f, "bar", "draws bar.bin itself: use ui.progress / loader.screen")
    if n not in ("ui.py", "loader.py"):
        for line in c.splitlines():
            if DRAWS.search(line):
                for m in BUSY.finditer(line):
                    if m.group(1).endswith("...") and m.group(1)[:-3].strip() == "":
                        continue
                    if re.search(r'\.replace\(\s*"\.\.\."', line) or re.search(r'\+ "\.\.\." \+', line):
                        continue                # taking "..." off, or shortening an address
                    fail(f, "busy", "says it's busy in words (%r): show the boot loader, ui.progress(what it's doing, the step)" % m.group(1))
    if n not in ("lcd.py",):
        for line in c.splitlines():
            if LETTER.search(line):
                fail(f, "letter", "names a button by its letter (%s): show its color, {g} {r} {k}" % line.strip()[:60])
    if n not in ("lcd.py",) and re.search(r"\bL\.(WHITE|BLACK|RED|GREEN|BLUE|YELLOW|GREY|DARK)\b", c):
        fail(f, "raw colors", "uses lcd's raw colors (L.WHITE, L.RED...): use the ui palette")
    if n in app_files and re.search(r"(center_text|\.text|big_text)\(", c) and not re.search(r"^\s*import .*\bui\b|^\s*from ui import", c, re.M):
        fail(f, "kit", "an app that draws text without the kit: import ui (ui.page / ui.ask / ui.progress, the palette)")

for f in ["public/wedgie.py", "public/drive.html"] + ["src/%s/%s" % (d, x) for d in ("pages", "serial", "ui") for x in sorted(os.listdir(os.path.join(root, "src", d))) if x.endswith(".ts")]:
    for i, line in enumerate(read(f).splitlines(), 1):
        if "wedgie.py press" not in line and re.search(r"\b[Pp]ress (?:<[^>]*>)?[ABXY]\b|\(press [ABXY]\)", line):
            fail(f, "letter", "line %d tells a person a button's letter: say its color (the green button)" % i)

ts = read("src/ui/palette.ts")
for k, (r, g, b) in pal.items():
    want = "#%02x%02x%02x" % (r, g, b)
    if not re.search(r"\b%s: \"%s\"" % (k, want), ts):
        bad.append("src/ui/palette.ts: %s should be %s (firmware/ui.py)" % (k, want))

# The hosts: one writer each, and every REPL job says what it is.
WRITE = re.compile(r"""open\([^)\n]*,\s*\\?["']wb?\\?["']\)""")
for dp, _, fs in os.walk(os.path.join(root, "src")):
    for n in fs:
        if not n.endswith(".ts"):
            continue
        f = os.path.relpath(os.path.join(dp, n), root)
        s = open(os.path.join(dp, n)).read()
        if f != "src/serial/files.ts":
            for m in re.finditer(r"`[^`]*`", s):
                if WRITE.search(m.group(0)):
                    bad.append("%s: writes a file on the wedgie itself: use files.ts writeFile (it moves the wedgie's bar)" % f)
        for m in re.finditer(r"\btakeOver\(r\)", s):
            bad.append("%s: takeOver without the job: the wedgie's question and busy screen say it" % f)
wp = read("public/wedgie.py")
put = re.search(r"\n    def put\(self[\s\S]*?\n    def ", wp).group(0)
for line in wp.replace(put, "").splitlines():
    if ".exec(" in line and WRITE.search(line):
        bad.append("public/wedgie.py: writes a file on the wedgie outside Wedgie.put: use put (it moves the bar): " + line.strip()[:80])
if re.search(r"\btake_over\(wg\)", wp):
    bad.append("public/wedgie.py: take_over without the job: the wedgie's question and busy screen say it")
b_ts = re.search(r"const BUSY_PY = `([\s\S]*?)`;", read("src/serial/files.ts")).group(1)
b_py = re.search(r'BUSY_PY = """([\s\S]*?)"""', wp).group(1)
if b_ts != b_py:
    bad.append("BUSY_PY differs between src/serial/files.ts and public/wedgie.py: keep them the same")

for k in sorted(KNOWN - seen):
    bad.append("%s: %r is fixed: take it off KNOWN in tools/test_style.py" % k)
for b in bad:
    print("FAIL", b)
debt = sorted(seen)
if debt:
    print("not on the style guide yet (KNOWN, may only shrink): " + ", ".join("%s %s" % (f.split("/")[-1], r) for f, r in debt))
print("%d palette colors; %s" % (len(pal), "%d FAILED" % len(bad) if bad else "all ok"))
sys.exit(1 if bad else 0)
