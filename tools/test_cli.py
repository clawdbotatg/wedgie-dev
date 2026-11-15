#!/usr/bin/env python3
"""wedgie.py use never turns a checked install into FULL CONTROL because the wedgie kept quiet (audit 11-13,
INST-18). An app that doesn't answer one 1.5 s hello looked like "old firmware": take_over then sent Ctrl-C,
which a locked wedgie answers with its red question. Now only a hello that says firmware before 0.3.12 goes
that way; no answer, or an unsigned list for newer firmware, stops with a message.
    python3 tools/test_cli.py"""
import importlib.util, os, sys, types

sys.modules.setdefault("serial", types.ModuleType("serial"))       # no port here
sys.modules.setdefault("serial.tools", types.ModuleType("serial.tools"))
sys.modules.setdefault("serial.tools.list_ports", types.ModuleType("serial.tools.list_ports"))

spec = importlib.util.spec_from_file_location("cli", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "wedgie.py"))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


class Wg:
    def __init__(self, answers):
        self.answers, self.asked = list(answers), 0

    hello_late = cli.Wedgie.hello_late

    def hello(self, timeout=1.0):
        self.asked += 1
        return self.answers.pop(0) if self.answers else None

    def request(self, msg, timeout=5):
        return {"sums": {}, "apps": []}


def run(wg, m):
    try:
        return cli.checked(wg, m)
    except (RuntimeError, SystemExit) as e:
        return "stopped: %s" % e


M = {"signed": True, "core": [], "carts": [], "files": []}
NEW = {"type": "hello", "version": "0.3.80", "jobs": 3}
got = run(Wg([NEW]), M)
check(isinstance(got, dict), "it answers, the list is signed: a checked install (%r)" % (got if isinstance(got, str) else "have"))
wg = Wg([])
got = run(wg, M)
check(isinstance(got, str), "it never answers: stops, no full control (%r)" % (got,))
check(wg.asked >= 3, "after more than one try (%d)" % wg.asked)
got = run(Wg([None, NEW]), M)
check(isinstance(got, dict), "a busy app answers the second hello: a checked install")
got = run(Wg([NEW]), dict(M, signed=False))
check(isinstance(got, str) and "signed" in got, "newer firmware, a list that isn't signed: stops (%r)" % (got,))
got = run(Wg([{"type": "hello", "version": "0.3.11", "jobs": 2}]), M)
check(got is None, "firmware before 0.3.12 says so itself: full control, once (%r)" % (got,))
got = run(Wg([{"type": "hello", "version": "0.2.9"}]), M)
check(got is None, "firmware with no jobs: full control (%r)" % (got,))

# ---- wedgie.py update on 0.3.55+: a checked job, the firmware only (INST-2). What it sends goes through the
# real firmware's check (firmware/job.py), on a scratch flash, as tools/test_sitejobs.py does for the page's jobs.
import hashlib, json, shutil, tempfile  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FW = os.path.join(HERE, "..", "firmware")
REL = os.path.join(HERE, "..", "release")       # the signed list, as committed (public/fw is a build's copy)
sys.path.insert(0, os.path.join(HERE, "..", "firmware"))
machine = types.ModuleType("machine")
machine.unique_id = lambda: b"\x01" * 8
sys.modules["machine"] = machine
sel = types.ModuleType("select")
sel.POLLIN = 1
sys.modules["select"] = sel
sys.modules["micropython"] = types.ModuleType("micropython")
import wedgie as W  # noqa: E402
import job          # noqa: E402

rel = open(os.path.join(REL, "firmware.txt")).read()
al = open(os.path.join(REL, "apps.txt")).read() if "\n@apps  " in rel else ""
listed = [l.split("  ", 1) for l in rel.split("\n")[2:] if l and not l.startswith("@")]
man = {"version": rel.split("\n")[1][8:], "core": [n for _, n in listed], "files": [{"name": n, "sha256": h} for h, n in listed], "carts": []}
other = next(l.split("  ", 1)[1] for l in al.split("\n") if l and not l.startswith("@"))      # an app's file: never part of a firmware update
stale = [n for n in man["core"] if n != "main.py"][:2]
d, old = tempfile.mkdtemp(), os.getcwd()
os.chdir(d)
try:
    hashes = {}
    for n in man["core"]:
        data = b"old" if n in stale else open(os.path.join(FW, n), "rb").read()
        open(n, "wb").write(data)
        hashes[n] = hashlib.sha256(data).hexdigest()
    apps = []
    open("apps.json", "w").write(json.dumps(apps))
    have = {"hashes": hashes, "apps": apps, "files": list(hashes)}
    write = cli.update_writes(man, have)
    check(sorted(write) == sorted(stale), "an update sends only the firmware files that differ (%s)" % write)
    check(cli.update_writes(man, dict(have, hashes={n: hashlib.sha256(open(os.path.join(FW, n), "rb").read()).hexdigest() for n in man["core"]})) == [],
          "nothing to send when it's up to date")
    m = {"type": "job", "job": "Update firmware", "write": write, "delete": [], "apps": None, "release": rel}
    if al:
        m["_apps"] = job.Apps(job.keep(m))
        m["_apps"].feed(al)
    try:
        job.check(m, sig=False)
        check(True, "the firmware takes that job (its app stays: apps.json isn't in it)")
    except ValueError as e:
        check(False, "the firmware refused the job: %s" % e)
    m2 = dict(m, write=write + [other])
    m2.pop("clean", None)
    try:
        job.check(m2, sig=False)
        check(False, "(the test's own check) an update that also writes an app file is refused")
    except ValueError:
        check(True, "(the test's own check) an update that also writes an app file is refused")
finally:
    os.chdir(old)
    shutil.rmtree(d)

# no answer and no open REPL: update stops before any Ctrl-C
src = open(os.path.join(HERE, "..", "public", "wedgie.py")).read()
up = src[src.index('elif c == "update":'):src.index('elif c == "debug":')]
check(up.index("repl_open()") < up.index("take_over(") and "args.dev" in up, "update asks for an open REPL (Ctrl-A) before it ever takes over; --dev is the way to full control")
print("\n%s" % ("ALL OK" if not bad else "%d FAILED" % bad))
sys.exit(1 if bad else 0)
