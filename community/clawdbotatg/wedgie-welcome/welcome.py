# Welcome: what a new wedgie plays until it gets real software. A little guy in his undies stands on a
# stage; the screen behind him runs a slideshow: its checks (the chip, its wires, its random, its key slots,
# no saves, every button: see "the checks" below), what a wedgie is, what's inside this one (its CPU,
# RAM, flash, secure chip and a few random numbers from that chip), and where to get software.
#
#   joystick left/right   walk                 up, the green button   jump
#   red and grey buttons  wave                 joystick down          a wedgie
#   Every press also moves the slideshow along faster; a grey button skips to the next slide (not on the
#   checks, where every button is tested). Leave him alone and he wanders on his own.
#
# One full redraw a frame at 20 fps: the slide lives in its own 16-color buffer (S, drawn once per
# slide), so a frame is a fill, a few rects, one blit of S, one sprite. No saves.
import time, framebuf, random, gc, os, machine, array, struct
import lcd as L
from lcd import LCD, Keys, color
import ui
import wedgie as W

lcd = LCD()
keys = Keys()
FRAME = 50

DARK = color(26, 27, 26)
SHADE = color(60, 60, 60)
FLOOR = color(90, 91, 90)
SKIN = color(255, 220, 0)
BLACK = color(0, 0, 0)
BLUE = color(40, 100, 230)
KEY = BLUE                              # the sprites' see-through color (the guy has no blue on him)
WHITE, INK, MUTED, GREEN, GREEN_D, GREY, RED = ui.WHITE, ui.INK, ui.MUTED, ui.GREEN, ui.GREEN_D, ui.GREY, ui.RED

# The projection screen: its picture is S, SW x SH at (SX, SY), a grey frame around it.
SX, SY, SW, SH = 30, 16, 180, 158
FEET = 204                              # where his feet touch the stage
APRON = 212                             # below it, the stage's front: wedgie.dev, always
FLOOR_Y = 188


class _Buf(framebuf.FrameBuffer):
    width = SW                          # ui.say centers on d.width


