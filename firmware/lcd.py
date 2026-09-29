# Waveshare Pico-LCD-1.3: 240x240 ST7789 over SPI1, plus joystick and A/B/X/Y keys.
# Pins from waveshare.com/wiki/Pico-LCD-1.3.
from machine import Pin, SPI, PWM
import framebuf, time, sys, machine
import splash as _s     # pins and panel setup; boot.py already used it to put the logo up
from splash import DC, CS, SCK, MOSI, RST, BL
KEYS = {"A": 15, "B": 17, "X": 19, "Y": 21, "up": 2, "down": 18, "left": 16, "right": 20, "press": 3}


def color(r, g, b):
    """RGB888 -> RGB565, byte-swapped because framebuf is little-endian and the panel wants big-endian."""
    c = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
    return ((c & 0xFF) << 8) | (c >> 8)


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
RP2350 = "RP2350" in sys.implementation._machine
_SPI1 = 0x40088000 if RP2350 else 0x40040000        # SPI1's registers, for show_start's DMA
_dma = None         # the DMA channel show_start uses (one, shared); False: this board has none (the emulator)
_dma_ctl = 0
_pushing = None     # the LCD whose DMA push is still going

# The one 115 KB framebuffer, allocated the moment lcd is imported. On an RP2040 board (264 KB
# RAM) a block that big is only available on a fresh heap: after a 20 KB module like wallet.py
# has been compiled the heap is too fragmented and LCD() dies with MemoryError. So anything that
# runs a big module (main.py, the emulator's send) imports lcd first, and LCD() reuses this.
_BUF = bytearray(240 * 240 * 2)
_on_show = None     # loader.py: called at the app's first show(), i.e. its first screen


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
        super().__init__(self.buffer, self.width, self.height, framebuf.RGB565)
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
        """Push the frame to the panel (~38 ms for all of it). show(y0, y1) pushes only rows y0..y1-1:
        full-width rows are one piece of the buffer, so nothing is copied and a 24-row band costs a
        tenth of a frame. A game that only changes part of the screen pushes only that part."""
        if _on_show:
            _on_show()
        if _pushing:
            _pushing.show_wait()
        y0, y1 = max(0, y0), min(240, y1)
        if y0 >= y1:
            return
        self._cmd(0x2A, [0x00, 0x00, 0x00, 0xEF])
        self._cmd(0x2B, [0x00, y0, 0x00, y1 - 1])
        self._cmd(0x2C)
        self.dc(1); self.cs(0)
        self.spi.write(self.buffer if y0 == 0 and y1 == 240 else memoryview(self.buffer)[y0 * 480:y1 * 480])
        self.cs(1)

    def show_rect(self, x, y, w, h):
        """Push only this box (a sprite's old and new place, a score): the panel's window is set to it
        and its rows go one after another. Costs its own bytes plus ~20 us a row."""
        x0, y0, x1, y1 = max(0, x), max(0, y), min(240, x + w), min(240, y + h)
        if x0 >= x1 or y0 >= y1:
            return
        if x0 == 0 and x1 == 240:
            return self.show(y0, y1)
        if _on_show:
            _on_show()
        if _pushing:
            _pushing.show_wait()
        self._cmd(0x2A, [0x00, x0, 0x00, x1 - 1])
        self._cmd(0x2B, [0x00, y0, 0x00, y1 - 1])
        self._cmd(0x2C)
        mv, n, o = memoryview(self.buffer), (x1 - x0) * 2, (y0 * 240 + x0) * 2
        self.dc(1); self.cs(0)
        for _ in range(y1 - y0):
            self.spi.write(mv[o:o + n])
            o += 480
        self.cs(1)

    def show_start(self):
        """show() without waiting: DMA sends the frame while your code runs (18 ms of CPU back per
        frame). Don't draw until show_wait() returns; do input, game logic, gc.collect() meanwhile.
        Where there's no DMA (the emulator) it is a plain show()."""
        global _dma, _dma_ctl, _pushing
        if _on_show:
            _on_show()
        if _pushing:
            _pushing.show_wait()
        if _dma is None:
            try:
                import rp2
                _dma = rp2.DMA()
                _dma_ctl = _dma.pack_ctrl(size=0, inc_read=True, inc_write=False, treq_sel=26 if RP2350 else 18)
            except Exception:
                _dma = False
        if not _dma:
            return self.show()
        self._cmd(0x2A, [0x00, 0x00, 0x00, 0xEF])
        self._cmd(0x2B, [0x00, 0x00, 0x00, 0xEF])
        self._cmd(0x2C)
        self.dc(1); self.cs(0)
        _pushing = self
        _dma.config(read=self.buffer, write=_SPI1 + 0x08, count=len(self.buffer), ctrl=_dma_ctl, trigger=True)

    def show_wait(self):
        """Wait for show_start's frame to be on the panel. Then the buffer is yours again."""
        global _pushing
        if _pushing is not self:
            return
        from machine import mem32
        while _dma.active():
            pass
        while mem32[_SPI1 + 0x0C] & 0x10:       # busy: the last bytes are still going out
            pass
        while mem32[_SPI1 + 0x0C] & 0x04:       # the RX FIFO filled while DMA only sent: empty it,
            mem32[_SPI1 + 0x08]
        mem32[_SPI1 + 0x20] = 1                 # clear its overrun, so spi.write works after
        self.cs(1)
        _pushing = None

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
    def __init__(self):
        self.pins = {k: Pin(p, Pin.IN, Pin.PULL_UP) for k, p in KEYS.items()}
        self.last = {k: 1 for k in KEYS}
        self.queue = []
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
        t = _hold.get(k)
        return t is not None and time.ticks_diff(t, time.ticks_ms()) > 0
