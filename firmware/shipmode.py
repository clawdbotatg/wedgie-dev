# Ship mode (0.3.88; its own file since 0.3.90: rare code stays out of every wedgie's heap). On battery, hold
# the four front buttons (green, both grey, red) 10 s (power.py watches) and it's off till USB comes: no button
# wakes it. USPS Pub 52 349.221: a device with a lithium battery in the mail must have "effective means of
# preventing it from being inadvertently turned on". A flag file (SHIP) keeps it off through a RESET press in
# the mail; plugging in USB clears it and boots fresh.
import os, sys, time, machine
from machine import Pin
import ui
import power as P

SHIP = "/.ship"                 # ship mode is on (survives a reset; USB clears it). power.start looks for it


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


def boot():
    """power.start found the flag. Still on the battery (a RESET press in the mail): off again, no screen.
    On USB: the flag goes and it runs as ever."""
    if P._vbus.value() == 0:
        ship(quiet=True)
    _flag(False)


def ship(quiet=False):
    """Screen and chip off until USB. No button can wake it; USB boots it fresh (machine.reset).
    quiet: no screen (a reset while in ship mode)."""
    d = P._d
    if not quiet:
        ui.page(d, "Off", (("plug in USB to turn on", ui.MUTED),))
        t = time.ticks_ms()
        while P._down() and time.ticks_diff(time.ticks_ms(), t) < 15000:
            time.sleep_ms(10)                       # let go first
        time.sleep_ms(2000)
    _flag(True)
    d.backlight(0)
    P._black(d)
    d._cmd(0x28)                                    # panel: display off
    d._cmd(0x10)                                    # panel: sleep in
    if " W" not in sys.implementation._machine:
        Pin(25).init(Pin.OUT, value=0)              # a Pico's own LED
    while P._vbus.value() == 0:                     # only USB ends it: a button that wakes the chip sleeps again
        try:
            if P._gp24:
                P._wake(True, keys=False)
                machine.lightsleep()                # dormant until GP24 (VBUS)
            else:
                machine.lightsleep(1000)            # VBUS on the radio (a Pico W): look each second
        except Exception:
            time.sleep_ms(1000)
    if P._gp24:
        P._wake(False)
    _flag(False)
    machine.reset()
