#!/usr/bin/env python3
"""wedgie: talk to a wedgie on USB from a terminal (or from your coding agent). MIT, wedgie.dev

  pip install pyserial            (mpremote users already have it)
  curl -O https://wedgie.dev/wedgie.py

  python3 wedgie.py list                      every wedgie on USB, with its ID
  python3 wedgie.py hello                     what it is and runs (JSON)
  python3 wedgie.py shot [out.png]            the real screen, as a PNG you can look at
  python3 wedgie.py press A [ms]              press a button: A B X Y up down left right press
  python3 wedgie.py launch hello              open an app from its launcher;  home  goes back
  python3 wedgie.py apps                      apps in its launcher
  python3 wedgie.py run app.py                run a file once (output streams; Ctrl-C stops), then back to the launcher
  python3 wedgie.py install app.py [--name N] save your own app to it and add it to the launcher
  python3 wedgie.py uninstall app             take your app out of the launcher (the file is removed)
  python3 wedgie.py carts                     the cartridges on wedgie.dev, and which are on it
  python3 wedgie.py cart add wallet           put a cartridge on it (or update it); cart remove wallet
  python3 wedgie.py update                    install/update the wedgie firmware (only changed files; cartridges stay)
  python3 wedgie.py ls                        files on it

  --port /dev/cu.usbmodemXXXX  (or --id A1B2C3) picks one when several are plugged in.

hello/shot/press/launch/home/apps talk to the wedgie launcher over JSON lines and never interrupt it.
The rest stop it (Ctrl-C), use MicroPython's raw REPL, then start the launcher again by running main.py.
Only update and run soft-reset it (new firmware only runs after one; run clears your code's timers).
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

    def close(self):
        self.s.close()

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

    def enter(self):
        """Stop what it runs (Ctrl-C) and go to the raw REPL. No soft reset: wedgie firmware 0.1.1+ re-adds
        its USB drive at boot, which re-enumerates USB and would drop this port mid-command."""
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
        """Out of raw mode and back to the launcher. reset=True soft-resets (needed after writing firmware;
        on 0.1.1+ the port drops and comes back); False just runs main.py again, port stays up."""
        self.s.write(b"\x02")
        time.sleep(0.05)
        self.s.write(b"\x04" if reset else b'exec(open("main.py").read())\r')

    def put(self, name, data):
        tmp = "_wedgie.tmp"
        self.exec("import binascii, os, hashlib\n_f = open(%r, 'wb')" % tmp)
        for i in range(0, len(data), 2048):
            self.exec("_f.write(binascii.a2b_base64(%r))" % base64.b64encode(data[i:i + 2048]).decode())
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


# ---- firmware core and cartridges (the same model as wedgie.dev: src/serial/install.ts) -----------
# /fw/manifest.json: files (name, size, sha256), core (the firmware's own files), carts (each app's files
# and v). apps.json on the wedgie lists what's in its launcher; it's rebuilt from what's really on the
# flash after every change: each cart whose files are all there, with v from their real hashes, then
# the person's own apps as they were.
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
print(json.dumps({'hashes': {n: _h(n) for n in %s}, 'files': os.listdir(), 'apps': _a}))"""


def manifest():
    return json.load(urllib.request.urlopen(SITE + "/fw/manifest.json"))


def cart_v(hashes):
    return hashlib.sha256("\n".join(h or "None" for h in hashes).encode()).hexdigest()[:12]


def look(wg, m):
    names = sorted(set(m["core"]) | {n for c in m["carts"] for n in c["files"]})
    return json.loads(wg.exec(HASH_PY % json.dumps(names), 60))


def copy(wg, m, names, have):
    todo = sorted([f for f in m["files"] if f["name"] in names and have["hashes"].get(f["name"]) != f["sha256"]], key=lambda f: f["name"] == "main.py")
    for i, f in enumerate(todo):
        print("[%d/%d] %s" % (i + 1, len(todo), f["name"]))
        wg.put(f["name"], urllib.request.urlopen(SITE + "/fw/" + f["name"]).read())
        have["hashes"][f["name"]] = f["sha256"]
    return todo


def write_apps(wg, m, have, drop=()):
    known = {c["mod"] for c in m["carts"]}
    out = []
    for c in m["carts"]:
        if c["mod"] in drop or not all(have["hashes"].get(n) for n in c["files"]):
            continue
        a = {"mod": c["mod"], "name": c["name"], "about": c.get("about", ""), "v": cart_v([have["hashes"][n] for n in c["files"]])}
        if c.get("entry"):
            a["entry"] = c["entry"]
        out.append(a)
    out += [a for a in have.get("apps", []) if a.get("mod") not in known and a.get("mod") not in drop]
    wg.exec("import json\n_f = open('apps.json', 'w')\n_f.write(%r)\n_f.close()" % json.dumps(out))
    wg.sync()
    return out


