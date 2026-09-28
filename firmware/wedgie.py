# wedgie: who this board is, and the few things a host (wedgie.dev, an agent, mpremote) can ask of it.
# The launcher (menu.py) answers these as JSON lines on USB while it runs, so nothing gets
# interrupted; from the REPL they are plain calls:  import wedgie; wedgie.shot(); wedgie.press("A")
import sys, os, json, machine

VERSION = "0.1.4"


def uid():
    return machine.unique_id().hex()


def short():
    return uid()[-6:].upper()


def board():
    m = sys.implementation._machine
    cpu = "RP2350" if "RP2350" in m else "RP2040" if "RP2040" in m else "?"
    try:
        import network  # noqa: F401  only W boards have it
        w = True
    except ImportError:
        w = False
    name = {"RP2350": "Pico 2 W" if w else "Pico 2", "RP2040": "Pico W" if w else "RP2040 Pico"}.get(cpu, m)
    return name, cpu, w


def apps():
    """What's in the launcher: apps.json, the wedgie's own list of the cartridges wedgie.dev put on it
    ({"mod", "name", "entry"?, "about"?, "v"}) plus any app saved with wedgie.py or the site's editor.
    The firmware ships none: a fresh wedgie has an empty launcher until a cartridge goes on."""
    try:
        with open("apps.json") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def free():
    """Bytes free on its flash (cartridges need room)."""
    try:
        s = os.statvfs("/")
        return s[0] * s[3]
    except Exception:
        return None


_chip = None        # what the last chip() found: "ATECC608", "OPTIGA Trust M", "none" (None: not asked yet)


def hello(mid=None, **extra):
    name, cpu, wifi = board()
    a = apps()
    d = {"type": "hello", "name": "wedgie", "fw": "wedgie-" + VERSION, "version": VERSION, "uid": uid(),
         "short": short(), "board": name, "cpu": cpu, "wifi": wifi, "machine": sys.implementation._machine,
         "micropython": os.uname().release, "apps": [x["mod"] for x in a],
         "carts": [{"mod": x["mod"], "v": x.get("v")} for x in a], "free": free(), "chip": _chip}
    if mid is not None:
        d["id"] = mid
    d.update(extra)
    return d


def chip():
    """Prove the secure chip works, without stopping anything: the host sends nothing but this
    request and checks the answer itself (wedgie.dev: src/serial/chipcheck.ts).
      ATECC608: SHA-256 of 100 random bytes computed on the chip, and two Random reads.
      Trust M: two Random reads, its Infineon device certificate, and its factory key's signature
      over random bytes (the host checks the signature against the certificate and the certificate
      against Infineon's roots).
    Also the I2C lines (the breakout's pull-ups hold them high), so "no chip" can say why."""
    global _chip
    import binascii, hashlib, gc
    from machine import Pin
    hx = lambda b: binascii.hexlify(b).decode()
    lines = {}
    for n, p in (("sda", 4), ("scl", 5)):
        lines[n] = Pin(p, Pin.IN, Pin.PULL_DOWN).value()
        Pin(p, Pin.IN)
    msg = os.urandom(100)
    d = {"type": "chip", "lines": lines, "msg": hx(msg), "kind": None}
    had = set(sys.modules)
    try:
        if lines["sda"] and lines["scl"]:
            try:
                import atecc
                a = atecc.ATECC608(sda=4, scl=5)
                a.wake()
            except Exception:
                a = None
            if a:
                try:
                    a.command(0x47, 0x00, 0, resp_len=1, wait_ms=10)                     # SHA start
                    a.command(0x47, 0x01, 64, msg[:64], resp_len=1, wait_ms=10)          # 64 bytes
                    sha = a.command(0x47, 0x02, 36, msg[64:], resp_len=32, wait_ms=10)   # last 36, digest
                    r1 = a.command(0x1B, 0x01, 0, resp_len=32, wait_ms=25)               # Random, seed untouched
                    r2 = a.command(0x1B, 0x01, 0, resp_len=32, wait_ms=25)
                    serial = a.serial()
                    locks = a.lock_state()
                finally:
                    a.sleep()
                d.update(kind="atecc", type_="ATECC608", sha=hx(sha), random=[hx(r1), hx(r2)], serial=hx(serial), **locks)
            else:
                import trustm
                trustm.bus(4, 5)
                try:
                    s = trustm.Session()
                except OSError:
                    raise OSError("no chip answered, but the lines have power")
                d["kind"] = "trustm"
                d["type_"] = "OPTIGA Trust M"
                d["random"] = [hx(s.random(32)), hx(s.random(32))]
                d["cert"] = hx(s.get_all(0xE0E0))
                r, sg = s.sign(0xE0F0, hashlib.sha256(msg).digest())
                d.update(r="%064x" % r, s="%064x" % sg)
    except Exception as e:
        d["error"] = str(e) or type(e).__name__
    for m in set(sys.modules) - had:        # the drivers stay loaded only if something else uses them
        del sys.modules[m]
    gc.collect()
    _chip = d.get("type_") or ("none" if not d.get("error") else None)
    d["chip"] = d.pop("type_", None)
    return d


def send(obj):
    print(json.dumps(obj))


def shot(mid=None):
    """The screen as it is now (the framebuffer every lcd.LCD() draws into), as JSON lines:
    {"type":"shot","i":0,"n":N,"w":240,"h":240,"fmt":"rgb565be","data":"<base64>"} ... one per chunk."""
    import lcd, binascii
    b = memoryview(lcd._BUF)
    step = 3072
    n = (len(b) + step - 1) // step
    for i in range(n):
        d = {"type": "shot", "i": i, "n": n, "w": 240, "h": 240, "fmt": "rgb565be",
             "data": binascii.b2a_base64(b[i * step:(i + 1) * step]).decode().strip()}
        if mid is not None:
            d["id"] = mid
        print(json.dumps(d))


def press(k, ms=80):
    import lcd
    lcd.press(k, ms)
