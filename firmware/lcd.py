# Waveshare Pico-LCD-1.3: 240x240 ST7789 over SPI1, plus joystick and A/B/X/Y keys.
# Pins from waveshare.com/wiki/Pico-LCD-1.3.
from machine import Pin, SPI, PWM
import framebuf, time, sys, machine, micropython
import splash as _s     # pins and panel setup; boot.py already used it to put the logo up
from splash import DC, CS, SCK, MOSI, RST, BL
KEYS = {"A": 15, "B": 17, "X": 19, "Y": 21, "up": 2, "down": 18, "left": 16, "right": 20, "press": 3}

# The screen has 16 colors (Austin, 2026-10-03: the 115 KB full-color framebuffer left ~75 KB for
# everything else on an RP2040, and every "memory allocation failed" came out of that). The framebuffer
# keeps a 4-bit palette index per pixel (29 KB); show() turns rows into the panel's RGB565 on the way
# out. The palette: firmware/ui.py's seven colors exactly, a grey ramp for the logo's shading, black,
# yellow, blue. color() gives the nearest of the 16, so apps keep calling it as before.
PALETTE = ((0, 0, 0), (26, 27, 26), (60, 60, 60), (90, 91, 90), (120, 123, 120), (148, 149, 150),
           (169, 170, 171), (195, 196, 197), (216, 217, 218), (236, 237, 238), (254, 254, 254),
           (34, 196, 82), (22, 140, 52), (227, 49, 44), (255, 220, 0), (40, 100, 230))


def _565(r, g, b):
    """RGB888 -> RGB565, byte-swapped: stored little-endian, it's the big-endian bytes the panel wants."""
    c = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
    return ((c & 0xFF) << 8) | (c >> 8)


_LUT = bytearray(32)                    # palette index -> the panel's two bytes
for _i in range(16):
    _v = _565(*PALETTE[_i])
    _LUT[2 * _i], _LUT[2 * _i + 1] = _v & 255, _v >> 8
_PR = bytes([p[0] for p in PALETTE])
_PG = bytes([p[1] for p in PALETTE])
_PB = bytes([p[2] for p in PALETTE])

