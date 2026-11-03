# Clear Signing: the same transactions, clear signed and blind signed. Nothing is signed or sent.
# Up / down: switch between clear (what it does, in words) and blind (the raw bytes).
# Green / red: on to the next transaction. The screens copy Safe Signer's (clawdbotatg/wedgie-safe).
import json, time
import lcd as L
import ui
import clearsign_blockie as blockie

d = L.LCD()
keys = L.Keys()
INK, MUTED, RED, WHITE, GREY = ui.INK, ui.MUTED, ui.RED, ui.WHITE, ui.GREY
COL = {"i": ui.INK, "m": ui.MUTED, "r": ui.RED, "g": ui.GREEN_D}

with open("clearsign_txs.json") as f:
    DEMO = json.load(f)
YOU = DEMO["you"]
TXS = DEMO["txs"]


def card():
    """Who signs: a dark card, its blockie, its address (first 6 and last 4 in white), as Safe Signer's."""
    r = 8
    for y in range(46):
        e = min(y, 45 - y)
        i = int(r - (r * r - (r - e - 0.5) ** 2) ** 0.5 + 0.5) if e < r else 0
        d.hline(2 + i, 2 + y, 236 - 2 * i, INK)
    blockie.draw(d, YOU, 9, 5, 5)
    for i in range(3):
        s = YOU[i * 14:i * 14 + 14]
        for j in range(len(s)):
            n = i * 14 + j
            d.text(s[j], 60 + 8 * j, 7 + i * 13, WHITE if n < 6 or n >= 38 else GREY)


def icon(i, x, y, n):
    import framebuf
    b = bytearray(n * n // 2)
    with open("clearsign_icons.bin", "rb") as f:
        f.seek(i * 416 + (0 if n == 24 else 288))
        f.readinto(b)
    d.blit(framebuf.FrameBuffer(b, n, n, framebuf.GS4_HMSB), x, y, 2)


def big(s, c, ic, y):
    """A big value, its token's picture before it when it has one."""
    sc = 3 if len(s) <= 10 else 2 if len(s) <= ui.COLS_BIG else 1
    if ic is not None:
        n = 24 if sc == 3 else 16
        w = 8 * len(s) * sc + n + 4
        if w > 236 and sc == 3:
            sc, n = 2, 16
            w = 8 * len(s) * sc + n + 4
        if w <= 236:
            x = (240 - w) // 2
            icon(ic, x, y + 5 - sc + (8 * sc - n) // 2, n)
            d.big_text(s, x + n + 4, y + 5 - sc, c, sc)
            return
    d.center_text(s, y + 5 - sc, c, sc)


def clear_page(t):
    y = 76
    red = False
    for l in t["lines"]:
        s, c = l[0], COL[l[1]]
        k = l[2] if len(l) > 2 else None
        if k == "b":
            big(s, c, l[3] if len(l) > 3 else None, y)
            y += 30 if len(s) <= 10 else 22
            red = red or c == RED
        elif k == "a":
            blockie.draw(d, s, 12, y + 2, 4, MUTED)
            d.text(s[:22], 54, y + 6, c)
            d.text(s[22:], 54, y + 20, c)
            y += 38
            red = red or c == RED
        else:
            d.center_text(s, y, c)
            y += 12
    ui.title(d, t["title"], 54, 1, RED if red else INK)
    d.center_text((t["app"] + " - " + t["chain"])[:ui.COLS_SMALL], 172, MUTED)


def blind_page(t):
    ui.title(d, "Blind sign", 54, 1, INK)
    a = t["to"]
    d.center_text("to " + a[:8] + ".." + a[-6:], 76, MUTED)
    y = 88
    if "data" not in t:                         # a signed message: just its two hashes
        for name in ("domain", "message"):
            d.text(name, 4, y, MUTED)
            y += 10
            h = t[name][2:]
            for i in range(0, len(h), 27):
                d.text(h[i:i + 26], 4, y, INK)
                y += 10
        d.center_text(t["chain"], 172, MUTED)
        return
    y += 2
    d.text("value " + t["value"], 4, y, INK)
    y += 12
    h = t["data"]
    n = len(h)
    i = 0
    while i < n and y <= 158:
        d.text(h[i:i + 29], 2, y, INK)
        i += 29
        y += 10
    left = (n - i) // 2
    d.center_text(("+%d bytes - " % left if left > 0 else "") + t["chain"], 172, MUTED)


def draw(i, clear):
    t = TXS[i]
    d.fill(WHITE)
    card()
    if clear:
        clear_page(t)
    else:
        blind_page(t)
    ui.buttons(d, "yes", "no")
    d.show()


def stamp(yes):
    d.fill(ui.GREEN if yes else RED)
    d.center_text("Signed" if yes else "Rejected", 108, WHITE, 3)
    d.show()
    time.sleep_ms(500)


IDLE = 15000    # ms with no press before autopilot starts
STEP = 4000     # ms per screen in autopilot: blind, then clear, then the next transaction


def run():
    i, clear = 0, True
    draw(i, clear)
    last = shown = time.ticks_ms()
    while True:
        now = time.ticks_ms()
        for k in keys.pressed():
            last = now
            if k in ("up", "down"):
                clear = not clear
            elif k in ("A", "Y"):
                stamp(k == "A")
                i = (i + 1) % len(TXS)
            else:
                continue
            draw(i, clear)
            keys.pressed()                      # presses made while it drew don't count twice
            shown = time.ticks_ms()
        if time.ticks_diff(now, last) >= IDLE and time.ticks_diff(now, shown) >= STEP:    # autopilot
            if not clear:                       # the raw bytes, then the same one clear, then the next one raw
                clear = True
            else:
                i, clear = (i + 1) % len(TXS), False
            draw(i, clear)
            shown = time.ticks_ms()
        time.sleep_ms(20)
