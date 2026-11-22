# wedgie battery firmware (wedgie.dev/batt). NOT the wedgie firmware: no apps, no signing, no lock.
# One file (public/device/batt.py on the site, main.py on the board), on plain MicroPython. It never sleeps, burns as much power as it can, and shows and
# logs everything it can read about the battery. Go back to a real wedgie at wedgie.dev/reset.
#
# The load: backlight full, the whole screen pushed over SPI non-stop (core 0 never idles), core 1 in a
# tight loop, an RP2040 clocked up to 250 MHz, the Pico's LED on. Green (A) turns the load off and on.
# What it reads: VSYS through GP29 (a 3:1 divider, as firmware/power.py does), USB power on GP24, the
# chip's temperature. Once a minute on battery the load drops for 0.3 s to read the battery at rest:
# rest minus loaded is the sag.
# The log: batt.csv on its flash, a line every 30 s and at every plug or unplug. It outlives a dead
# battery; wedgie.dev/batt reads it back and draws it.
#   #boot,<n>,<version>,<board>
#   <seconds since boot>,<usb 0/1>,<mV loaded>,<mV at rest, 0 = not read>,<temp C>,<load 0/1>
# Ctrl-C is left on: any computer may stop it and read the file.
# Hold red (B) while it starts: no 250 MHz, no core 1 (if either one ever makes a board misbehave).
import sys, os, gc, time, machine, framebuf, micropython
from machine import Pin, SPI, ADC, PWM

VERSION = "batt-2"
DC, CS, SCK, MOSI, RST, BL = 8, 9, 10, 11, 12, 13
KEY_A, KEY_B = 15, 17
LOG, OLD = "batt.csv", "batt.old.csv"
LOG_MAX = 300000        # bytes; then batt.csv becomes batt.old.csv
LOG_S = 30
REST_S = 60
# mV at VSYS -> percent: the wedgie firmware's own table (firmware/power.py, 0.3.89), so this shows what
# a wedgie would.
CURVE = ((3700, 100), (3600, 90), (3520, 80), (3450, 70), (3390, 60), (3340, 50), (3300, 40),
         (3260, 30), (3220, 20), (3150, 10), (3000, 0))

if "BUF" not in globals():              # run again by a computer (Ctrl-C, then main.py): keep the one it has
    BUF = bytearray(240 * 240 * 2)      # first, while the heap is whole: full color, 115 KB
fb = framebuf.FrameBuffer(BUF, 240, 240, framebuf.RGB565)
RP2040 = "RP2040" in sys.implementation._machine
SAFE = Pin(KEY_B, Pin.IN, Pin.PULL_UP).value() == 0
try:
    if RP2040 and not SAFE:
        machine.freq(250000000)         # twice the clock, about twice the chip's current
except Exception:
    pass


def rgb(r, g, b):
    c = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
    return ((c & 0xFF) << 8) | (c >> 8)     # the panel's byte order


WHITE, INK, GREEN, RED, BLUE, GREY = rgb(255, 255, 255), rgb(26, 27, 26), rgb(22, 140, 52), rgb(227, 49, 44), rgb(40, 100, 230), rgb(120, 123, 120)

# The panel: firmware/splash.py's setup, word for word.
_SETUP = ((0x36, b"\x70"), (0x3A, b"\x05"), (0xB2, b"\x0c\x0c\x00\x33\x33"), (0xB7, b"\x35"), (0xBB, b"\x19"),
          (0xC0, b"\x2c"), (0xC2, b"\x01"), (0xC3, b"\x12"), (0xC4, b"\x20"), (0xC6, b"\x0f"), (0xD0, b"\xa4\xa1"),
          (0xE0, b"\xd0\x04\x0d\x11\x13\x2b\x3f\x54\x4c\x18\x0d\x0b\x1f\x23"),
          (0xE1, b"\xd0\x04\x0c\x11\x13\x2c\x3f\x44\x51\x2f\x1f\x1f\x20\x23"), (0x21, b""))
bl = PWM(Pin(BL))
bl.freq(1000)
bl.duty_u16(0)
cs, dc, rst = Pin(CS, Pin.OUT, value=1), Pin(DC, Pin.OUT, value=1), Pin(RST, Pin.OUT, value=1)
spi = SPI(1, 62500000, polarity=0, phase=0, sck=Pin(SCK), mosi=Pin(MOSI), miso=None)


def cmd(c, data=b""):
    dc(0); cs(0); spi.write(bytes([c])); cs(1)
    if data:
        dc(1); cs(0); spi.write(data); cs(1)


