# Battery (0.3.28+). A wedgie with a battery (the atomic wedgie: a LiPo on the Pico's VSYS) runs on it
# whenever USB isn't plugged in. Then, under every app, with no app doing anything:
#  - its charge shows in the top-right corner (BOX), drawn over the app's frame as it goes out (lcd._on_frame).
#    Apps keep their own top-right text left of ui.right();
#  - after IDLE_MS with no press, the screen goes off and the chip lightsleeps until any button. That
#    press only wakes it: the app never sees it.
# On USB power none of this happens (VSYS is then USB's 5 V, so the battery can't be read) and the corner
# is the app's. The slot starts it on a real board only (slot.run); the emulator has no battery.
# Runs in one real Timer (never an app's: slot._RealTimer), every TICK_MS. Integers only: nothing grows.
import sys, time, machine
from machine import Pin, ADC
import lcd as L
import ui

IDLE_MS = 20000
TICK_MS = 1000
BOX = (184, 2, 55, 11)          # x, y, w, h: the corner the battery takes
# LiPo volts (mV at VSYS) -> percent, resting. Below the last: 0.
CURVE = ((4150, 100), (4050, 90), (3970, 80), (3900, 70), (3840, 60), (3790, 50), (3750, 40),
         (3710, 30), (3670, 20), (3600, 10), (3450, 0))

on_battery = False
pct = None          # 0-100 while on battery
_mv = 0             # VSYS, smoothed
_last = 0           # ticks_ms of the last press
_d = None
_t = None
_vbus = None
_adc = None
_pins = ()


def shown():
    """The battery is in the corner now."""
    return on_battery and pct is not None


def _touch(_=None):
    """A press (a hard IRQ: it runs even while sleep() blocks; allocates nothing)."""
    global _last
    _last = time.ticks_ms()


def _read_mv():
    """VSYS in mV: GP29 reads it through a 3:1 divider (3.3 V reference)."""
    s = 0
    for _ in range(16):
        s += _adc.read_u16()
    return s * 9900 // (65535 * 16)


def _percent(mv):
    hi = CURVE[0]
    if mv >= hi[0]:
        return 100
    for lo in CURVE[1:]:
        if mv >= lo[0]:
            return lo[1] + (mv - lo[0]) * (hi[1] - lo[1]) // (hi[0] - lo[0])
        hi = lo
    return 0


def start(d, Timer):
    """Watch the power from now on. d: the slot's LCD. Never raises: a board it can't read runs as before."""
    global _d, _t, _vbus, _adc, _pins
    try:
        _d = d
        try:
            _vbus = Pin("WL_GPIO2", Pin.IN)         # a Pico W / Pico 2 W
        except (ValueError, TypeError):
            _vbus = Pin(24, Pin.IN)
        _adc = ADC(29)
        _pins = [Pin(p, Pin.IN, Pin.PULL_UP) for p in L.KEYS.values()]
        for p in _pins:                             # any press is activity, whatever reads the keys
            p.irq(_touch, Pin.IRQ_FALLING, hard=True)
        _touch()
        L._on_frame = corner
        _tick()
        _t = Timer(-1, period=TICK_MS, mode=Timer.PERIODIC, callback=_tick)
    except Exception as e:
        print("power:", e)


def stop():
    global _t, on_battery
    if _t:
        _t.deinit()
        _t = None
    L._on_frame = None
    on_battery = False


def _tick(_=None):
    global on_battery, pct, _mv
    was, before = on_battery, pct
    on_battery = False
    if _vbus.value() == 0:
        mv = _read_mv()
        on_battery = 3000 < mv < 4500               # a LiPo; USB's VSYS is ~4.8 V (a clone whose GP24 isn't VBUS)
    if on_battery:
        _mv = mv if not was or not _mv else (_mv * 7 + mv) // 8
        p = _percent(_mv)
        pct = p if before is None or abs(p - before) > 1 or p in (0, 100) else before    # no flicker
    if L._busy:                                     # the app is mid-push: next tick
        return
    if (on_battery != was or pct != before) and not L._on_show:
        _d.show_rect(*BOX)                          # a still screen gets it too (corner() draws it)
    if on_battery and time.ticks_diff(time.ticks_ms(), _last) > IDLE_MS:
        sleep()


def corner(d, x0, y0, x1, y1):
    """lcd._on_frame: draw the battery into the frame when the rows going out cover the corner."""
    if not shown():
        return
    x, y, w, h = BOX
    if x1 <= x or x0 >= x + w or y1 <= y or y0 >= y + h:
        return
    bg = d.pixel(239, 0)                            # the app's background up there
    r, g, b = L.PALETTE[bg]
    fg = ui.WHITE if r + g + b < 384 else ui.INK
    d.fill_rect(x, y, w, h, bg)
    s = "%d%%" % pct
    d.text(s, x + w - 21 - 8 * len(s), y + 2, fg)
    bx = x + w - 19                                 # the cell: 16 x 9, its nub on the right
    d.rect(bx, y + 1, 16, 9, fg)
    d.fill_rect(bx + 16, y + 3, 2, 5, fg)
    d.fill_rect(bx + 2, y + 3, 12 * pct // 100 or 1, 5, ui.RED if pct <= 15 else ui.GREEN)


def _down():
    for p in _pins:
        if p.value() == 0:
            return True
    return False


def sleep():
    """Screen off, chip asleep, until any button (or USB comes back). Blocks right here, inside the Timer
    callback, so the app is frozen as it was. Off: backlight, panel, the Pico's LED, the CPU between checks (its ticks wait); the waking press is let go before it goes on. A press wakes the lightsleep (its IRQ), so a quick tap counts."""
    d = _d
    duty = d.bl.duty_u16()
    d.backlight(0)
    d._cmd(0x28)                                    # panel: display off
    d._cmd(0x10)                                    # panel: sleep in (it keeps its picture)
    led = None
    if " W" not in sys.implementation._machine:    # a Pico's own LED (a Pico W's is on the radio: leave it)
        led = Pin(25)
        on = led.value()
        led.init(Pin.OUT, value=0)
    t0 = _last
    try:
        while _last == t0 and not _down() and _vbus.value() == 0:
            try:
                machine.lightsleep(200)
            except Exception:
                time.sleep_ms(200)
    finally:
        if led and on:
            led.value(1)
        d._cmd(0x11)                                # sleep out: 5 ms before the next command
        time.sleep_ms(5)
        d._cmd(0x29)                                # display on
        d.bl.duty_u16(duty)
        t = time.ticks_ms()
        while _down() and time.ticks_diff(time.ticks_ms(), t) < 5000:
            time.sleep_ms(10)                       # the waking press goes to nobody
        _touch()
