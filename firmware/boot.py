# Runs before main.py. The boot logo goes up first, before anything slow loads.
try:
    import splash
    splash.show()
except Exception as e:
    print("splash:", e)

# The WEDGIE drive (wedgiedrive.py): a tiny read-only USB drive beside the serial port, with the
# underwear icon and an "Open wedgie.dev" page. Hold Y while plugging in to skip it.
try:
    import lcd  # noqa: F401  grab the 115 KB screen buffer first, while the heap is fresh (RP2040)
    from machine import Pin
    if Pin(21, Pin.IN, Pin.PULL_UP).value():
        import wedgiedrive
        wedgiedrive.start()
    else:
        print("drive: skipped (Y held)")
except Exception as e:
    print("drive:", e)
import gc
gc.collect()
