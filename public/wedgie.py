#!/usr/bin/env python3
"""wedgie: talk to a wedgie on USB from a terminal (or from your coding agent). MIT, wedgie.dev

  pip install pyserial            (mpremote users already have it)
  curl -O https://wedgie.dev/wedgie.py

  python3 wedgie.py list                      every wedgie on USB, with its ID
  python3 wedgie.py hello                     what it is and runs (JSON)
  python3 wedgie.py shot [out.png]            the real screen, as a PNG you can look at
  python3 wedgie.py press A [ms]              press a button: A B X Y up down left right press
  python3 wedgie.py apps                      the apps on wedgie.dev, and which one it runs
  python3 wedgie.py use usbwallet             make that the app it runs (the old one comes off, saves stay); it restarts into it
  python3 wedgie.py uninstall                 uninstall its app ("no software")
  python3 wedgie.py run app.py                run a file once (output streams; Ctrl-C stops), then back to its app
  python3 wedgie.py install .                 make the app in this folder's wedgie.json the app it runs (wedgie.dev/code.md)
                                              (several apps in it: install . snake)
  python3 wedgie.py install app.py [--name N] make one file the app it runs
  python3 wedgie.py update                    install/update the wedgie firmware (only changed files; its app and saves stay)
  python3 wedgie.py ls                        files on it, saves included
  python3 wedgie.py saves [backup f.json | restore f.json]    its saves (/saves/<game>/), out to a file and back
  python3 wedgie.py unlock                    full control (mpremote, Ctrl-C, its chip) until it restarts; asks on its screen, in red
  python3 wedgie.py debug                     a report (firmware, files, free space and RAM, error.log); asks on its screen

  --port /dev/cu.usbmodemXXXX  (or --id A1B2C3) picks one when several are plugged in.

A wedgie (firmware 0.2+) runs one app: it boots straight into it and the app gets every button.
hello/shot/press talk to the firmware over JSON lines while the app runs and never interrupt it.
The rest stop it (Ctrl-C), use MicroPython's raw REPL, then start the app again by running main.py.
Firmware 0.2.5+ is sealed: the first of those asks on the wedgie's screen and waits for you to press A
there. A yes is for that one command: the next one asks again.
update, use, install and run soft-reset it (a fresh heap for new firmware or a new app).
Only one program can hold the port: close the wedgie's page on wedgie.dev (and mpremote) first.

Plugging in: the wedgie adds its WEDGIE USB drive about a second after power-up, which disconnects and
reconnects USB, so a wedgie you just plugged in shows up, vanishes and shows up again (a new port,
same ID). Wait a couple of seconds after plugging in; pick it by --id, not by port, in scripts. A soft
reset doesn't re-add the drive on 0.1.3+, but the first one after updating from older firmware does.
"""
import sys, os, time, json, base64, hashlib, zlib, struct, argparse, urllib.request

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("wedgie.py needs pyserial:  pip install pyserial")

VID = 0x2E8A
SITE = os.environ.get("WEDGIE_SITE", "https://wedgie.dev")
KEYS = ["A", "B", "X", "Y", "up", "down", "left", "right", "press"]


# ---- the port ----------------------------------------------------------------------------------
def ports():
    return [p for p in list_ports.comports() if p.vid == VID]


