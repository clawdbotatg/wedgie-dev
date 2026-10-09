#!/usr/bin/env python3
"""A checked install on a REAL wedgie, the way the site sends it (src/serial/install.ts job(): hello,
sums, the job, the person presses A, the signed list, sums, the files in 1024-byte chunks, commit, the
restart), with wedgie.dev's own signed files. Reports free RAM (hello's ram) along the way. The last
word on memory (CLAUDE.md landmine 13): the virtual chip (tools/chipprobe.mjs) comes close, this is it.
    python3 tools/boardprobe.py battery [hello ...]     (pyserial; press A on the wedgie each time)
    --site https://wedgie.dev  --port /dev/ttyACM0"""
import sys, json, time, base64, hashlib, urllib.request, argparse, glob
import serial

ap = argparse.ArgumentParser()
ap.add_argument("apps", nargs="+")
ap.add_argument("--site", default="https://wedgie.dev")
ap.add_argument("--port", default=None)
a = ap.parse_args()
get = lambda n: urllib.request.urlopen(a.site + "/fw/" + n).read()
man = json.loads(get("manifest.json"))
rel, sig = get("release.txt").decode(), get("release.sig").decode().strip()


def port():
    return a.port or (glob.glob("/dev/serial/by-id/*wedgie*") + glob.glob("/dev/serial/by-id/*MicroPython*") + glob.glob("/dev/ttyACM*") + glob.glob("/dev/cu.usbmodem*"))[0]


class W:
    def __init__(self):
        self.s = serial.Serial(port(), 115200, timeout=0.2)
        self.id = 100
        self.buf = b""

    def req(self, m, wait=30):
        """The answer, None after `wait` s, or {"type": "lost"} when the port went away (a restart)."""
        self.id += 1
        m = dict(m, id=self.id)
        try:
            self.s.write((json.dumps(m) + "\n").encode())
        except (serial.SerialException, OSError):
            return {"type": "lost"}
        end = time.time() + wait
        while time.time() < end:
            try:
                self.buf += self.s.read(4096)
            except (serial.SerialException, OSError):
                return {"type": "lost"}
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                t = line.decode(errors="replace").strip()
                if not t.startswith("{"):
                    if t:
                        print("     |", t)
                    continue
                try:
                    r = json.loads(t)
                except ValueError:
                    continue
                if r.get("id") == self.id:
                    return r
                if r.get("type") == "ready":
                    print("     | ready (ram %s)" % r.get("ram"))
        return None


def install(mod):
    cart = next(c for c in man["carts"] if c["mod"] == mod)
    w = W()
    h = w.req({"type": "hello"}, 5)
    print("%s: wedgie %s, running %s, %s B free" % (mod, h and h.get("version"), h and h.get("running"), h and h.get("ram")))
    names = sorted(set(man["core"] + [n for c in man["carts"] for n in c["files"]]))
    w.req({"type": "sums", "names": [], "exists": names}, 30)
    others = [n for c in man["carts"] for n in c["files"] if n not in cart["files"] and n not in man["core"]]
    apps = [{"mod": cart["mod"], "name": cart["name"], "v": cart["v"], **({"entry": cart["entry"]} if cart.get("entry") else {}), **({"usb": True} if cart.get("usb") else {})}]
    print("   press the green button on the wedgie: Install %s?" % cart["name"])
    g = w.req({"type": "job", "job": "Install " + cart["name"], "version": man["version"], "write": cart["files"], "delete": others, "apps": json.dumps(apps)}, 70)
    if g and g.get("type") == "lost":
        # 0.3.12: the yes restarts it into install mode, and the first restart since a plug-in drops the
        # port (the WEDGIE drive goes). Open it again and ask the job (hello says job), as the site does.
        print("   the port dropped at the restart; finding it again")
        w.s.close()
        hh = None
        for _ in range(40):
            time.sleep(0.5)
            try:
                w = W()
            except (serial.SerialException, OSError, IndexError):
                continue
            hh = w.req({"type": "hello"}, 2)
            if hh and hh.get("type") == "hello":
                break
        if not (hh and hh.get("job")):
            return "after the yes: no job on it (%s)" % hh
        g = {"type": "go", "asked_ms": hh.get("asked_ms")}
    if not g or g.get("type") != "go":
        return "job: %s" % g
    print("   yes (question up in %s ms)" % g.get("asked_ms"))
    r = w.req({"type": "release", "release": rel, "sig": sig}, 120)
    if not r or r.get("type") != "ok":
        return "release: %s" % r
    s = w.req({"type": "sums", "names": cart["files"]}, 60)
    if not s or s.get("type") != "sums":
        return "sums: %s" % s
    for n in cart["files"]:
        f = next(x for x in man["files"] if x["name"] == n)
        if s["sums"].get(n) == f["sha256"]:
            continue
        b = get(n)
        for o in range(0, max(len(b), 1), 1024):
            p = w.req({"type": "put", "name": n, "data": base64.b64encode(b[o:o + 1024]).decode(), "end": o + 1024 >= len(b)}, 30)
            if not p or p.get("type") != "ok":
                return "put %s @%d: %s" % (n, o, p)
        hh = w.req({"type": "hello"}, 5)
        print("   %s sent, %s B free" % (n, hh and hh.get("ram")))
    d = w.req({"type": "commit"}, 30)
    if not d or d.get("type") != "done":
        return "commit: %s" % d
    w.s.close()
    time.sleep(4)
    w = W()
    h = w.req({"type": "hello"}, 8)
    if not h or h.get("running") != mod:
        return "after the restart: %s" % h
    print("   running %s, %s B free" % (mod, h.get("ram")))
    return True


bad = 0
for m in a.apps:
    r = install(m)
    print(("ok   " if r is True else "FAIL ") + "install %s%s" % (m, "" if r is True else ": %s" % r))
    bad += r is not True
sys.exit(1 if bad else 0)
