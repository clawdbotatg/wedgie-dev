# wedgie.dev/test on the device: what board this is, then the guided button run on its own screen.
# Runs after probe.py (uses its _LCD, col, _big, KEYS, out). "@<tag> <json>" lines, like probe.py.

_ORDER = ("up", "down", "left", "right", "press", "A", "B", "X", "Y")
_NAME = {"up": "UP", "down": "DOWN", "left": "LEFT", "right": "RIGHT", "press": "IN", "A": "A", "B": "B", "X": "X", "Y": "Y"}
_COLOR = {"up": (255, 0, 0), "down": (0, 255, 0), "left": (0, 0, 255), "right": (255, 255, 255), "press": (0, 0, 0),
          "A": (255, 220, 0), "B": (0, 230, 230), "X": (230, 0, 230), "Y": (128, 128, 128)}
_INK, _PAPER, _GREEN, _RED = (26, 27, 26), (255, 255, 255), (34, 196, 82), (227, 49, 44)


# --- which board ---------------------------------------------------------
def _vbus():
    """A real Pico / Pico 2 senses USB power on GP24. (On a Pico W that pin is the WiFi chip's.)"""
    p = Pin(24, Pin.IN, Pin.PULL_DOWN)
    time.sleep_ms(2)
    v = p.value()
    Pin(24, Pin.IN)
    return v


def _cyw43():
    """Is the Pico W's WiFi chip there? Power it (WL_ON GP23) and read its gSPI test register
    (0xFEEDBEAD) by hand: CS GP25, clock GP29, data GP24. Word order and clock edge are tried
    every way, since only 'it answered' matters here."""
    on, cs, clk = Pin(23, Pin.OUT, value=0), Pin(25, Pin.OUT, value=1), Pin(29, Pin.OUT, value=0)
    time.sleep_ms(20)
    on(1)
    time.sleep_ms(250)
    pats = (0xFEEDBEAD, 0xBEADFEED, 0xADBEEDFE, 0xEDFEADBE)
    found = False
    for cmd in (0x4000A004, 0xA0044000):          # read, bus function, address 0x14, 4 bytes
        for _ in range(3):
            d = Pin(24, Pin.OUT, value=0)
            cs(0)
            for i in range(31, -1, -1):
                d((cmd >> i) & 1)
                clk(1)
                clk(0)
            d = Pin(24, Pin.IN)
            hi = lo = 0
            for _ in range(64):
                clk(1)
                hi = (hi << 1) | d.value()
                clk(0)
                lo = (lo << 1) | d.value()
            cs(1)
            for v in (hi, lo):
                for s in range(33):
                    if ((v >> s) & 0xFFFFFFFF) in pats:
                        found = True
            if found:
                break
            time.sleep_ms(10)
        if found:
            break
    on(0)
    for p in (23, 24, 25, 29):
        Pin(p, Pin.IN)
    return found


def board():
    gc.collect()
    m = sys.implementation._machine
    fs = os.statvfs("/")
    d = {"machine": m, "cpu": "RP2350" if "RP2350" in m else "RP2040" if "RP2040" in m else "?",
         "uid": machine.unique_id().hex(), "mp": os.uname().release, "mhz": machine.freq() // 1_000_000,
         "heap": gc.mem_free() + gc.mem_alloc(), "fs": fs[0] * fs[2], "wbuild": False, "wifi": False}
    try:
        import network
        d["wbuild"] = True
    except ImportError:
        pass
    if d["wbuild"]:
        try:
            w = network.WLAN(network.STA_IF)
            w.active(True)
            d["mac"] = ":".join("%02x" % b for b in w.config("mac"))
            w.active(False)
            d["wifi"] = True
        except Exception as e:
            d["wifiError"] = str(e) or type(e).__name__
    else:
        d["vbus"] = _vbus()
        d["wifi"] = not d["vbus"] and _cyw43()
    out("board", d)