class Wedgie:
    def __init__(self, dev):
        self.dev = dev
        self.s = serial.Serial(dev, 115200, timeout=0.05)
        self.buf = b""
        self.id = 1
        self.sn = next((p.serial_number for p in ports() if p.device == dev), None)   # its board ID

    def close(self):
        self.s.close()

    def reopen(self, timeout=20):
        """Open it again after its port dropped (a restart: the first one since it was plugged in takes
        the WEDGIE drive away). Found by its board ID: the port's name can change. True once open."""
        try:
            self.s.close()
        except Exception:
            pass
        end = time.time() + timeout
        while time.time() < end:
            time.sleep(0.5)
            for p in ports():
                if (p.serial_number == self.sn) if self.sn else (p.device == self.dev):
                    try:
                        self.s = serial.Serial(p.device, 115200, timeout=0.05)
                    except (serial.SerialException, OSError):
                        continue
                    self.dev, self.buf = p.device, b""
                    return True
        return False

    def _lines(self, until, timeout):
        """Yield lines as they arrive until until(line) is True or timeout."""
        end = time.time() + timeout
        while time.time() < end:
            chunk = self.s.read(4096)
            if chunk:
                self.buf += chunk
                while b"\n" in self.buf:
                    line, self.buf = self.buf.split(b"\n", 1)
                    line = line.decode("utf8", "replace").rstrip("\r")
                    yield line
                    if until(line):
                        return
        raise TimeoutError("the wedgie did not answer")

    # JSON lines to the launcher --------------------------------------------------------------
    def request(self, msg, timeout=5.0):
        mid = self.id
        self.id += 1
        msg = dict(msg, id=mid)
        self.s.reset_input_buffer()
        self.buf = b""
        self.s.write((json.dumps(msg) + "\n").encode())
        parts, n = {}, None
        for line in self._lines(lambda l: False, timeout):
            if not line.startswith("{"):
                continue
            try:
                v = json.loads(line)
            except ValueError:
                continue
            if v.get("id") != mid:
                continue
            if v.get("type") == "shot":
                parts[v["i"]] = v["data"]
                n = v["n"]
                if len(parts) == n:
                    v["data"] = "".join(parts[i] for i in range(n))
                    return v
                continue
            return v

    def hello(self, timeout=1.0):
        try:
            return self.request({"type": "hello"}, timeout)
        except TimeoutError:
            return None

    # MicroPython raw REPL ----------------------------------------------------------------------
    def _read_until(self, marker, timeout):
        end = time.time() + timeout
        data, self.buf = self.buf, b""      # bytes left over from the last read come first
        while True:
            i = data.find(marker)
            if i >= 0:
                self.buf = data[i + len(marker):]
                return data[:i]
            if time.time() > end:
                raise TimeoutError("waiting for %r" % marker)
            data += self.s.read(4096)

    def let_in(self, job=""):
        """0.2.5+ is sealed: Ctrl-C does nothing until its person presses A on the wedgie's own screen
        ({"type": "open"}; Y or a minute with no answer is a no). A yes lasts until its app starts again."""
        h = self.hello(1.0)
        if not h or not h.get("sealed") or h.get("open"):
            return
        sys.stderr.write("press A on the wedgie to let this computer in\n")
        try:
            v = self.request({"type": "open", "for": job}, 65)
        except TimeoutError:
            sys.exit("nobody pressed A on the wedgie")
        if v.get("type") != "open":
            sys.exit("the wedgie said no (Y on its screen)" if v.get("type") == "refused" else "the wedgie said %s" % v)

    def enter(self):
        """Stop what it runs (Ctrl-C) and go to the raw REPL. No soft reset: wedgie firmware 0.1.1+ re-adds
        its USB drive at boot, which re-enumerates USB and would drop this port mid-command."""
        self.let_in()
        self.s.write(b"\r\x03\x03")
        time.sleep(0.15)
        self.s.reset_input_buffer()
        self.buf = b""
        self.s.write(b"\x01")
        self._read_until(b"raw REPL; CTRL-B to exit\r\n>", 4)

    def exec(self, code, timeout=30, echo=False):
        data = code.encode()
        for i in range(0, len(data), 256):
            self.s.write(data[i:i + 256])
            time.sleep(0.005)
        self.s.write(b"\x04")
        self._read_until(b"OK", 5)
        if echo:
            data, self.buf = self.buf, b""      # output that came in with the OK
            end = time.time() + timeout
            while b"\x04" not in data:
                if data:
                    sys.stdout.write(data.decode("utf8", "replace")); sys.stdout.flush()
                if time.time() > end:
                    raise TimeoutError("still running")
                data = self.s.read(256)
            head, rest = data.split(b"\x04", 1)
            sys.stdout.write(head.decode("utf8", "replace")); sys.stdout.flush()
            self.buf = rest
            err = self._read_until(b"\x04", 5)
        else:
            out = self._read_until(b"\x04", timeout)
            err = self._read_until(b"\x04", 5)
            return_out = out.decode("utf8", "replace")
        if err.strip():
            raise RuntimeError(err.decode("utf8", "replace").strip().splitlines()[-1])
        return None if echo else return_out

    def leave(self, reset=True):
        """Out of raw mode and back to its app. reset=True soft-resets (after writing firmware or a new app;
        the port stays on 0.1.3+, but the first soft reset after updating from older firmware drops it);
        False just runs main.py again, port stays up."""
        self.s.write(b"\x02")
        time.sleep(0.05)
        self.s.write(b"\x04" if reset else b'exec(open("main.py").read())\r')

    def put(self, name, data):
        tmp = "_wedgie.tmp"
        self.exec("import binascii, os, hashlib\n_f = open(%r, 'wb')" % tmp)
        for i in range(0, len(data), 1024):          # small writes: little RAM in one piece (RP2040)
            self.exec("_f.write(binascii.a2b_base64(%r))" % base64.b64encode(data[i:i + 1024]).decode())
        self.exec("_f.close()")
        got = self.exec("h = hashlib.sha256()\nwith open(%r, 'rb') as f:\n    while True:\n        b = f.read(1024)\n        if not b: break\n        h.update(b)\nprint(binascii.hexlify(h.digest()).decode())" % tmp).strip()
        if got != hashlib.sha256(data).hexdigest():
            raise RuntimeError("%s did not copy cleanly" % name)
        self.exec("try:\n    os.remove(%r)\nexcept OSError:\n    pass\nos.rename(%r, %r)" % (name, tmp, name))

    def sync(self):
        self.exec("import os\ntry:\n    os.sync()\nexcept AttributeError:\n    pass")


