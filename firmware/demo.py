# Graphics speed test for the Pico + LCD hat. Four scenes, each prints its fps.
# demo.run()          cycle scenes with A, quit with X
# demo.bench(4)       run each scene 4 s, print fps, exit
import time, math
import micropython
from lcd import LCD, KEYS, color, BLACK, WHITE, RED, GREEN, BLUE, YELLOW
from machine import Pin

lcd = LCD()
W = H = 240
btn = {k: Pin(p, Pin.IN, Pin.PULL_UP) for k, p in KEYS.items()}
COLORS = [RED, GREEN, BLUE, YELLOW, color(255, 0, 255), color(0, 255, 255), color(255, 128, 0)]


def _label(name, fps):
    lcd.fill_rect(0, 0, 240, 12, BLACK)
    lcd.text("%s  %d fps" % (name, fps), 4, 2, WHITE)


def _scene(name, step, seconds):
    """Run step(t) until X pressed, or A pressed (next), or seconds elapsed. Returns fps."""
    t0 = time.ticks_ms(); frames = 0; fps = 0; last = t0
    while True:
        step(frames)
        frames += 1
        now = time.ticks_ms()
        if time.ticks_diff(now, last) >= 500:
            fps = frames * 1000 // time.ticks_diff(now, t0)
            last = now
        _label(name, fps)
        lcd.show()
        if seconds and time.ticks_diff(now, t0) > seconds * 1000:
            return "time", fps
        if btn["X"].value() == 0:
            return "quit", fps
        if btn["A"].value() == 0:
            while btn["A"].value() == 0:
                pass
            return "next", fps


# 1. bouncing balls: framebuf fill + ellipse, all C-speed
_balls = [[20 + i * 17, 30 + i * 13, 3 + i % 4, 2 + i % 3, 6 + i % 6, COLORS[i % 7]] for i in range(12)]

def balls(_):
    lcd.fill(BLACK)
    for b in _balls:
        b[0] += b[2]; b[1] += b[3]
        if b[0] < b[4] or b[0] > W - b[4]: b[2] = -b[2]
        if b[1] < 14 + b[4] or b[1] > H - b[4]: b[3] = -b[3]
        lcd.ellipse(b[0], b[1], b[4], b[4], b[5], True)


# 2. wireframe cube: 8 points rotated in Python, 12 lines in C
_V = [(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
_E = [(a, b) for a in range(8) for b in range(a + 1, 8) if sum(_V[a][i] != _V[b][i] for i in range(3)) == 1]

def cube(f):
    lcd.fill(BLACK)
    a = f * 0.03; b = f * 0.02
    ca, sa, cb, sb = math.cos(a), math.sin(a), math.cos(b), math.sin(b)
    p = []
    for x, y, z in _V:
        x, z = x * ca - z * sa, x * sa + z * ca
        y, z = y * cb - z * sb, y * sb + z * cb
        s = 220 / (z + 3.5)
        p.append((int(120 + x * s), int(127 + y * s)))
    for i, (u, v) in enumerate(_E):
        lcd.line(p[u][0], p[u][1], p[v][0], p[v][1], COLORS[i % 7])


# 3. plasma: every pixel computed on the chip, viper-compiled, using a sine table
_SIN = bytearray(int(127 + 127 * math.sin(i * 2 * math.pi / 256)) for i in range(256))
_PAL = bytearray(512)
for i in range(256):
    r = int(127 + 127 * math.sin(i * 2 * math.pi / 256))
    g = int(127 + 127 * math.sin((i + 85) * 2 * math.pi / 256))
    bb = int(127 + 127 * math.sin((i + 170) * 2 * math.pi / 256))
    c = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (bb >> 3)
    _PAL[2 * i] = c >> 8; _PAL[2 * i + 1] = c & 0xFF

@micropython.viper
def _plasma(buf: ptr8, sin: ptr8, pal: ptr8, t: int):
    i = 0
    for y in range(240):
        for x in range(240):
            v = int(sin[(x + t) & 255]) + int(sin[(y * 2 - t) & 255]) + int(sin[((x + y) >> 1) + (t >> 1) & 255])
            v = (v // 3) & 255
            buf[i] = pal[2 * v]; buf[i + 1] = pal[2 * v + 1]
            i += 2

def plasma(f):
    _plasma(lcd.buffer, _SIN, _PAL, f * 3)


# 4. raw: nothing drawn, just push the framebuffer. This is the SPI ceiling.
def raw(f):
    lcd.fill_rect(0, 14, 240, 226, COLORS[(f // 30) % 7])


SCENES = [("balls", balls), ("cube", cube), ("plasma", plasma), ("raw spi", raw)]


def bench(seconds=4):
    out = {}
    for name, fn in SCENES:
        why, fps = _scene(name, fn, seconds)
        out[name] = fps
        print("%-8s %3d fps" % (name, fps))
        if why == "quit":
            break
    return out


def run():
    i = 0
    while True:
        name, fn = SCENES[i % len(SCENES)]
        why, fps = _scene(name, fn, 0)
        print("%-8s %3d fps" % (name, fps))
        if why == "quit":
            return
        i += 1
