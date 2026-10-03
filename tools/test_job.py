#!/usr/bin/env python3
"""Checked installs against a hostile host, in seconds: the real firmware/job.py and wedgie.py under
CPython (the board's modules stubbed), a throwaway release key, a scratch flash folder. Each case sends
what a host could send and checks what ends up on the flash. codex (2026-10-02) found these by hand:
a re-upload after a file checked out, an app whose entry was wedgie.set_open, ./main.py deleted.
    python3 tools/test_job.py"""
import sys, os, json, hashlib, binascii, base64, tempfile, shutil, types, time

HERE = os.path.dirname(os.path.abspath(__file__))
FW = os.path.join(HERE, "..", "firmware")
sys.path.insert(0, FW)

# ---- the board, stubbed -----------------------------------------------------------------------------
_t = [0]
def _ticks():
    _t[0] += 500                         # every look at the clock moves it: an idle job ends quickly
    return _t[0]
time.ticks_ms = _ticks
time.ticks_diff = lambda a, b: a - b
time.sleep_ms = lambda ms: None
machine = types.ModuleType("machine")
machine.unique_id = lambda: b"\x01" * 8
machine.soft_reset = lambda: (_ for _ in ()).throw(SystemExit("soft reset"))
machine.mem32 = {}
sys.modules["machine"] = machine
sel = types.ModuleType("select")
sel.POLLIN = 1
sel.poll = lambda: types.SimpleNamespace(register=lambda *a: None, poll=lambda ms=0: [])
sys.modules["select"] = sel
sys.modules["micropython"] = types.ModuleType("micropython")

import p256          # noqa: E402  (pure Python: signs here as it checks on the wedgie)
import wedgie as W   # noqa: E402
import job           # noqa: E402

D = 0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDE
QX, QY = p256.pubkey(D)
W.RELEASE_KEY = ("%064x" % QX, "%064x" % QY)
carts = json.load(open(os.path.join(FW, "carts.json")))
sha = lambda b: hashlib.sha256(b).hexdigest()
read = lambda n: open(os.path.join(FW, n), "rb").read()
names = sorted(n for n in os.listdir(FW) if n.endswith((".py", ".mpy", ".bin")) and not (n.endswith(".py") and os.path.exists(os.path.join(FW, n[:-3] + ".mpy"))))


def release(apps=True):
    t = "wedgie-release 1\nversion 9.9.9\n" + "".join("%s  %s\n" % (sha(read(n)), n) for n in names)
    if apps:
        for c in sorted(carts, key=lambda c: c["mod"]):
            a = {"mod": c["mod"], "name": c["name"], "files": c["files"]}
            for k in ("entry", "usb"):
                if c.get(k):
                    a[k] = c[k]
            t += "@app  " + json.dumps(a, separators=(",", ":")) + "\n"
    r, s = p256.sign(D, hashlib.sha256(t.encode()).digest())
    return t, "%064x %064x" % (r, s)


class Host:
    """What the job reads (W.lines) and sends (W.send)."""
    def __init__(self, msgs):
        self.q, i = [], 0
        for m in msgs:                  # a raw put: its header line, then its bytes (wedgie.Lines.raw)
            if isinstance(m, bytes):
                self.q.append(("raw", m))
            else:
                self.q.append(json.dumps(dict(m, id=100 + i)).encode())
                i += 1
        self.out = []

    def pump(self, poll, wait=0):
        while self.q and isinstance(self.q[0], tuple):      # bytes nobody read: a raw put the job refused
            self.q.pop(0)
        return self.q.pop(0) if self.q else None

    def raw(self, mv):
        kind, b = self.q.pop(0)
        mv[:] = b


def puts(name, data, chunk=1024):
    return [{"type": "put", "name": name, "data": base64.b64encode(data[o:o + chunk]).decode(), "end": o + chunk >= len(data)}
            for o in range(0, max(len(data), 1), chunk)]


def run(job_msg, msgs, rel_apps=True, app="hello"):
    """One job on a fresh flash running `app`. (answers, {file: bytes} after)."""
    d = tempfile.mkdtemp()
    old = os.getcwd()
    os.chdir(d)
    try:
        app_files = {n for c in carts for n in c["files"]}
        for n in names:
            if n not in app_files:
                shutil.copy(os.path.join(FW, n), n)
        c = next(c for c in carts if c["mod"] == app)
        for n in c["files"]:
            shutil.copy(os.path.join(FW, n), n)
        open("apps.json", "w").write(json.dumps([{"mod": app, "name": c["name"]}]))
        rel, sig = release(rel_apps)
        h = Host([{"type": "release", "release": rel, "sig": sig}] + msgs)
        W.lines = lambda size=6144: h
        W.send = lambda o: h.out.append(o)
        try:
            job.run(1, dict(job_msg, type="job", version="9.9.9"), lambda *a: True)
        except SystemExit:
            h.out.append({"type": "reset"})
        files = {n: open(n, "rb").read() for n in os.listdir(".") if os.path.isfile(n)}
        return h.out, files
    finally:
        os.chdir(old)
        shutil.rmtree(d)