# ---- picking one ---------------------------------------------------------------------------
def pick(args):
    if args.port:
        return Wedgie(args.port)
    ps = ports()
    if not ps:
        sys.exit("no wedgie on USB (Raspberry Pi vendor 0x2e8a). Plugged in? Data cable, not charge-only?")
    if args.id:
        for p in ps:
            if (p.serial_number or "").lower().endswith(args.id.lower()):
                return Wedgie(p.device)
        sys.exit("no wedgie with ID %s; try: wedgie.py list" % args.id)
    if len(ps) > 1:
        sys.exit("%d wedgies plugged in; pick one with --port or --id:\n%s" % (len(ps), "\n".join("  %s  %s" % (p.device, (p.serial_number or "")[-6:].upper()) for p in ps)))
    return Wedgie(ps[0].device)


def png(path, rgb565be, w=240, h=240):
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        for x in range(w):
            i = (y * w + x) * 2
            v = (rgb565be[i] << 8) | rgb565be[i + 1]
            rows += bytes((((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


# ---- firmware core and its app (the same model as wedgie.dev: src/serial/install.ts) -----------------
# /fw/manifest.json: files (name, size, sha256), core (the firmware's own files), carts (each app's files
# and v). apps.json on the wedgie names the one app it runs; it's rebuilt from what's really on the
# flash after every change: that cart if its files are all there, with v from their real hashes, or the
# person's own app as it was. Another app going on takes the old one's files off; /saves is never touched.
RETIRED = ["menu.py", "menu.mpy"]       # core files a newer core dropped (0.2.0: the menu)
FLOOR = 32 * 1024                       # what the firmware keeps free (save.py FLOOR)
HASH_PY = """import os, json, hashlib, binascii
def _h(n):
    try:
        h = hashlib.sha256()
        with open(n, 'rb') as f:
            while True:
                b = f.read(1024)
                if not b: break
                h.update(b)
        return binascii.hexlify(h.digest()).decode()
    except OSError:
        return None
try:
    _a = json.load(open('apps.json'))
except Exception:
    _a = []
_n = %s
for _x in _a:
    _n += [f for f in _x.get('files', []) if isinstance(f, str)]
print(json.dumps({'hashes': {n: _h(n) for n in _n}, 'files': os.listdir(), 'apps': _a}))"""


def manifest():
    return json.load(urllib.request.urlopen(SITE + "/fw/manifest.json"))


def cart_v(hashes):
    return hashlib.sha256("\n".join(h or "None" for h in hashes).encode()).hexdigest()[:12]


def twin(n):
    """A compiled app file's source name (usbwallet.mpy -> usbwallet.py), or None. MicroPython imports
    the .py first, so one left beside a new .mpy runs instead of it: looks ask about it, others() takes it
    off (install.ts twin, the same rule)."""
    return n[:-4] + ".py" if n.endswith(".mpy") else None


def with_twins(names):
    names = set(names)
    return names | {twin(n) for n in names if twin(n)}


def look(wg, m):
    names = sorted(with_twins(set(m["core"]) | {n for c in m["carts"] for n in c["files"]}))
    return json.loads(wg.exec(HASH_PY % json.dumps(names), 60))


def copy(wg, m, names, have):
    todo = sorted([f for f in m["files"] if f["name"] in names and have["hashes"].get(f["name"]) != f["sha256"]], key=lambda f: f["name"] == "main.py")
    for i, f in enumerate(todo):
        print("[%d/%d] %s" % (i + 1, len(todo), f["name"]))
        data = urllib.request.urlopen(SITE + "/fw/" + f["name"]).read()
        if hashlib.sha256(data).hexdigest() != f["sha256"]:      # what the manifest says, or nothing goes on
            sys.exit("%s isn't what wedgie.dev's manifest says (a deploy since? run it again)" % f["name"])
        wg.put(f["name"], data)
        have["hashes"][f["name"]] = f["sha256"]
    # every .mpy that's on now (just sent, or already there from a try that stopped halfway): its old
    # source comes off, or it would run instead
    remove_files(wg, have, [twin(f["name"]) for f in m["files"] if f["name"] in names and twin(f["name"])
                            and have["hashes"].get(f["name"]) == f["sha256"] and have["hashes"].get(twin(f["name"]))])
    return todo


def write_apps(wg, m, have, only):
    out = []
    c = next((x for x in m["carts"] if x["mod"] == only), None)
    if c and all(have["hashes"].get(n) for n in c["files"]):
        a = {"mod": c["mod"], "name": c["name"], "about": c.get("about", ""), "v": cart_v([have["hashes"][n] for n in c["files"]])}
        if c.get("entry"):
            a["entry"] = c["entry"]
        if c.get("usb"):
            a["usb"] = True
        out.append(a)
    elif not c and only:
        out += [a for a in have.get("apps", []) if a.get("mod") == only][:1]
    wg.exec("import json\n_f = open('apps.json', 'w')\n_f.write(%r)\n_f.close()" % json.dumps(out))
    wg.sync()
    return out


def active_of(m, have):
    """The app it runs now: the first in apps.json whose files are there (0.1.x kept several)."""
    for a in have.get("apps", []):
        c = next((x for x in m["carts"] if x["mod"] == a.get("mod")), None)
        if (all(have["hashes"].get(n) or have["hashes"].get(twin(n)) for n in c["files"]) if c else (a.get("mod", "") + ".py") in have["files"]):
            return a["mod"]
    return None


def others(m, have, keep):
    """Every app file on it (a cart's, or one apps.json lists for a repo/folder app) that neither the core nor `keep` needs."""
    listed = [a for a in have.get("apps", []) if isinstance(a.get("files"), list)]
    keep_files = next((x["files"] for x in m["carts"] if x["mod"] == keep), None) or next((a["files"] for a in listed if a.get("mod") == keep), [])
    need = with_twins(set(m["core"]) | set(keep_files))     # a kept app's old .py goes only once its .mpy is on (copy, job)
    every = with_twins({n for x in m["carts"] for n in x["files"]} | {n for a in listed for n in a["files"]})
    return sorted(every - need - {n for n, h in have["hashes"].items() if not h})


def folder_app(path, pick, m):
    """The app in a folder's wedgie.json (the rules: wedgie.dev/code.md): (entry for apps.json, {name: bytes})."""
    try:
        j = json.load(open(os.path.join(path, "wedgie.json")))
    except (OSError, ValueError) as e:
        sys.exit("can't read %s/wedgie.json: %s" % (path, e))
    apps = j.get("apps") or []
    a = next((x for x in apps if x.get("mod") == pick), None) if pick else (apps[0] if len(apps) == 1 else None)
    if not a:
        sys.exit("which app? wedgie.py install %s <mod>   (%s)" % (path, ", ".join(str(x.get("mod")) for x in apps)))
    mod, core = a.get("mod", ""), set(m["core"])
    files = {}
    for p in a.get("files", []):
        n = os.path.basename(p)
        stem = n.rsplit(".", 1)[0]
        if n in core or stem.rsplit(".", 1)[0] in {c.rsplit(".", 1)[0] for c in core} or not (stem == mod or stem.startswith(mod + "_")):
            sys.exit("%s: every file is named %s.py or %s_something (it lands in the flash's root), and no firmware file" % (n, mod, mod))
        files[n] = open(os.path.join(path, p), "rb").read()
    if mod + ".py" not in files and mod + ".mpy" not in files:
        sys.exit("wedgie.json: %s needs %s.py in its files" % (mod, mod))
    entry = {"mod": mod, "name": str(a.get("name") or mod)[:14], "about": a.get("about", ""), "repo": "local", "files": sorted(files),
             "v": cart_v([hashlib.sha256(files[n]).hexdigest() for n in sorted(files)])}
    for k in ("entry", "usb"):
        if a.get(k):
            entry[k] = a[k]
    return entry, files


def remove_files(wg, have, names):
    for n in names:
        wg.exec("import os, sys\ntry:\n    os.remove(%r)\nexcept OSError:\n    pass\nsys.modules.pop(%r, None)" % (n, n.rsplit(".", 1)[0]))
        have["hashes"][n] = None


FREE_PY = """def _free():
    import gc, sys
    for n in list(sys.modules):
        if n not in ("lcd", "splash", "micropython") and n[0] != "_":   # _: the host's own (the emulator's _emu)
            del sys.modules[n]
    l = sys.modules.get("lcd")
    if l:
        del l._keys[:]          # every Keys() the app and the slot made
        l._on_show = None       # the loader's hook
    g = globals()
    for n in list(g):
        if not n.startswith("__"):
            del g[n]
    gc.collect()
_free()"""


def checked(wg, m):
    """A wedgie that installs signed files itself (0.3.0+, hello says jobs): no REPL needed. Returns
    `have` like look() does (hashes, apps), or None for older firmware or an unsigned manifest."""
    h = wg.hello(1.5) or {}
    if not h.get("jobs") or not m.get("signed"):
        return None
    # before 0.3.12 a job could run out of memory on a real board (it ran on the app's heap, and read each
    # USB line a char at a time): those take full access once, then install on a clean heap (install.ts)
    if tuple(int(x) for x in (h.get("version") or "0").split(".")[:3] if x.isdigit()) < (0, 3, 12):
        return None
    names = sorted(with_twins(set(m["core"]) | {n for c in m["carts"] for n in c["files"]}))
    v = wg.request({"type": "sums", "names": names}, 30)
    return {"hashes": v["sums"], "apps": v.get("apps") or [], "files": [n for n, s in v["sums"].items() if s]}


def job(wg, title, write, delete, apps):
    """Checked install (firmware/job.py): the wedgie checks the signed list, asks its person, takes the
    files one chunk at a time, checks each against the list, then puts them in place and restarts."""
    rel = urllib.request.urlopen(SITE + "/fw/release.txt").read().decode()
    sig = urllib.request.urlopen(SITE + "/fw/release.sig").read().decode().strip()
    delete = sorted(set(delete) | {twin(n) for n in write if twin(n)})     # a written .mpy's old source
    sys.stderr.write("press A on the wedgie: %s?\n" % title)
    try:
        v = wg.request({"type": "job", "job": title, "release": rel, "sig": sig, "write": write, "delete": delete,
                        "apps": None if apps is None else json.dumps(apps)}, 120)
    except (serial.SerialException, OSError):
        # 0.3.12+: a yes restarts it into install mode, and the first restart since it was plugged in drops
        # the port. Find it again; in install mode its hello says job (the go went out on the old port).
        if not wg.reopen():
            sys.exit("the wedgie restarted and didn't come back: unplug it and plug it in again")
        h = None
        for _ in range(10):
            h = wg.hello(1.0)
            if h:
                break
        if not (h and h.get("job")):
            sys.exit("the wedgie restarted without the install (did someone press Y?)")
        v = {"type": "go"}
    if v.get("type") == "refused":
        sys.exit("the wedgie said no (Y on its screen)")
    if v.get("type") != "go":
        sys.exit("the wedgie said: %s" % (v.get("error") or v))
    for i, n in enumerate(write):
        data = urllib.request.urlopen(SITE + "/fw/" + n).read()
        print("[%d/%d] %s" % (i + 1, len(write), n))
        for o in range(0, max(len(data), 1), 1024):
            r = wg.request({"type": "put", "name": n, "data": base64.b64encode(data[o:o + 1024]).decode(), "end": o + 1024 >= len(data)}, 15)
            if r.get("type") != "ok":
                sys.exit("the wedgie stopped: %s" % (r.get("error") or r))
    r = wg.request({"type": "commit"}, 30)
    if r.get("type") != "done":
        sys.exit("the wedgie stopped: %s" % (r.get("error") or r))


def cart_entry(cart):
    a = {"mod": cart["mod"], "name": cart["name"], "about": cart.get("about", ""), "v": cart["v"]}
    for k in ("entry", "usb"):
        if cart.get(k):
            a[k] = cart[k]
    return a


def take_over(wg, job=""):
    """Stop its app and take the raw REPL, with its RAM freed: Ctrl-C leaves the app loaded, and on an
    RP2040 a copy then fails with MemoryError. lcd stays (its 115 KB framebuffer)."""
    wg.let_in(job)                              # sealed: its person says yes first (job: what its screen asks)
    try:
        wg.request({"type": "stop"}, 1)        # stop its app first (0.1.x: "home"; its Timer would keep drawing)
    except TimeoutError:
        pass
    wg.enter()
    try:
        wg.exec(FREE_PY)
    except RuntimeError:
        pass


# ---- commands ------------------------------------------------------------------------------
def need_firmware(wg):
    h = wg.hello()
    if not h or not str(h.get("fw", "")).startswith("wedgie-"):
        sys.exit("that board isn't answering as wedgie firmware (not installed, or its app has USB to itself, like the Wallet).\nInstall or update:  wedgie.py update")
    return h


def cmd_list(args):
    ps = ports()
    if not ps:
        print("no wedgies on USB")
    for p in ps:
        line = "%s  %s" % (p.device, (p.serial_number or "")[-6:].upper() or "??????")
        try:
            wg = Wedgie(p.device)
            h = wg.hello()
            wg.close()
            line += "  " + ("%s %s on %s" % (h.get("name"), h.get("version") or h.get("fw"), h.get("board")) if h else "MicroPython, no wedgie firmware (wedgie.py update)")
        except serial.SerialException as e:
            line += "  busy (%s)" % e
        print(line)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd")
    ap.add_argument("rest", nargs="*")
    ap.add_argument("--port")
    ap.add_argument("--id")
    ap.add_argument("--name")
    args = ap.parse_args()
    c = args.cmd
    if c == "list":
        return cmd_list(args)
    wg = pick(args)
    try:
        if c == "hello":
            h = wg.hello(2)
            print(json.dumps(h, indent=1) if h else "no answer: not running wedgie firmware (try: wedgie.py update)")
        elif c == "unlock":
            h = wg.hello(2)                     # the slot's hello, or an app's own (the Wallet: fw "usb-1")
            if not h:
                sys.exit("no answer: not running wedgie firmware (plain MicroPython: Ctrl-C already works)")
            if not h.get("sealed") or h.get("open"):
                print("it's open already: Ctrl-C works (mpremote too)")
            else:
                sys.stderr.write("press A on the wedgie (the red screen) to give this computer full control\n")
                try:
                    v = wg.request({"type": "open", "full": True}, 65)
                except TimeoutError:
                    sys.exit("nobody pressed A on the wedgie")
                if v.get("type") != "open":
                    sys.exit("the wedgie said no" if v.get("type") == "refused" else "the wedgie said %s" % v)
                print("full control until it restarts or is unplugged: Ctrl-C works now (mpremote repl, mpremote cp ...)")
        elif c == "shot":
            need_firmware(wg)
            v = wg.request({"type": "shot"}, 10)
            out = args.rest[0] if args.rest else "wedgie-shot.png"
            png(out, base64.b64decode(v["data"]))
            print(out)
        elif c == "press":
            need_firmware(wg)
            k = args.rest[0] if args.rest else ""
            if k not in KEYS:
                sys.exit("key must be one of: " + " ".join(KEYS))
            print(json.dumps(wg.request({"type": "press", "key": k, "ms": int(args.rest[1]) if len(args.rest) > 1 else 80})))
        elif c in ("launch", "home"):
            sys.exit("a wedgie runs one app now (firmware 0.2+):  wedgie.py use <app>   (wedgie.py apps lists them)")
        elif c == "ls":
            take_over(wg)
            print(wg.exec("import os\ndef _w(d):\n    for n in sorted(os.listdir(d)):\n        p = d.rstrip('/') + '/' + n\n        s = os.stat(p)\n        if s[0] & 0x4000:\n            print('%7s  %s/' % ('', p)); _w(p)\n        else:\n            print('%7d  %s' % (s[6], p))\n_w('/')\n_s = os.statvfs('/')\nprint('%7d  free' % (_s[0] * _s[3]))"))
            wg.leave(reset=False)
        elif c == "saves":
            take_over(wg)
            got = json.loads(wg.exec("import os, json, binascii\n_o = {}\ntry:\n    _gs = os.listdir('/saves')\nexcept OSError:\n    _gs = []\nfor _g in _gs:\n    for _n in os.listdir('/saves/' + _g):\n        with open('/saves/%s/%s' % (_g, _n), 'rb') as _f:\n            _o['/saves/%s/%s' % (_g, _n)] = binascii.b2a_base64(_f.read()).decode().strip()\nprint(json.dumps(_o))", 60))
            sub = args.rest[0] if args.rest else ""
            if sub == "backup" and len(args.rest) == 2:
                json.dump({"wedgie-saves": 1, "files": got}, open(args.rest[1], "w"))
                print("%d save files -> %s" % (len(got), args.rest[1]))
            elif sub == "restore" and len(args.rest) == 2:
                b = json.load(open(args.rest[1]))
                n = 0
                for p, data in b.get("files", {}).items():
                    parts = p.split("/")
                    if len(parts) != 4 or parts[1] != "saves" or ".." in parts:
                        continue
                    wg.exec("import os\nfor _d in ('/saves', '/saves/%s'):\n    try:\n        os.mkdir(_d)\n    except OSError:\n        pass" % parts[2])
                    wg.put(p, base64.b64decode(data))
                    n += 1
                wg.sync()
                print("%d save files put back" % n)
            elif sub:
                sys.exit("usage: wedgie.py saves [backup f.json | restore f.json]")
            else:
                for p in sorted(got):
                    print("%7d  %s" % (len(base64.b64decode(got[p])), p))
                if not got:
                    print("no saves")
            wg.leave(reset=False)
        elif c == "run":
            src = open(args.rest[0]).read()
            wg.enter()
            try:
                wg.exec(src, timeout=24 * 3600, echo=True)
                print("\n[returned; its timers keep running. Ctrl-C to stop and go back to its app]")
                while True:
                    c2 = wg.s.read(256)
                    if c2:
                        sys.stdout.write(c2.decode("utf8", "replace")); sys.stdout.flush()
            except KeyboardInterrupt:
                wg.s.write(b"\x03")
            except RuntimeError as e:
                print("\n" + str(e))
            wg.leave()
        elif c == "install" and (os.path.isdir(args.rest[0]) or args.rest[0].endswith("wedgie.json")):
            path = args.rest[0][:-len("wedgie.json")] or "." if args.rest[0].endswith("wedgie.json") else args.rest[0]
            m = manifest()
            entry, files = folder_app(path, args.rest[1] if len(args.rest) > 1 else None, m)
            take_over(wg)
            have = look(wg, m)
            remove_files(wg, have, [n for n in others(m, have, None) if n not in files])     # the old app's files
            for n, b in sorted(files.items()):
                if have["hashes"].get(n) != hashlib.sha256(b).hexdigest():
                    print("  " + n)
                    wg.put(n, b)
            wg.exec("import json\njson.dump(%r, open('apps.json', 'w'))" % [entry])
            wg.sync()
            wg.leave()      # a fresh heap for it
            print("%s is the app it runs now (saves in /saves/%s stay)" % (entry["name"], entry["mod"]))
        elif c == "install":
            path = args.rest[0]
            mod = os.path.splitext(os.path.basename(path))[0]
            name = (args.name or mod)[:12]
            take_over(wg)
            wg.put(mod + ".py", open(path, "rb").read())
            wg.exec("import json\njson.dump([{'mod': %r, 'name': %r, 'about': 'installed with wedgie.py'}], open('apps.json', 'w'))" % (mod, name))
            wg.sync()
            wg.leave()
            print("installed %s as %r; it's the app it runs now" % (mod, name))
        elif c in ("off", "uninstall"):
            m = manifest()
            take_over(wg)
            have = look(wg, m)
            remove_files(wg, have, others(m, have, None))
            write_apps(wg, m, have, None)
            wg.leave(reset=False)
            print("its app is uninstalled; it shows \"no software\"")
        elif c == "update":
            m = manifest()
            take_over(wg)
            have = look(wg, m)
            names = [f["name"] for f in m["files"]]
            from_menu = any(n in have["files"] for n in RETIRED)     # 0.1.x: it starts with no app
            for n in [n[:-3] + ".mpy" for n in names if n.endswith(".py")] + RETIRED:
                if n in have["files"] and n not in names:       # stale bytecode MicroPython would import first; retired core files
                    wg.exec("import os\nos.remove(%r)" % n)
            act = None if from_menu else active_of(m, have)     # one app from 0.2 on: it keeps its app, up to date
            keep = next((c["files"] for c in m["carts"] if c["mod"] == act), [])   # (the Wallet gets its .mpy here)
            todo = copy(wg, m, set(m["core"]) | set(keep), have)
            remove_files(wg, have, others(m, have, act))
            write_apps(wg, m, have, act)
            wg.leave()      # the new firmware only runs after a soft reset (see "Plugging in" above)
            print("wedgie %s: %s" % (m["version"], "%d files updated" % len(todo) if todo else "already up to date"))
        elif c == "debug":
            code = urllib.request.urlopen(SITE + "/device/debug.py").read().decode()
            take_over(wg, "Debug and read logs")
            out = wg.exec(code, 30)
            wg.leave(reset=False)       # its app again, locked
            line = next((l for l in out.splitlines() if l.startswith("@debug ")), None)
            if not line:
                sys.exit("no report: " + out[-500:])
            print(json.dumps(json.loads(line[7:]), indent=1))
        elif c in ("apps", "carts"):
            m = manifest()
            take_over(wg)
            have = look(wg, m)
            wg.leave(reset=False)
            act = active_of(m, have)
            on = {a["mod"]: a.get("v") for a in have["apps"]}
            for cart in m["carts"]:
                state = ("runs it" if on.get(cart["mod"]) == cart["v"] else "runs it, update ready") if cart["mod"] == act else "%d KB" % max(1, cart["size"] // 1024)
                print("%-10s %-12s %-20s %s%s" % (cart["mod"], cart["name"], state, cart.get("about", ""), "  [needs an %s chip]" % cart["chip"] if cart.get("chip") else ""))
            if act and not any(x["mod"] == act for x in m["carts"]):
                print("%-10s %-12s %-20s" % (act, "(yours)", "runs it"))
        elif c in ("use", "cart"):
            mod = args.rest[-1] if args.rest else ""
            if c == "cart" and args.rest[:1] == ["remove"]:
                sys.exit("wedgie.py uninstall   uninstalls its app")
            m = manifest()
            cart = next((x for x in m["carts"] if x["mod"] == mod), None)
            if not cart:
                sys.exit("no app %r; wedgie.py apps lists them" % mod)
            have = checked(wg, m)
            if have:
                sha = {f["name"]: f["sha256"] for f in m["files"]}
                job(wg, "Install " + cart["name"], [n for n in cart["files"] if have["hashes"].get(n) != sha[n] or have["hashes"].get(twin(n))],
                    others(m, have, cart["mod"]), [cart_entry(cart)])
                print("%s is the app it runs now (checked install; saves stay)" % cart["name"])
                return
            take_over(wg)
            have = look(wg, m)
            size = {f["name"]: f["size"] for f in m["files"]}
            gone = others(m, have, cart["mod"])
            need = sum(size[n] for n in cart["files"] if not have["hashes"].get(n))
            free = int(wg.exec("import os\n_s = os.statvfs('/')\nprint(_s[0] * _s[3])").strip())
            if free + sum(size.get(n, 0) for n in gone) < need + FLOOR:     # 0: an old repo app's file (not in the manifest)
                wg.leave(reset=False)
                sys.exit("not enough room: %s needs %d KB. Delete some saves or files first." % (cart["name"], need // 1024))
            remove_files(wg, have, gone)
            copy(wg, m, set(cart["files"]), have)
            write_apps(wg, m, have, cart["mod"])
            wg.leave()      # a fresh heap for it
            print("%s is the app it runs now" % cart["name"])
        else:
            sys.exit("unknown command %r; see: wedgie.py --help" % c)
    finally:
        wg.close()


if __name__ == "__main__":
    main()
