# ETH Price: the price of ETH, big, and a check under it as each source confirms it (Chainlink, Coinbase), every
# 30 s. Down: every number and every step of the fetch under way, as a table. Up: back. The wedgie has no internet: its page on wedgie.dev (open in a tab) or `wedgie.py net` carries it
# (firmware net.py, 0.3.61+). The sites it may reach are in wedgie.json "net": "chain" and api.coinbase.com.
#   wedgie.dev    wedgie.dev's price, ~1 s. Grey: the computer or wedgie.dev could change it.
#   Chainlink     the price from Chainlink's feed, read over the wedgie's own TLS (firmware 0.3.70+): nobody in
#                 between can change it. Its steps show below as each passes (0.3.72+): keys made on the chip,
#                 each certificate's signature, the site's own signature, the answer.
#   Coinbase      Coinbase's price, the same way. Eth block: BuidlGuidl's node, the same. Base block: wedgie.dev.
# Green: now.
import time
import lcd as L
import ui
import net

EVERY = 30000
TOP = 40            # the table's first row
ROW = 12
STEPS = 112         # the last fetch's steps

NAMES = {"connect": "connect", "keys": "keys (chip)", "open": "encrypted", "asked": "asked",
         "signed": "site signed it", "answer": "answer"}


def commas(i):
    out = ""
    while len(i) > 3:
        out, i = "," + i[-3:] + out, i[:-3]
    return i + out


def dollars(v):
    i, f = ("%.2f" % v).split(".")
    return "$" + commas(i) + "." + f


def block(chain, log=None, keep=False):
    kw = {"log": log} if log else {}            # log: firmware 0.3.72+
    if keep:
        kw["keep"] = True
    return "#" + commas(str(int(net.chain(chain, "eth_blockNumber", **kw), 16)))


CHECKS = ("Chainlink", "Coinbase")     # the main screen's checks, under the price
WANT = bytearray(1)     # 1: down was pressed, 2: up (set by the IRQ below, even mid-fetch; 0: nothing new)


def arrows(tab):
    """Up and down caught the moment they're pressed, and the screen switched at once (scheduled: it runs while a
    fetch waits on the site): a fetch blocks for seconds between its own steps. The firmware's power.py has an IRQ
    on every key (activity): it's still called."""
    import sys
    import micropython
    from machine import Pin
    pw = sys.modules.get("power")
    touch = getattr(pw, "_touch", None)
    dn = Pin(L.KEYS["down"], Pin.IN, Pin.PULL_UP)

    flip = tab.flip

    def irq(p):
        WANT[0] = 1 if p is dn else 2
        if touch:
            touch()
        micropython.schedule(flip, None)
    for p in (dn, Pin(L.KEYS["up"], Pin.IN, Pin.PULL_UP)):
        p.irq(irq, Pin.IRQ_FALLING, hard=True)


