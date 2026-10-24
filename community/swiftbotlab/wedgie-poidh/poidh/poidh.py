# poidh for wedgie: browse live poidh bounties (Ethereum, Base, Arbitrum) and their claims.
#
# A wedgie has no internet, so a computer runs the bridge (bridge/poidh_bridge.py). The app asks for
# what it shows, one JSON line at a time on USB, and the bridge answers with real poidh data:
#   app -> bridge  {"type": "poidh_want", "rid": 7, "what": "list", "chain": 0, "page": 0}
#                  {"type": "poidh_want", "rid": 8, "what": "bounty", "chain": 8453, "id": 1504}
#                  {"type": "poidh_want", "rid": 9, "what": "claims", "chain": 8453, "id": 1504, "page": 0}
#                  {"type": "poidh_want", "rid": 10, "what": "claim", "chain": 8453, "id": 1504, "claim": 9003}
#   bridge -> app  {"type": "poidh", "rid": 7, ...}   (the bridge formats and wraps all text for this screen)
# The app owns its USB ("usb": true in wedgie.json); every other request (hello, shot, open, jobs) goes
# on to the firmware's own handler, so wedgie.dev and wedgie.py still work while it runs.
#
# Controls: joystick up/down moves, left/right changes chain (list) or pages (text), green (or a press
# of the joystick) opens, red goes back, the grey button next to green (X) reloads.
import sys, select, json, time, gc
import lcd as L
import wedgie as W
import ui
from ui import WHITE, INK, MUTED, GREEN_D, RED

FRAME = 30                          # ms per loop
RETRY = 3000                        # ms before asking the bridge again
PER = 6                             # rows per list page (the bridge pages by this)
COLS = 29                           # characters across at scale 1 (4 px margins)
SEL = L.color(236, 237, 238)        # the selected row's background
LINE = L.color(216, 217, 218)
CHAINS = ((0, "All"), (1, "Ethereum"), (8453, "Base"), (42161, "Arbitrum"))

d = None
keys = None
_poll = None
rid = 0
want = None                         # the request we wait for: its dict (resent until answered)
sent_at = 0
bridge = False                      # the bridge answered at least once
err = None
dirty = True

view = "list"                       # list | bounty | claims | claim
chain_i = 0
sel = 0                             # list: index across all pages
lst = None                          # {"page", "total", "items"} of the list page on screen
bounty = None                       # the bounty open: its dict from the bridge
scroll = 0
csel = 0
cl = None                           # claims page
claim = None


def ask(what, **kw):
    global rid, want, sent_at, err, dirty
    rid += 1
    want = dict(kw, type="poidh_want", rid=rid, what=what)
    sent_at = time.ticks_ms()
    err = None
    dirty = True
    W.send(want)


def resend():
    global sent_at
    if want and time.ticks_diff(time.ticks_ms(), sent_at) > RETRY:
        sent_at = time.ticks_ms()
        W.send(want)


def got(m):
    """An answer from the bridge."""
    global want, bridge, err, lst, bounty, cl, claim, dirty, scroll
    bridge = True
    if not want or m.get("rid") != want.get("rid"):
        return                      # an old answer (the person moved on)
    what = want["what"]
    want = None
    dirty = True
    if m.get("error"):
        err = str(m["error"])[:120]
        return
    if what == "list":
        lst = m
    elif what == "bounty":
        bounty, scroll = m, 0
    elif what == "claims":
        cl = m
    elif what == "claim":
        claim, scroll = m, 0
    gc.collect()


def handle(m):
    global dirty, bridge, sent_at
    t = m.get("type")
    if t == "poidh":
        got(m)
    elif t == "poidh_hi":           # the bridge started: ask again now
        bridge = True
        if want:
            sent_at = time.ticks_ms() - RETRY - 1
        dirty = True
    elif t == "hello":
        W.send(W.hello(m.get("id"), running="poidh"))
    else:                           # hello's cousins, shots, jobs, open: the firmware's
        import slot
        slot.handle(m)
        dirty = True


