# wedgie: who this board is, and the few things a host (wedgie.dev, an agent, mpremote) can ask of it.
# The slot (slot.py) answers these as JSON lines on USB while the app runs, so nothing gets
# interrupted; from the REPL they are plain calls:  import wedgie; wedgie.shot(); wedgie.press("A")
import sys, os, json, machine

VERSION = "0.3.23"

# The lock. main.py turns Ctrl-C off before anything else and never ends by itself, so a computer
# can only send the slot's JSON lines: it can't stop the app, reach the REPL, or make the secure chip
# sign. {"type": "open"} asks the person on the wedgie's own screen (slot.let_in; only a real press of
# A says yes). Yes turns Ctrl-C back on for ONE job: the next time main.py starts (the soft reset or
# exec(main.py) every host does when it's done) it's locked again. Nothing is kept across a restart
# on purpose: "until unplugged" (a watchdog scratch register, 0.2.5-0.2.6) stayed open on a real
# wedgie long after the job. SEALED stays False where main.py doesn't run (the emulator).
SEALED = False
_open = False

# The release key (tools/sign.mjs writes it here): a file list signed with it is ours. A checked install
# hashes every file it's sent against that list (release_ok), so the computer can't swap in others.
RELEASE_KEY = ("75467e0970a70909082a39594e9c29e8c6e42cf3663ab9ae31dbbb8babc522f3", "dc7b3ed1006e9273a185c4a6f754cd5c1fd15f0d0a8464f78a9c65ac938eb8d3")


def release_ok(text, sig, tick=None):
    """text: the signed list (tools/release.mjs), sig: "r s" in hex. True if our key signed it.
    Pure-Python P-256 (p256.py): 2.2 s on an RP2040, once per job; tick(0..1) moves a bar meanwhile."""
    import gc
    try:
        import p256, hashlib
        r, s = (int(x, 16) for x in sig.split())
        return p256.verify(int(RELEASE_KEY[0], 16), int(RELEASE_KEY[1], 16), hashlib.sha256(text).digest(), r, s, tick)
    except Exception:
        return False
    finally:
        sys.modules.pop("p256", None)       # once per job: give its code and its big numbers back
        gc.collect()


def release_files(text):
    """{name: sha256} from a signed list, and its version. "@app" lines are the apps (release_apps)."""
    lines = text.decode().split("\n") if isinstance(text, bytes) else text.split("\n")
    if lines[0] != "wedgie-release 1" or not lines[1].startswith("version "):
        raise ValueError("not a release list")
    files = {}
    for l in lines[2:]:
        if l and l[0] != "@":
            h, n = l.split("  ", 1)
            files[n] = h
    return lines[1][8:], files


def release_apps(text):
    """{mod: {mod, name, entry, usb, files}} from a signed list's "@app  <json>" lines (0.3.12+:
    a job's apps.json comes from these, never from the host). Firmware before 0.3.12 reads such a line
    as a file named by the JSON, which no job ever writes."""
    lines = text.decode().split("\n") if isinstance(text, bytes) else text.split("\n")
    out = {}
    for l in lines[2:]:
        if l.startswith("@app  "):
            a = json.loads(l[6:])
            out[a["mod"]] = a
    return out


def is_open():
    return _open


def set_open():
    """Let the computer in, until main.py starts again."""
    global _open
    _open = True
    try:
        import micropython
        micropython.kbd_intr(3)
    except Exception:
        pass


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
    """apps.json: the app wedgie.dev (or wedgie.py, or the site's editor) put on it, as a one-item list
    ({"mod", "name", "entry"?, "usb"?, "about"?, "v"}). The firmware ships none: a fresh wedgie says
    "no software yet" until one goes on. Firmware 0.1.x kept several; the first is the one that runs."""
    try:
        with open("apps.json") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def active():
    """The app it runs: the first in apps.json whose file is on the flash, or None."""
    for a in apps():
        try:
            os.stat(a["mod"] + ".py")
            return a
        except (OSError, KeyError, TypeError):
            try:
                os.stat(a["mod"] + ".mpy")
                return a
            except (OSError, KeyError, TypeError):
                pass
    return None


def free():
    """Bytes free on its flash (cartridges need room)."""
    try:
        s = os.statvfs("/")
        return s[0] * s[3]
    except Exception:
        return None


