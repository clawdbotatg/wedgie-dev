#!/usr/bin/env python3
"""Checked installs against a hostile host, in seconds: the real firmware/job.py and wedgie.py under
CPython (the board's modules stubbed), a throwaway release key, a scratch flash folder. Each case sends
what a host could send and checks what ends up on the flash. codex (2026-10-02) found these by hand:
a re-upload after a file checked out, an app whose entry was wedgie.set_open, ./main.py deleted.
Every case runs twice: the apps in the signed list (before 0.3.66), and on their own (SPLIT: the app list, sent
in pieces before the signed list, which names it by its hash).
    python3 tools/test_job.py"""
import sys, os, json, hashlib, binascii, base64, tempfile, shutil, types, time, subprocess

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
machine.reset = lambda: (_ for _ in ()).throw(SystemExit("reset"))    # job.restart (0.3.57+: a hard reset after an install)
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
W.RELEASE_KEYS = (("%064x" % QX, "%064x" % QY),)
# Three small apps of the test's own (the real ones live in their own repos now): the cases need an app
# that runs, one to install, and a third whose files the install mustn't touch.
APPS = {"hello.py": b"print('hello')\n", "keytest.py": b"def run():\n    pass\n", "battery.py": b"print('battery')\n"}
carts = [{"mod": "hello", "name": "Hello", "files": ["hello.py"]},
         {"mod": "keytest", "name": "Buttons", "entry": "run", "files": ["keytest.py"]},
         {"mod": "battery", "name": "Battery", "files": ["battery.py"]}]
sha = lambda b: hashlib.sha256(b).hexdigest()
read = lambda n: APPS[n] if n in APPS else open(os.path.join(FW, n), "rb").read()
names = sorted([n for n in os.listdir(FW) if n.endswith((".py", ".mpy", ".bin")) and not (n.endswith(".py") and os.path.exists(os.path.join(FW, n[:-3] + ".mpy")))] + list(APPS))


VER = ["9.9.9"]                          # the signed list's version: older than W.VERSION is refused
SER = [0]                                # its "@serial" (0: none): lower than the one on the flash is refused
SPLIT = bool(os.environ.get("SPLIT"))
APPS_TEXT = [""]                         # SPLIT: the app list the last release() names


def app_line(c):
    a = {"mod": c["mod"], "name": c["name"], "files": c["files"]}
    for k in ("entry", "usb"):
        if c.get(k):
            a[k] = c[k]
    return "@app  " + json.dumps(a, separators=(",", ":")) + "\n"


def apps_text(extra=None):
    return "".join(app_line(c) + "".join("%s  %s\n" % ((extra or {}).get(n) or sha(read(n)), n) for n in c["files"])
                   for c in sorted(carts, key=lambda c: c["mod"]))


def release(apps=True, extra=None):
    appf = set(APPS)
    if SPLIT and apps:
        APPS_TEXT[0] = apps_text(extra)
        t = "wedgie-release 1\nversion %s\n" % VER[0] + "".join("%s  %s\n" % (sha(read(n)), n) for n in names if n not in appf)
        t += "@apps  %s\n" % sha(APPS_TEXT[0].encode())
    else:
        t = "wedgie-release 1\nversion %s\n" % VER[0] + "".join("%s  %s\n" % (sha(read(n)), n) for n in names)
        if apps:
            t += "".join(app_line(c) for c in sorted(carts, key=lambda c: c["mod"]))
    if SER[0]:
        t += "@serial  %d\n" % SER[0]
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

    def raw(self, mv, poll=None, ms=5000):
        kind, b = self.q.pop(0)
        mv[:] = b


def puts(name, data, chunk=1024):
    return [{"type": "put", "name": name, "data": base64.b64encode(data[o:o + chunk]).decode(), "end": o + chunk >= len(data)}
            for o in range(0, max(len(data), 1), chunk)]


def pieces(text, n=120):
    out, o = [], 0
    while o < len(text):
        e = text.find("\n", o + n)
        e = len(text) if e < 0 else e + 1
        out.append({"type": "apps", "t": text[o:e]})
        o = e
    return out