# ---- commands ------------------------------------------------------------------------------
def need_launcher(wg):
    h = wg.hello()
    if not h or not str(h.get("fw", "")).startswith("wedgie-"):
        sys.exit("that board isn't running the wedgie launcher. Install it:  wedgie.py update")
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
        elif c == "shot":
            need_launcher(wg)
            v = wg.request({"type": "shot"}, 10)
            out = args.rest[0] if args.rest else "wedgie-shot.png"
            png(out, base64.b64decode(v["data"]))
            print(out)
        elif c == "press":
            need_launcher(wg)
            k = args.rest[0] if args.rest else ""
            if k not in KEYS:
                sys.exit("key must be one of: " + " ".join(KEYS))
            print(json.dumps(wg.request({"type": "press", "key": k, "ms": int(args.rest[1]) if len(args.rest) > 1 else 80})))
        elif c in ("launch", "home"):
            need_launcher(wg)
            msg = {"type": "launch", "app": args.rest[0]} if c == "launch" else {"type": "home"}
            print(json.dumps(wg.request(msg, 10)))
        elif c == "apps":
            wg.enter()
            print(wg.exec("print(open('apps.json').read())").strip())
            wg.leave(reset=False)
        elif c == "ls":
            wg.enter()
            print(wg.exec("import os\nfor n in sorted(os.listdir()):\n    print('%7d  %s' % (os.stat(n)[6], n))"))
            wg.leave(reset=False)
        elif c == "run":
            src = open(args.rest[0]).read()
            wg.enter()
            try:
                wg.exec(src, timeout=24 * 3600, echo=True)
                print("\n[returned; its timers keep running. Ctrl-C to stop and go back to the launcher]")
                while True:
                    c2 = wg.s.read(256)
                    if c2:
                        sys.stdout.write(c2.decode("utf8", "replace")); sys.stdout.flush()
            except KeyboardInterrupt:
                wg.s.write(b"\x03")
            except RuntimeError as e:
                print("\n" + str(e))
            wg.leave()
        elif c == "install":
            path = args.rest[0]
            mod = os.path.splitext(os.path.basename(path))[0]
            name = (args.name or mod)[:12]
            wg.enter()
            wg.put(mod + ".py", open(path, "rb").read())
            wg.exec("import json, sys\ntry:\n    _a = json.load(open('apps.json'))\nexcept Exception:\n    _a = []\n_a = [x for x in _a if x['mod'] != %r] + [{'mod': %r, 'name': %r, 'about': 'installed with wedgie.py'}]\njson.dump(_a, open('apps.json', 'w'))\nsys.modules.pop(%r, None)" % (mod, mod, name, mod))
            wg.sync()
            wg.leave(reset=False)
            print("installed %s as %r; it's in the launcher" % (mod, name))
        elif c == "uninstall":
            mod = args.rest[0]
            wg.enter()
            wg.exec("import json, os\n_a = json.load(open('apps.json'))\njson.dump([x for x in _a if x['mod'] != %r], open('apps.json', 'w'))\ntry:\n    os.remove(%r)\nexcept OSError:\n    pass" % (mod, mod + ".py"))
            wg.sync()
            wg.leave(reset=False)
            print("removed", mod)
        elif c == "update":
            m = manifest()
            wg.enter()
            have = look(wg, m)
            names = [f["name"] for f in m["files"]]
            for n in [n[:-3] + ".mpy" for n in names if n.endswith(".py")]:
                if n in have["files"] and n not in names:       # stale bytecode MicroPython would import first
                    wg.exec("os.remove(%r)" % n)
            todo = copy(wg, m, set(m["core"]), have)
            write_apps(wg, m, have)
            wg.leave()      # the new firmware only runs after a soft reset (see "Plugging in" above)
            print("wedgie %s: %s" % (m["version"], "%d files updated" % len(todo) if todo else "already up to date"))
        elif c == "carts":
            m = manifest()
            wg.enter()
            have = look(wg, m)
            wg.leave(reset=False)
            on = {a["mod"]: a.get("v") for a in have["apps"]}
            for cart in m["carts"]:
                state = ("on it" if on[cart["mod"]] == cart["v"] else "on it, update ready") if cart["mod"] in on else "%d KB" % max(1, cart["size"] // 1024)
                print("%-10s %-12s %-20s %s" % (cart["mod"], cart["name"], state, cart.get("about", "")))
        elif c == "cart":
            if len(args.rest) != 2 or args.rest[0] not in ("add", "remove"):
                sys.exit("usage: wedgie.py cart add|remove <mod>   (wedgie.py carts lists them)")
            m = manifest()
            cart = next((x for x in m["carts"] if x["mod"] == args.rest[1]), None)
            if not cart:
                sys.exit("no cartridge %r; wedgie.py carts lists them" % args.rest[1])
            try:
                wg.request({"type": "home"}, 1)        # close a launcher app first (its Timer would keep drawing)
            except TimeoutError:
                pass
            wg.enter()
            have = look(wg, m)
            if args.rest[0] == "add":
                copy(wg, m, set(cart["files"]), have)
                wg.exec("import sys\nfor _n in %r:\n    sys.modules.pop(_n, None)" % [n[:-3] for n in cart["files"] if n.endswith(".py")])
                write_apps(wg, m, have)
                print("%s is on it; wedgie.py launch %s" % (cart["name"], cart["mod"]))
            else:
                others = [x for x in m["carts"] if x["mod"] != cart["mod"] and all(have["hashes"].get(n) for n in x["files"])]
                keep = set(m["core"]) | {n for x in others for n in x["files"]}
                for n in cart["files"]:
                    if n not in keep and have["hashes"].get(n):
                        wg.exec("import os\nos.remove(%r)" % n)
                        have["hashes"][n] = None
                write_apps(wg, m, have, drop=[cart["mod"]])
                print("removed", cart["name"])
            wg.leave(reset=False)
        else:
            sys.exit("unknown command %r; see: wedgie.py --help" % c)
    finally:
        wg.close()


if __name__ == "__main__":
    main()
