# wedgie firmware: boot straight into the one app it has (slot.py). The slot owns the screen and USB.
# Sealed (0.2.5+): Ctrl-C goes off on the first line (MicroPython turns it on for every file it starts),
# and this file never ends by itself, so a computer can't stop the app and land in the REPL, where it
# could run anything and make the secure chip sign anything. A computer gets the REPL only after the
# person presses A on the wedgie ({"type": "open"}, slot.let_in); then Ctrl-C works as it always did
# (mpremote, wedgie.dev's raw-REPL tools) until this file runs again, which locks it. The lock is in wedgie.py.
import micropython
micropython.kbd_intr(-1)
import sys, time


def stuck(e):
    """The slot broke. A (a real press: these are the pins) lets the computer in to fix it, B tries
    again. True: let it in."""
    try:
        with open("error.log", "w") as f:
            sys.print_exception(e, f)
    except Exception:
        pass
    sys.print_exception(e)
    try:
        import lcd
        d = lcd.LCD()
        ink = lcd.color(26, 27, 26)
        d.fill(lcd.color(254, 254, 254))
        d.center_text("wedgie broke", 70, lcd.color(227, 49, 44), 2)
        d.center_text(("%s" % e)[:28], 100, ink)
        d.center_text("A  let the computer in", 170, ink)
        d.center_text("B  try again", 190, ink)
        d.show()
    except Exception:
        pass
    from machine import Pin
    a, b = Pin(15, Pin.IN, Pin.PULL_UP), Pin(17, Pin.IN, Pin.PULL_UP)
    while a.value() == 0 or b.value() == 0:
        time.sleep_ms(20)
    while True:
        if a.value() == 0:
            try:
                import wedgie
                wedgie.set_open()
            except Exception:
                micropython.kbd_intr(3)
            return True
        if b.value() == 0:
            return False
        time.sleep_ms(20)


try:
    import lcd          # first: grabs the framebuffer while the heap is fresh (RP2040 boards need this)
    import wedgie
    wedgie.SEALED = True
    wedgie._open = False                # a yes was for one job; this is a fresh start
    import loader
    _a = wedgie.active()
    loader.load(_a["mod"] if _a else "slot")    # its files load one by one under the boot logo's bar
except BaseException as e:
    sys.print_exception(e)
while True:
    try:
        import slot
        slot.run()
        e = RuntimeError("the slot ended")
    except KeyboardInterrupt:       # only once the person let the computer in
        break
    except SystemExit:              # machine.soft_reset() is a SystemExit: let the one a job asked for through
        if getattr(sys.modules.get("wedgie"), "restarting", False):   # (0.3.0 caught it: "wedgie broke"
            raise                                                      # after every checked install)
        e = RuntimeError("an app called sys.exit")
        sys.modules.pop("slot", None)
    except BaseException as x:
        e = x
        sys.modules.pop("slot", None)
    if "wedgie" in sys.modules and sys.modules["wedgie"].is_open():
        sys.print_exception(e)
        break
    if stuck(e):
        break