def run(job_msg, msgs, rel_apps=True, app="hello", flash=None, version=None, apps=None, extra=None):
    """One job on a fresh flash running `app`. (answers, {file: bytes} after). SPLIT: the app list goes first
    (apps: these pieces instead)."""
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
            open(n, "wb").write(read(n))
        open("apps.json", "w").write(json.dumps([{"mod": app, "name": c["name"]}]))
        for n, data in (flash or {}).items():
            open(n, "wb").write(data)
        rel, sig = release(rel_apps, extra)
        if job_msg.get("release") is True:      # embedded: this run's own list
            job_msg = dict(job_msg, release=rel, sig=sig)
        first = [] if "release" in job_msg else [{"type": "release", "release": rel, "sig": sig}]
        if SPLIT and rel_apps and "release" not in job_msg:
            first = (pieces(APPS_TEXT[0]) if apps is None else apps) + first
        h = Host(first + msgs)
        W.lines = lambda size=6144: h
        W.send = lambda o: h.out.append(o)
        try:
            job.run(1, dict(job_msg, type="job", version=version or VER[0]), lambda *a: True)
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
check(a and a[0].get("mod") == "keytest" and a[0].get("name") == "Buttons" and a[0].get("entry") == "run", "apps.json comes from the signed list: %s" % a)

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
check(a[0].get("entry") == "run", "the host's entry is never written: %s" % a)

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

# 9. an update keeps the app it runs and writes only the core (0.3.53: one job, one thing)
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": json.dumps([{"mod": "hello"}])},
             puts("slot.mpy", read("slot.mpy")) + [{"type": "commit"}])
check(types_(out)[-2:] == ["done", "reset"] and json.loads(f["apps.json"])[0]["mod"] == "hello", "an update keeping its app goes in: %s" % types_(out))
out, f = run({"job": "Update firmware", "write": ["slot.mpy", "hello.py"], "delete": [], "apps": json.dumps([{"mod": "hello"}])},
             puts("slot.mpy", read("slot.mpy")) + puts("hello.py", b"print('new')\n") + [{"type": "commit"}], flash={"hello.py": b"print('old')\n"})
check(f["hello.py"] == b"print('old')\n" and "done" not in types_(out), "'Update firmware' that also writes its app: refused (%s)" % types_(out))
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": ["battery.py"], "apps": json.dumps([{"mod": "hello"}])},
             puts("slot.mpy", read("slot.mpy")) + [{"type": "commit"}], flash={"battery.py": b"x"})
check("battery.py" in f and "done" not in types_(out), "'Update firmware' that deletes a file: refused (%s)" % types_(out))
# an outdated app doesn't block a firmware update (the update doesn't touch it)
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": json.dumps([{"mod": "hello"}])},
             puts("slot.mpy", read("slot.mpy")) + [{"type": "commit"}], flash={"hello.py": b"print('old')\n"})
check(types_(out)[-2:] == ["done", "reset"] and f["hello.py"] == b"print('old')\n", "an update with an old app goes in, the app untouched: %s" % types_(out))
# "Install X" writes only X's files, takes off only the app it replaces
out, f = run({"job": "Install Buttons", "write": ["keytest.py", "slot.mpy"], "delete": ["hello.py"], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + puts("slot.mpy", read("slot.mpy")) + [{"type": "commit"}])
check("keytest.py" not in f and "done" not in types_(out), "'Install Buttons' that also writes the firmware: refused (%s)" % types_(out))
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": ["hello.py", "battery.py"], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + [{"type": "commit"}], flash={"battery.py": b"x"})
check("battery.py" in f and "hello.py" in f and "done" not in types_(out), "'Install Buttons' taking off another app's file too: refused (%s)" % types_(out))
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": ["mine.py"], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + [{"type": "commit"}], flash={"mine.py": b"x"})
check("mine.py" in f and "done" not in types_(out), "'Install Buttons' taking off the person's own file: refused (%s)" % types_(out))
out, f = run({"job": "Uninstall the app", "write": [], "delete": ["hello.py", "battery.py"], "apps": "[]"},
             [{"type": "commit"}], flash={"battery.py": b"x"})
check("battery.py" in f and "done" not in types_(out), "an uninstall taking off more than its app: refused (%s)" % types_(out))

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

# 15. raw puts (0.3.16+): a header line with n, then n bytes
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

VER[0] = "0.3.47"                       # an old signed list puts back an old core with its holes (audit 10-16)
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": None},
             raw_puts("slot.mpy", big) + [{"type": "commit"}])
check("done" not in types_(out) and "older" in str(out), "a signed list older than this wedgie: refused (%s)" % out[-1:])
VER[0] = W.VERSION
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": None},
             raw_puts("slot.mpy", big) + [{"type": "commit"}])