fails = 0
def check(ok, what):
    global fails
    print(("ok   " if ok else "FAIL ") + what)
    fails += not ok


kt = read("keytest.py")
buttons = [{"mod": "keytest", "v": "x"}]
types_ = lambda out: [o.get("type") for o in out]

# 1. a good install: Buttons over Hello
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": ["hello.py"], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + [{"type": "commit"}])
a = json.loads(f.get("apps.json", b"[]"))
check(types_(out)[-2:] == ["done", "reset"] and f.get("keytest.py") == kt and "hello.py" not in f, "a good install goes in: %s" % types_(out))
check(a and a[0].get("mod") == "keytest" and a[0].get("name") == "Buttons" and "entry" not in a[0], "apps.json comes from the signed list: %s" % a)

# 2. a finished, checked file sent again with other bytes, left open, then commit
evil = b"import wedgie; wedgie.set_open()\n"
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": [], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + [{"type": "put", "name": "keytest.py", "data": base64.b64encode(evil).decode(), "end": False}, {"type": "commit"}])
check(f.get("keytest.py") != evil and "done" not in types_(out), "re-upload after the check, then commit: refused (%s)" % types_(out))

# 3. the same, finished: its hash is wrong now
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": [], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + puts("keytest.py", evil) + [{"type": "commit"}])
check(f.get("keytest.py") != evil and "done" not in types_(out), "re-upload finished with other bytes: refused (%s)" % types_(out))

# 4. an app that is a core module, with an entry of the host's choosing
out, f = run({"job": "Install Buttons", "write": [], "delete": [], "apps": json.dumps([{"mod": "wedgie", "entry": "set_open"}])}, [{"type": "commit"}])
check(json.loads(f["apps.json"])[0]["mod"] == "hello" and "done" not in types_(out), "apps naming wedgie.set_open: refused (%s)" % types_(out))

# 5. a signed app's mod, but the host's own entry
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": [], "apps": json.dumps([{"mod": "keytest", "entry": "set_open"}])},
             puts("keytest.py", kt) + [{"type": "commit"}])
a = json.loads(f["apps.json"])
check("entry" not in a[0], "the host's entry is never written: %s" % a)

# 6. the title says one app, the job puts on another
out, f = run({"job": "Install Buttons", "write": ["battery.py"], "delete": [], "apps": json.dumps([{"mod": "battery"}])},
             puts("battery.py", read("battery.py")) + [{"type": "commit"}])
check(json.loads(f["apps.json"])[0]["mod"] == "hello" and "done" not in types_(out), "'Install Buttons' putting on Battery: refused (%s)" % types_(out))

# 7. deletes by another name: ./main.py, a save, a folder, a core file
for bad in ("./main.py", "main.py", "saves", "./saves/x.json", "/main.py", "slot.py", "slot.mpy", "../x", ".hidden"):
    out, f = run({"job": "Install Buttons", "write": [], "delete": [bad], "apps": json.dumps(buttons)}, [{"type": "commit"}])
    check("main.py" in f and "slot.mpy" in f and "done" not in types_(out), "delete %r: refused (%s)" % (bad, types_(out)))

