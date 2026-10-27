# ETH Price: the price of ETH and the newest block on Ethereum and Base, every 30 s, as a table of every step as
# it happens. The wedgie has no internet: its page on wedgie.dev (open in a tab) or `wedgie.py net` carries it
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


def block(chain, log=None):
    kw = {"log": log} if log else {}            # log: firmware 0.3.72+
    return "#" + commas(str(int(net.chain(chain, "eth_blockNumber", **kw), 16)))


class Table:
    def __init__(self, d):
        self.d = d
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

    def draw(self):
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
        d.show()

    def fetch(self, name, f, fmt, c=ui.INK, steps=True):
        """One number: its steps as they pass, then its row. False: it failed (the row says why)."""
        t0 = time.ticks_ms()
        sec = lambda: time.ticks_diff(time.ticks_ms(), t0) / 1000
        if steps:
            self.what, self.steps = name + ":", []

        def log(step):
            self.steps.append((NAMES.get(step) or step + " checked", sec()))
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


def logs():
    """Firmware 0.3.72+ reports each step of its own TLS (net.get log=)."""
    try:
        import wedgie
        return tuple(int(x) for x in wedgie.VERSION.split(".")) >= (0, 3, 72)
    except Exception:
        return False


def run():
    d = L.LCD()
    keys = L.Keys()
    tab = Table(d)
    tab.draw()
    lg = logs()
    first = True
    while True:
        if first:
            tab.fetch("wedgie.dev", fast, dollars, ui.MUTED, steps=False)
            first = False
        if lg:
            tab.fetch("Chainlink", lambda log: net.price(log=log), dollars, ui.GREEN_D)
            tab.fetch("Eth block", lambda log: block(1, log), str)
            tab.fetch("Coinbase", lambda log: float(net.get("https://api.coinbase.com/v2/prices/ETH-USD/spot", pick="data.amount", log=log)), dollars, ui.GREEN_D)
        else:
            tab.fetch("Chainlink", net.price, dollars, ui.GREEN_D, steps=False)
            tab.fetch("Eth block", lambda: block(1), str, steps=False)
            tab.fetch("Coinbase", lambda: float(net.get("https://api.coinbase.com/v2/prices/ETH-USD/spot", pick="data.amount")), dollars, ui.GREEN_D, steps=False)
        tab.fetch("Base block", lambda: block(8453), str, steps=False)
        t = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), t) < EVERY:
            k = keys.pressed()
            if "A" in k or "press" in k:
                break
            time.sleep_ms(50)
