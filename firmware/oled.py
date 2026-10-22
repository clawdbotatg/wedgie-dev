# Waveshare Pico-OLED-1.3: 128x64 white OLED (SH1107) on the same pins as the Pico-LCD-1.3, two keys:
# KEY1 (GP17, top) is the green "yes", KEY0 (GP15, bottom) the red "no". lcd.py loads this only on a wedgie with a
# file named "oled" on it (docs/SCREENS.md); then LCD and KEYS here replace lcd's. An LCD wedgie never
# imports it. Apps draw as always (16 colors into the same framebuffer, 128x64 of it); show() lights
# every pixel darker than near-white, so ui's white screens come out as lit text on black.
from machine import Pin, SPI
import framebuf, time, micropython
import lcd as L
from splash import DC, CS, SCK, MOSI, RST

KEYS = {"A": 17, "Y": 15}
W, H = 128, 64
_LIT = bytes(1 if sum(p) < 600 else 0 for p in L.PALETTE)   # palette index -> lit
_ROW = bytearray(16)
_up = False

_SETUP = bytes((0xAE, 0x00, 0x10, 0xB0, 0xDC, 0x00, 0x81, 0x6F, 0x21, 0xA0, 0xC0, 0xA4, 0xA6,
                0xA8, 0x3F, 0xD3, 0x60, 0xD5, 0x41, 0xD9, 0x22, 0xDB, 0x35, 0xAD, 0x8A))


@micropython.viper
def _bits(src, y: int, lit, dst):
    """Row y of the 4-bit framebuffer -> the 16 bytes the panel takes for it (right to left, a bit a
    pixel, low bit first: the panel is mounted turned around)."""
    s = ptr8(src)
    t = ptr8(lit)
    o = ptr8(dst)
    j = 0
    while j < 16:
        v = 0
        k = 0
        while k < 8:
            p = y * 128 + 127 - 8 * j - k
            b = s[p >> 1]
            if p & 1:
                n = b & 15
            else:
                n = b >> 4
            if t[n]:
                v |= 1 << k
            k += 1
        o[j] = v
        j += 1


class LCD(framebuf.FrameBuffer):
    big_text = L.LCD.big_text
    center_text = L.LCD.center_text
    show_start = L.LCD.show_start
    show_wait = L.LCD.show_wait

    def __init__(self):
        global _up
        self.width, self.height = W, H
        self.cs = Pin(CS, Pin.OUT, value=1)
        self.rst = Pin(RST, Pin.OUT, value=1)
        self.dc = Pin(DC, Pin.OUT, value=1)
        self.spi = SPI(1, 10_000_000, polarity=0, phase=0, sck=Pin(SCK), mosi=Pin(MOSI), miso=None)
        self.buffer = memoryview(L._BUF)[:W * H // 2]
        super().__init__(self.buffer, W, H, framebuf.GS4_HMSB)
        if not _up:
            self.rst(0); time.sleep_ms(10); self.rst(1); time.sleep_ms(50)
            self._cmd(_SETUP)
            self.fill(0)                 # black
            self.show()                 # panel RAM cleared before it lights: no noise
            self._cmd(b"\xAF")
            _up = True

    def _cmd(self, b):
        self.dc(0); self.cs(0); self.spi.write(b); self.cs(1)

    def backlight(self, pct):
        self._cmd(b"\xAF" if pct else b"\xAE")

    def fill(self, c):
        super().fill(c)

    def show(self, y0=0, y1=64):
        self.show_rect(0, 0, W, H)

    def show_rect(self, x, y, w, h):
        """The whole screen goes out (1 KB, ~2 ms): no boxes to keep track of."""
        h = L._on_show                  # once: a job can clear it between the check and the call
        if h:
            h()
        L._busy = True
        try:
            c = bytearray(2)
            self._cmd(b"\xB0")
            for r in range(H):
                c[0], c[1] = r & 15, 0x10 | r >> 4
                self._cmd(c)
                _bits(self.buffer, r, _LIT, _ROW)
                self.dc(1); self.cs(0); self.spi.write(_ROW); self.cs(1)
        finally:
            L._busy = False