_chip = None        # what the last chip() found: "ATECC608", "OPTIGA Trust M", "none" (None: not asked yet)


def _ram():
    """Bytes of heap free after a collect (wedgie.dev shows it). Without the collect it counted garbage
    as used: a real board said 4 KB with ~60 KB really there."""
    import gc
    gc.collect()
    return gc.mem_free()


asked_ms = None     # how long the last question took to be on the screen, from its request arriving


def hello(mid=None, **extra):
    name, cpu, wifi = board()
    a = apps()
    d = {"type": "hello", "name": "wedgie", "fw": "wedgie-" + VERSION, "version": VERSION, "uid": uid(),
         "short": short(), "board": name, "cpu": cpu, "wifi": wifi, "machine": sys.implementation._machine,
         "micropython": os.uname().release, "apps": [x["mod"] for x in a],
         "carts": [{"mod": x["mod"], "v": x.get("v")} for x in a], "free": free(), "chip": _chip, "slot": 1,
         "sealed": SEALED, "open": is_open(), "jobs": 2, "ram": _ram()}
    if SEALED:              # a job takes raw puts of up to this many bytes (0.3.16+; job.py RAW). Not in the
        d["bin"] = 4096     # emulator: its job runs in place and its stdin is the page's
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


# ---- randomness from the secure chip -------------------------------------------------------------
# rand(n): bytes from the chip's hardware random generator, for games (a fair shuffle, dice) and anything
# that must not be guessable. The chip is found at the first call and kept open. Where they came from:
# rand_source(). No chip, or an ATECC608 whose config isn't locked yet (as shipped its Random answers a
# fixed pattern, ffff0000..., not randomness): os.urandom, the Pico's own generator, and it says so.
_rng = None         # ("atecc", ATECC608) | ("trustm", Session) | ("none", why)
_pool = b""         # rand_below's unused random bytes


def _find_rng():
    from machine import Pin
    for p in (4, 5):                # no pull-ups on SDA/SCL: nothing on the bus, don't wait on timeouts
        if not Pin(p, Pin.IN, Pin.PULL_DOWN).value():
            Pin(p, Pin.IN)
            return ("none", "no chip")
        Pin(p, Pin.IN)
    try:
        import atecc
        a = atecc.ATECC608(sda=4, scl=5)
        r1 = a.run(0x1B, 0x01, 0, resp_len=32, wait_ms=25)    # Random, mode 1: the EEPROM seed isn't rewritten
        r2 = a.run(0x1B, 0x01, 0, resp_len=32, wait_ms=25)
        if r1 == r2:
            return ("none", "ATECC608 not locked: its random is a fixed pattern")
        return ("atecc", a)
    except Exception:
        pass
    try:
        import trustm
        trustm.bus(4, 5)
        return ("trustm", trustm.Session())
    except Exception:
        return ("none", "no chip")


def rand(n=32):
    global _rng
    for _ in range(2):              # a chip that stopped answering (wedgie.chip() resets a Trust M): find it again
        if _rng is None:
            _rng = _find_rng()
        kind, h = _rng
        if kind == "none":
            break
        try:
            out = b""
            while len(out) < n:
                out += h.run(0x1B, 0x01, 0, resp_len=32, wait_ms=25) if kind == "atecc" else h.random(max(8, min(256, n - len(out))))   # small: n bytes, 32 at a time (callers ask for 32 or so)
            return out[:n]
        except Exception:
            _rng = None
    try:
        return os.urandom(n)
    except (AttributeError, OSError):            # a port without it (not the Pico): random is still random-ish
        import random
        return bytes(random.getrandbits(8) for _ in range(n))


def rand_source():
    """Where rand()'s bytes come from: "ATECC608", "OPTIGA Trust M", or "os.urandom (why)"."""
    if _rng is None:
        rand(1)
    return {"atecc": "ATECC608", "trustm": "OPTIGA Trust M"}.get(_rng[0]) or "os.urandom (%s)" % _rng[1]


