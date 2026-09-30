# wedgie.dev/debug and `wedgie.py debug` run this in the raw REPL (after the person lets the computer in)
# and print one "@debug {json}" line: what's on it and why it might have broken. Read-only.
import os, sys, gc, json, machine
def _debug():
    d = {"machine": sys.implementation._machine, "micropython": os.uname().release}
    try:
        import wedgie
        d["version"] = wedgie.VERSION
        d["apps"] = wedgie.apps()
    except Exception as e:
        d["wedgie"] = "can't import wedgie: %r" % e
    try:
        d["reset_cause"] = machine.reset_cause()
    except Exception:
        pass
    files = []
    def walk(p):
        for n in sorted(os.listdir(p)):
            q = (p.rstrip("/") + "/" + n) if p != "" else n
            s = os.stat(q)
            if s[0] & 0x4000:
                walk(q)
            else:
                files.append([q, s[6]])
    walk("")
    d["files"] = files
    s = os.statvfs("/")
    d["flash_free"] = s[0] * s[3]
    gc.collect()
    d["ram_free"] = gc.mem_free()
    d["modules"] = sorted(k for k in sys.modules)
    for n in ("error.log", "apptimes.txt"):
        try:
            with open(n) as f:
                d[n] = f.read()[-4000:]
        except OSError:
            pass
    print("@debug", json.dumps(d))
_debug()
del _debug