def push():
    cmd(0x2A, b"\x00\x00\x00\xef")
    cmd(0x2B, b"\x00\x00\x00\xef")
    cmd(0x2C)
    dc(1); cs(0); spi.write(BUF); cs(1)


rst(0); time.sleep_us(20); rst(1)
time.sleep_ms(5)
for _c, _d in _SETUP:
    cmd(_c, _d)
fb.fill(WHITE)
push()
time.sleep_ms(120)
cmd(0x11)
time.sleep_ms(5)
cmd(0x29)
bl.duty_u16(65535)

_one = bytearray(8)
_glyph = framebuf.FrameBuffer(_one, 8, 8, framebuf.MONO_HLSB)


def big(s, x, y, c, k):
    """Text k times the 8 x 8 font."""
    for ch in s:
        if ch != " ":
            _glyph.fill(0)
            _glyph.text(ch, 0, 0, 1)
            for r in range(8):
                row = _one[r]
                if row:
                    for q in range(8):
                        if row & (0x80 >> q):
                            fb.fill_rect(x + q * k, y + r * k, k, k, c)
        x += 8 * k


# ---- power -----------------------------------------------------------------------------------------------
try:
    vbus = Pin("WL_GPIO2", Pin.IN)      # a Pico W
except (ValueError, TypeError):
    vbus = Pin(24, Pin.IN)
adc = ADC(29)
tadc = ADC(4)
key = Pin(KEY_A, Pin.IN, Pin.PULL_UP)
led = None
if " W" not in sys.implementation._machine:
    led = Pin(25, Pin.OUT, value=1)


def read_mv():
    s = 0
    for _ in range(32):
        s += adc.read_u16()
    return s * 9900 // (65535 * 32)


def read_temp():
    s = 0
    for _ in range(8):
        s += tadc.read_u16()
    v = s * 3.3 / (65535 * 8)
    return int(27 - (v - 0.706) / 0.001721)


def percent(mv):
    hi = CURVE[0]
    if mv >= hi[0]:
        return 100
    for lo in CURVE[1:]:
        if mv >= lo[0]:
            return lo[1] + (mv - lo[0]) * (hi[1] - lo[1]) // (hi[0] - lo[0])
        hi = lo
    return 0


# ---- core 1: a tight loop, while the load is on -------------------------------------------------------------
if "_on" not in globals():              # run again by a computer (Ctrl-C, then main.py): the old thread still runs
    _on = bytearray(1)
    _th = False
_on[0] = 1


@micropython.viper
def _burn(n: int) -> int:
    x = 1
    i = 0
    while i < n:
        x = (x * 75 + 74) & 0xFFFF
        i += 1
    return x


def _core1():
    while True:
        if _on[0]:
            _burn(100000)
        else:
            time.sleep_ms(20)


if not _th and not SAFE:
    try:
        import _thread
        _thread.start_new_thread(_core1, ())
        _th = True
    except Exception as e:
        print("core 1:", e)


# ---- the log -----------------------------------------------------------------------------------------------
def scan():
    """(boots so far, the last time it ran on battery: [seconds, mV at its start, mV at its end] or None)."""
    boots, last, seg = 0, None, None
    try:
        with open(LOG) as f:
            for ln in f:
                if ln.startswith("#"):
                    boots += 1
                    if seg:
                        last, seg = seg, None
                    continue
                p = ln.split(",")
                try:
                    t, u, mv = int(p[0]), int(p[1]), int(p[2])
                except (ValueError, IndexError):
                    continue
                if u:
                    if seg:
                        last, seg = seg, None
                elif seg:
                    seg[1], seg[3] = t, mv
                else:
                    seg = [t, t, mv, mv]
    except OSError:
        pass
    if seg:
        last = seg
    return boots, ([last[1] - last[0], last[2], last[3]] if last else None)


def log(line):
    try:
        try:
            if os.stat(LOG)[6] > LOG_MAX:
                try:
                    os.remove(OLD)
                except OSError:
                    pass
                os.rename(LOG, OLD)
        except OSError:
            pass
        with open(LOG, "a") as f:
            f.write(line)
            f.write("\n")
    except Exception as e:
        print("log:", e)


