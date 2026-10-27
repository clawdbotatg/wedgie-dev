# net: the internet for an app, through the computer it's plugged into (0.3.61+). A wedgie has no internet:
# its page on wedgie.dev (/connect/<ID>, open in a tab) or `wedgie.py net` carries it. Only the sites the app
# lists in its wedgie.json are reached:
#   "net": ["poidh.xyz", "chain"]          ("chain": read-only chain calls and prices)
#
#   import net
#   net.get("https://poidh.xyz/bounties/data", pick="0:5.{title,amount}")   -> the JSON (or text), trimmed
#   net.post("https://poidh.xyz/api", {"q": 1}, pick="data")                 -> the same, for a POST of JSON
#   net.chain(8453, "eth_getBalance", ["0x...", "latest"])                    -> the call's result
#   net.price()                                                               -> ETH in dollars (a float)
#   net.get(url, log=f)      (0.3.72+, also post/chain(1)/price): f(step) as each happens, to show them: "connect",
#                            "keys", "open", "asked", "cert 0" .. (each certificate checked), "signed" (the
#                            site's own signature checked), "answer". Each step has passed when it's said.
#
# net.get and net.post (0.3.67+, post 0.3.70+) are the wedgie's own TLS 1.3 to the site (tls.py, the Trust M
# does the math): the computer and wedgie.dev's relay carry encrypted bytes, so they can block an answer but
# never read or change it. The whole answer must fit in MOST bytes; pick runs here.
# net.chain(1, ...) and net.price() (0.3.70+) are the same: Ethereum's RPC node at BuidlGuidl (RPC1), the price
# from Chainlink's ETH/USD feed. Other chains and the wedgie_* methods are wedgie.dev's answers (its Alchemy
# key): the computer or wedgie.dev could change those.
# Each waits for its answer (up to ms) and raises net.Error if none comes: draw your loading screen first.
# Not waiting (chain calls): rid = net.ask({...}); then net.answer(rid) each tick (None until it's in). A url
# ask does the whole fetch before it returns.
# Wire (public/usb.md): a site: {"type": "tcp", "rid": 7, "host": ...}, then {"type": "tcp", "rid": 7, "d": <base64>}
# both ways, {..., "end": true} or {..., "error": "..."} to close. A chain call: {"type": "net", "rid": 7, "chain":
# 1, "method": ..., "params": [...]}; the answer {"type": "net", "rid": 7, "data": ...} or {..., "error": "..."}.
# {"type": "net"} with no rid (0.3.69+): a host carries net from now on. Lines nobody answered yet go out again
# (after an install the app asks before its page has found it: those were lost, and it said No internet).
import time
import wedgie as W

MS = 15000
MOST = 6000         # the biggest answer a site may send (bytes, the body): it's all in RAM before pick
RPC1 = "https://mainnet.rpc.buidlguidl.com/"    # Ethereum reads, over the wedgie's own TLS
FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"     # Chainlink ETH/USD on Ethereum (8 decimals)


class Error(Exception):
    pass


_rid = 0
_got = {}           # rid -> its answer line (a dict), till the app takes it
_tcp = {}           # rid -> what the computer sent on that connection, not read yet: [bytes | None (end) | str (error)]
_out = {}           # rid -> the lines sent on it that nothing has answered yet (ready sends them again)


def _send(rid, line):
    W.send(line)
    if rid in _out:
        _out[rid].append(line)


def ready():
    """A host just started carrying net: everything nobody answered goes out again, in order."""
    for rid in sorted(_out):
        for line in _out[rid]:
            W.send(line)


def ask(req):
    """Send one request; returns its rid. The answer comes back through slot.py (got). A url: fetched now."""
    global _rid
    _rid += 1
    if "url" in req or _own(req):
        try:
            _got[_rid] = {"data": get(req["url"], req.get("pick")) if "url" in req else _rpc(req["method"], req.get("params") or [])}
        except Error as e:
            _got[_rid] = {"error": str(e)}
        return _rid
    req["type"], req["rid"] = "net", _rid
    _out[_rid] = []
    while len(_out) > 4:            # asks nobody waits for any more
        del _out[min(_out)]
    _send(_rid, req)
    return _rid