def pump():
    global dirty
    R = W.lines()
    for _ in range(4):
        line = R.pump(_poll)
        if R.intr:                  # a Ctrl-C while sealed: the firmware's red question
            R.intr = False
            if W.SEALED and not W.is_open():
                try:
                    import hatch
                    ok = hatch.ctrl_c()
                except Exception as e:
                    sys.print_exception(e)
                    ok = False
                if ok:
                    raise KeyboardInterrupt
                dirty = True
        if line is None:
            return
        if line is False or not line.strip().startswith(b"{"):
            continue
        try:
            m = json.loads(line)
        except Exception:
            line = None
            gc.collect()
            continue
        line = None
        if isinstance(m, dict):
            try:
                handle(m)
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as e:
                W.failed(m.get("id"), e)


# ---- drawing --------------------------------------------------------------------------------------

def s(v, n=COLS):
    v = str(v) if v is not None else ""
    return v if len(v) <= n else v[:n - 1] + "~"


def header(left, right=""):
    d.fill(WHITE)
    d.big_text(s(left, 14), 4, 4, INK, 2)
    if right:
        r = s(right, 14)
        d.text(r, ui.right() - 8 * len(r), 9, MUTED)
    for i, c in enumerate((ui.GREEN, ui.GREY, RED)):
        d.fill_rect(0, 24 + i * 3, 240, 2, c)


def footer(hint):
    d.hline(0, 220, 240, LINE)
    ui.say(d, hint, 227, MUTED)


def status_line(y=120):
    if err:
        ui.say(d, s(err), y, RED)
        ui.say(d, "{k} try again", y + 14, MUTED)
    elif not bridge:
        ui.say(d, "Waiting for the bridge", y, INK)
        ui.say(d, "run poidh_bridge.py", y + 16, MUTED)
        ui.say(d, "on your computer", y + 28, MUTED)
    else:
        ui.say(d, "Loading...", y, MUTED)


def rows(items, start, cur, line1, line2):
    y = 34
    for i, it in enumerate(items):
        on = start + i == cur
        if on:
            d.fill_rect(0, y, 240, 30, INK)
        a, b, c = line2(it)
        d.text(s(line1(it)), 4, y + 4, WHITE if on else INK)
        d.text(a, 4, y + 17, ui.GREEN if on else GREEN_D)
        if b:
            d.text(s(b, COLS - len(a) - 1), 4 + 8 * (len(a) + 1), y + 17, LINE if on else MUTED)
        if c:
            d.text(c, 236 - 8 * len(c), y + 17, LINE if on else MUTED)
        if not on:
            d.hline(0, y + 30, 240, LINE)
        y += 31


def draw_list():
    name = CHAINS[chain_i][1]
    total = lst.get("total", 0) if lst else 0
    header("poidh", ("< %s >" % name) if not lst else "%s %d/%d" % (name, min(sel + 1, total), total))
    if lst and not want and not err:
        if not lst["items"]:
            ui.say(d, "No open bounties", 110, INK)
            ui.say(d, "on %s right now" % name, 126, MUTED)
        else:
            rows(lst["items"], lst["page"] * PER, sel, lambda b: b["t"], lambda b: (b["a"], b["c"], b["ago"]))
    else:
        status_line()
    footer("{g} open  < > chain  {k} reload")


