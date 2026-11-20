# Ship mode (0.3.88; its own file since 0.3.90: rare code stays out of every wedgie's heap). On battery, hold
# the four front buttons (green, both grey, red) 10 s (power.py watches) and it's off till USB comes: no button
# wakes it. USPS Pub 52 349.221: a device with a lithium battery in the mail must have "effective means of
# preventing it from being inadvertently turned on". A flag file (SHIP) keeps it off through a RESET press in
# the mail: RESET is the chip's own pin, nothing can turn it off, so boot.py looks for the flag before the
# screen lights and comes straight back here (0.3.91: it used to boot to the logo first, then go off).
# Plugging in USB clears the flag and boots fresh.
# Nothing is imported up here but the chip's own modules: boot() runs before lcd, ui and power exist.
import os, sys, time, machine
from machine import Pin

SHIP = "/.ship"                 # ship mode is on (survives a reset; USB clears it). boot.py looks for it


def _flag(on):
    """Write ship mode's file, or remove it. Never raises."""
    try:
        if on:
            with open(SHIP, "w") as f:
                f.write("1")
        else:
            os.remove(SHIP)
    except OSError:
        pass


def _vbus():
    """(the pin that reads USB power, can it wake the chip from dormant): power.start's own rule."""
    try:
        return Pin("WL_GPIO2", Pin.IN), False       # a Pico W / Pico 2 W
    except (ValueError, TypeError):
        return Pin(24, Pin.IN), "RP2040" in sys.implementation._machine


def _wake(on):
    """Only VBUS (GP24) going high ends dormant: no button (RP2040 IO_BANK0 DORMANT_WAKE_INTE0-3, as power._wake)."""
    for i in range(4):
        machine.mem32[0x400140F0 + 4 * i] = 0xFFFFFFFF  # INTR: clear latched edges
        machine.mem32[0x40014160 + 4 * i] = 8 if on and i == 3 else 0


def _off():
    """Asleep until USB, then a fresh start. Never returns."""
    v, g = _vbus()
    while v.value() == 0:                           # only USB ends it: anything else that wakes the chip sleeps again
        try:
            if g:
                _wake(True)
                machine.lightsleep()                # dormant until GP24 (VBUS)
            else:
                machine.lightsleep(1000)            # VBUS on the radio (a Pico W): look each second
        except Exception:
            time.sleep_ms(1000)
    if g:
        _wake(False)
    _flag(False)
    machine.reset()


def boot():
    """boot.py found the flag, before anything is on the screen. Still on the battery (a RESET press in the
    mail): the backlight stays off and it's asleep again. On USB: the flag goes and it boots as ever."""
    if _vbus()[0].value() == 0:
        try:
            from splash import BL
            Pin(BL, Pin.OUT, value=0)
        except Exception:
            pass
        _off()
    _flag(False)


def ship():
    """The four buttons were held (power._ship_check): say so, then screen and chip off until USB."""
    import ui
    import power as P
    d = P._d
    ui.page(d, "Off", (("plug in USB to turn on", ui.MUTED),))
    t = time.ticks_ms()
    while P._down() and time.ticks_diff(time.ticks_ms(), t) < 15000:
        time.sleep_ms(10)                           # let go first
    time.sleep_ms(2000)
    _flag(True)
    d.backlight(0)
    P._black(d)
    d._cmd(0x28)                                    # panel: display off
    d._cmd(0x10)                                    # panel: sleep in
    if " W" not in sys.implementation._machine:
        Pin(25).init(Pin.OUT, value=0)              # a Pico's own LED
    _off()