def rand_below(n):
    """A fair whole number 0 <= x < n (n up to 2**24) from rand(), 32 bytes fetched at a time."""
    global _pool
    lim = (1 << 24) // n * n        # draws at or above this would favor small numbers: draw again
    while True:
        if len(_pool) < 3:
            _pool = rand(32)
        x = _pool[0] << 16 | _pool[1] << 8 | _pool[2]
        _pool = _pool[3:]
        if x < lim:
            return x % n


def send(obj):
    s = json.dumps(obj)
    print(s)
    ib = sys.modules.get("inbox")
    if ib and ib.fed:                   # a request came in as a file on the WEDGIE drive: answer there too
        ib.answer(s)


# ---- USB lines: the ONE way firmware reads what a host sends -------------------------------------
# A line is collected into one bytearray made once, while the heap is still in one piece. Never a
# string grown a char at a time: each += copies the whole line, so a 1.4 KB line makes a thousand
# copies and chops the RP2040's ~75 KB of heap into pieces too small for the next one. slot.py had
# that (0.3.6 died of it, 0.3.9 fixed it); job.py still had it and 0.3.11 broke on a real board in
# the middle of installing Battery ("memory allocation failed, allocating 1336 bytes"). Every reader
# (slot, job, the Wallet) goes through lines(); tools/test_memory.py fails the build on any other
# sys.stdin.read, and on any string grown with += that doesn't say why it stays small.
class Lines:
    def __init__(self, size):
        self.b = bytearray(size)
        self.n = 0
        self.over = False
        self.intr = False       # a Ctrl-C came in (sealed: just a byte); the slot asks about it (hatch.ctrl_c)

    def feed(self, ch):
        """One char from USB (or one byte, an int: a file dropped on the WEDGIE drive, inbox.py). At a
        newline: the line as bytes (one copy, its own size), or False for one that didn't fit (dropped
        whole). Otherwise None."""
        bs = None
        if isinstance(ch, int):
            bs, ch = (ch,), chr(ch) if ch < 128 else ""
        if ch == "\n":
            n, over = self.n, self.over
            self.n, self.over = 0, False
            if over:
                return False
            return bytes(memoryview(self.b)[:n])
        if ch == "\x03":                    # a Ctrl-C while sealed is just a byte: start a clean line
            self.n, self.over, self.intr = 0, False, True
            return None
        if ch == "\r" or self.over:
            return None
        if bs is None:
            o = ord(ch)
            bs = (o,) if o < 128 else ch.encode()
        if self.n + len(bs) > len(self.b):
            self.over = True
            return None
        for c in bs:
            self.b[self.n] = c
            self.n += 1
        return None

    def raw(self, mv):
        """Exactly len(mv) raw bytes, right after the line just read (a raw put, job.py), in one C loop
        (stdin.buffer.readinto): 4 KB in ~37 ms on an RP2040, where the same as a base64 line read a char
        at a time took ~4 s. Ctrl-C is off while sealed, so any byte value comes through."""
        got, n = 0, len(mv)
        while got < n:
            got += sys.stdin.buffer.readinto(mv[got:min(n, got + 512)]) or 0

    def pump(self, poll, wait=0):
        """Read USB until a line is done (bytes, or False: too long) or nothing more is waiting (None).
        wait: ms to wait for the first char."""
        r = _dropped(self)
        if r is not None:
            return r
        while poll.poll(wait):
            wait = 0
            ch = sys.stdin.read(1)
            if not ch:
                return None
            r = self.feed(ch)
            if r is not None:
                return r
        return None


_lines = None


def _dropped(R):
    """A line from a file dropped on the WEDGIE drive (inbox.py, imported only once the host wrote)."""
    dr = getattr(sys.modules.get("wedgiedrive"), "drive", None)
    if dr is None or not (dr.wrote or "inbox" in sys.modules):
        return None
    import inbox
    return inbox.pump(dr, R)


# ---- install mode -----------------------------------------------------------------------------
# A yes to a checked install (slot._job) saves the job here and restarts; main.py finds it and runs
# job.resume() before anything else loads: no app, no slot, the same clean heap for every install.
# The app that was running chopped the heap into pieces nobody can predict (0.3.12 tests: Battery
# went in, then the Wallet died reading the 2.6 KB signed list). The file is deleted before the job
# runs, so a job that crashes can't loop.
JOB = "_job.json"


def save_job(d):
    with open(JOB, "w") as f:
        json.dump(d, f)


