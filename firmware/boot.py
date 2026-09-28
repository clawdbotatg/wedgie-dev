# Runs before main.py. The boot logo goes up first, before anything slow loads.
try:
    import splash
    splash.show()
except Exception as e:
    print("splash:", e)

# The WEDGIE drive (wedgiedrive.py): a tiny read-only USB drive beside the serial port, with the
# underwear icon and an "Open wedgie" app. Only on a real power-up: adding it re-enumerates USB,
# which drops the serial port, and a host that soft-resets the board (tools, wedgie.dev) would
# otherwise get dropped every time. A watchdog scratch register survives soft resets and is cleared
# at power-on, so it tells the two apart. Hold Y while plugging in to skip the drive.
try:
    import lcd  # noqa: F401  grab the 115 KB screen buffer first, while the heap is fresh (RP2040)
    import sys, machine
    from machine import Pin
    _SCRATCH = (0x400D8000 if "RP2350" in sys.implementation._machine else 0x40058000) + 0x0C  # WATCHDOG SCRATCH0
    _MARK = 0x57ED61E0
    if machine.mem32[_SCRATCH] == _MARK:
        print("drive: soft reset, left as is")
    elif not Pin(21, Pin.IN, Pin.PULL_UP).value():
        print("drive: skipped (Y held)")
    else:
        machine.mem32[_SCRATCH] = _MARK
        import wedgiedrive
        wedgiedrive.start()
except Exception as e:
    print("drive:", e)
import gc
gc.collect()