class Table:
    def __init__(self, d, keys):
        self.d, self.keys = d, keys
        self.more = False       # down: the whole table
        self.drawing = False
        self.rows = []          # [name, value, seconds, color]
        self.steps = []         # (text, seconds) of the fetch under way, or the last one
        self.what = ""

    def row(self, name, value, s, c):
        for r in self.rows:
            if r[0] == name:
                r[1:] = [value, s, c]
                break
        else:
            self.rows.append([name, value, s, c])
        self.draw()

    def look(self):
        """Up and down switch the screens, even mid-fetch (each step calls it). True: the green button."""
        k = self.keys.pressed()
        self.arrow(k)
        return "A" in k or "press" in k

    def flip(self, _):
        if not self.drawing:            # mid-draw: that draw picks it up at its end
            self.arrow()

    def arrow(self, k=()):
        w, WANT[0] = WANT[0], 0
        more = True if w == 1 or "down" in k else False if w == 2 or "up" in k else self.more
        if more != self.more:
            self.more = more
            self.draw()

    def get(self, name):
        for r in self.rows:
            if r[0] == name:
                return r

    def draw(self):
        self.drawing = True
        try:
            self.table() if self.more else self.main()
        finally:
            self.drawing = False
        if WANT[0]:
            self.arrow()

    def table(self):
        d = self.d
        d.fill(ui.WHITE)
        ui.band(d)
        for i, (name, value, s, c) in enumerate(self.rows):
            y = TOP + i * ROW
            d.text(name, 4, y, ui.MUTED)
            t = "%s %4.1fs" % (value, s) if s is not None else value
            d.text(t, 236 - 8 * len(t), y, c)
        d.text(self.what, 4, STEPS - 12, ui.INK)
        for i, (t, s) in enumerate(self.steps[-9:]):
            y = STEPS + i * ROW
            d.text("ok", 12, y, ui.GREEN_D)
            d.text(t, 36, y, ui.INK)
            x = "%4.1fs" % s
            d.text(x, 236 - 8 * len(x), y, ui.MUTED)
        ui.say(d, "{g} now", 226, ui.MUTED)
        for i in range(5):                      # up: back
            d.fill_rect(226 - i, 226 + i, 1 + 2 * i, 1, ui.MUTED)
        d.show()

    def main(self):
        """The price, as big as it fits (grey till Chainlink's is in), and a check under it for each source."""
        d = self.d
        d.fill(ui.WHITE)
        ui.band(d)
        ui.say(d, "ETH", 46, ui.MUTED, 2)
        cl, fast = self.get("Chainlink"), self.get("wedgie.dev")
        ok = lambda r: r and r[3] != ui.RED and r[1][:1] == "$"      # in (the last one stays up while it's asked again)
        p, c = (cl[1], ui.INK) if ok(cl) else (fast[1], ui.MUTED) if ok(fast) else ("...", ui.MUTED)
        ui.say(d, p, 80, c, 3 if len(p) <= 9 else 2)
        for i, name in enumerate(CHECKS):
            r, y = self.get(name), 132 + i * 28
            x = 120 - (16 + 8 + 16 * len(name)) // 2
            if ok(r):
                ui.check(d, x, y)
            elif r and r[3] == ui.RED:
                ui.warn(d, x, y + 1)
            else:
                d.ellipse(x + 8, y + 7, 5, 5, ui.GREY, True)
            d.big_text(name, x + 24, y, ui.INK if ok(r) else ui.MUTED, 2)
        ui.say(d, "{g} now", 222, ui.MUTED)
        for i in range(5):                      # down: more
            d.fill_rect(222 + i, 222 + i, 11 - 2 * i, 1, ui.MUTED)
        d.show()

    def fetch(self, name, f, fmt, c=ui.INK, steps=True):
        """One number: its steps as they pass, then its row. False: it failed (the row says why)."""
        t0 = time.ticks_ms()
        sec = lambda: time.ticks_diff(time.ticks_ms(), t0) / 1000
        if steps:
            self.what, self.steps = name + ":", []

        def log(step):
            self.steps.append((NAMES.get(step) or step + " checked", sec()))
            self.look()
            self.draw()
        old = [r for r in self.rows if r[0] == name]
        self.row(name, old[0][1] if old else "...", None, ui.MUTED)
        try:
            v = f(log) if steps else f()
        except (net.Error, KeyError, TypeError, ValueError) as e:
            self.row(name, "no internet" if "no internet" in str(e) else str(e)[:14], sec(), ui.RED)
            return False
        self.row(name, fmt(v), sec(), c)
        return True


def fast():
    """wedgie.dev's price. Right after an install the wedgie restarts and its page takes a few seconds to come
    back: ask every 3 s, up to 45 s."""
    t = time.ticks_ms()
    while True:
        try:
            return net.chain(1, "wedgie_prices", (), 3000)["eth"]
        except net.Error:
            if time.ticks_diff(time.ticks_ms(), t) > 45000:
                raise


def fw():
    """The firmware's version: 0.3.72+ reports each step of its own TLS (net.get log=), 0.3.74+ keeps a connection
    open (keep=True: the block, asked of the same node right after the price, skips the handshake)."""
    try:
        import wedgie
        return tuple(int(x) for x in wedgie.VERSION.split("."))
    except Exception:
        return (0,)


def run():
    d = L.LCD()
    keys = L.Keys()
    tab = Table(d, keys)
    arrows(tab)
    tab.draw()
    v = fw()
    lg, kp = v >= (0, 3, 72), v >= (0, 3, 74)
    first = True
    while True:
        if first:
            tab.fetch("wedgie.dev", fast, dollars, ui.MUTED, steps=False)
            first = False
        if lg:
            tab.fetch("Chainlink", lambda log: net.price(log=log, keep=True) if kp else net.price(log=log), dollars, ui.GREEN_D)
            tab.fetch("Eth block", lambda log: block(1, log, kp), str)
            tab.fetch("Coinbase", lambda log: float(net.get("https://api.coinbase.com/v2/prices/ETH-USD/spot", pick="data.amount", log=log)), dollars, ui.GREEN_D)
        else:
            tab.fetch("Chainlink", net.price, dollars, ui.GREEN_D, steps=False)
            tab.fetch("Eth block", lambda: block(1), str, steps=False)
            tab.fetch("Coinbase", lambda: float(net.get("https://api.coinbase.com/v2/prices/ETH-USD/spot", pick="data.amount")), dollars, ui.GREEN_D, steps=False)
        tab.fetch("Base block", lambda: block(8453), str, steps=False)
        t = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), t) < EVERY:
            if tab.look():
                break
            time.sleep_ms(50)