def _own(req):
    """An Ethereum read the wedgie makes itself (RPC1), not through wedgie.dev."""
    return req.get("chain") == 1 and not str(req.get("method", "")).startswith("wedgie_")


def _rpc(method, params, ms=MS, log=None):
    import json
    v = post(RPC1, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)}), ms=ms, log=log)
    if not isinstance(v, dict):
        raise Error("not JSON-RPC")
    if "error" in v:
        e = v["error"]
        raise Error(str(e.get("message", e) if isinstance(e, dict) else e)[:120])
    return v.get("result")


def got(m):
    """slot.py: a "net" or "tcp" line from the computer."""
    rid = m.get("rid")
    if rid is None:
        return ready()
    if not (isinstance(rid, int) and 0 < rid <= _rid):
        return
    _out.pop(rid, None)             # a host has it
    if m.get("type") == "tcp":
        q = _tcp.get(rid)
        if q is not None:
            if m.get("d"):
                import binascii
                q.append(binascii.a2b_base64(m["d"]))
            elif m.get("error"):
                q.append(str(m["error"])[:120])
            elif m.get("end"):
                q.append(None)
        return
    _got[rid] = m
    while len(_got) > 4:            # answers nobody took
        del _got[min(_got)]


def answer(rid):
    """None while it's on its way; then its data (raises Error if the computer said no)."""
    m = _got.pop(rid, None)
    if m is None:
        return None
    if m.get("error"):
        raise Error(str(m["error"])[:120])
    return m.get("data")


def _serve():
    import slot
    return slot.serve if slot.state != "entry" or slot._own_usb() else None    # an entry app's USB has its own timer


def wait(rid, ms=MS):
    serve = _serve()
    t = time.ticks_ms()
    while rid not in _got:
        if time.ticks_diff(time.ticks_ms(), t) > ms:
            _out.pop(rid, None)
            raise Error("no internet: open its page on wedgie.dev")
        if serve:
            serve()
        time.sleep_ms(20)
    return answer(rid)


def post(url, data, pick=None, ms=MS, log=None):
    """POST JSON (a dict or list, or a str already JSON) to an https site over the wedgie's own TLS."""
    if not isinstance(data, str):
        import json
        data = json.dumps(data)
    if len(data) > 1500:
        raise Error("too much to send")
    return get(url, pick, ms, data.encode(), log)


