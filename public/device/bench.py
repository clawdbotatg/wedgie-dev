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
# Drawn with one reused 11 KB stripe buffer and a line at a time, never a whole-screen allocation:
# with the firmware loaded an RP2040 has ~25 KB free, and a draw that has to hunt for memory stalls
# long enough to miss a quick button tap.
_row = None


def _fill(c):
    global _row
    if _row is None:
        _row = bytearray(240 * 24 * 2)
    framebuf.FrameBuffer(_row, 240, 24, framebuf.RGB565).fill(c)
    for y in range(0, 240, 24):
        _lcd.blit(0, y, 240, 24, _row)


def _text(s, scale, y, f, b):
    w = 8 * len(s)
    mono = bytearray((w + 7) // 8 * 8)
    m = framebuf.FrameBuffer(mono, w, 8, framebuf.MONO_HLSB)
    m.text(s, 0, 0, 1)
    fg, bg = bytes((f & 0xFF, f >> 8)) * scale, bytes((b & 0xFF, b >> 8)) * scale
    x0 = (240 - w * scale) // 2
    for r in range(8):
        line = b"".join(fg if m.pixel(x, r) else bg for x in range(w))
        _lcd.blit(x0, y + r * scale, w * scale, scale, line * scale)


def _say(big, small="", bg=_PAPER, fg=_INK):
    global _lcd
    if _lcd is None:
        _lcd = _LCD()
    b, f = col(*bg), col(*fg)
    _fill(b)
    _text(big, 5 if len(big) <= 5 else 3 if len(big) <= 9 else 2, 84, f, b)
    if small:
        small = small[:28]
        _text(small, 2 if len(small) <= 14 else 1, 160, f, b)


def _ink_on(c):
    return _INK if sum(c) > 380 else _PAPER


# --- the buttons -----------------------------------------------------------
# Every edge on every button pin is caught by an interrupt, so a tap made while the screen is still
# drawing counts. A press is everything touched between all-released and all-released again (40 ms
# calm): exactly the target = counts; the target with anything else = not clean; else the wrong key.
_edges = []


def _arm(pins):
    for k, p in pins.items():
        p.irq(lambda _p, k=k: _edges.append(k), Pin.IRQ_FALLING | Pin.IRQ_RISING)


def _down(pins):
    return {k for k, p in pins.items() if not p.value()}


def _released(pins, target, phase):
    """Until nothing is down for 30 ms. Held 2 s: say which, and wait for it."""
    t, calm, warned = time.ticks_ms(), None, False
    while True:
        now = _down(pins)
        if now:
            calm = None
            if not warned and time.ticks_diff(time.ticks_ms(), t) > 2000:
                warned = True
                out("stuck", sorted(now))
                _say("LET GO", " ".join(_NAME[k] for k in sorted(now)), _RED, _PAPER)
        elif calm is None:
            calm = time.ticks_ms()
        elif time.ticks_diff(time.ticks_ms(), calm) >= 30:
            break
        time.sleep_ms(3)
    if warned:
        _prompt(target, phase)


def _press(target, pins, phase):
    _released(pins, target, phase)
    while True:
        del _edges[:]
        seen, calm = set(), None
        while True:
            now = _down(pins)
            while _edges:
                seen.add(_edges.pop())
            seen |= now
            if seen and not now:
                if calm is None:
                    calm = time.ticks_ms()
                elif time.ticks_diff(time.ticks_ms(), calm) >= 40:
                    break
            else:
                calm = None
            time.sleep_ms(2)
        if seen == {target}:
            out("ok", {"phase": phase, "key": target})
            return
        others = sorted(seen - {target})
        if target in seen:
            out("combo", {"phase": phase, "key": target, "with": others})
            _say("NOT CLEAN", _NAME[target] + " + " + " ".join(_NAME[k] for k in others), _RED, _PAPER)
        else:
            out("wrong", {"phase": phase, "want": target, "got": others[0]})
            _say("THAT WAS " + _NAME[others[0]], "PRESS " + _NAME[target], _RED, _PAPER)
        time.sleep_ms(900)
        _prompt(target, phase)
        _released(pins, target, phase)


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
    _arm(pins)
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
    _fill(col(*_bg))
    time.sleep_ms(1200)
    for p in pins.values():
        p.irq(None)
    out("benchDone", {})


def verdict(ok, line):
    _say("PASS" if ok else "FAIL", line or ("UNPLUG IT" if ok else ""), _GREEN if ok else _RED, _PAPER)


# --- use the chip, lock nothing ---------------------------------------------
def chipwork(kind):
    """ATECC608: SHA-256 of random bytes on the chip (the page checks the digest) and two Random
    reads (a chip whose config isn't locked yet answers a fixed pattern: that's normal, and we don't
    lock it). Trust M: its random, its Infineon certificate, and a signature with its factory key
    over random bytes, all checked on the page. Needs the wedgie firmware's atecc.py / trustm.py."""
    import hashlib, binascii
    hx = lambda b: binascii.hexlify(b).decode()
    msg = os.urandom(100)
    d = {"kind": kind, "msg": hx(msg)}
    try:
        if kind == "atecc":
            import atecc
            a = atecc.ATECC608(sda=4, scl=5)
            a.wake()
            try:
                a.command(0x47, 0x00, 0, resp_len=1, wait_ms=10)                     # SHA start
                a.command(0x47, 0x01, 64, msg[:64], resp_len=1, wait_ms=10)          # 64 bytes
                sha = a.command(0x47, 0x02, 36, msg[64:], resp_len=32, wait_ms=10)   # last 36, digest
                r1 = a.command(0x1B, 0x01, 0, resp_len=32, wait_ms=25)               # Random, seed untouched
                r2 = a.command(0x1B, 0x01, 0, resp_len=32, wait_ms=25)
            finally:
                a.sleep()
            d.update(sha=hx(sha), random=[hx(r1), hx(r2)])
        else:
            import trustm
            trustm.bus(4, 5)
            s = trustm.Session()
            d["random"] = [hx(s.random(32)), hx(s.random(32))]
            d["cert"] = hx(s.get_all(0xE0E0))
            r, sg = s.sign(0xE0F0, hashlib.sha256(msg).digest())
            d.update(r="%064x" % r, s="%064x" % sg)
    except Exception as e:
        d["error"] = str(e) or type(e).__name__
    out("chipwork", d)
