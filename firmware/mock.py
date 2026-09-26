# Fake wallet screens for photos. Bare Pico + Waveshare Pico-LCD-1.3, no chip, no WiFi.
# Joystick left/right flips through the screens. On the home screen the A/B/X/Y column jumps to
# send / receive / activity / settings. Up/down moves the cursor on lists. A on the lock screen
# unlocks. Runs from a 40 ms Timer so the REPL stays free. mock.stop() stops it.
import time
from machine import Timer
from lcd import LCD, Keys, color, BLACK, WHITE, RED, GREEN, GREY, DARK, YELLOW

lcd = LCD()
keys = Keys()
timer = None

# palette
BG = color(8, 8, 12)
PANEL = color(24, 26, 34)
LINE = color(48, 52, 64)
DIM = color(140, 144, 160)
LIME = color(80, 220, 120)
BLUE = color(90, 150, 255)
PURPLE = color(170, 110, 255)
ORANGE = color(255, 150, 40)
PINK = color(255, 90, 140)
DKGREEN = color(20, 70, 40)
DKRED = color(110, 30, 30)

ENS = "hard.atg.eth"
ADDR = "0x7a3F9C0e4b12D8A6F5e3c1B0d9a8e7F6C5B4a391"
BAL = "$247.13"

# the A/B/X/Y column: A at the top, Y at the bottom, 56 px pitch
BTN_Y = [37, 93, 149, 205]

# ---- helpers ----------------------------------------------------------------

def short(a):
    return a[:6] + "..." + a[-4:]


def text(s, x, y, c, scale=1):
    if scale == 1:
        lcd.text(s, x, y, c)
    else:
        lcd.big_text(s, x, y, c, scale)