# The one framebuffer, 4 bits a pixel (29 KB; it was 115 KB in full color), allocated the moment lcd is
# imported, while the heap is in one piece. Anything that runs a big module (main.py, the emulator's
# send) imports lcd first, and LCD() reuses this. _ROWS: 4 rows as RGB565, what show() sends at a time.
_BUF = bytearray(240 * 240 // 2)
_ROWS = bytearray(240 * 4 * 2)
_on_show = None     # loader.py: called at the app's first show(), i.e. its first screen
_art = None         # (x, y, w, h, file, offset): a full-color picture on flash shown over that box (art())
_artrow = None      # one of its rows, read from the file


def art(x, y, w, h, path, offset):
    """Show the picture stored in path (RGB565 rows, the panel's bytes, from offset) at x, y in full
    color, over whatever the framebuffer has there: show() reads it from flash as it sends the rows,
    so it costs one row of RAM, not 16 colors' worth of banding (the boot logo: loader.logo). Gone at
    the next fill() (a new screen)."""
    global _art, _artrow
    _art = (x, y, w, h, path, offset)
    _artrow = bytearray(w * 2)


@micropython.viper
def _copy16(src, i0: int, dst, q0: int, n: int):
    s = ptr16(src)
    d = ptr16(dst)
    j = 0
    while j < n:
        d[q0 + j] = s[i0 + j]
        j += 1


def rows565(x0, y, n, m, f=None):
    """m rows of n pixels from x0, y as RGB565 into _ROWS (the art over them, from f when it's open)."""
    i = 0
    while i < m:
        _to565(_BUF, (y + i) * 240 + x0, _ROWS, i * n, n)
        i += 1
    a = _art
    if f is None or a is None:
        return
    ax, ay, aw, ah = a[0], a[1], a[2], a[3]
    c0, c1 = max(x0, ax), min(x0 + n, ax + aw)
    if c0 >= c1:
        return
    i = max(0, ay - y)
    while i < m and y + i < ay + ah:
        f.seek(a[5] + (y + i - ay) * aw * 2)
        f.readinto(_artrow)
        _copy16(_artrow, c0 - ax, _ROWS, i * n + c0 - x0, c1 - c0)
        i += 1


def art_file(y0, y1):
    """The art's file, open, if any of rows y0..y1-1 has it (close it after); else None."""
    a = _art
    if a is None or y1 <= a[1] or y0 >= a[1] + a[3]:
        return None
    try:
        return open(a[4], "rb")
    except OSError:
        return None


@micropython.viper
def _near(r: int, g: int, b: int) -> int:
    pr = ptr8(_PR)
    pg = ptr8(_PG)
    pb = ptr8(_PB)
    best = 0x7FFFFFF
    bi = 0
    i = 0
    while i < 16:
        dr = r - pr[i]
        dg = g - pg[i]
        db = b - pb[i]
        d = dr * dr * 3 + dg * dg * 4 + db * db * 2
        if d < best:
            best = d
            bi = i
        i += 1
    return bi


def color(r, g, b):
    """The palette index nearest to this RGB (0-255 each). Pass it to fill, text, rect, pixel..."""
    return _near(r, g, b)


def index565(v):
    """The palette index nearest to a pixel as the panel takes it (the logo's and the bar's files: 2
    bytes, big-endian, read little-endian: v = b[0] | b[1] << 8)."""
    c = (v & 255) << 8 | v >> 8
    return _near((c >> 8) & 0xF8, (c >> 3) & 0xFC, (c << 3) & 0xF8)


@micropython.viper
def _to565(src, p0: int, dst, q0: int, n: int):
    """n pixels of the 4-bit framebuffer from pixel p0 -> dst's 16-bit slots from q0, as the panel's
    RGB565 bytes. Allocates nothing."""
    s = ptr8(src)
    d = ptr16(dst)
    l = ptr16(_LUT)
    j = 0
    while j < n:
        p = p0 + j
        b = s[p >> 1]
        if p & 1:
            d[q0 + j] = l[b & 15]
        else:
            d[q0 + j] = l[b >> 4]
        j += 1


@micropython.viper
def put565(row, n: int, p0: int):
    """n panel pixels (RGB565 bytes, as in logo.bin) into the framebuffer from pixel p0, each the nearest
    palette color. For pictures made in full color. Allocates nothing."""
    s = ptr8(row)
    f = ptr8(_BUF)
    pr = ptr8(_PR)
    pg = ptr8(_PG)
    pb = ptr8(_PB)
    j = 0
    while j < n:
        c = (s[2 * j] << 8) | s[2 * j + 1]
        r = (c >> 8) & 0xF8
        g = (c >> 3) & 0xFC
        b = (c << 3) & 0xF8
        best = 0x7FFFFFF
        bi = 0
        i = 0
        while i < 16:
            dr = r - pr[i]
            dg = g - pg[i]
            db = b - pb[i]
            d = dr * dr * 3 + dg * dg * 4 + db * db * 2
            if d < best:
                best = d
                bi = i
            i += 1
        p = p0 + j
        o = p >> 1
        if p & 1:
            f[o] = (f[o] & 0xF0) | bi
        else:
            f[o] = (f[o] & 0x0F) | (bi << 4)
        j += 1


BLACK, WHITE = color(0, 0, 0), color(255, 255, 255)
RED, GREEN, BLUE = color(255, 0, 0), color(0, 255, 0), color(0, 0, 255)
YELLOW, GREY, DARK = color(255, 220, 0), color(120, 120, 120), color(30, 30, 30)


# The clock. Out of the box MicroPython runs the SPI bus off a 48 MHz clock, so the screen can't get
# more than 24 MHz: ~46 ms a frame. With the peripherals on the CPU clock at 125 MHz the bus runs at
# 62.5 MHz, the panel's top speed: ~18 ms (measured on an RP2040; 150 MHz is worse, its divider lands
# on 37.5). An RP2350 gives up 150 -> 125 MHz of CPU for it. USB and I2C don't mind.
try:
    machine.freq(125_000_000, 125_000_000)
except Exception:
    pass


class LCD(framebuf.FrameBuffer):
    def __init__(self):
        self.width = self.height = 240
        self.cs = Pin(CS, Pin.OUT, value=1)
        self.rst = Pin(RST, Pin.OUT, value=1)
        self.dc = Pin(DC, Pin.OUT, value=1)
        self.spi = SPI(1, _s.SPI_HZ, polarity=0, phase=0, sck=Pin(SCK), mosi=Pin(MOSI), miso=None)
        self.bl = PWM(Pin(BL))
        self.bl.freq(1000)
        self.buffer = _BUF
        super().__init__(self.buffer, self.width, self.height, framebuf.GS4_HMSB)
        if not _s.up:       # after the boot logo the panel is already up; resetting it would blank it
            self.backlight(0)
            t = _s.setup(self.spi, self.dc, self.cs, self.rst)
            self.fill(BLACK)
            self.show()                  # into panel RAM while it still sleeps: part of the wait
            _s.wake(self.spi, self.dc, self.cs, t)
            _s.up = True
        self.backlight(100)

    def backlight(self, pct):
        self.bl.duty_u16(int(65535 * max(0, min(100, pct)) / 100))

    def _cmd(self, cmd, data=None):
        self.dc(0); self.cs(0); self.spi.write(bytes([cmd])); self.cs(1)
        if data:
            self.dc(1); self.cs(0); self.spi.write(bytes(data)); self.cs(1)

    def show(self, y0=0, y1=240):
        """Push the frame to the panel. show(y0, y1) pushes only rows y0..y1-1: a game that only
        changes part of the screen pushes only that part."""
        self.show_rect(0, y0, 240, y1 - y0)

    def show_rect(self, x, y, w, h):
        """Push only this box (a sprite's old and new place, a score). Costs about its share of a frame."""
        x0, y0, x1, y1 = max(0, x), max(0, y), min(240, x + w), min(240, y + h)
        if x0 >= x1 or y0 >= y1:
            return
        if _on_show:
            _on_show()
        self._cmd(0x2A, [0x00, x0, 0x00, x1 - 1])
        self._cmd(0x2B, [0x00, y0, 0x00, y1 - 1])
        self._cmd(0x2C)
        n = x1 - x0
        k = 960 // n                    # rows a piece: what fits in _ROWS
        f = art_file(y0, y1)
        self.dc(1); self.cs(0)
        r = y0
        while r < y1:
            m = min(k, y1 - r)
            rows565(x0, r, n, m, f)
            self.spi.write(_ROWS if m * n == 960 else memoryview(_ROWS)[:m * n * 2])
            r += m
        self.cs(1)
        if f:
            f.close()

    def fill(self, c):
        """The whole screen one color: a new screen, so any art() on the old one goes."""
        global _art, _artrow
        _art = _artrow = None
        super().fill(c)

    def show_start(self):
        """The same as show() (kept for apps written for the full-color screen, which sent it by DMA)."""
        self.show()

    def show_wait(self):
        """Nothing to wait for: show_start() already sent the frame."""
        pass

    def big_text(self, s, x, y, c, scale=2):
        """framebuf's 8x8 font scaled up. Slow-ish, fine for a few words."""
        w = 8 * len(s)
        tmp = framebuf.FrameBuffer(bytearray(w * 8 // 8), w, 8, framebuf.MONO_HLSB)
        tmp.text(s, 0, 0, 1)
        for yy in range(8):
            for xx in range(w):
                if tmp.pixel(xx, yy):
                    self.fill_rect(x + xx * scale, y + yy * scale, scale, scale, c)

    def center_text(self, s, y, c, scale=1):
        x = (self.width - 8 * len(s) * scale) // 2
        if scale == 1:
            self.text(s, x, y, c)
        else:
            self.big_text(s, x, y, c, scale)


# Virtual presses (wedgie): press("A") from the USB console or wedgie.dev reaches every Keys() the
# way a finger would, so an agent can drive an app. Apps that read Pins directly do not see them.
_keys = []          # every Keys() made so far; each gets its own copy of a press
_hold = {}          # key -> ticks_ms until which held() reports it down


def press(k, ms=80):
    if k not in KEYS:
        raise ValueError("key must be one of " + " ".join(KEYS))
    for ks in _keys:
        ks.queue.append(k)
    _hold[k] = time.ticks_add(time.ticks_ms(), ms)


class Keys:
    def __init__(self, physical=False):
        """physical=True: only real presses, never press() from USB. Anything that decides for the
        person (sign, let a computer in) reads its keys this way, or the computer could press yes."""
        self.pins = {k: Pin(p, Pin.IN, Pin.PULL_UP) for k, p in KEYS.items()}
        self.last = {k: 1 for k in KEYS}
        self.queue = []
        self.physical = physical
        if not physical:
            _keys.append(self)

    def pressed(self):
        """Names of keys that went down since the last call."""
        out = []
        for k, p in self.pins.items():
            v = p.value()
            if v == 0 and self.last[k] == 1:
                out.append(k)
            self.last[k] = v
        if self.queue:
            out += self.queue
            self.queue = []
        return out

    def held(self, k):
        if self.pins[k].value() == 0:
            return True
        if self.physical:
            return False
        t = _hold.get(k)
        return t is not None and time.ticks_diff(t, time.ticks_ms()) > 0
