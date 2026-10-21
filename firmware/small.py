# The system screens on a small screen (the 128x64 OLED: oled.py). ui.py, loader.py, slot.py and hatch.py
# hand their screens here when d.width < 240; an LCD wedgie never imports this. Same words, fewer of them:
# the buttons sit on the right edge, green "yes" at the top (KEY1), red "no" at the bottom (KEY0).
import time
import lcd as L
import ui
from ui import WHITE, INK

COLS = 16           # 8 px characters across 128


def _lines(d, lines, y, c=INK, bottom=64, cols=COLS):
    for s in lines:
        for x in ui.wrap(s, cols):
            if y > bottom - 8:
                return y
            ui.say(d, x, y, c, 1, c)
            y += 10
    return y


def _head(d, s, c=INK):
    """The title: big when it fits on one line, else small on up to two. Returns the y under it."""
    if len(s) <= 8:
        d.center_text(s, 0, c, 2)
        return 20
    return _lines(d, ui.wrap(s, COLS)[:2], 0, c) + 2


def page(d, head, lines=(), hint="", show=True):
    d.fill(WHITE)
    y = _head(d, head)
    _lines(d, [s for s, _ in lines], y, bottom=56 if hint else 64)
    if hint:
        ui.say(d, hint[:COLS], 56, INK, 1, INK)
    if show:
        d.show()


def _mark(d, x, y, s):
    """ui.mark in one color, 8 x 8: a check, a "!" in a box (not signed), nothing, or a dot that blinks."""
    d.fill_rect(x, y, 8, 8, WHITE)
    if s is True:
        for i in range(3):
            d.fill_rect(x + i, y + 4 + i, 2, 2, INK)
        for i in range(5):
            d.fill_rect(x + 3 + i, y + 5 - i, 2, 2, INK)
    elif s is False:
        d.fill_rect(x, y, 8, 8, INK)
        d.fill_rect(x + 3, y + 1, 2, 4, WHITE)
        d.fill_rect(x + 3, y + 6, 2, 1, WHITE)
    elif s is not None:
        d.ellipse(x + 3, y + 4, 3, 3, INK, s // 3 % 2 == 0)
    d.show_rect(x, y, 8, 8)


def ask(d, question, lines=(), yes="yes", no="no", ms=60000, keys=None, scary=False, big=None, sig=None):
    k = keys or L.Keys(physical=True)
    k.pressed()
    bg, fg = (INK, WHITE) if scary else (WHITE, INK)
    d.fill(bg)
    y = _head(d, question, fg)
    at = None
    if big:
        d.text(big[:11], 0, y, fg)
        at = (8 * len(big[:11]) + 2, y)
        y += 10
    _lines(d, lines, y, fg, cols=11)
    no, yes = no[:5], yes[:5]
    d.fill_rect(124 - 8 * len(yes), 0, 8 * len(yes) + 4, 12, fg)
    d.text(yes, 126 - 8 * len(yes), 2, bg)
    d.text(no, 128 - 8 * len(no), 56, fg)
    d.show()
    ui.drawn = time.ticks_ms()
    return ui.wait(k, ms, sig, at and (lambda s: _mark(d, at[0], at[1], s)))


def busy(d, title, what=""):
    """ui.progress: no logo, no bar (callers take None)."""
    d.fill(WHITE)
    d.center_text("wedgie", 0, INK, 2)
    _lines(d, ui.wrap(title, COLS)[:2], 24)
    if what:
        d.center_text(what[:COLS], 56, INK)
    d.show()


def empty(d, short):
    d.fill(WHITE)
    d.center_text("wedgie", 0, INK, 2)
    d.center_text("wedgie.dev", 26, INK)
    d.center_text(short, 56, INK)
    d.show()


def shown(d):
    d.fill(INK)
    d.center_text("COMPUTER HAS", 6, WHITE)
    d.center_text("FULL ACCESS", 20, WHITE)
    d.center_text("not you?", 40, WHITE)
    d.center_text("unplug it now", 52, WHITE)
    d.show()