def ctext(s, y, c, scale=1, x0=0, w=240):
    text(s, x0 + (w - 8 * len(s) * scale) // 2, y, c, scale)


def rtext(s, x1, y, c, scale=1):
    text(s, x1 - 8 * len(s) * scale, y, c, scale)


def box(x, y, w, h, c):
    """Filled rect with 1 px chamfered corners."""
    lcd.fill_rect(x + 1, y, w - 2, h, c)
    lcd.fill_rect(x, y + 1, w, h - 2, c)


def tri_right(x, y, h, c):
    for i in range(h // 2):
        lcd.vline(x + i, y - (h // 2 - i), h - 2 * i, c)


def tri_up(x, y, s, c):
    for i in range(s):
        lcd.hline(x + s - 1 - i, y + i, 2 * i + 1, c)


def tri_down(x, y, s, c):
    for i in range(s):
        lcd.hline(x + i, y + i, 2 * (s - 1 - i) + 1, c)


def battery(x, y, pct, c):
    lcd.rect(x, y, 18, 9, c)
    lcd.fill_rect(x + 18, y + 2, 2, 5, c)
    lcd.fill_rect(x + 2, y + 2, max(1, 14 * pct // 100), 5, c)


def dot(x, y, c):
    lcd.fill_rect(x, y, 6, 6, c)
    lcd.pixel(x, y, BG); lcd.pixel(x + 5, y, BG); lcd.pixel(x, y + 5, BG); lcd.pixel(x + 5, y + 5, BG)


def status_bar(chain="mainnet"):
    lcd.text(chain, 4, 4, LIME)
    battery(196, 5, 87, DIM)
    dot(228, 5, LIME)


def side_tabs(labels, colors, active=-1):
    """Four tabs down the right edge, one per physical button."""
    for i, (lab, c) in enumerate(zip(labels, colors)):
        y = BTN_Y[i] - 21
        bg = c if i == active else PANEL
        box(196, y, 44, 42, bg)
        if i != active:
            lcd.vline(196, y + 2, 38, c)
        text(lab, 198 + (42 - 8 * len(lab)) // 2, y + 17, WHITE if i == active else c)


def bar(y, h, label, c, scale=2):
    """Full-width bar with an arrow at the right pointing at the button."""
    lcd.fill_rect(0, y, 240, h, c)
    ctext(label, y + (h - 8 * scale) // 2, WHITE, scale)
    tri_right(222, y + h // 2, 16, WHITE)


def page_dots(cur, n):
    x = 120 - (n * 8 - 2) // 2
    for i in range(n):
        lcd.fill_rect(x + i * 8, 235, 4, 3 if i == cur else 2, WHITE if i == cur else LINE)


_qr = None
try:
    _b = open("mock_qr.bin", "rb").read()
    _n = _b[42]; _w = (_n + 7) // 8
    _qr = (_n, [int.from_bytes(_b[43 + i * _w:43 + (i + 1) * _w], "little") for i in range(_n)])
except OSError:
    pass


def draw_qr(x0, y0, size, pad=6):
    if not _qr:
        lcd.rect(x0, y0, 29 * size + 2 * pad, 29 * size + 2 * pad, LINE)
        ctext("no qr", y0 + 40, RED, 1, x0, 29 * size + 2 * pad)
        return
    n, rows = _qr
    b = n * size + 2 * pad
    lcd.fill_rect(x0, y0, b, b, WHITE)
    for r in range(n):
        bits = rows[r]
        for c in range(n):
            if bits >> c & 1:
                lcd.fill_rect(x0 + pad + c * size, y0 + pad + r * size, size, size, BLACK)


# ---- screens ----------------------------------------------------------------

def home():
    status_bar()
    ctext(BAL, 22, WHITE, 3, 0, 192)
    ctext("USDS", 50, DIM, 1, 0, 192)
    text("+1.3%", 118, 50, LIME)
    draw_qr(52, 64, 3)      # 87 + 12 = 99 px box
    ctext(ENS, 170, YELLOW, 2, 0, 192)
    ctext(short(ADDR), 194, DIM, 1, 0, 192)
    side_tabs(("SEND", "RECV", "HIST", "MENU"), (LIME, BLUE, PURPLE, DIM))


def send():
    bar(0, 60, "SIGN", color(0, 150, 60))
    ctext("send", 66, DIM)
    ctext("42.00", 80, WHITE, 4)
    ctext("USDS", 116, DIM)
    ctext("to", 134, DIM)
    ctext("vitalik.eth", 150, YELLOW, 2)
    ctext("0xd8dA...6045", 172, DIM)
    bar(190, 50, "REJECT", color(170, 30, 30))


def receive():
    draw_qr(25, 2, 6, 8)    # 174 + 16 = 190 px box
    ctext(ENS, 198, YELLOW, 2)
    ctext(ADDR[:21], 218, DIM)
    ctext(ADDR[21:], 227, DIM)


ACTIVITY = (
    ("in", "austin.eth", "+120.00", "2h"),
    ("out", "vitalik.eth", "-42.00", "1d"),
    ("in", "buidlguidl.eth", "+69.00", "3d"),
    ("out", "coffee.eth", "-5.50", "4d"),
    ("in", "work.eth", "+100.00", "1w"),
    ("out", "rent.eth", "-8.00", "2w"),
    ("in", "faucet.eth", "+13.63", "3w"),
)
cursor = {"hist": 0, "menu": 2}


def activity():
    lcd.text("ACTIVITY", 4, 4, YELLOW)
    rtext("7 txs", 236, 4, DIM)
    lcd.hline(0, 16, 240, LINE)
    for i, (d, who, amt, when) in enumerate(ACTIVITY):
        y = 22 + i * 29
        if i == cursor["hist"]:
            lcd.fill_rect(0, y - 5, 240, 28, PANEL)
        if d == "in":
            tri_down(6, y + 6, 6, LIME)
        else:
            tri_up(6, y + 6, 6, PINK)
        lcd.text(who, 22, y, WHITE)
        lcd.text(when, 22, y + 10, DIM)
        rtext(amt, 236, y + 5, LIME if d == "in" else PINK)


MENU = (
    ("network", "mainnet", LIME),
    ("name", ENS, YELLOW),
    ("chip", "ATECC608 locked", LIME),
    ("key", short(ADDR), WHITE),
    ("firmware", "v1.26.1", WHITE),
    ("wifi", "griffith", LIME),
    ("battery", "87%  3.9V", WHITE),
    ("recovery", "14 day delay", ORANGE),
)


def settings():
    lcd.text("SETTINGS", 4, 4, YELLOW)
    lcd.hline(0, 16, 240, LINE)
    for i, (k, v, c) in enumerate(MENU):
        y = 24 + i * 26
        if i == cursor["menu"]:
            lcd.fill_rect(0, y - 5, 240, 22, PANEL)
            lcd.text(">", 4, y + 1, YELLOW)
        lcd.text(k, 16, y + 1, DIM)
        rtext(v, 234, y + 1, c)


CHART = (228, 226, 229, 231, 230, 234, 233, 236, 240, 238, 235, 237, 241, 239, 236, 234,
         238, 242, 245, 243, 241, 244, 248, 246, 249, 251, 248, 250, 245, 247)


def chart():
    lcd.text("BALANCE 30d", 4, 4, YELLOW)
    rtext("USDS", 236, 4, DIM)
    text(BAL, 4, 20, WHITE, 3)
    lcd.text("+$18.40  +8.0%", 4, 48, LIME)
    x0, y0, w, h = 8, 70, 224, 130
    lo, hi = min(CHART) - 4, max(CHART) + 4
    n = len(CHART)
    pts = []
    for i, v in enumerate(CHART):
        pts.append((x0 + i * w // (n - 1), y0 + h - (v - lo) * h // (hi - lo)))
    for gy in (0, h // 2, h):
        lcd.hline(x0, y0 + gy, w, LINE)
    for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
        for x in range(xa, xb + 1):
            y = ya + (yb - ya) * (x - xa) // max(1, xb - xa)
            lcd.vline(x, y, y0 + h - y, DKGREEN)
    for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
        lcd.line(xa, ya, xb, yb, LIME)
        lcd.line(xa, ya + 1, xb, yb + 1, LIME)
    lcd.fill_rect(pts[-1][0] - 3, pts[-1][1] - 3, 6, 6, WHITE)
    lcd.text("$%d" % hi, x0, y0 + 2, DIM)
    lcd.text("$%d" % lo, x0, y0 + h - 10, DIM)
    lcd.text("30d ago", x0, y0 + h + 6, DIM)
    rtext("today", x0 + w, y0 + h + 6, DIM)


def swap():
    lcd.text("SWAP", 4, 4, YELLOW)
    rtext("uniswap v4", 236, 4, PURPLE)
    box(8, 22, 184, 54, PANEL)
    lcd.text("pay", 16, 28, DIM)
    text("0.10", 16, 42, WHITE, 2)
    rtext("ETH", 184, 46, BLUE)
    lcd.fill_rect(88, 82, 24, 10, BG)
    tri_down(94, 80, 6, DIM)
    box(8, 94, 184, 54, PANEL)
    lcd.text("receive", 16, 100, DIM)
    text("421.58", 16, 114, WHITE, 2)
    rtext("USDS", 184, 118, LIME)
    lcd.text("1 ETH = 4215.8 USDS", 8, 158, DIM)
    lcd.text("fee 0.05%  slip 0.5%", 8, 170, DIM)
    lcd.text("gas ~$0.42", 8, 182, DIM)
    side_tabs(("GO", "", "", "BACK"), (LIME, LINE, LINE, DIM), 0)


def lock():
    lcd.ellipse(120, 78, 26, 26, DIM)
    lcd.ellipse(120, 78, 25, 25, DIM)
    lcd.fill_rect(80, 80, 80, 60, BG)
    box(76, 82, 88, 64, YELLOW)
    lcd.fill_rect(116, 100, 8, 14, BG)
    lcd.ellipse(120, 100, 6, 6, BG, True)
    ctext("LOCKED", 160, WHITE, 2)
    ctext(ENS, 184, YELLOW)
    ctext("press A to unlock", 206, DIM)
    side_tabs(("A", "", "", ""), (LIME, LINE, LINE, LINE), 0)


sign_t = 0


def signing():
    global sign_t
    ph = sign_t % 100
    ctext("SIGNING", 30, WHITE, 2)
    ctext("secp256k1 on ATECC608", 54, DIM)
    # chip
    box(90, 74, 60, 60, PANEL)
    lcd.rect(90, 74, 60, 60, LINE)
    for i in range(6):
        lcd.fill_rect(80, 82 + i * 9, 10, 4, DIM)
        lcd.fill_rect(150, 82 + i * 9, 10, 4, DIM)
    lcd.fill_rect(104, 88, 32, 32, LIME if ph < 60 and (ph // 5) % 2 else DKGREEN)
    if ph < 60:
        lcd.rect(30, 150, 180, 14, DIM)
        lcd.fill_rect(32, 152, 176 * ph // 60, 10, LIME)
        ctext("digest 0x9f3c...b71a", 172, DIM)
        ctext("hash ok  nonce 11", 186, DIM)
    else:
        lcd.fill_rect(30, 150, 180, 14, DKGREEN)
        ctext("SENT", 150, LIME, 2, 0, 240)
        ctext("tx 0x0fbd...3e2c", 172, DIM)
        ctext("relayed  82k gas", 186, LIME)


SCREENS = (home, chart, send, receive, activity, settings, swap, signing, lock)
NAMES = tuple(f.__name__ for f in SCREENS)
cur = 0


def show(i):
    global cur
    cur = i % len(SCREENS)
    draw()


def goto(name):
    show(NAMES.index(name))


def draw():
    lcd.fill(BG)
    SCREENS[cur]()
    if NAMES[cur] not in ("send", "receive"):
        page_dots(cur, len(SCREENS))
    lcd.show()


def tick(_):
    global sign_t
    redraw = False
    for k in keys.pressed():
        name = NAMES[cur]
        if k == "right":
            show(cur + 1); return
        if k == "left":
            show(cur - 1); return
        if name == "home":
            j = {"A": "send", "B": "receive", "X": "activity", "Y": "settings"}.get(k)
            if j:
                goto(j); return
        if name == "lock" and k == "A":
            goto("home"); return
        if name in ("send", "swap") and k in ("A", "Y"):
            goto("signing" if k == "A" else "home"); return
        if name == "activity" and k in ("up", "down"):
            cursor["hist"] = (cursor["hist"] + (1 if k == "down" else -1)) % len(ACTIVITY); redraw = True
        if name == "settings" and k in ("up", "down"):
            cursor["menu"] = (cursor["menu"] + (1 if k == "down" else -1)) % len(MENU); redraw = True
        if k in ("B", "X", "Y") and name not in ("home",):
            goto("home"); return
    if NAMES[cur] == "signing":
        sign_t += 1
        if sign_t % 3 == 0:
            redraw = True
    if redraw:
        draw()


def start():
    global timer
    draw()
    timer = Timer(period=40, mode=Timer.PERIODIC, callback=tick)
    print("mock wallet: left/right flips screens. mock.stop() to stop.")


def stop():
    if timer:
        timer.deinit()


def snap(path="shot.bin"):
    """Save the framebuffer to flash so the Mac can pull it (tools/shot)."""
    with open(path, "wb") as f:
        f.write(lcd.buffer)


start()
