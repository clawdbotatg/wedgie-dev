# Keypad: typing on a wedgie. A PIN pad and a keyboard, one grid under both. https://wedgie.dev
# Joystick moves, A (or pressing the joystick in) types the key, Y deletes (Y on nothing = cancel),
# X = done, B = caps on the keyboard. pin() and text() are what another app would call; run() tries both.
#
#   from keypad import pin, text
#   code = pin(lcd, "Enter PIN", 4)        # "1234", or None for cancel
#   name = text(lcd, "Name it")            # "my wallet", or None
import time
from lcd import LCD, Keys
import ui

DEL, OK, CAPS, SPACE = "\x08", "\n", "\x0e", " "
LABEL = {DEL: "<", OK: "OK", CAPS: "aA", SPACE: "space"}

# Rows of (key, width). Every row in a layout adds up to the same width.
PIN = [[(c, 1) for c in r] for r in ("123", "456", "789")] + [[(DEL, 1), ("0", 1), (OK, 1)]]
KEYBOARD = [[(c, 1) for c in r] for r in ("1234567890", "qwertyuiop", "asdfghjkl-", "zxcvbnm_.@")] \
    + [[(CAPS, 2), (SPACE, 4), (DEL, 2), (OK, 2)]]


class Grid:
    def __init__(self, d, head, rows, x0, y0, w, h, gap, big):
        self.d, self.head, self.rows, self.big = d, head, rows, big
        self.x0, self.y0, self.w, self.h, self.gap = x0, y0, w, h, gap
        self.units = sum(u for _, u in rows[0])
        self.r = self.c = 0
        self.caps = False

    def box(self, r, c):
        """Cell (r, c) on the screen: x, y, w, h."""
        a = sum(u for _, u in self.rows[r][:c])
        u = self.rows[r][c][1]
        x = self.x0 + self.w * a // self.units
        return x, self.y0 + r * (self.h + self.gap), self.x0 + self.w * (a + u) // self.units - x - self.gap, self.h

    def key(self, r=None, c=None):
        return self.rows[self.r if r is None else r][self.c if c is None else c][0]

    def cell(self, r, c):
        d = self.d
        x, y, w, h = self.box(r, c)
        k = self.key(r, c)
        on = r == self.r and c == self.c
        fg = ui.WHITE if on else ui.GREEN_D if k == OK else ui.RED if k == DEL else ui.INK
        d.fill_rect(x, y, w, h, ui.GREEN if on else ui.WHITE)
        edge = ui.GREEN_D if on else ui.GREY
        d.rect(x, y, w, h, edge)
        d.rect(x + 1, y + 1, w - 2, h - 2, edge)
        s = LABEL.get(k, k.upper() if self.caps else k)
        if k == CAPS and self.caps:
            s = "AA"
        n = 2 if self.big or len(s) == 1 else 1
        d.big_text(s, x + (w - 8 * n * len(s)) // 2, y + (h - 8 * n) // 2, fg, n) if n > 1 \
            else d.text(s, x + (w - 8 * len(s)) // 2, y + (h - 8) // 2, fg)

    def draw(self, field, hint):
        d = self.d
        d.fill(ui.WHITE)
        ui.band(d)
        d.center_text(self.head[:ui.COLS_BIG], 40, ui.INK, 2)
        field()
        for r in range(len(self.rows)):
            for c in range(len(self.rows[r])):
                self.cell(r, c)
        d.center_text(hint, 231, ui.MUTED)
        d.show()

    def move(self, k):
        """Joystick: wraps around; up and down land on the key nearest above or below."""
        old = (self.r, self.c)
        row = self.rows[self.r]
        if k == "left":
            self.c = (self.c - 1) % len(row)
        elif k == "right":
            self.c = (self.c + 1) % len(row)
        else:
            x, _, w, _ = self.box(self.r, self.c)
            mid = x + w // 2
            self.r = (self.r + (1 if k == "down" else -1)) % len(self.rows)
            best = 999
            for c in range(len(self.rows[self.r])):
                x, _, w, _ = self.box(self.r, c)
                if abs(x + w // 2 - mid) < best:
                    best, self.c = abs(x + w // 2 - mid), c
        for r, c in (old, (self.r, self.c)):
            self.cell(r, c)
            x, y, w, h = self.box(r, c)
            self.d.show_rect(x, y, w, h)


def _type(g, field, val, n, most, keys, hint):
    """The loop under pin() and text(): the typed string on X/OK (or the n-th digit), None on cancel."""
    keys.pressed()                          # a key already down doesn't count
    g.draw(lambda: field(val), hint)
    while True:
        for k in keys.pressed():
            if k in ("up", "down", "left", "right"):
                g.move(k)
                continue
            if k in ("A", "press"):
                k = g.key()
            elif k == "Y":
                if not val:
                    return None
                k = DEL
            elif k == "X":
                k = OK
            elif k == "B" and g.rows is KEYBOARD:
                k = CAPS
            else:
                continue
            if k == OK:
                if not n or len(val) == n:
                    return val
                continue
            if k == CAPS:
                g.caps = not g.caps
                g.draw(lambda: field(val), hint)
                continue
            if k == DEL:
                val = val[:-1]
            elif len(val) < most:
                val = val + (k.upper() if g.caps else k)   # small: at most `most` characters
            field(val)
            g.d.show(60, 88)
            if n and len(val) == n:
                time.sleep_ms(150)              # the last dot shows before it's gone
                return val
        time.sleep_ms(20)


def pin(d, head="Enter PIN", n=4, keys=None):
    """A PIN pad. n digits (it returns as the n-th is typed; n=0: any length, OK to finish).
    Only real presses count unless you pass your own keys: a computer can't type a PIN."""
    g = Grid(d, head, PIN, 36, 96, 174, 28, 5, True)

    def field(val):
        d.fill_rect(0, 60, 240, 28, ui.WHITE)
        if n:
            x = 120 - (n * 30 - 6) // 2
            for i in range(n):
                d.rect(x + i * 30, 62, 24, 24, ui.GREY)
                if i < len(val):
                    d.fill_rect(x + i * 30 + 7, 69, 10, 10, ui.INK)
        else:
            d.center_text("*" * len(val) + "_", 66, ui.INK, 2)

    return _type(g, field, "", n, n or 12, keys or Keys(physical=True), "A press  Y delete")


def text(d, head="Type a name", val="", most=24, keys=None):
    """A keyboard. Starts with `val`; X or OK finishes."""
    g = Grid(d, head, KEYBOARD, 4, 96, 234, 22, 4, False)

    def field(val):
        d.fill_rect(0, 60, 240, 28, ui.WHITE)
        s = (val + "_")[-ui.COLS_BIG:]
        d.fill_rect(8, 62, 224, 24, ui.WHITE)
        d.rect(8, 62, 224, 24, ui.GREY)
        d.big_text(s, 120 - 8 * len(s), 66, ui.INK, 2)

    return _type(g, field, val, 0, most, keys or Keys(), "A type Y del B caps X done")


def run():
    d = LCD()
    keys = Keys()
    while True:
        code = pin(d, keys=keys)
        ui.page(d, "PIN", [(code if code is not None else "cancelled", ui.INK)], "A  next")
        _wait(keys)
        name = text(d, keys=keys)
        ui.page(d, "Name", [(name if name is not None else "cancelled", ui.INK)], "A  again")
        _wait(keys)


def _wait(keys):
    keys.pressed()
    while "A" not in keys.pressed():
        time.sleep_ms(20)
