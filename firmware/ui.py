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


def title(d, s, y=48, lines=2):
    """A big title, wrapped onto up to `lines` lines (falls back to small text when it won't fit).
    Returns the y under it."""
    t = wrap(s, COLS_BIG)
    if len(t) <= lines:
        for i, x in enumerate(t):
            d.center_text(x, y + i * 24, INK, 2)
        return y + len(t) * 24
    t = wrap(s, COLS_SMALL)[:lines + 1]
    for i, x in enumerate(t):
        d.center_text(x, y + i * 14, INK)
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


def _ask_draw(d, question, lines, yes, no):
    d.fill(WHITE)
    band(d)
    y = max(title(d, question, 48, 2) + 12, 108)
    for s in lines:
        for x in wrap(s):
            if y > 168:
                break
            d.center_text(x, y, INK)
            y += 14
    buttons(d, yes, no)


class _Strip:
    """A band of full-width rows, drawn with the LCD's calls (y as on the screen) and pushed straight
    to the panel (lcd.push), so the frame buffer keeps what it had."""
    width = height = 240

    def __init__(self, rows):
        import framebuf
        self.rows, self.y0 = rows, 0
        self.buf = bytearray(480 * rows)
        self.fb = framebuf.FrameBuffer(self.buf, 240, rows, framebuf.RGB565)

    def _in(self, y, h):
        return y < self.y0 + self.rows and y + h > self.y0

    def fill(self, c):
        self.fb.fill(c)

    def fill_rect(self, x, y, w, h, c):
        if self._in(y, h):
            self.fb.fill_rect(x, y - self.y0, w, h, c)

    def text(self, s, x, y, c):
        if self._in(y, 8):
            self.fb.text(s, x, y - self.y0, c)

    def center_text(self, s, y, c, scale=1):
        if self._in(y, 8 * scale):
            L.LCD.center_text(self, s, y, c, scale)

    def big_text(self, s, x, y, c, scale=2):
        L.LCD.big_text(self, s, x, y, c, scale)


kept = False    # the last ask(keep=True) left the frame buffer as it was (False: no RAM for a strip)


def ask(d, question, lines=(), yes="yes", no="no", ms=60000, keys=None, keep=False):
    """A yes/no question: A yes, Y no, no answer in `ms` is a no. Only real presses count (a press
    sent over USB can't answer). True for yes. keep=True: the question goes straight to the panel a
    band at a time and the frame buffer keeps the screen under it (d.show() puts that back), so it's up
    at once: saving 115 KB to flash first took seconds. ui.kept says whether it could."""
    global kept
    k = keys or L.Keys(physical=True)
    k.pressed()                             # a key already down doesn't count
    kept = False
    if keep and hasattr(d, "push"):
        try:
            s = _Strip(40)
            for y0 in range(0, 240, s.rows):
                s.y0 = y0
                _ask_draw(s, question, lines, yes, no)
                d.push(s.buf, y0)
            kept = True
        except MemoryError:
            pass
        s = None
    if not kept:
        _ask_draw(d, question, lines, yes, no)
        d.show()
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
