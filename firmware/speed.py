# Speed lab: times every graphics trick in wedgie.dev/code.md on this board and shows the numbers.
# The same numbers go out on USB as one line:  @speed {"board": ..., "ms": {...}}  (wedgie.py run speed.py)
# A runs it again. Each test is timed after a gc.collect(); ms are per call, averaged.
import sys, time, gc, machine, framebuf, micropython
import lcd as L
import ui

RP2350 = "RP2350" in sys.implementation._machine
res = {}            # name -> ms
lines = []          # what the screen lists
d = keys = None


def ms(fn, n=10):
    gc.collect()
    t0 = time.ticks_us()
    for _ in range(n):
        fn()
    return time.ticks_diff(time.ticks_us(), t0) / n / 1000


def note(name, v, extra=""):
    res[name] = round(v, 2)
    lines.append("%-12s%6.1f ms %s" % (name, v, extra))
    print("%-14s %7.2f ms %s" % (name, v, extra))


def spi_hz():
    s = repr(d.spi)                     # SPI(1, baudrate=24000000, ...)
    i = s.find("baudrate=")
    return int(s[i + 9:s.find(",", i)]) if i >= 0 else 0


# Sprites: a 16x16 ball, 4 bits a pixel, drawn in color by a 16-entry palette at C speed.
BALL = framebuf.FrameBuffer(bytearray(16 * 16 // 2), 16, 16, framebuf.GS4_HMSB)
for y in range(16):
    for x in range(16):
        r2 = (x - 7.5) ** 2 + (y - 7.5) ** 2
        BALL.pixel(x, y, 0 if r2 > 56 else 3 if r2 < 12 else 2 if r2 < 30 else 1)
PAL = framebuf.FrameBuffer(bytearray(16 * 2), 16, 1, framebuf.RGB565)
SPR = framebuf.FrameBuffer(bytearray(16 * 16 * 2), 16, 16, framebuf.RGB565)


@micropython.viper
def vfill(buf: ptr16, c: int):
    for i in range(240 * 240):
        buf[i] = c


def pyloop():
    b = d.buffer
    for i in range(0, 2000, 2):
        b[i] = 255


def dma_push():
    """The whole frame by DMA: returns (ms until the CPU is free again, ms until the panel has it all)."""
    import rp2
    from machine import mem32
    base = 0x40088000 if RP2350 else 0x40040000         # SPI1
    ch = rp2.DMA()
    try:
        ctrl = ch.pack_ctrl(size=0, inc_read=True, inc_write=False, treq_sel=26 if RP2350 else 18)
        d._cmd(0x2A, [0, 0, 0, 239]); d._cmd(0x2B, [0, 0, 0, 239]); d._cmd(0x2C)
        d.dc(1); d.cs(0)
        t0 = time.ticks_us()
        ch.config(read=d.buffer, write=base + 0x08, count=len(d.buffer), ctrl=ctrl, trigger=True)
        t1 = time.ticks_us()
        while ch.active():
            pass
        while mem32[base + 0x0C] & 0x10:                # busy: the last bytes are still going out
            pass
        while mem32[base + 0x0C] & 0x04:                # the RX FIFO filled while we only sent: empty it
            mem32[base + 0x08]
        mem32[base + 0x20] = 1                          # and clear its overrun flag
        d.cs(1)
        t2 = time.ticks_us()
        return time.ticks_diff(t1, t0) / 1000, time.ticks_diff(t2, t0) / 1000
    finally:
        ch.close()


def run_all():
    global d
    del lines[:]
    res.clear()
    d = L.LCD()
    d.fill(L.BLACK)
    cpu = machine.freq()
    print("@speed start", sys.implementation._machine)
    note("full frame", ms(d.show), "%d MHz SPI" % (spi_hz() // 1000000))
    # The clock trick: peri = cpu lifts the SPI cap from 24 MHz. A new LCD() makes a new SPI at the new rate.
    for mhz in (125, 150, 200, 250):
        try:
            machine.freq(mhz * 1000000, mhz * 1000000)
            d = L.LCD()
            note("@%d MHz" % mhz, ms(d.show), "%d MHz SPI" % (spi_hz() // 1000000))
        except Exception as e:
            lines.append("@%d MHz: %s" % (mhz, e))
    machine.freq(125000000, 125000000)        # the rest at the clock the firmware runs (lcd.py: 62.5 MHz SPI)
    d = L.LCD()
    note("24-row band", ms(lambda: d.show(100, 124)))
    note("120-row band", ms(lambda: d.show(0, 120)))
    note("32x32 rect", ms(lambda: d.show_rect(100, 100, 32, 32)))
    note("fill()", ms(lambda: d.fill(L.BLUE)))
    note("viper fill", ms(lambda: vfill(d.buffer, L.RED)))
    note("1000 px py", ms(pyloop, 3))
    for i, c in enumerate((0, L.color(40, 60, 200), L.color(90, 140, 255), L.color(230, 240, 255))):
        PAL.pixel(i, 0, c)
    note("16x16 rgb565", ms(lambda: [d.blit(SPR, 11 * i, 60, 0) for i in range(20)]) / 20)
    note("20 sprites", ms(lambda: [d.blit(BALL, 11 * i, 60 + i * 3, 0, PAL) for i in range(20)]))
    note("30 chars", ms(lambda: d.text("the quick brown fox jumps over", 0, 0, L.WHITE)))
    note("big text x3", ms(lambda: d.big_text("SCORE 1234", 0, 20, L.WHITE, 3), 3))
    note("gc.collect", ms(gc.collect, 5))
    try:
        busy, total = dma_push()
        note("dma frame", total, "cpu %.1f" % busy)
        note("show after", ms(d.show, 3))           # plain pushes still work after a DMA one
    except Exception as e:
        lines.append("dma: %s" % e)
        print("dma:", repr(e))
    print("@speed", '{"board": "%s", "cpu": %d, "ms": %s}' % (sys.implementation._machine, cpu, str(res).replace("'", '"')))
    draw()


def draw():
    d.fill(ui.WHITE)
    ui.band(d, 2)
    d.text("speed lab   A: again", 4, 30, ui.INK)
    y = 44
    for s in lines[:18]:
        d.text(s[:30], 0, y, ui.INK)
        y += 11
    d.show()


def run():
    global keys
    keys = L.Keys()
    run_all()
    while True:
        if "A" in keys.pressed():
            run_all()
        time.sleep_ms(30)
