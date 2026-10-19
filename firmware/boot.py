# Runs before main.py. The boot logo goes up first, before anything slow loads.
# Ctrl-C off on the first line, as in main.py: MicroPython turns it on for boot.py too, and a Ctrl-C that stops
# boot.py makes MicroPython skip main.py, lock and all, and hand a computer the REPL (found 10-15: a host waited
# out a question, the no soft-reset the board, and Ctrl-C spammed through the restart got in). Nothing here may
# end boot.py early: every failure is caught, BaseException too.
import micropython
micropython.kbd_intr(-1)
try:                                    # a computer was let in and main.py hasn't run since (wedgie.WAS_OPEN): a soft
    import machine, sys                 # reset from the raw REPL would skip main.py and leave it in, so start over for real
    _s3 = (0x400D8000 if "RP2350" in sys.implementation._machine else 0x40058000) + 0x18
    if machine.mem32[_s3] & 1:
        machine.mem32[_s3] &= ~1
        machine.reset()
except BaseException as e:
    print("boot:", e)
try:
    import splash, os, machine, sys
    # A soft reset into an install (wedgie.save_job) keeps the screen: it already shows the install's
    # progress. Only on a soft reset (the drive's mark, below): after a power-up the panel needs its reset.
    _scr = (0x400D8000 if "RP2350" in sys.implementation._machine else 0x40058000) + 0x0C
    try:                                # (scratch1 0xC01D: slot._cold's hard reset reset the panel too)
        _cold = machine.mem32[_scr + 4] == 0xC01D
        machine.mem32[_scr + 4] = 0
    except Exception:
        _cold = False
    try:
        _keep = not _cold and machine.mem32[_scr] == 0x57ED61E0 and bool(os.stat("_job.json"))
    except Exception:                   # no job file; or no mem32 (the emulator)
        _keep = False
    splash.show(keep=_keep)
except BaseException as e:
    print("splash:", e)

# The WEDGIE drive (wedgiedrive.py): a tiny read-only USB drive beside the serial port, with the
# underwear icon and an "Open wedgie" app. Only on a real power-up: adding it re-enumerates USB,
# which drops the serial port, and a host that soft-resets the board (tools, wedgie.dev) would
# otherwise get dropped every time. A watchdog scratch register survives soft resets and is cleared
# at power-on, so it tells the two apart. Hold Y while plugging in to skip the drive.
#
# READ THIS before touching boot, USB or anything that talks to a wedgie: about a second after
# power-up the serial port disappears and comes back (a new port, same board ID) while the drive is
# added. Every host has to live with that: wait before identifying a new port, retry an open that
# fails, find a wedgie by its ID, and never soft-reset just to restart its app (run main.py; see
# src/serial/repl.ts leave). The first soft reset after an update from firmware older than 0.1.3 has
# no mark yet and drops the port too. A host that reconnects and soft-resets again loops forever
# (wedgie.dev did, 2026-09-27: e6ea8c1). Hosts that handle this: src/serial/wedgies.ts, install.ts,
# pages/wedgie.ts, pages/update.ts, public/wedgie.py; tools/fakewedgies.mjs plays both cases.
try:
    import lcd  # noqa: F401  grab the 115 KB screen buffer first, while the heap is fresh (RP2040)
    import sys, machine
    from machine import Pin
    _SCRATCH = (0x400D8000 if "RP2350" in sys.implementation._machine else 0x40058000) + 0x0C  # WATCHDOG SCRATCH0
    _MARK = 0x57ED61E0
    _again = machine.mem32[_SCRATCH + 8] == 0xD21E     # scratch2: an install's last restart (job.restart)
    machine.mem32[_SCRATCH + 8] = 0
    if _again:                          # the drive back after an install: main.py adds it (here a soft reset's own
        _drive_again = True             # USB setup, which runs after boot.py, would put the plain port back over it)
    elif machine.mem32[_SCRATCH] == _MARK:
        print("drive: soft reset, left as is")
    elif not Pin(21, Pin.IN, Pin.PULL_UP).value():
        print("drive: skipped (Y held)")
    else:
        machine.mem32[_SCRATCH] = _MARK
        import wedgiedrive
        wedgiedrive.start()
except BaseException as e:
    print("drive:", e)
import gc
gc.collect()