def doing(job):
    """A job's title on its progress screen: "Install Buttons" -> "Installing Buttons...", "Update firmware
    to 0.3.14" -> "Updating firmware..." (the site's install.ts doing, the same words)."""
    t = str(job or "Update")[:60].split(" to ")[0]
    return t.replace("Uninstall", "Uninstalling").replace("Install", "Installing").replace("Update", "Updating") + "..."


def take_job():
    try:
        with open(JOB) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = None
    try:
        os.remove(JOB)
    except OSError:
        pass
    return d


def failed(mid, e):
    """A host request broke: tell the host, keep the reason in error.log, free what it left behind."""
    import gc
    sys.print_exception(e)
    try:
        with open("error.log", "w") as f:
            sys.print_exception(e, f)
    except Exception:
        pass
    gc.collect()
    send({"id": mid, "type": "error", "error": "%s: %s" % (type(e).__name__, e)})


def lines(size=6144):
    """The shared line reader (made the first time; a bigger size makes a bigger one)."""
    global _lines
    if _lines is None or len(_lines.b) < size:
        _lines = None
        import gc
        gc.collect()
        _lines = Lines(size)
    return _lines


def sums(names, exists=()):
    """sha256 of each of names; for exists, only whether it's there (1 or None): hashing every file
    on the flash took seconds before each question. Here, not in job.py: answering it used to import
    job.py, and compiling that (17 KB) on an app's heap ran out of memory ("allocating 1336 bytes",
    chipprobe, 0.3.13 with Clear sign running)."""
    import hashlib, binascii
    out = {}
    for n in exists or ():
        try:
            os.stat(n)
            out[n] = 1
        except OSError:
            out[n] = None
    buf = bytearray(512)
    for n in names or []:
        try:
            h = hashlib.sha256()
            with open(n, "rb") as f:
                while True:
                    k = f.readinto(buf)
                    if not k:
                        break
                    h.update(memoryview(buf)[:k])
            out[n] = binascii.hexlify(h.digest()).decode()
        except OSError:
            out[n] = None
    return out


def shot(mid=None):
    """The screen as it is now (the framebuffer every lcd.LCD() draws into), as JSON lines:
    {"type":"shot","i":0,"n":N,"w":240,"h":240,"fmt":"rgb565be","data":"<base64>"} ... one per chunk."""
    import lcd, binascii
    n = 60                              # 4 rows a chunk, as show() sends them (16 colors + the logo)
    f = lcd.art_file(0, 240)
    for i in range(n):
        lcd.rows565(0, i * 4, 240, 4, f)
        d = {"type": "shot", "i": i, "n": n, "w": 240, "h": 240, "fmt": "rgb565be",
             "data": binascii.b2a_base64(lcd._ROWS).decode().strip()}
        if mid is not None:
            d["id"] = mid
        print(json.dumps(d))
    if f:
        f.close()


def ls(path="/"):
    """Every file under path, [[path, bytes], ...]; a folder is [path + "/", 0], then its files."""
    out = []
    base = path.rstrip("/")
    try:
        names = sorted(os.listdir(path))
    except OSError:
        return out
    for n in names:
        p = base + "/" + n
        try:
            st = os.stat(p)
        except OSError:
            continue
        if st[0] & 0x4000:
            out.append([p + "/", 0])
            out += ls(p)
        else:
            out.append([p, st[6]])
    return out


def get(path, mid=None):
    """A file as JSON lines, like shot(): {"type":"file","i":0,"n":N,"size":S,"data":"<base64>"}."""
    import binascii
    size = os.stat(path)[6]
    step = 3072
    n = max(1, (size + step - 1) // step)
    with open(path, "rb") as f:
        for i in range(n):
            d = {"type": "file", "i": i, "n": n, "size": size, "data": binascii.b2a_base64(f.read(step)).decode().strip()}
            if mid is not None:
                d["id"] = mid
            print(json.dumps(d))


def rm(path):
    """Delete a file, or a folder and everything in it."""
    try:
        names = os.listdir(path)
    except OSError:
        os.remove(path)
        return
    for n in names:
        rm(path.rstrip("/") + "/" + n)
    os.rmdir(path)


def press(k, ms=80):
    import lcd
    lcd.press(k, ms)
