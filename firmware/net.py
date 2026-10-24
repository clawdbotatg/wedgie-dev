# net: the internet for an app, through the computer it's plugged into (0.3.61+). A wedgie has no internet:
# its page on wedgie.dev (/connect/<ID>, open in a tab) or `wedgie.py net` fetches for it, through wedgie.dev
# (api/net.ts, api/rpc.ts). Only the sites the app lists in its wedgie.json are fetched:
#   "net": ["poidh.xyz", "chain"]          ("chain": read-only chain calls and prices, Alchemy's key stays on wedgie.dev)
#
#   import net
#   net.get("https://poidh.xyz/bounties/data", pick="0:5.{title,amount}")   -> the JSON (or text), trimmed
#   net.chain(8453, "eth_getBalance", ["0x...", "latest"])                    -> the call's result
#   net.price()                                                               -> ETH in dollars (a float)
#
# Each waits for its answer (up to ms) and raises net.Error if none comes: draw your loading screen first.
# Not waiting: rid = net.ask({...}); then net.answer(rid) each tick (None until it's in).
# Wire (public/usb.md): {"type": "net", "rid": 7, "url": ..., "pick": ...} or {"type": "net", "rid": 7, "chain":
# 1, "method": ..., "params": [...]}; the answer {"type": "net", "rid": 7, "data": ...} or {..., "error": "..."}.
import time
import wedgie as W

MS = 15000


class Error(Exception):
    pass


_rid = 0
_got = {}           # rid -> its answer line (a dict), till the app takes it


def ask(req):
    """Send one request; returns its rid. The answer comes back through slot.py (got)."""
    global _rid
    _rid += 1
    req["type"], req["rid"] = "net", _rid
    W.send(req)
    return _rid


def got(m):
    """slot.py: a "net" line from the computer."""
    rid = m.get("rid")
    if isinstance(rid, int) and 0 < rid <= _rid:
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


def wait(rid, ms=MS):
    import slot
    serve = slot.state != "entry" or slot._own_usb()    # an entry app's USB has its own timer (slot.step)
    t = time.ticks_ms()
    while rid not in _got:
        if time.ticks_diff(time.ticks_ms(), t) > ms:
            raise Error("no internet: open its page on wedgie.dev")
        if serve:
            slot.serve()
        time.sleep_ms(20)
    return answer(rid)


def get(url, pick=None, ms=MS):
    req = {"url": url}
    if pick is not None:
        req["pick"] = pick
    return wait(ask(req), ms)


def chain(chain_id, method, params=(), ms=MS):
    return wait(ask({"chain": chain_id, "method": method, "params": list(params)}), ms)


def price(ms=MS):
    return chain(1, "wedgie_prices", (), ms)["eth"]
