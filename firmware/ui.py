# The wedgie's look: one palette and the few pieces its screens are made of. Every system screen uses
# this (the question, installing, "no software", an app that ended, "wedgie broke"), and apps should too
# (wedgie.dev/code.md, "Look and feel"). Don't re-type these colors or redraw these pieces elsewhere:
# tools/test_style.py fails the build if a firmware file does, and src/ui/palette.ts must match.
#
#   import lcd, ui
#   d = lcd.LCD()
#   ui.page(d, "Game over", [("score 120", ui.INK)], hint="{g} play again")   # {g} = a green square
#   if ui.ask(d, "Delete your save?", ["It can't come back."]): ...
#   bar = ui.progress("Loading level 3", "tiles"); bar and bar.to(0.5)   # the boot bar (loader.screen)
import time
import lcd as L

WHITE = L.color(254, 254, 254)     # the screen
INK = L.color(26, 27, 26)          # text
MUTED = L.color(120, 123, 120)     # second lines, hints
GREEN = L.color(34, 196, 82)       # the waistband's top stripe; yes; the green button
GREEN_D = L.color(22, 140, 52)     # green text on white
GREY = L.color(169, 170, 171)      # the waistband's middle stripe
RED = L.color(227, 49, 44)         # the waistband's bottom stripe; no; errors; the red button

SMALL, BIG = 8, 16                 # text heights: scale 1 and 2 (8 px font)
COLS_SMALL, COLS_BIG = 28, 15      # characters that fit across the screen at each


def wrap(s, n=COLS_SMALL):
    """Words into lines of at most n characters."""
    out = [""]
    for w in str(s).split():
        if out[-1] and len(out[-1]) + 1 + len(w) > n:
            out.append("")
        out[-1] = (out[-1] + " " + w).strip()
    return [x for x in out if x] or [""]


def right():
    """Where an app's text in the top-right corner should end (its x). On a battery the charge takes the
    corner (power.py), so this moves left; call it at each draw, it changes when USB comes and goes."""
    import sys
    p = sys.modules.get("power")
    return p.BOX[0] - 2 if p and p.shown() else 236


def band(d, y=10):
    """The waistband: green, grey, red stripes across the top."""
    for i, c in enumerate((GREEN, GREY, RED)):
        d.fill_rect(0, y + i * 9, 240, 5, c)


def title(d, s, y=48, lines=2, c=INK):
    """A big title, wrapped onto up to `lines` lines (falls back to small text when it won't fit).
    Returns the y under it."""
    t = wrap(s, COLS_BIG)
    if len(t) <= lines:
        for i, x in enumerate(t):
            d.center_text(x, y + i * 24, c, 2)
        return y + len(t) * 24
    t = wrap(s, COLS_SMALL)[:lines + 1]
    for i, x in enumerate(t):
        d.center_text(x, y + i * 14, c)
    return y + len(t) * 14


# The case's buttons have no letters on them, so a screen never names one ("A", "press Y"): it shows the
# button's color. In any text drawn through say(), {g} {r} {k} are a green, red, grey square.
_KEY = {"g": GREEN, "r": RED, "k": GREY}


def say(d, s, y, c=INK, scale=1, edge=INK):
    """center_text, with {g} {r} {k} drawn as a square of that button's color (an `edge` line around it)."""
    if "{" not in s:
        return d.center_text(s, y, c, scale)
    parts = []
    while s:
        j = s.find("{")
        if j < 0 or s[j + 2:j + 3] != "}" or s[j + 1:j + 2] not in _KEY:
            parts.append(s)
            break
        if j:
            parts.append(s[:j])
        parts.append(_KEY[s[j + 1]])
        s = s[j + 3:]
    w = 8 * scale
    x = (240 - w * sum(len(p) if isinstance(p, str) else 1 for p in parts)) // 2
    for p in parts:
        if isinstance(p, str):
            if scale == 1:
                d.text(p, x, y, c)
            else:
                d.big_text(p, x, y, c, scale)
            x += w * len(p)
        else:
            d.fill_rect(x, y - 1, w, w, edge)
            d.fill_rect(x + 1, y, w - 2, w - 2, p)
            x += w


