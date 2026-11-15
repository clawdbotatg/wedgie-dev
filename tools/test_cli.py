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
print("\n%s" % ("ALL OK" if not bad else "%d FAILED" % bad))
sys.exit(1 if bad else 0)