# 8. writing another app's file in an install
out, f = run({"job": "Install Buttons", "write": ["keytest.py", "battery.py"], "delete": [], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + puts("battery.py", read("battery.py")) + [{"type": "commit"}])
check("battery.py" not in f and "done" not in types_(out), "an install writing another app's file: refused (%s)" % types_(out))

# 9. an update keeps the app it runs and may write the core + that app's files
out, f = run({"job": "Update firmware", "write": ["slot.mpy", "hello.py"], "delete": [], "apps": json.dumps([{"mod": "hello"}])},
             puts("slot.mpy", read("slot.mpy")) + puts("hello.py", read("hello.py")) + [{"type": "commit"}])
check(types_(out)[-2:] == ["done", "reset"] and json.loads(f["apps.json"])[0]["mod"] == "hello", "an update keeping its app goes in: %s" % types_(out))

# 10. "Update firmware" switching the app: refused
out, f = run({"job": "Update firmware", "write": ["keytest.py"], "delete": [], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + [{"type": "commit"}])
check(json.loads(f["apps.json"])[0]["mod"] == "hello" and "done" not in types_(out), "'Update firmware' that switches the app: refused (%s)" % types_(out))

# 11. a list from before 0.3.12 (no @app lines): files only, no apps.json from it
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": [], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + [{"type": "commit"}], rel_apps=False)
check(json.loads(f["apps.json"])[0]["mod"] == "hello" and "done" not in types_(out), "apps with a list that names none: refused (%s)" % types_(out))

# 12. taking the app off
out, f = run({"job": "Uninstall the app", "write": [], "delete": ["hello.py"], "apps": "[]"}, [{"type": "commit"}])
check(types_(out)[-2:] == ["done", "reset"] and json.loads(f["apps.json"]) == [] and "hello.py" not in f, "uninstalling goes in: %s" % types_(out))

# 13. commit with an upload still open
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": [], "apps": json.dumps(buttons)},
             puts("keytest.py", kt, chunk=len(kt))[:1] and [{"type": "put", "name": "keytest.py", "data": base64.b64encode(kt[:100]).decode(), "end": False}, {"type": "commit"}])
check("done" not in types_(out), "commit while an upload is open: refused (%s)" % types_(out))

# 14. the title binds the kind of job (codex 2026-10-03)
out, f = run({"job": "Install Buttons", "write": [], "delete": ["hello.py"], "apps": "[]"}, [{"type": "commit"}])
check("hello.py" in f and "done" not in types_(out), "'Install Buttons' that uninstalls: refused (%s)" % types_(out))
out, f = run({"job": "Install Buttons", "write": ["hello.py"], "delete": [], "apps": json.dumps([{"mod": "hello"}])},
             puts("hello.py", read("hello.py")) + [{"type": "commit"}])
check("done" not in types_(out), "'Install Buttons' putting on the Hello it runs: refused (%s)" % types_(out))
out, f = run({"job": "Install Hello", "write": ["hello.py"], "delete": [], "apps": json.dumps([{"mod": "hello"}])},
             puts("hello.py", read("hello.py")) + [{"type": "commit"}])
check(types_(out)[-2:] == ["done", "reset"], "'Install Hello' reinstalling the Hello it runs goes in: %s" % types_(out))
out, f = run({"job": "Uninstall the app", "write": ["keytest.py"], "delete": ["hello.py"], "apps": "[]"},
             puts("keytest.py", kt) + [{"type": "commit"}])
check("keytest.py" not in f and "hello.py" in f and "done" not in types_(out), "an uninstall that writes a file: refused (%s)" % types_(out))
out, f = run({"job": "Uninstall the app", "write": [], "delete": ["hello.py"], "apps": "[]"}, [{"type": "commit"}])
check(types_(out)[-2:] == ["done", "reset"] and "hello.py" not in f, "'Uninstall the app' goes in: %s" % types_(out))
out, f = run({"job": "Make it faster", "write": [], "delete": [], "apps": None}, [{"type": "commit"}])
check("done" not in types_(out), "a job title it doesn't know: refused (%s)" % types_(out))
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": None},
             puts("slot.mpy", read("slot.mpy")) + [{"type": "commit"}])
check(types_(out)[-2:] == ["done", "reset"] and json.loads(f["apps.json"])[0]["mod"] == "hello", "an update with no apps keeps apps.json: %s" % types_(out))

# 15. raw puts (0.3.15+): a header line with n, then n bytes
def raw_puts(name, data, chunk=4096):
    out = []
    for o in range(0, max(len(data), 1), chunk):
        part = data[o:o + chunk]
        out += [{"type": "put", "name": name, "n": len(part), "end": o + chunk >= len(data)}, part]
    return out
big = read("slot.mpy")
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": None, "raw": True},
             raw_puts("slot.mpy", big) + [{"type": "commit"}])
check(types_(out)[-2:] == ["done", "reset"] and f.get("slot.mpy") == big, "raw puts (%d bytes, 4 KB each) go in: %s" % (len(big), types_(out)))
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": None},
             [{"type": "put", "name": "slot.mpy", "n": 9000, "end": True}, b"x" * 9000, {"type": "commit"}])
check("done" not in types_(out), "a raw put over 4 KB: refused (%s)" % types_(out))
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": None},
             raw_puts("slot.mpy", big[:-1] + b"!") + [{"type": "commit"}])
check(f.get("slot.mpy") == read("slot.mpy") and "done" not in types_(out), "raw bytes that don't match the signed list: refused (%s)" % types_(out))
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": None},
             [{"type": "put", "name": "slot.mpy", "n": -1, "end": True}, {"type": "commit"}])
check("done" not in types_(out), "a raw put with n -1: refused (%s)" % types_(out))

print("all ok" if not fails else "%d FAILED" % fails)
sys.exit(1 if fails else 0)
