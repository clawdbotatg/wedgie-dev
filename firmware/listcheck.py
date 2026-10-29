# The signed list's check while a job's question is up (slot._sig): loaded only then, and dropped after. Its own
# file because slot.py stays loaded beside every app: 0.3.66's app-list lines in it left Safe Signer's heap too
# broken up to confirm a big transaction (tools/safechip.mjs).
import json, time, hashlib, binascii
import wedgie as W

SIG_WAIT = 8000     # ms with nothing from the host: it stopped sending the list


def run(mid, app, v, tick, poll):
    """Ask the host for the list ({"type": "list"}): 0.3.66+, for "Install X", the app list first in pieces of
    whole lines, {"type": "apps", "t": ...} (it must name X and hash to the signed list's "@apps"); then the
    signed list, {"type": "rel", "t": ...}, and {"type": "rel", "sig": ...}. Each piece is hashed and dropped.
    True: signed, for the version (and the app) the question names. False: not. Raises StopIteration: no list
    came; MemoryError."""
    W.send({"id": mid, "type": "list"})
    h, n, named, sg = hashlib.sha256(), 0, app is None, None
    ah, tag = None, None
    R, t0 = W.lines(), time.ticks_ms()
    while sg is None:
        tick()
        line = R.pump(poll, 20)
        if line is None:
            if time.ticks_diff(time.ticks_ms(), t0) > SIG_WAIT:
                raise StopIteration
            continue
        t0 = time.ticks_ms()
        q = json.loads(line) if line else {}
        line = None
        t = q.get("t") or ""
        if t and t[-1] != "\n":
            raise ValueError("a piece ends in a whole line")
        if q.get("type") == "apps" and n == 0:
            ah = ah or hashlib.sha256()
            ah.update(t)
            for l in t.split("\n"):
                if app and l.startswith("@app  ") and json.loads(l[6:]).get("name") == app:
                    named = "apps"
            continue
        if q.get("type") != "rel":
            raise StopIteration
        h.update(t)
        for l in t.split("\n")[:-1]:
            if n == 0 and l != "wedgie-release 1" or n == 1 and l != "version %s" % v:
                raise ValueError("not this release")
            if l.startswith("@apps  "):
                tag = l[7:]
            if app and l.startswith("@app  ") and json.loads(l[6:]).get("name") == app:
                named = True
            n += 1
        sg = q.get("sig")
    if named == "apps":                 # named in the app list: only if that's the list it signed
        named = binascii.hexlify(ah.digest()).decode() == tag
    return n > 1 and named and W.release_ok(None, sg, tick, h.digest())


def unsigned(d):
    """After a yes on a list no release key signed (the question's warning sign, or job.check after the yes):
    nothing changed, and the screen says where to put it on anyway (Austin, 10-28: a wedgie that only restarted
    read as a crash). Here, not in slot.py: that one stays loaded beside every app."""
    import lcd, ui
    ui.page(d, "Not signed", [("Nothing changed.", ui.INK), ("To install anyway:", ui.INK), ("wedgie.dev/reset", ui.RED)], show=False)
    if d.width >= 240:
        ui.warn(d, 112, 52)
    d.show()
    ui.wait(lcd.Keys(physical=True), 8000)