def hms(s):
    return "%d:%02d:%02d" % (s // 3600, s // 60 % 60, s % 60)


def hm(s):
    return "%dh%02dm" % (s // 3600, s // 60 % 60) if s >= 3600 else "%dm%02ds" % (s // 60, s % 60)


boots, last = scan()
log("#boot,%d,%s,%s" % (boots + 1, VERSION, sys.implementation._machine.replace(",", " ")))
t0 = time.time()
load = True
usb = None              # None: not read yet
since = 0               # when this stretch (on battery, or on USB) began
mv = rest = sag = lo = first = rlog = 0
temp = 0
hist = []               # (seconds, mV) every LOG_S on battery, the last 10: the drop per minute
next_log = next_rest = 0
tick = -1
was_key = 1
frames = fps = 0


def set_load(on):
    global load
    load = on
    _on[0] = 1 if on else 0
    bl.duty_u16(65535 if on else 16000)
    if led:
        led.value(1 if on else 0)


def measure_rest():
    """The battery with the load off for 0.3 s: screen dark, core 1 idle."""
    _on[0] = 0
    bl.duty_u16(0)
    if led:
        led.value(0)
    time.sleep_ms(300)
    v = read_mv()
    set_load(load)
    return v


def draw(now):
    fb.fill(WHITE)
    fb.fill_rect(0, 0, 240, 28, BLUE if usb else GREEN)
    big("USB" if usb else "BATT", 6, 6, WHITE, 2)
    s = hms(now - since)
    big(s, 234 - 16 * len(s), 6, WHITE, 2)
    rows = []
    if usb:
        big("USB", 48, 40, BLUE, 6)
        big("%d mV" % mv, (240 - 24 * len("%d mV" % mv)) // 2, 100, INK, 3)
        rows.append(("can't read it", GREY))
        rows.append(("while on USB", GREY))
        if last:
            rows.append(("last run " + hm(last[0]), INK))
            rows.append(("%d > %d mV" % (last[1], last[2]), INK))
        else:
            rows.append(("unplug to test", INK))
    else:
        p = "%d%%" % percent(mv)
        big(p, (240 - 56 * len(p)) // 2, 36, RED if percent(mv) <= 15 else INK, 7)
        m = "%d mV" % mv
        big(m, (240 - 24 * len(m)) // 2, 100, INK, 3)
        rows.append(("sag  %d mV" % sag if rest else "sag  ...", INK))
        if len(hist) > 1 and hist[-1][0] > hist[0][0]:
            d = (hist[0][1] - hist[-1][1]) * 600 // (hist[-1][0] - hist[0][0])
            rows.append(("drop %d.%d/min" % (d // 10, d % 10) if d >= 0 else "drop 0.0/min", INK))
        else:
            rows.append(("drop ...", INK))
        rows.append(("from %d mV" % first, INK))
        rows.append(("low  %d mV" % lo, INK))
    rows.append(("%dC %s" % (temp, "LOAD ON" if load else "LOAD OFF"), GREEN if load else RED))
    y = 130
    for s, c in rows[:5]:
        big(s[:15], 4, y, c, 2)
        y += 20
    fb.text("%d fps %d MHz %s%s" % (fps, machine.freq() // 1000000, VERSION, " safe" if SAFE else ""), 4, 231, GREY)


set_load(True)
while True:
    now = time.time() - t0
    k = key.value()
    if k == 0 and was_key:
        set_load(not load)
        tick = -1
    was_key = k
    if now != tick:
        tick = now
        fps, frames = frames, 0
        v = read_mv()
        u = vbus.value() == 1 or not (2500 < v < 4500)
        temp = read_temp()
        changed = u != usb
        if changed:
            if usb is False:            # a stretch on battery just ended: it's the last run now
                last = [now - since, first, mv]
            usb, since, mv = u, now, v
            first = lo = v
            rest = sag = rlog = 0
            hist = []
            next_rest = now + 5
            next_log = now
        mv = v if changed else (mv * 3 + v) // 4
        if not usb:
            lo = min(lo, mv)
        if not usb and load and now >= next_rest:
            next_rest = now + REST_S
            rlog = rest = measure_rest()    # rlog: it goes in the next log line
            sag = max(0, rest - mv)
        if now >= next_log:
            next_log = now + LOG_S
            if not usb:
                hist.append((now, mv))
                if len(hist) > 10:
                    hist.pop(0)
            log("%d,%d,%d,%d,%d,%d" % (now, 1 if usb else 0, mv, 0 if usb else rlog, temp, 1 if load else 0))
            rlog = 0
            gc.collect()
        draw(now)
    if load:
        push()
        frames += 1
    else:
        push()
        time.sleep_ms(200)
