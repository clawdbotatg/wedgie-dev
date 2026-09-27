# wedgie: who this board is, and the few things a host (wedgie.dev, an agent, mpremote) can ask of it.
# The launcher (menu.py) answers these as JSON lines on USB while it runs, so nothing gets
# interrupted; from the REPL they are plain calls:  import wedgie; wedgie.shot(); wedgie.press("A")
import sys, os, json, machine

VERSION = "0.1.1"


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
    try:
        with open("apps.json") as f:
            return json.load(f)
    except OSError:
        return []


def hello(mid=None, **extra):
    name, cpu, wifi = board()
    d = {"type": "hello", "name": "wedgie", "fw": "wedgie-" + VERSION, "version": VERSION, "uid": uid(),
         "short": short(), "board": name, "cpu": cpu, "wifi": wifi, "machine": sys.implementation._machine,
         "micropython": os.uname().release, "apps": [a["mod"] for a in apps()]}
    if mid is not None:
        d["id"] = mid
    d.update(extra)
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
