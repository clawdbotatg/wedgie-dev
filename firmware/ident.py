# The wedgie's ID: "<board>-<chip>". board = machine.unique_id(), which an RP2040 reads from its flash
# chip, and a whole batch of RP2040-Plus boards answers the same 4150353034313610 (Austin, 2026-11-19:
# two wedgies, one ID). chip = 12 hex of the SHA-256 of the secure chip's factory serial (ATECC608
# serial, Trust M coprocessor UID), different on every chip. No chip: the board part alone.
# Read once per boot (boot.py for the USB serial, else wedgie.uid()); kept in RAM, never saved.
import machine, sys

_id = None


def _chip():
    from machine import Pin
    for p in (4, 5):                # no pull-ups on SDA/SCL: nothing on the bus, don't wait on timeouts
        v = Pin(p, Pin.IN, Pin.PULL_DOWN).value()
        Pin(p, Pin.IN)
        if not v:
            return None
    try:
        import atecc
        a = atecc.ATECC608(sda=4, scl=5)
        a.wake()
        try:
            return a.serial()
        finally:
            a.sleep()
    except Exception:
        pass
    try:
        import trustm
        trustm.bus(4, 5)
        return trustm.coprocessor_uid()
    except Exception:
        return None


def uid():
    global _id
    if _id is None:
        b = machine.unique_id().hex()
        had = set(sys.modules)
        try:
            s = _chip()
        except Exception:
            s = None
        for m in set(sys.modules) - had:        # the drivers stay loaded only if something else uses them
            del sys.modules[m]
        if s:
            import hashlib, binascii
            b = b + "-" + binascii.hexlify(hashlib.sha256(s).digest()[:6]).decode()   # once, 29 chars
        _id = b
    return _id
