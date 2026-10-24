# ETH Price: the price of ETH and the newest block on Ethereum and Base, every 30 s. The wedgie has no internet:
# its page on wedgie.dev (open in a tab) or `wedgie.py net` fetches for it (firmware net.py, 0.3.61+). The
# sites it may reach are in wedgie.json "net": "chain" (Alchemy, through wedgie.dev) and api.coinbase.com.
# Green: now.
import time
import lcd as L
import ui
import net

EVERY = 30000


def commas(i):
    out = ""
    while len(i) > 3:
        out, i = "," + i[-3:] + out, i[:-3]
    return i + out


def dollars(v):
    i, f = ("%.2f" % v).split(".")
    return "$" + commas(i) + "." + f


def block(chain):
    return commas(str(int(net.chain(chain, "eth_blockNumber"), 16)))


def fetch():
    p = net.price()
    cb = float(net.get("https://api.coinbase.com/v2/prices/ETH-USD/spot", pick="data.amount"))
    return p, cb, block(1), block(8453)


def draw(d, got):
    p, cb, eth, base = got
    d.fill(ui.WHITE)
    ui.band(d)
    ui.say(d, "ETH", 46, ui.MUTED, 2)
    s = dollars(p)
    ui.say(d, s, 80, ui.INK, 3 if len(s) <= 10 else 2)
    ui.say(d, "Coinbase " + dollars(cb), 132, ui.GREEN_D)
    ui.say(d, "Ethereum #" + eth, 162, ui.MUTED)
    ui.say(d, "Base #" + base, 178, ui.MUTED)
    ui.say(d, "{g} now", 222, ui.MUTED)
    d.show()


def run():
    d = L.LCD()
    keys = L.Keys()
    ui.progress("Getting the price", "wedgie.dev", bar=False)
    while True:
        try:
            got = fetch()
            draw(d, got)
        except net.Error as e:
            ui.page(d, "No internet", [(str(e), ui.MUTED)], hint="{g} try again")
        t = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), t) < EVERY:
            k = keys.pressed()
            if "A" in k or "press" in k:
                break
            time.sleep_ms(50)