def get(url, pick=None, ms=MS, body=None, log=None):
    """GET an https site over the wedgie's own TLS; its JSON (or text), with pick applied."""
    if not url.startswith("https://"):
        raise Error("https only")
    host, _, path = url[8:].partition("/")
    if not host or ":" in host or "@" in host:
        raise Error("a site name, no port")
    global _rid
    _rid += 1
    rid, serve = _rid, _serve()
    q, said = _tcp.setdefault(rid, []), []
    _out[rid] = []
    _send(rid, {"type": "tcp", "rid": rid, "host": host})
    if log:
        log("connect")

    def send(b):
        import binascii
        _send(rid, {"type": "tcp", "rid": rid, "d": binascii.b2a_base64(b, newline=False).decode()})

    def recv():
        t = time.ticks_ms()
        while not q or later:
            if later:                   # an install is waiting: stop this fetch now (10-27: an install waited 41 s
                said.append("stopped: an install came")   # on 4 fetches in a row)
                return b""
            if time.ticks_diff(time.ticks_ms(), t) > ms:
                raise Error("no internet: open its page on wedgie.dev")
            if serve:
                serve()
            time.sleep_ms(10)
        x = q.pop(0)
        if isinstance(x, str):          # the computer's reason it closed ("not in its net", "can't reach")
            said.append(x)
            return b""
        return x or b""
    import sys
    import gc
    import trustm
    import slot
    # A job, open or rm stops the fetch (recv), then runs: run inside the TLS's stack, an install's question hit "maximum
    # recursion depth" (wedgie-dev-bd, 10-26). Here, not in slot.py: its every byte stays in RAM (safechip).
    h, later = slot.handle, []
    slot.handle = lambda m: later.append(m) if m.get("type") in ("job", "open", "rm") and len(later) < 4 else h(m)
    trustm.busy[0] += 1                 # the whole fetch: the host's chip check (wedgie.chip) resets the chip, which
    try:                                # wipes this connection's key and fails both (10-26: "No chip" on the page)
        import tls
        try:
            body = tls.Conn(host, send, recv, log=log).get("/" + path, most=MOST, body=body)
        except tls.Error as e:
            raise Error(said[0] if said else str(e))
        except OSError as e:            # no Trust M to do the math
            raise Error("needs the Trust M chip (%s)" % e)
    finally:
        trustm.busy[0] -= 1
        slot.handle = h
        del _tcp[rid]
        _out.pop(rid, None)
        W.send({"type": "tcp", "rid": rid, "end": True})
        sys.modules.pop("tls", None)    # ~11 KB of code: back as soon as it's done
        gc.collect()
        import micropython
        for m in later:                 # as the USB Timer runs it: nothing else reads USB under its question
            micropython.schedule(h, m)
    try:
        import json
        v = json.loads(body)
    except ValueError:
        v = body.decode() if pick is None or isinstance(pick, str) else None
        if v is None:
            raise Error("not JSON")
    del body
    return v if pick is None else pick_of(v, pick)


def pick_of(v, pick):
    """pick: one path ("0:5.{title,amount}") or {name: path}. A path is steps split by ".": a field, 3 an item (-1
    the last), 2:5 items 2-4 (each takes the rest of the path; on text, its characters), * every item, {a,b} just
    those fields. A step that doesn't fit gives None. (wedgie.dev's api/net.ts pickOf, the same.)"""
    if isinstance(pick, str):
        return _walk(v, pick.split(".") if pick else [])
    if isinstance(pick, dict):
        return {k: pick_of(v, p) if isinstance(p, str) else None for k, p in list(pick.items())[:30]}
    return v


def _slice(s):
    a, _, b = s.partition(":")
    try:
        return slice(int(a) if a else None, int(b) if b else None)
    except ValueError:
        return None


def _walk(v, steps):
    if not steps or v is None:
        return v
    s, rest = steps[0], steps[1:]
    if s.startswith("{") and s.endswith("}"):
        if not isinstance(v, dict):
            return None
        return {k: _walk(v.get(k), rest) for k in (x.strip() for x in s[1:-1].split(",")) if k}
    if isinstance(v, str):
        sl = _slice(s) if ":" in s else None
        return _walk(v[sl], rest) if sl else None
    if isinstance(v, list):
        if s == "*":
            return [_walk(x, rest) for x in v]
        if ":" in s:
            sl = _slice(s)
            return [_walk(x, rest) for x in v[sl]] if sl else None
        try:
            i = int(s)
        except ValueError:
            return None
        return _walk(v[i], rest) if -len(v) <= i < len(v) else None
    if isinstance(v, dict) and s in v:
        return _walk(v[s], rest)
    return None


def chain(chain_id, method, params=(), ms=MS, log=None):
    if _own({"chain": chain_id, "method": method}):
        return _rpc(method, params, ms, log)
    return wait(ask({"chain": chain_id, "method": method, "params": list(params)}), ms)


def price(ms=MS, log=None):
    """ETH in dollars: Chainlink's feed on Ethereum (latestAnswer), read over the wedgie's own TLS."""
    return int(_rpc("eth_call", ({"to": FEED, "data": "0x50d25bcd"}, "latest"), ms, log), 16) / 1e8