S = _Buf(bytearray(SW * SH // 2), SW, SH, framebuf.GS4_HMSB)
_T = framebuf.FrameBuffer(bytearray(128), 128, 8, framebuf.MONO_HLSB)    # one line of text, to scale up

# wedgie.dev on the stage's front, drawn once at scale 2 and blitted every frame.
class _Site(framebuf.FrameBuffer):
    width = 160


SITE = _Site(bytearray(160 * 16 // 2), 160, 16, framebuf.GS4_HMSB)
SITE.fill(KEY)
_T.fill(0)
_T.text("wedgie.dev", 0, 0, 1)
for _y in range(8):
    for _x in range(80):
        if _T.pixel(_x, _y):
            SITE.fill_rect(_x * 2, _y * 2, 2, 2, WHITE)

# ---- the guy: 12 x 18 cells of 3 px ------------------------------------------------------------------
P, GW, GH = 3, 36, 54
CELL = {"k": BLACK, "y": SKIN, "w": WHITE, "g": GREEN, "s": GREY, "r": RED}
HEAD = ["...kkkkkk...", "..kkkkkkkk..", "..yyyyyyyy..", "..yyyyyyyy..", "..yyyyyyyy..", "..yyykkyyy..",
        "...yyyyyy...", "....yyyy...."]
BODY = [".yyyyyyyyyy.", ".y.yyyyyy.y.", ".y.gggggg.y.", ".y.ssssss.y.", ".y.rrrrrr.y.", "...wwwwww...",
        "...ww..ww..."]
STAND = ["...yy..yy...", "...yy..yy...", "..kkk..kkk.."]
STEP = ["..yy....yy..", ".yy......yy.", ".kkk....kkk."]
TOGETHER = ["....yyyy....", "....yyyy....", "...kkkkkk..."]
TUCK = ["...yy..yy...", "..kkk..kkk..", "............"]
WAVE_BODY = [".yyyyyyyyyyy", ".y.yyyyyy...", ".y.gggggg...", ".y.ssssss...", ".y.rrrrrr...", "...wwwwww...",
             "...ww..ww..."]
ARMS_UP = ["yyyyyyyyyyyy", "...yyyyyy...", "...gggggg...", "...ssssss...", "...rrrrrr...", "...wwwwww...",
           "...ww..ww..."]
PULLED = [".yyyyyyyyyy.", ".yggggggggy.", ".y.ssssss.y.", ".y.rrrrrr.y.", ".y.wwwwww.y.", "...wwwwww...",
          "....w..w...."]
KNOCK = ["....yyyy....", "...yy..yy...", "..kkk..kkk.."]


def _with(head, cells):
    """HEAD with an arm drawn up its right side: cells = [(row, col), ...]."""
    h = [list(r) for r in head]
    for r, c in cells:
        h[r][c] = "y"
    return ["".join(r) for r in h]


def sprite(rows):
    fb = framebuf.FrameBuffer(bytearray(GW * GH // 2), GW, GH, framebuf.GS4_HMSB)
    fb.fill(KEY)
    for j, r in enumerate(rows):
        for i, ch in enumerate(r):
            if ch != ".":
                fb.fill_rect(i * P, j * P, P, P, CELL[ch])
    return fb


ARM1 = [(r, 11) for r in range(2, 8)]
ARM2 = [(3, 10), (3, 11)] + [(r, 11) for r in range(4, 8)]
UP2 = [(r, c) for r in range(3, 8) for c in (0, 11)]
G_STAND = sprite(HEAD + BODY + STAND)
G_STEP = sprite(HEAD + BODY + STEP)
G_TOGETHER = sprite(HEAD + BODY + TOGETHER)
G_WAVE1 = sprite(_with(HEAD, ARM1) + WAVE_BODY + STAND)
G_WAVE2 = sprite(_with(HEAD, ARM2) + WAVE_BODY + STAND)
G_JUMP = sprite(_with(HEAD, UP2) + ARMS_UP + TUCK)
G_WEDGIE = sprite(HEAD + PULLED + KNOCK)
del HEAD, BODY, STAND, STEP, TOGETHER, TUCK, WAVE_BODY, ARMS_UP, PULLED, KNOCK, ARM1, ARM2, UP2
gc.collect()

# ---- the slides ---------------------------------------------------------------------------------------


def big(s, y, c=INK, sc=2, x0=None):
    """Text scaled up, centered on S (or from x0): framebuf's 8x8 font, a fill_rect per run of lit pixels."""
    w = 8 * len(s)
    _T.fill(0)
    _T.text(s, 0, 0, 1)
    if x0 is None:
        x0 = (SW - w * sc) // 2
    for yy in range(8):
        xx = 0
        while xx < w:
            if _T.pixel(xx, yy):
                n = xx + 1
                while n < w and _T.pixel(n, yy):
                    n += 1
                S.fill_rect(x0 + xx * sc, y + yy * sc, (n - xx) * sc, sc, c)
                xx = n
            else:
                xx += 1


def small(s, y, c=MUTED):
    S.text(s, (SW - 8 * len(s)) // 2, y, c)


def undies(cx, y, w):
    """The wedgie's underwear, like the boot logo: a white waistband with a green and a red stripe, white
    briefs with leg holes cut up toward a narrow middle."""
    x = cx - w // 2
    S.fill_rect(x, y, w, 16, MUTED)
    S.fill_rect(x + 1, y + 1, w - 2, 14, WHITE)
    S.fill_rect(x + 1, y + 4, w - 2, 3, GREEN)
    S.fill_rect(x + 1, y + 9, w - 2, 3, RED)
    top, m = y + 16, w // 2
    pts = array.array("h", [1, 0, w - 1, 0, w + 3, w // 3, m + w // 8, w * 3 // 5, m - w // 8, w * 3 // 5,
                            -3, w // 3])
    S.poly(x, top, pts, WHITE, True)
    S.poly(x, top, pts, MUTED, False)
    for o in (4, 7):                    # the leg holes' hems
        S.line(x - 3 + o, top + w // 3 + 1, x + m - w // 8 + o // 2, top + w * 3 // 5 - o, GREY)
        S.line(x + w + 3 - o, top + w // 3 + 1, x + m + w // 8 - o // 2, top + w * 3 // 5 - o, GREY)


def safe_icon(cx, y):
    S.fill_rect(cx - 30, y, 60, 52, INK)
    S.fill_rect(cx - 27, y + 3, 54, 46, GREY)
    S.rect(cx - 22, y + 8, 44, 36, INK)
    S.ellipse(cx, y + 26, 11, 11, INK, True)
    S.ellipse(cx, y + 26, 7, 7, WHITE, True)
    S.fill_rect(cx - 1, y + 17, 3, 7, INK)
    S.fill_rect(cx - 26, y + 52, 8, 4, INK)
    S.fill_rect(cx + 18, y + 52, 8, 4, INK)
    ui.check(S, cx + 36, y + 30)


def blocks(cx, y):
    B = 12
    for col, row, c in ((0, 2, GREEN), (1, 2, GREEN), (2, 2, GREEN), (1, 1, GREEN), (3, 2, RED), (4, 2, RED),
                        (4, 1, RED), (4, 0, RED), (-1, 2, BLUE), (-1, 1, BLUE), (-2, 2, BLUE), (-2, 1, BLUE),
                        (2, 0, SKIN), (2, 1, SKIN), (3, 1, SKIN), (3, 0, SKIN)):
        x, yy = cx - B + col * B, y + row * B
        S.fill_rect(x, yy, B, B, INK)
        S.fill_rect(x + 1, yy + 1, B - 2, B - 2, c)


def terminal(cx, y):
    S.fill_rect(cx - 44, y, 88, 52, INK)
    for i, c in enumerate((RED, SKIN, GREEN)):
        S.fill_rect(cx - 40 + i * 9, y + 4, 5, 5, c)
    S.text(">", cx - 36, y + 18, GREEN)
    S.text("make me", cx - 26, y + 18, WHITE)
    S.text("a game", cx - 26, y + 30, WHITE)
    S.fill_rect(cx + 24, y + 30, 7, 8, GREEN)


# What this wedgie is made of: read once at start (the chip's random numbers are new on every lap).
INFO = {}


def _kb(n):
    return "%d KB" % (n // 1024) if n < 1024 * 1024 else "%d.%d MB" % (n // 1048576, n * 10 // 1048576 % 10)


def _bits(b):
    n = 0
    for x in b:
        while x:
            n += x & 1
            x >>= 1
    return n


# ---- the checks: what a Trust M wedgie shows on its second slide -------------------------------------
# Run one small step a frame (a generator; each step one chip command, a few ms), so he keeps moving and
# the rows tick green as they finish. Nothing written anywhere, so nothing wears: reads, random, SHA-256.
#   Trust M   it answers
#   wires     45 commands in a row (200 bytes of its certificate, 32 random bytes, SHA-256 of 200 random bytes),
#             every answer checked; a miss gets one quiet retry (a page checking the chip over USB resets it)
#   random    two reads differ, neither one byte over and over, about half the bits 1 (6 sigma of 512)
#   key slot  KEY2-4 and DATA[11] unlocked, no Safe Signer key copy in DATA[11]: its person makes their own key
#             and locks it (Safe Signer locks KEY2 for good, and locks a copy it finds: trustm.md)
#   fresh     nothing in /saves
#   buttons   all 9 pressed since it started (any slide); the slide waits up to 12 s for them
# No Trust M (an ATECC608, or none): no checks slide. Its signature and its certificate's chain to Infineon
# are checked on wedgie.dev/prepare (Infineon's newer CAs are P-384, more than this can verify).
ROWS = ("Trust M", "wires", "random", "key slot", "fresh")
RES = {}                                # row -> True / False, as each finishes
BUTTONS = ("up", "down", "left", "right", "press", "A", "B", "X", "Y")
seen = set()
CHECK = None                            # the checks under way (a generator), None when done or not started
done_t = None                           # when they finished


def _bits(b):
    n = 0
    for x in b:
        while x:
            n += x & 1
            x >>= 1
    return n


def _meta(m):
    """Metadata as (locked, used bytes). locked: operational (locked for good), or never changeable."""
    i, locked, used = 2, False, 0
    while i + 2 <= len(m):
        t, v = m[i], m[i + 2:i + 2 + m[i + 1]]
        if (t == 0xC0 and v[0] >= 7) or (t == 0xD0 and v == b"\xff"):
            locked = True
        elif t == 0xC5:                 # used size
            used = int.from_bytes(v, "big")
        i += 2 + m[i + 1]
    return locked, used


def checks():
    from machine import Pin
    import hashlib
    tm = True
    for p in (4, 5):                    # no pull-ups: nothing on the bus (don't wait on timeouts)
        tm = Pin(p, Pin.IN, Pin.PULL_DOWN).value() and tm
        Pin(p, Pin.IN)
    s = None
    if tm:
        try:
            import trustm
            trustm.bus(4, 5)
            s = trustm.Session()
        except Exception:
            s = None
    RES["Trust M"] = s is not None
    yield
    if s:
        def run(f):                     # one command; a miss gets one retry on a new session
            nonlocal s
            try:
                return f(s)
            except Exception:
                s = trustm.Session()
                return f(s)
        ok, used = True, 0
        try:
            for oid in (0xE0F1, 0xE0F2, 0xE0F3, 0xF1DB):
                locked, used = _meta(run(lambda c: c.metadata(oid)))
                ok = ok and not locked
                yield
            if used:                    # DATA[11] holds something: it mustn't be a key copy (a read that fails: not ok)
                ok = ok and run(lambda c: c.get(0xF1DB, 0, 6)) != b"wsafe1"
        except Exception:
            ok = False
        RES["key slot"] = ok
        yield
        try:
            a, b = run(lambda c: c.random(32)), run(lambda c: c.random(32))
            RES["random"] = a != b and a != a[:1] * 32 and b != b[:1] * 32 and abs(_bits(a + b) - 256) <= 68
        except Exception:
            RES["random"] = False
        yield
        ok = True
        try:
            cert = run(lambda c: c.get(0xE0E0, 0, 200))
            prev = b""
            for n in range(45):
                k = n % 3
                if k == 0:
                    ok = run(lambda c: c.get(0xE0E0, 0, 200)) == cert and ok
                elif k == 1:
                    r = run(lambda c: c.random(32))
                    ok = len(r) == 32 and r != prev and ok
                    prev = r
                else:
                    d = os.urandom(200)
                    ok = run(lambda c: c.command(0x30, 0xE2, b"\x01\x00\xc8" + d))[3:] == hashlib.sha256(d).digest() and ok
                yield
        except Exception:
            ok = False
        RES["wires"] = ok
    try:
        top = os.listdir("/saves")
    except OSError:
        top = []                        # no /saves at all
    fresh = True
    for n in top:                       # each a game's folder, empty; anything else (a file, unreadable): not fresh
        try:
            fresh = fresh and not os.listdir("/saves/" + n)
        except OSError:
            fresh = False
    RES["fresh"] = fresh
    gc.collect()
    yield
    read_chip()                         # last: finding the chip for rand resets it


def read_info():
    name, cpu, wifi = W.board()
    INFO["cpu"] = cpu
    INFO["mhz"] = "%d MHz" % (machine.freq() // 1000000)
    gc.collect()
    INFO["ram"] = _kb(gc.mem_free()) + " RAM"
    try:
        s = os.statvfs("/")
        INFO["flash"] = _kb(s[0] * s[3]) + " free"
        INFO["of"] = "of " + _kb(s[0] * s[2]) + " flash"
    except Exception:
        INFO["flash"], INFO["of"] = "", ""
    INFO["chip"], INFO["state"], INFO["from"] = ["its chip"], "", ""     # read_chip, after the checks


def read_chip():
    try:
        W.rand(1)                       # finds the chip (half a second on a Trust M)
        src = W.rand_source()
    except Exception as e:
        src = "os.urandom (%s)" % e
    if src.startswith("os.urandom"):
        why = src[12:-1]
        if why.startswith("ATECC608"):
            INFO["chip"], INFO["state"] = ["ATECC608"], "not locked yet"
        else:
            INFO["chip"], INFO["state"] = ["No chip"], "" if why == "no chip" else why[:22]
        INFO["from"] = "random from the Pico"
    else:
        INFO["chip"] = ["OPTIGA", "Trust M"] if "Trust" in src else [src]
        INFO["state"] = "working"
        INFO["from"] = "random from the chip"


def row(i):
    """One check's row on S: its name, then a check, a red X, or nothing yet."""
    label, y = ROWS[i], 22 + 20 * i
    S.fill_rect(0, y, SW, 18, WHITE)
    ok = RES.get(label)
    big(label, y, MUTED if ok is None else INK if ok else RED, 2, 14)
    if ok:
        ui.check(S, 150, y + 1, GREEN_D)
    elif ok is False:
        big("X", y, RED, 2, 150)


def buttons_row():
    """The 9 buttons as squares, green once pressed, and what it all comes to."""
    y = 138
    for n, k in enumerate(BUTTONS):
        S.fill_rect(14 + n * 17, y, 13, 13, GREEN if k in seen else SHADE)
    S.fill_rect(0, y - 14, SW, 10, WHITE)
    if any(v is False for v in RES.values()):
        small("not ready", y - 14, RED)
    elif CHECK is None and len(RES) == len(ROWS) and len(seen) == len(BUTTONS):
        small("ready for your key", y - 14, GREEN_D)
    elif CHECK is None and len(RES) == len(ROWS):
        small("press every button", y - 14, MUTED)


def s_ready():
    small("this wedgie", 6)
    for i in range(len(ROWS)):
        row(i)
    buttons_row()


def s_welcome():
    big("Welcome", 34, INK, 3)
    big("to", 70, INK, 3)
    ui.say(S, "{g} jump  {r} wave", 118, MUTED)


# The boot logo (logo.bin, on every wedgie): kept in 16 colors in S, and shown over that in full color
# (lcd.art) whenever the guy isn't in front of it.
LOGO = None                             # (x, y, w, h) on S
LY = 12


def read_logo():
    global LOGO
    try:
        with open("logo.bin", "rb") as f:
            _, _, w, h = struct.unpack(">4H", f.read(8))
            f.read(2)
            if w > SW or h > 100:
                return
            fb = framebuf.FrameBuffer(bytearray((w * h + 1) // 2), w, h, framebuf.GS4_HMSB)
            row = bytearray(w * 2)
            for j in range(h):
                f.readinto(row)
                for i in range(w):
                    fb.pixel(i, j, L.index565(row[2 * i] | row[2 * i + 1] << 8))
        LOGO = ((SW - w) // 2, LY, w, h, fb)
    except (OSError, ValueError, AttributeError):
        pass


def s_wedgie():
    if LOGO:
        S.blit(LOGO[4], LOGO[0], LOGO[1], -1)
        big("the wedgie", LY + LOGO[3] + 14, INK, 2)
    else:
        undies(SW // 2, 12, 112)
        big("the wedgie", 110, INK, 2)


def s_safe():
    safe_icon(SW // 2 - 8, 12)
    big("Signs for", 82, INK, 2)
    big("your Safe", 104, INK, 2)


def s_games():
    blocks(SW // 2, 14)
    big("Play games", 70, INK, 2)
    small("blocks, frog, 2048,", 98)
    small("blackjack, bunker", 110)


def s_make():
    terminal(SW // 2, 12)
    big("Make your", 76, INK, 2)
    big("own games", 98, INK, 2)


def s_inside():
    small("inside this one", 10)
    y = 28
    for k in ("cpu", "mhz", "ram", "flash"):
        big(INFO[k], y, INK, 2)
        y += 22
    small(INFO["of"], y + 2)


def s_chip():
    small("its secure chip", 10)
    y = 26
    for s in INFO["chip"]:
        big(s, y, INK, 2)
        y += 20
    small(INFO["state"], y, GREEN_D if INFO["state"] == "working" else MUTED)
    small(INFO["from"], y + 18)
    global RND, RY, roll_t
    try:
        RND = W.rand(8)
    except Exception:
        RND = os.urandom(8)
    RY, roll_t = y + 32, None
    digits(0)


# The random number rolls like a slot machine, then each digit stops on the chip's, left to right.
HEX = "0123456789abcdef"


def _glyph(ch, c):
    fb = framebuf.FrameBuffer(bytearray(128), 16, 16, framebuf.GS4_HMSB)
    fb.fill(WHITE)
    _T.fill(0)
    _T.text(ch, 0, 0, 1)
    for yy in range(8):
        for xx in range(8):
            if _T.pixel(xx, yy):
                fb.fill_rect(xx * 2, yy * 2, 2, 2, c)
    return fb


SPIN = [_glyph(c, MUTED) for c in HEX]
STOP = [_glyph(c, GREEN_D) for c in HEX]
RND, RY = b"", 0
roll_t = None                           # when the chip slide came up (None: not yet)
ROLL0, ROLL_EACH = 500, 110             # ms of spinning before the first digit stops, then one per


def digits(ms):
    """Draw the 16 digits as they are ms after the slide came up. True once all have stopped."""
    x0 = (SW - 128) // 2
    for n in range(16):
        v = RND[n >> 1] >> (0 if n & 1 else 4) & 15
        g = STOP[v] if ms >= ROLL0 + n * ROLL_EACH else SPIN[random.getrandbits(4)]
        S.blit(g, x0 + (n & 7) * 16, RY + (n >> 3) * 20, -1)
    return ms >= ROLL0 + 15 * ROLL_EACH


def s_go():
    big("Go to", 22, INK, 2)
    big("wedgie.dev", 46, GREEN_D, 2)
    small("plug me in there", 82, INK)
    small("for apps and updates", 96)


SLIDES = ((s_welcome, 2600), (s_wedgie, 3600), (s_ready, 6000), (s_inside, 8000), (s_chip, 6000), (s_safe, 3600),
          (s_games, 3600), (s_make, 3600), (s_go, 6000))
FLIP = 360                              # ms: the screen turns over between slides

si = 0
slide_end = 0
flip_t = None
flipped = False


def render(i):
    global CHECK
    if SLIDES[i][0] is s_ready and CHECK is None and not RES:
        CHECK = checks()                # not at start: a page checking the chip over USB at plug-in does it then
    S.fill(WHITE)
    SLIDES[i][0]()
    gc.collect()


# ---- the guy ------------------------------------------------------------------------------------------
x = 102
h = 0                                   # how high he is off the stage
vy = 0
face = 0                                # -1 left, 0 ahead, 1 right
walk = 0                                # steps taken, for the legs
wave_end = 0
said, say_end = "", 0
last_in = 0                             # the last press or push
target = None                           # where he wanders to when nobody plays
next_idea = 0


def jump():
    global vy
    if h == 0:
        vy = 11


def wave(now):
    global wave_end, said, say_end
    wave_end = time.ticks_add(now, 1000)
    said, say_end = "hi!", wave_end


def update(now, pressed):
    global x, h, vy, face, walk, last_in, target, next_idea, slide_end, said, say_end
    for k in pressed:
        seen.add(k)
        last_in = now
        target = None
        if k in ("A", "up"):
            jump()
        elif k in ("B", "X", "Y", "press"):
            wave(now)
        if flip_t is None and SLIDES[si][0] is not s_ready:     # every press moves the slideshow along faster,
            slide_end = now if k in ("B", "X") else time.ticks_add(slide_end, -1200)   # a grey one to the next
                                                                    # slide (the checks: two presses on the line)
    dx = 0
    wedgie = keys.held("down")
    if wedgie:
        last_in = now
        if said != "ow!":
            said = "ow!"
        say_end = time.ticks_add(now, 300)
    elif keys.held("left"):
        dx = -1
    elif keys.held("right"):
        dx = 1
    if dx:
        last_in = now
        target = None
    elif time.ticks_diff(now, last_in) > 5000 and not wedgie:      # nobody's playing: he wanders
        if target is None and time.ticks_diff(now, next_idea) > 0:
            r = random.randint(0, 9)
            if r < 6:
                target = random.randint(30, 180)
            elif r < 8:
                wave(now)
            else:
                jump()
            next_idea = time.ticks_add(now, random.randint(900, 2600))
        if target is not None:
            if abs(target - x) <= 3:
                target = None
                face = 0
            else:
                dx = 1 if target > x else -1
    if dx:
        face = dx
        x = max(22, min(218 - GW, x + dx * 3))
        walk += 1
    elif h == 0 and time.ticks_diff(now, last_in) > 1500 and target is None:
        face = 0
    if h or vy:
        h += vy
        vy -= 1
        if h <= 0:
            h, vy = 0, 0
    return wedgie, dx


def stage():
    d = lcd
    d.fill(DARK)
    d.fill_rect(24, 9, 192, 5, SHADE)                       # the screen's roller
    d.rect(SX - 2, SY - 2, SW + 4, SH + 4, GREY)
    d.rect(SX - 1, SY - 1, SW + 2, SH + 2, GREY)
    d.fill_rect(0, FLOOR_Y, 240, APRON - FLOOR_Y, FLOOR)
    d.fill_rect(0, FLOOR_Y, 240, 2, GREY)
    d.hline(0, 200, 240, SHADE)
    for vx in (40, 112, 190):
        d.vline(vx, FLOOR_Y + 2, 10, SHADE)
    for vx in (76, 150, 220):
        d.vline(vx, 201, APRON - 201, SHADE)
    d.hline(0, APRON, 240, GREY)
    d.blit(SITE, (240 - SITE.width) // 2, APRON + 8, KEY)
    d.fill_rect(0, 0, 240, 7, RED)                          # the curtains
    d.fill_rect(0, 0, 22, FLOOR_Y, RED)
    d.fill_rect(218, 0, 22, FLOOR_Y, RED)
    for vx in (7, 15, 225, 233):
        d.vline(vx, 7, FLOOR_Y - 7, SHADE)


def draw(now, wedgie, dx):
    d = lcd
    stage()
    if flip_t is None:
        d.blit(S, SX, SY, -1)
        if SLIDES[si][0] is s_wedgie and LOGO and hasattr(L, "art"):
            lx, ly, lw, lh = SX + LOGO[0], SY + LOGO[1], LOGO[2], LOGO[3]
            top = FEET - GH - h
            if x + GW + 30 <= lx or x >= lx + lw or top - 16 >= ly + lh:     # he (and what he says) isn't in front
                L.art(lx, ly, lw, lh, "logo.bin", 10)
    else:                               # turning over: a white card narrowing to an edge and back
        half = FLIP // 2
        p = min(FLIP, time.ticks_diff(now, flip_t))
        w = max(2, SW * abs(half - p) // half)
        d.fill_rect(SX - 2, SY - 2, SW + 4, SH + 4, DARK)
        d.fill_rect(SX + (SW - w) // 2, SY, w, SH, WHITE)
        d.vline(SX + (SW - w) // 2, SY, SH, GREY)
        d.vline(SX + (SW + w) // 2 - 1, SY, SH, GREY)
    top = FEET - GH - h
    if h:
        r = max(6, 16 - h // 6)
        d.ellipse(x + GW // 2, FEET - 1, r, 3, SHADE, True)
    if wedgie:
        g = G_WEDGIE
    elif h:
        g = G_JUMP
    elif time.ticks_diff(wave_end, now) > 0:
        g = G_WAVE1 if (now // 160) & 1 else G_WAVE2
    elif dx:
        g = (G_STEP, G_STAND, G_TOGETHER, G_STAND)[(walk // 2) & 3]
    else:
        g = G_STAND
    d.blit(g, x, top, KEY)
    ey = top + 9
    if wedgie:                          # eyes squeezed shut
        d.fill_rect(x + 8, ey + 1, 6, 2, BLACK)
        d.fill_rect(x + 22, ey + 1, 6, 2, BLACK)
    elif (now // 100) % 34 == 0:        # a blink now and then
        d.fill_rect(x + 9, ey + 2, 4, 1, BLACK)
        d.fill_rect(x + 23, ey + 2, 4, 1, BLACK)
    else:
        e = 3 * face
        d.fill_rect(x + 10 + e, ey, 3, 4, BLACK)
        d.fill_rect(x + 23 + e, ey, 3, 4, BLACK)
    if time.ticks_diff(say_end, now) > 0:
        bw = 8 * len(said) + 8
        bx = max(2, min(238 - bw, x + GW - 6))
        by = top - 16
        d.fill_rect(bx, by, bw, 13, WHITE)
        d.rect(bx, by, bw, 13, INK)
        d.text(said, bx + 4, by + 3, INK)


def run():
    global si, slide_end, flip_t, flipped, last_in, next_idea, roll_t, CHECK, done_t
    read_info()
    render(si)
    draw(time.ticks_ms(), False, 0)     # the stage up first: reading the logo takes a moment
    lcd.show()
    read_logo()
    now = time.ticks_ms()
    slide_end = time.ticks_add(now, SLIDES[si][1])
    last_in = next_idea = now
    keys.pressed()
    drawn = None                        # what the checks slide last showed: (results, buttons, done)
    while True:
        t = time.ticks_ms()
        pressed = keys.pressed()
        on = SLIDES[si][0] is s_ready and flip_t is None
        if CHECK is not None:
            try:
                next(CHECK)
            except StopIteration:
                CHECK, done_t = None, t
        if on:
            now_drawn = (len(RES), len(seen), CHECK is None)
            if now_drawn != drawn:      # redraw only what changed: big() is a few ms a row
                drawn = now_drawn
                for i in range(len(ROWS)):
                    row(i)
                buttons_row()
            if CHECK is not None and not RES.get("Trust M", True):
                slide_end = t           # no Trust M: no checks to show
            elif CHECK is not None or (len(seen) < len(BUTTONS) and done_t is not None and time.ticks_diff(t, done_t) < 12000):
                slide_end = time.ticks_add(t, 400)  # wait for the checks, then up to 12 s for every button
        if flip_t is None and time.ticks_diff(t, slide_end) >= 0:
            drawn = None
            flip_t, flipped, roll_t = t, False, None     # a roll cut short by presses stops with its slide
        if flip_t is not None:
            p = time.ticks_diff(t, flip_t)
            if p >= FLIP // 2 and not flipped:
                si = (si + 1) % len(SLIDES)
                render(si)
                flipped = True
            if p >= FLIP:
                flip_t = None
                slide_end = time.ticks_add(t, SLIDES[si][1])
                if SLIDES[si][0] is s_chip:
                    roll_t = t
        if roll_t is not None and flip_t is None and digits(time.ticks_diff(t, roll_t)):
            roll_t = None
        wedgie, dx = update(t, pressed)
        draw(t, wedgie, dx)
        lcd.show()
        left = FRAME - time.ticks_diff(time.ticks_ms(), t)
        time.sleep_ms(left if left > 2 else 2)
