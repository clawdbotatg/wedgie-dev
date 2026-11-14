#!/usr/bin/env python3
"""An app's internet (firmware/net.py) against a computer that lies (audit 11-13). net.ask with a url, or a chain 1
call, is fetched by the wedgie over its own TLS: the computer can block it, never change it. It could: a "net" line
with that ask's rid put the computer's data over the fetched answer before the app took it. Checked here: a "net"
line counts only for an ask that was sent to the computer and isn't answered yet. The real net.py under CPython,
the board stubbed, the fetch itself faked (tools/netchip.mjs does it with the real TLS).
    python3 tools/test_netswap.py"""
import os, sys, types

FW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware")
sent = []
w = types.ModuleType("wedgie")
w.send = lambda line: sent.append(dict(line))
sys.modules["wedgie"] = w
sys.path.insert(0, FW)
import time  # noqa: E402
time.ticks_ms = lambda: 0
import net  # noqa: E402
net._serve = lambda: None       # no USB loop here

bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


def answer(rid):
    try:
        return net.answer(rid)
    except net.Error as e:
        return "Error: %s" % e


def boom(*a, **k):
    raise net.Error("no")


# 1. a url: fetched by the wedgie; the computer's line for its rid changes nothing
net.get = lambda url, pick=None, *a, **k: "REAL"
r = net.ask({"url": "https://x.example/a"})
net.got({"type": "net", "rid": r, "data": "FAKE"})
v = answer(r)
check(v == "REAL", 'a url ask, then the computer\'s "net" line for it: the app gets the site\'s answer (%r)' % (v,))
check(not sent, "a url ask sends the computer no net line")

# 2. a chain 1 call: the same
net._rpc = lambda method, params, *a, **k: "REAL"
r = net.ask({"chain": 1, "method": "eth_blockNumber"})
net.got({"type": "net", "rid": r, "data": "FAKE"})
v = answer(r)
check(v == "REAL", "a chain 1 ask, then the computer's line: the node's answer (%r)" % (v,))

# 7. its error can't be swapped for an answer either
net.get = boom
r = net.ask({"url": "https://x.example/a"})
net.got({"type": "net", "rid": r, "data": "ok"})
v = answer(r)
check(v == "Error: no", "a url ask that failed, then the computer's data: the real error (%r)" % (v,))
net.get = lambda url, pick=None, *a, **k: "REAL"

# the computer's line first (it can guess the next rid), then the ask
net.got({"type": "net", "rid": net._rid + 1, "data": "FAKE"})
r = net.ask({"url": "https://x.example/a"})
v = answer(r)
check(v == "REAL", "the computer's line before the ask: the site's answer (%r)" % (v,))

# 3. another chain goes to the computer: its answer is the answer, as before
r = net.ask({"chain": 8453, "method": "eth_blockNumber"})
check(sent and sent[-1].get("type") == "net" and sent[-1].get("rid") == r, "a chain 8453 ask goes to the computer")
check(answer(r) is None, "no answer yet: None")
net.got({"type": "net", "rid": r, "data": "0x10"})
v = answer(r)
check(v == "0x10", "its answer from the computer (%r)" % (v,))
check(answer(r) is None, "taken once")

# 4. an ask is answered once
r = net.ask({"chain": 8453, "method": "eth_blockNumber"})
net.got({"type": "net", "rid": r, "data": "first"})
net.got({"type": "net", "rid": r, "data": "second"})
v = answer(r)
check(v == "first", "two answers to one ask: the first (%r)" % (v,))
net.got({"type": "net", "rid": r, "data": "third"})
check(answer(r) is None, "an answer after it was taken: nothing")
r = net.ask({"chain": 8453, "method": "x"})
net.got({"type": "net", "rid": r, "error": "nope"})
check(answer(r) == "Error: nope", "the computer's error for its own ask still raises")

# 5. rids never asked
n = len(net._got)
for rid in (net._rid + 50, 0, -1, "1", None and 0, 1.0, True):
    net.got({"type": "net", "rid": rid, "data": "x"})
check(len(net._got) == n, "lines for rids never asked (ahead, 0, -1, text, a float, True): ignored")

# 6. a site's bytes still reach its connection; a "net" line for a connection's rid goes nowhere
link = net._Link("x.example", None)
check(link.rid in net._out, "a new connection's first line waits for a computer")
net.got({"type": "net", "rid": link.rid, "data": "FAKE"})
check(link.rid not in net._got and link.rid in net._out, 'a "net" line for a connection\'s rid: ignored, its first line still waits')
net.got({"type": "tcp", "rid": link.rid, "d": "aGk="})
check(link.q == [b"hi"] and link.rid not in net._out, "a tcp line reaches its connection (%r)" % (link.q,))
net.got({"type": "tcp", "rid": link.rid, "end": True})
check(link.q == [b"hi", None], "and its end")
link.end()

# a late computer: asks nobody answered go out again, answered ones don't
r1 = net.ask({"chain": 8453, "method": "a"})
r2 = net.ask({"chain": 8453, "method": "b"})
net.got({"type": "net", "rid": r1, "data": 1})
del sent[:]
net.got({"type": "net"})
check([m.get("rid") for m in sent] == [r2], "{type: net} with no rid: only the unanswered ask is sent again (%r)" % ([m.get("rid") for m in sent],))
net.got({"type": "net", "rid": r2, "data": 2})
check((answer(r1), answer(r2)) == (1, 2), "both answers arrive")

# asks nobody waits for any more: the oldest of more than 4 is dropped, and so is a late answer to it
rs = [net.ask({"chain": 8453, "method": "m%d" % i}) for i in range(5)]
for x in rs:
    net.got({"type": "net", "rid": x, "data": x})
check([answer(x) for x in rs] == [None] + rs[1:], "five asks at once: the newest four are answered")

print("\n%s" % ("ALL OK" if not bad else "%d FAILED" % bad))
sys.exit(1 if bad else 0)