def page(d, head, lines=(), hint="", show=True):
    """The standard screen: white, the waistband, a big title, lines of (text, color), a hint at the
    bottom. Nothing else on a system screen."""
    d.fill(WHITE)
    band(d)
    y = title(d, head, 72) + 12
    for s, c in lines:
        for x in wrap(s):
            say(d, x, y, c)
            y += 14
    if hint:
        say(d, hint[:COLS_SMALL + 2], 222, MUTED)
    if show:
        d.show()


def buttons(d, yes="yes", no="no"):
    """The two answer bars at the bottom: green and red, the colors of the case's yes and no buttons."""
    d.fill_rect(0, 184, 240, 26, GREEN)
    d.center_text(yes[:COLS_BIG], 189, WHITE, 2)
    d.fill_rect(0, 214, 240, 26, RED)
    d.center_text(no[:COLS_BIG], 219, WHITE, 2)


drawn = 0       # ticks_ms when the last ask() finished drawing its question (the slot reports it)


def check(d, x, y, c=GREEN_D):
    """A small check mark, 16 x 13, its top left at (x, y): a quiet "signed"."""
    for i in range(5):
        d.fill_rect(x + i, y + 5 + i, 3, 3, c)
    for i in range(11):
        d.fill_rect(x + 4 + i, y + 9 - i, 3, 3, c)


def ask(d, question, lines=(), yes="yes", no="no", ms=60000, keys=None, scary=False, big=None):
    """A yes/no question: green yes, red no, no answer in `ms` is a no. Only real presses count (a press
    sent over USB can't answer). True for yes. scary: white on red, for a yes that hands over
    everything (full control: slot.let_in). big: what it's about, drawn huge under a one-line question
    (scale 3, a word a line, or scale 2 for long words) with a small green check after its last line:
    a signed update's version, a signed app's name."""
    k = keys or L.Keys(physical=True)
    k.pressed()                             # a key already down doesn't count
    bg, fg = (RED, WHITE) if scary else (WHITE, INK)
    d.fill(bg)
    if scary:
        d.center_text("! WARNING !", 14, WHITE, 2)
    else:
        band(d)
    if big:
        t = big.split()
        sc = 3 if max(len(w) for w in t) <= 8 else 2
        t = wrap(big, 8 if sc == 3 else 13)[:2]
        h = 8 * sc + 4
        y = 34 + (150 - (36 + h * len(t) - 4)) // 2      # the block centered between band and buttons
        d.center_text(question[:COLS_BIG], y, fg, 2)
        y += 36
        for i, s in enumerate(t):
            w = 8 * sc * len(s)
            x = (240 - w - (24 if i == len(t) - 1 else 0)) // 2
            d.big_text(s, x, y, fg, sc)
            y += h
        check(d, x + w + 8, y - h + (8 * sc - 13) // 2)
        y = 168
    else:
        y = max(title(d, question, 48, 2, fg) + 12, 108)
    for s in lines:
        for x in wrap(s):
            if y > 168:
                break
            say(d, x, y, fg, 1, fg)
            y += 14
    buttons(d, yes, no)
    if scary:                               # the no bar is red on red: a white line keeps it a button
        d.fill_rect(0, 212, 240, 2, WHITE)
    d.show()
    global drawn
    drawn = time.ticks_ms()
    t0 = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), t0) < ms:
        for key in k.pressed():
            if key in ("A", "Y"):
                return key == "A"
        time.sleep_ms(20)
    return False


def progress(head, what="", bar=True):
    """The one progress screen: the boot logo and the boot bar (loader.screen). Returns the bar
    (bar.to(0..1)) or None; loader.what(text) changes the line under it. bar=False: the bar drawn empty
    and nothing kept (no RAM), for nothing to measure or a screen up while an app is still loaded."""
    import loader
    return loader.screen(head, what, bar)