check(types_(out)[-2:] == ["done", "reset"], "a signed list of this wedgie's own version goes in: %s" % types_(out))

# The signed list, not the host's write list, defines the complete installed app/core.
out, f = run({"job": "Install Buttons", "write": [], "apps": json.dumps(buttons)}, [{"type": "commit"}])
check("done" not in types_(out) and "keytest.py" not in f and json.loads(f["apps.json"])[0]["mod"] == "hello",
      "an omitted app file cannot activate an absent app")
old = b"print('old unreviewed hello')\n"
out, f = run({"job": "Install Hello", "write": [], "apps": json.dumps([{"mod": "hello"}])},
             [{"type": "commit"}], flash={"hello.py": old})
check("done" not in types_(out) and f["hello.py"] == old, "an omitted changed app cannot report a successful install")
out, f = run({"job": "Update firmware", "write": [], "apps": None},
             [{"type": "commit"}], flash={"boot.py": b"# old boot\n"})
check("done" not in types_(out) and f["boot.py"] == b"# old boot\n", "an omitted changed core file cannot report a successful update")
out, f = run({"job": "Update firmware", "write": [], "apps": None},
             [{"type": "commit"}], flash={"slot.py": evil})
check(types_(out)[-2:] == ["done", "reset"] and "slot.py" not in f,
      "verified existing bytecode cannot be shadowed by old source")

# A source twin that is itself signed and required is not an unsigned shadow.
APPS["keytest.mpy"] = b"fixture bytecode"
names.append("keytest.mpy")
carts[1]["files"].append("keytest.mpy")
try:
    out, f = run({"job": "Install Buttons", "write": ["keytest.mpy", "keytest.py"], "apps": json.dumps(buttons)},
                 puts("keytest.mpy", APPS["keytest.mpy"]) + puts("keytest.py", kt) + [{"type": "commit"}])
    check(types_(out)[-2:] == ["done", "reset"] and f.get("keytest.py") == kt and f.get("keytest.mpy") == APPS["keytest.mpy"],
          "source cleanup retains every signed required app file")
finally:
    carts[1]["files"].remove("keytest.mpy")
    names.remove("keytest.mpy")
    del APPS["keytest.mpy"]

# A second authentic list cannot replace the list that approved an upload, including legacy jobs.
rel, sig = release()
second = {"type": "release", "release": rel, "sig": sig}
for embedded in (False, True):
    m = {"job": "Install Buttons", "write": ["keytest.py"], "apps": json.dumps(buttons)}
    if embedded:
        m.update(release=rel, sig=sig)
    out, f = run(m, puts("keytest.py", kt) + [second, {"type": "commit"}])
    check("done" not in types_(out) and "keytest.py" not in f and ("one signed list" in str(out) or SPLIT and embedded),
          "a job cannot switch signed lists (embedded=%s)" % embedded)

# The question shows the host's version: an embedded list of another version never goes in (audit 10-18).
for emb in (False, True):
    m = {"job": "Update firmware", "write": [], "apps": None}
    if emb:
        m["release"] = True
    out, f = run(m, [{"type": "commit"}], version="9.9.10")
    check("done" not in types_(out) and "9.9.10" in str(out), "an update shown as another version is refused (embedded=%s): %s" % (emb, types_(out)))

# A same-version list signed before the one on it never goes back on (@serial, audit 10-18).
try:
    for ser, on, want in ((4, b"5", False), (0, b"5", False), (5, b"5", True), (6, b"5", True), (1, None, True)):
        SER[0] = ser
        out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": ["hello.py"], "apps": json.dumps(buttons)},
                     puts("keytest.py", kt) + [{"type": "commit"}], flash={"serial": on} if on else None)
        done = types_(out)[-2:] == ["done", "reset"]
        check(done == want and (not done or f.get("serial") == str(max(ser, int(on or 0))).encode()),
              "a list with serial %d on a wedgie at %s: %s (serial after: %s)" % (ser, on and on.decode(), "in" if done else "refused", f.get("serial")))
    SER[0] = 3
    out, f = run({"job": "Uninstall the app", "write": [], "delete": ["serial"], "apps": "[]"}, [{"type": "commit"}], flash={"serial": b"2"})
    check("done" not in types_(out) and f.get("serial") == b"2", "a job can't delete the serial")
