# The wedgie's look: one palette and the few pieces its screens are made of. Every system screen uses
# this (the question, installing, "no software", an app that ended, "wedgie broke"), and apps should too
# (wedgie.dev/code.md, "Look and feel"). Don't re-type these colors or redraw these pieces elsewhere:
# tools/test_style.py fails the build if a firmware file does, and src/ui/palette.ts must match.
#
#   import lcd, ui
#   d = lcd.LCD()
#   ui.page(d, "Game over", [("score 120", ui.INK)], hint="A  play again")
#   if ui.ask(d, "Delete your save?", ["It can't come back."]): ...
#   bar = ui.progress("Loading level 3", "tiles"); bar and bar.to(0.5)   # the boot bar (loader.screen)
import time
import lcd as L

WHITE = L.color(254, 254, 254)     # the screen
INK = L.color(26, 27, 26)          # text
MUTED = L.color(120, 123, 120)     # second lines, hints
GREEN = L.color(34, 196, 82)       # the waistband's top stripe; yes; the A button
GREEN_D = L.color(22, 140, 52)     # green text on white
GREY = L.color(169, 170, 171)      # the waistband's middle stripe
RED = L.color(227, 49, 44)         # the waistband's bottom stripe; no; errors; the Y button

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


def page(d, head, lines=(), hint="", show=True):
    """The standard screen: white, the waistband, a big title, lines of (text, color), a hint at the
    bottom. Nothing else on a system screen."""
    d.fill(WHITE)
    band(d)
    y = title(d, head, 72) + 12
    for s, c in lines:
        for x in wrap(s):
            d.center_text(x, y, c)
            y += 14
    if hint:
        d.center_text(hint[:COLS_SMALL], 222, MUTED)
    if show:
        d.show()


def buttons(d, yes="yes", no="no"):
    """The two answer bars at the bottom: A (green) and Y (red), as on the case."""
    d.fill_rect(0, 184, 240, 26, GREEN)
    d.center_text(("A  " + yes)[:COLS_BIG], 189, WHITE, 2)
    d.fill_rect(0, 214, 240, 26, RED)
    d.center_text(("Y  " + no)[:COLS_BIG], 219, WHITE, 2)


drawn = 0       # ticks_ms when the last ask() finished drawing its question (the slot reports it)


def ask(d, question, lines=(), yes="yes", no="no", ms=60000, keys=None, scary=False):
    """A yes/no question: A yes, Y no, no answer in `ms` is a no. Only real presses count (a press
    sent over USB can't answer). True for yes. scary: white on red, for a yes that hands over
    everything (full control: slot.let_in)."""
    k = keys or L.Keys(physical=True)
    k.pressed()                             # a key already down doesn't count
    bg, fg = (RED, WHITE) if scary else (WHITE, INK)
    d.fill(bg)
    if scary:
        d.center_text("! WARNING !", 14, WHITE, 2)
    else:
        band(d)
    y = max(title(d, question, 48, 2, fg) + 12, 108)
    for s in lines:
        for x in wrap(s):
            if y > 168:
                break
            d.center_text(x, y, fg)
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


def progress(head, what=""):
    """The one progress screen: the boot logo and the boot bar (loader.screen). Returns the bar
    (bar.to(0..1)) or None; loader.what(text) changes the line under it."""
    import loader
    return loader.screen(head, what)
