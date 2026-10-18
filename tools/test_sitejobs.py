#!/usr/bin/env python3
"""The jobs wedgie.dev's pages really send, against the real firmware's rules: the probes' fake wedgies log
every job (tools/fakewedgies.mjs jobLog, written by prepareprobe/updateprobe to sitejobs.json), and each
one sent to firmware this version or newer goes through firmware/job.py check() under CPython, on a
scratch flash holding what that wedgie held. A job the wedgie would refuse fails here, before a person
sees it fail on a real board (2026-10-18: "Install Welcome" that also wrote the firmware, refused on
every real wedgie after the yes; the fake let it through).
    python3 tools/test_sitejobs.py [sitejobs.json ...]   (after npm run build: uses dist/fw/release.txt)"""
import sys, os, json, tempfile, shutil, types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "firmware"))
machine = types.ModuleType("machine")
machine.unique_id = lambda: b"\x01" * 8
sys.modules["machine"] = machine
sel = types.ModuleType("select")
sel.POLLIN = 1
sys.modules["select"] = sel
sys.modules["micropython"] = types.ModuleType("micropython")
import wedgie as W   # noqa: E402
import job           # noqa: E402

ver = lambda v: tuple(int(x) for x in v.split("."))
rel = open(os.path.join(HERE, "..", "dist", "fw", "release.txt")).read()
logs = sys.argv[1:] or [os.path.join(HERE, "..", "shots", n) for n in ("sitejobs-prepare.json", "sitejobs-update.json")]
n = bad = 0
for path in logs:
    for e in json.load(open(path)):
        if not e.get("version") or ver(e["version"]) < ver(W.VERSION):
            continue                    # older firmware runs its own older rules
        d = tempfile.mkdtemp()
        old = os.getcwd()
        os.chdir(d)
        try:
            for f in e["files"]:
                if "/" not in f:
                    open(f, "wb").write(b"x")
            open("apps.json", "w").write(json.dumps(e["apps"]))
            m = dict(e["msg"], release=rel)
            n += 1
            try:
                job.check(m, sig=False)
                print("ok  ", m.get("job"), "on", e["version"], "write", len(m.get("write") or []), "delete", m.get("delete"))
            except ValueError as x:
                bad += 1
                print("FAIL", m.get("job"), "on", e["version"], "refused:", x)
        finally:
            os.chdir(old)
            shutil.rmtree(d)
if not n:
    print("FAIL no jobs for firmware %s+ in %s" % (W.VERSION, logs))
    bad += 1
print("%d jobs, %s" % (n, "all ok" if not bad else "%d FAILED" % bad))
sys.exit(1 if bad else 0)