def draw_text(head, right, body, hint):
    """A page of text rows [text, color, scale]; scroll moves through them."""
    header(head, right)
    if body is None:
        status_line()
    else:
        y = 36
        for r in body[scroll:]:
            h = 16 * r[2] if r[2] > 1 else 13
            if y + h > 218:
                break
            col = (INK, MUTED, GREEN_D, RED)[r[1]]
            if r[2] > 1:
                d.big_text(s(r[0], 29 // r[2]), 4, y, col, r[2])
            elif r[0] == "-":
                d.hline(4, y + 5, 232, LINE)
            else:
                d.text(s(r[0]), 4, y, col)
            y += h
        if len(body) > 1 and (scroll > 0 or y > 205):
            n = len(body)
            top = 36 + 180 * scroll // n
            d.fill_rect(237, top, 3, max(8, 180 * 12 // n), MUTED)
    footer(hint)


def draw():
    if view == "list":
        draw_list()
    elif view == "bounty":
        b = bounty if bounty and not want else None
        draw_text(CHAINS_NAME(bounty_key[0]), "#%d" % bounty_key[1], b and b["body"],
                  "{g} claims  {r} back" if b and b.get("hasClaims") else "{r} back  ^ v scroll")
    elif view == "claims":
        total = cl.get("total", 0) if cl else 0
        header("Claims", ("%d/%d" % (min(csel + 1, total), total)) if cl and total else "#%d" % bounty_key[1])
        if cl and not want and not err:
            if not cl["items"]:
                ui.say(d, "No claims yet", 110, INK)
                ui.say(d, "be the first on poidh.xyz", 126, MUTED)
            else:
                rows(cl["items"], cl["page"] * PER, csel, lambda c: c["t"], lambda c: (c["st"], c["by"], c["ago"]))
        else:
            status_line()
        footer("{g} open  {r} back")
    elif view == "claim":
        c = claim if claim and not want else None
        draw_text("Claim", "#%d" % claim_id, c and c["body"], "{r} back  ^ v scroll")
    d.show()


def CHAINS_NAME(cid):
    for c, n in CHAINS:
        if c == cid:
            return n
    return "?"


bounty_key = (0, 0)
claim_id = 0


# ---- moving around --------------------------------------------------------------------------------

def load_list():
    ask("list", chain=CHAINS[chain_i][0], page=sel // PER, per=PER)


def load_claims():
    ask("claims", chain=bounty_key[0], id=bounty_key[1], page=csel // PER, per=PER)


def key(k):
    global view, chain_i, sel, lst, scroll, csel, cl, bounty, bounty_key, claim, claim_id, dirty
    dirty = True
    if k == "X":                                       # reload what's on screen
        if view == "list":
            load_list()
        elif view == "bounty":
            ask("bounty", chain=bounty_key[0], id=bounty_key[1])
        elif view == "claims":
            load_claims()
        else:
            ask("claim", chain=bounty_key[0], id=bounty_key[1], claim=claim_id)
        return
    if view == "list":
        if k in ("left", "right"):
            chain_i = (chain_i + (1 if k == "right" else -1)) % len(CHAINS)
            sel, lst = 0, None
            load_list()
        elif lst and lst["items"]:
            total = lst.get("total", 0)
            if k in ("up", "down"):
                n = sel + (1 if k == "down" else -1)
                if 0 <= n < total:
                    page = sel // PER
                    sel = n
                    if n // PER != page:
                        load_list()
            elif k in ("A", "press"):
                i = sel - lst["page"] * PER
                if 0 <= i < len(lst["items"]):
                    b = lst["items"][i]
                    bounty_key = (b["ch"], b["id"])
                    view, bounty, scroll = "bounty", None, 0
                    ask("bounty", chain=b["ch"], id=b["id"])
    elif view in ("bounty", "claim"):
        body = (bounty if view == "bounty" else claim) or {}
        n = len(body.get("body") or ())
        if k in ("up", "down", "left", "right"):
            step = 1 if k in ("up", "down") else 10
            scroll = max(0, min(max(0, n - 10), scroll + (step if k in ("down", "right") else -step)))
        elif k == "Y":
            if view == "bounty":
                view, bounty = "list", None
                if not lst:
                    load_list()
            else:
                view, claim = "claims", None
                if not cl:
                    load_claims()
        elif k in ("A", "press") and view == "bounty" and bounty and bounty.get("hasClaims"):
            view, csel, cl = "claims", 0, None
            load_claims()
    elif view == "claims":
        if k == "Y":
            view, cl = "bounty", None
            if not bounty:
                ask("bounty", chain=bounty_key[0], id=bounty_key[1])
        elif cl and cl["items"]:
            total = cl.get("total", 0)
            if k in ("up", "down"):
                n = csel + (1 if k == "down" else -1)
                if 0 <= n < total:
                    page = csel // PER
                    csel = n
                    if n // PER != page:
                        load_claims()
            elif k in ("A", "press"):
                i = csel - cl["page"] * PER
                if 0 <= i < len(cl["items"]):
                    claim_id = cl["items"][i]["id"]
                    view, claim, scroll = "claim", None, 0
                    ask("claim", chain=bounty_key[0], id=bounty_key[1], claim=claim_id)


def run():
    global d, keys, _poll, dirty
    d = L.LCD()
    keys = L.Keys()
    _poll = select.poll()
    _poll.register(sys.stdin, select.POLLIN)
    W.send(W.hello(None, type="ready", running="poidh"))
    load_list()
    while True:
        for k in keys.pressed():
            key(k)
        pump()
        resend()
        if dirty:
            dirty = False
            draw()
        time.sleep_ms(FRAME)