finally:
    SER[0] = 0

# full control's red border (wedgie.MARK): only a signed job that leaves every file it runs as signed takes it off
M = {"modified": b""}
upd = lambda: puts("slot.mpy", read("slot.mpy")) + [{"type": "commit"}]
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": json.dumps([{"mod": "hello"}])}, upd(), flash=M)
check("done" in types_(out) and "modified" not in f, "a signed update, all as signed: the border goes (%s)" % types_(out))
out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": json.dumps([{"mod": "hello"}])}, upd(),
             flash=dict(M, **{"hello.py": b"print('changed')\n"}))
check("done" in types_(out) and "modified" in f, "the app it runs was changed: the border stays")
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": ["hello.py"], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + [{"type": "commit"}], flash=dict(M, **{"ui.py": b"x = 1\n"}))
check("done" in types_(out) and "modified" in f, "an install, a .py over a signed .mpy: the border stays")
out, f = run({"job": "Install Buttons", "write": ["keytest.py"], "delete": ["hello.py"], "apps": json.dumps(buttons)},
             puts("keytest.py", kt) + [{"type": "commit"}], flash=M)
check("done" in types_(out) and "modified" not in f, "a signed install, all as signed: the border goes")
out, f = run({"job": "Uninstall the app", "write": [], "delete": ["modified"], "apps": "[]"}, [{"type": "commit"}],
             flash=dict(M, **{"ui.py": b"x = 1\n"}))
check("done" not in types_(out) and "modified" in f, "a job can't delete the border's file")
W.SEALED = True
d = tempfile.mkdtemp(); o = os.getcwd(); os.chdir(d)
try:
    W.set_open()
    check(os.path.exists("modified"), "full control leaves the border's file")
finally:
    os.chdir(o); shutil.rmtree(d); W.SEALED = False; W._open = False

# 0.3.66+: the app list on its own, named by its hash in the signed list
if SPLIT:
    good = puts("keytest.py", kt) + [{"type": "commit"}]
    inst = {"job": "Install Buttons", "write": ["keytest.py"], "delete": ["hello.py"], "apps": json.dumps(buttons)}
    release()
    al = APPS_TEXT[0]
    out, f = run(inst, good, apps=pieces(al.replace("Buttons", "Buttonz")))
    check("done" not in types_(out) and "keytest.py" not in f and "isn't the signed one" in str(out), "an app list that isn't the signed one: refused (%s)" % out[-1:])
    out, f = run(inst, good, apps=pieces(al)[:-1])
    check("done" not in types_(out) and "keytest.py" not in f, "half the app list: refused (%s)" % out[-1:])
    out, f = run(inst, good, apps=[])
    check("done" not in types_(out) and "keytest.py" not in f, "no app list for an install: refused (%s)" % out[-1:])
    out, f = run(inst, [{"type": "apps", "t": al}] + good)
    check("done" not in types_(out) and "keytest.py" not in f and "comes before" in str(out), "the app list after the signed list: refused (%s)" % out[-1:])
    out, f = run(inst, good, apps=[{"type": "apps", "t": al[:-1]}])
    check("done" not in types_(out) and "whole line" in str(out), "a piece that ends mid-line: refused (%s)" % out[-1:])
    carts[1]["files"].append("slot.mpy")         # a signed app list that names a core file with other bytes
    try:
        out, f = run(inst, good, extra={"slot.mpy": "0" * 64})
        check("done" not in types_(out) and "twice" in str(out), "an app list naming a core file again: refused (%s)" % out[-1:])
    finally:
        carts[1]["files"].remove("slot.mpy")
    out, f = run({"job": "Update firmware", "write": ["slot.mpy"], "delete": [], "apps": json.dumps([{"mod": "hello"}])},
                 puts("slot.mpy", read("slot.mpy")) + [{"type": "commit"}], apps=[])
    check("done" in types_(out) and json.loads(f["apps.json"])[0]["mod"] == "hello", "'Update firmware' with no app list keeps its app (%s)" % out[-1:])

print(("SPLIT: " if SPLIT else "") + ("all ok" if not fails else "%d FAILED" % fails))
if not SPLIT and not os.environ.get("ONE"):     # again, the app list on its own
    fails += subprocess.run([sys.executable, __file__], env=dict(os.environ, SPLIT="1")).returncode != 0
sys.exit(1 if fails else 0)