# --- the screen ------------------------------------------------------------
def _say(big, small="", bg=_PAPER, fg=_INK):
    global _lcd
    if _lcd is None:
        _lcd = _LCD()
    b, f = col(*bg), col(*fg)
    _lcd.fill(b)
    w, h, buf = _big(big, 5 if len(big) <= 5 else 3 if len(big) <= 9 else 2, f, b)
    _lcd.blit((240 - w) // 2, 84, w, h, buf)
    if small:
        small = small[:28]
        w, h, buf = _big(small, 2 if len(small) <= 14 else 1, f, b)
        _lcd.blit((240 - w) // 2, 160, w, h, buf)


def _ink_on(c):
    return _INK if sum(c) > 380 else _PAPER


# --- the buttons -----------------------------------------------------------
def _down(pins):
    a = [k for k, p in pins.items() if not p.value()]
    time.sleep_ms(4)
    return {k for k in a if not pins[k].value()}      # debounced: down on both reads


def _press(target, pins, phase):
    """Wait for one clean press of target: down and up with nothing else down at any moment.
    Other presses are reported and don't count."""
    held = _down(pins)
    if held:
        t = time.ticks_ms()
        while _down(pins):
            if time.ticks_diff(time.ticks_ms(), t) > 2000:
                out("stuck", sorted(held))
                _say("LET GO", " ".join(_NAME[k] for k in sorted(held)), _RED, _PAPER)
                while _down(pins):
                    time.sleep_ms(20)
                break
            time.sleep_ms(20)
        _prompt(target, phase)
    first, extra = None, set()
    while True:
        now = _down(pins)
        if now:
            if first is None:
                first = target if target in now else sorted(now)[0]
            extra |= now - {first}
            time.sleep_ms(2)
            continue
        if first is None:
            time.sleep_ms(3)
            continue
        if first == target and not extra:
            out("ok", {"phase": phase, "key": target})
            return
        if first == target:
            out("combo", {"phase": phase, "key": target, "with": sorted(extra)})
            _say("NOT CLEAN", _NAME[target] + " + " + " ".join(_NAME[k] for k in sorted(extra)), _RED, _PAPER)
        else:
            out("wrong", {"phase": phase, "want": target, "got": first})
            _say("THAT WAS " + _NAME[first], "PRESS " + _NAME[target], _RED, _PAPER)
        time.sleep_ms(900)
        _prompt(target, phase)
        first, extra = None, set()


_bg = (200, 200, 200)   # in the color pass: the last button's color, which stays up behind the next prompt


def _prompt(key, phase):
    n = _ORDER.index(key) + 1
    if phase == 1:
        _say(_NAME[key], "PRESS %d/9" % n)
    else:
        _say(_NAME[key], "COLOR %d/9" % n, _bg, _ink_on(_bg))
    out("prompt", {"phase": phase, "key": key})


def bench(chip_ok, chip_line):
    """Chip result, then every button alone in order, then every button again filling the screen with
    its own color, then the verdict. Runs until done; unplugging ends it."""
    pins = {k: Pin(p, Pin.IN, Pin.PULL_UP) for k, p in KEYS.items()}
    time.sleep_ms(5)
    _say("CHIP OK" if chip_ok else "NO CHIP", chip_line, _GREEN if chip_ok else _RED, _PAPER)
    time.sleep_ms(1500)
    for k in _ORDER:
        _prompt(k, 1)
        _press(k, pins, 1)
    global _bg
    _bg = (200, 200, 200)
    for k in _ORDER:
        _prompt(k, 2)
        _press(k, pins, 2)
        _bg = _COLOR[k]
    _lcd.fill(col(*_bg))
    time.sleep_ms(1200)
    out("benchDone", {})


def verdict(ok, line):
    _say("PASS" if ok else "FAIL", line or ("UNPLUG IT" if ok else ""), _GREEN if ok else _RED, _PAPER)
