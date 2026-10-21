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
    x = (d.width - w * sum(len(p) if isinstance(p, str) else 1 for p in parts)) // 2
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
    if d.width < 240:                       # a small screen (oled.py): small.py lays it out
        import small
        return small.page(d, head, lines, hint, show)
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
SETTLE = 600    # ms a question is up before a press answers it: one meant for what was there before (a game's A)
said_no = False # the last ask() was answered with a real no (not a timeout)
signed = None   # the last ask()'s signature check: True, False (not signed), None (none, or not finished)


def check(d, x, y, c=GREEN_D):
    """A small check mark, 16 x 13, its top left at (x, y): a quiet "signed"."""
    for i in range(5):
        d.fill_rect(x + i, y + 5 + i, 3, 3, c)
    for i in range(11):
        d.fill_rect(x + 4 + i, y + 9 - i, 3, 3, c)


def warn(d, x, y):
    """A small red warning sign, 16 x 14, its top left at (x, y-1): "not signed"."""
    for i in range(14):
        d.fill_rect(x + 7 - i // 2, y - 1 + i, 2 + i // 2 * 2, 1, RED)
    d.fill_rect(x + 7, y + 3, 2, 6, WHITE)
    d.fill_rect(x + 7, y + 10, 2, 2, WHITE)


# The dot that pulses where the check will go while a signature is checked: grey, lighter, darker.
PULSE = tuple(L.color(v, v, v) for v in (236, 216, 195, 169, 148, 120, 148, 169, 195, 216))


def mark(d, x, y, s):
    """Where a question's check goes (x, y: the check's top left): s True a check, False a warning sign,
    None nothing, a number the pulsing dot (PULSE[s])."""
    d.fill_rect(x, y - 1, 16, 15, WHITE)
    if s is True:
        check(d, x, y)
    elif s is False:
        warn(d, x, y)
    elif s is not None:
        d.ellipse(x + 8, y + 6, 6, 6, PULSE[s % len(PULSE)], True)
    d.show_rect(x, y - 1, 16, 15)


def ask(d, question, lines=(), yes="yes", no="no", ms=60000, keys=None, scary=False, big=None, sig=None):
    """A yes/no question: green yes, red no, no answer in `ms` is a no. Only real presses count (a press
    sent over USB can't answer). True for yes. scary: white on red, for a yes that hands over
    everything (full control: slot.let_in). big: what it's about, drawn huge under a one-line question
    (scale 3, a word a line, or scale 2 for long words): an update's version, an app's name.
    sig(tick): a signed job's check (slot._sig), run once the question is up, a dot pulsing after big
    meanwhile; it turns into a green check (True), a red warning sign (False) or nothing (None: it
    couldn't check; job.py does after the yes). A press answers at any time, checked or not. Without
    sig there's never a check: it means only "this wedgie checked the signature" (Austin, 10-19)."""
    if d.width < 240:
        import small
        return small.ask(d, question, lines, yes, no, ms, keys, scary, big, sig)
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
        at = (x + w + 8, y - h + (8 * sc - 13) // 2)
        y = 168
    else:
        at = None
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
    return wait(k, ms, sig, at and (lambda s: mark(d, at[0], at[1], s)))


class _Answered(BaseException):     # a press during the check: not an Exception, so release_ok can't eat it
    pass


def wait(k, ms, sig=None, show=None):
    """The answer to a question just drawn: A True, Y False, nothing in ms False. Presses in its first SETTLE
    ms are dropped (audit 10-18: a computer could pop a question under a finger already pressing A).
    sig, show: ask's check, and what draws its mark (show(s), s as ui.mark). signed: what it found."""
    global said_no, signed
    said_no = False
    signed = None
    k.pressed()                             # what went down while it drew doesn't count either
    t0 = time.ticks_ms()
    if sig:
        got, n = [], [0]

        def tick(_=None):                   # ~30 times a check (p256.verify): the keys, then the dot
            for key in k.pressed():
                if key in ("A", "Y") and time.ticks_diff(time.ticks_ms(), t0) >= SETTLE:
                    got.append(key)
                    raise _Answered
            n[0] += 1
            show and show(n[0])

        show and show(0)
        try:
            signed = sig(tick)
        except _Answered:
            pass
        if got:
            said_no = got[0] == "Y"
            return got[0] == "A"
        show and show(signed)
    while time.ticks_diff(time.ticks_ms(), t0) < ms:
        for key in k.pressed():
            if key in ("A", "Y") and time.ticks_diff(time.ticks_ms(), t0) >= SETTLE:
                said_no = key == "Y"
                return key == "A"
        time.sleep_ms(20)
    return False


def progress(head, what="", bar=True):
    """The one progress screen: the boot logo and the boot bar (loader.screen). Returns the bar
    (bar.to(0..1)) or None; loader.what(text) changes the line under it. bar=False: the bar drawn empty
    and nothing kept (no RAM), for nothing to measure or a screen up while an app is still loaded."""
    import loader
    return loader.screen(head, what, bar)
