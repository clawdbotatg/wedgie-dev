# PQ Safe Signer: signs Safe transactions with a post-quantum key (SLH-DSA-SHA2-128f, NIST FIPS 205).
# A test: small money only. The page: wedgie.dev/pqsafe. The contracts: github.com/clawdbotatg/wedgie-pq.
#
# The key: 48 bytes the secure chip (Trust M) derives from a seed in its data slot 9. The seed never leaves
# the chip. The derived key is in this wedgie's memory while it signs, then dropped. The seed is not locked:
# anything that rewrites that slot loses the key. The public key is saved (/saves/pqsafe/pk).
#
# Its questions are black, not white, so they can't be taken for Safe Signer's.
# It works out the Safe transaction hash itself from the fields it is sent, and shows those fields.
#
# USB (one JSON line each way; everything else goes to the slot, so hello/shot/jobs still work):
#   {"id":1,"type":"pq_key"} -> {"id":1,"type":"pq_key","pk":"<64 hex: PK.seed, PK.root>"} (pk null: no key yet)
#   {"id":2,"type":"pq_make"} -> asks, makes the seed if the chip has none, then pq_key. Or {"type":"refused"}.
#   {"id":3,"type":"pq_sign","tx":{"chainId":1,"safe":"0x..","to":"0x..","value":"1000","data":"0x","operation":0,
#     "safeTxGas":"0","baseGas":"0","gasPrice":"0","gasToken":"0x..","refundReceiver":"0x..","nonce":0}}
#   -> on a real green press: lines '@sig "<hex>"' (the 17,088-byte signature, in order), then
#      {"id":3,"type":"pq_sig","safeTxHash":"0x..","pk":"..","bytes":17088}
#   -> {"id":3,"type":"refused"} (red, or no answer in 2 minutes) or {"type":"error","error":".."}
#   hello answers also carry "pq": the public key or null.
import sys, select, json, time, gc, binascii
import lcd as L
import wedgie as W
import save
import ui
from ui import WHITE, INK, GREY, GREEN, RED

FW = "pqsafe-1"
ASK_MS = 120000
SIG = 17088
CHAINS = {1: "Ethereum", 8453: "Base"}
DOMAIN = binascii.unhexlify("47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218")
SAFE_TX = binascii.unhexlify("bb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8")

d = None
keys = None
_poll = None
key = None          # the public key, 64 hex, or None
note = ""
dirty = True


# ---- the key ------------------------------------------------------------------------------------

def _chip():
    import optiga
    return optiga.Chip(), optiga.DATA[9]


def seeded():
    c, slot = _chip()
    m = c.metadata(slot)
    return m.get(0xE8) == b"\x21" and m.get(0xD1) == b"\xff"


def make_seed():
    c, slot = _chip()
    c.write(slot, c.random(64), erase=True)
    c.set_metadata(slot, {0xE8: b"\x21", 0xD1: b"\xff", 0xD3: b"\x00"})     # a secret to derive from; read: never


def parts():
    """SK.seed, SK.prf, PK.seed (16 bytes each) and 16 spare. Two 32-byte derives: a size every Trust M does."""
    c, slot = _chip()
    return (c.derive(slot, 32, b"slh-dsa safe owner 0 a", method="prf256")
            + c.derive(slot, 32, b"slh-dsa safe owner 0 b", method="prf256"))


def public_key():
    import pqsafe_slh as S
    p = parts()
    st = bytearray(S.size())
    root = bytearray(16)
    S.root(st, 1, p[:16], p[32:48], root)
    return binascii.hexlify(p[32:48] + root).decode()


def find_key():
    """The saved public key, or the chip's if it has a seed and nothing is saved."""
    global key
    key = save.load("pk", None)
    if not key and seeded():
        key = public_key()
        save.store("pk", key)


# ---- the screen: black ---------------------------------------------------------------------------

def head():
    d.fill(INK)
    ui.band(d)
    d.center_text("PQ SAFE SIGNER", 46, GREEN)


def draw_home():
    head()
    if key:
        d.center_text("key", 84, GREY)
        d.center_text(key[:16], 100, WHITE)
        d.center_text(key[16:32], 114, WHITE)
        d.center_text("wedgie.dev/pqsafe", 150, GREY)
    else:
        d.center_text("No key yet", 92, WHITE, 2)
        d.center_text("Make one at", 136, GREY)
        d.center_text("wedgie.dev/pqsafe", 150, GREY)
    if note:
        d.center_text(note[:28], 196, RED if note.startswith("!") else GREEN)
    d.center_text("test: small money only", 222, GREY)
    d.show()


def ask(q, lines, yes):
    """A yes/no question, black. Only real presses count. lines: text, or (text, color)."""
    k = L.Keys(physical=True)
    k.pressed()
    head()
    y = ui.title(d, q, 68, 2, WHITE) + 10
    for s in lines:
        c = GREY
        if isinstance(s, tuple):
            s, c = s
        d.center_text(s[:28], y, c)
        y += 13
    ui.buttons(d, yes, "no")
    d.show()
    ui.drawn = time.ticks_ms()
    return ui.wait(k, ASK_MS)


# ---- a Safe transaction ----------------------------------------------------------------------------

def _num(v, what):
    n = int(v)
    if n < 0 or n >= 1 << 256:
        raise ValueError("bad " + what)
    return n


def _adr(v, what):
    if not isinstance(v, str) or len(v) != 42 or v[:2] != "0x":
        raise ValueError("bad " + what)
    return binascii.unhexlify(v[2:])


def _word(n):
    return n.to_bytes(32, "big")


def eth(wei):
    s = "%019d" % wei
    w, f = s[:-18], s[-18:].rstrip("0")
    return w + ("." + f[:9] if f else "")


def read_tx(t):
    """The fields, checked, and the Safe transaction hash worked out from them (EIP-712, Safe 1.3+)."""
    from pqsafe_keccak import keccak256
    z = "0x" + "0" * 40
    x = {"chain": _num(t["chainId"], "chainId"), "safe": _adr(t["safe"], "safe"), "to": _adr(t["to"], "to"),
         "value": _num(t.get("value", 0), "value"), "op": _num(t.get("operation", 0), "operation"),
         "gas": [_num(t.get(k, 0), k) for k in ("safeTxGas", "baseGas", "gasPrice")],
         "token": _adr(t.get("gasToken") or z, "gasToken"), "refund": _adr(t.get("refundReceiver") or z, "refundReceiver"),
         "nonce": _num(t["nonce"], "nonce")}
    data = t.get("data") or "0x"
    if data[:2] != "0x" or len(data) > 2 + 2 * 4096:
        raise ValueError("bad data")
    data = binascii.unhexlify(data[2:])
    if x["op"] > 1:
        raise ValueError("bad operation")
    x["data"] = len(data)
    dom = keccak256(DOMAIN + _word(x["chain"]) + bytes(12) + x["safe"])
    st = keccak256(SAFE_TX + bytes(12) + x["to"] + _word(x["value"]) + keccak256(data) + _word(x["op"])
                   + _word(x["gas"][0]) + _word(x["gas"][1]) + _word(x["gas"][2]) + bytes(12) + x["token"]
                   + bytes(12) + x["refund"] + _word(x["nonce"]))
    x["hash"] = keccak256(b"\x19\x01" + dom + st)
    return x


def tx_lines(x):
    to = "0x" + binascii.hexlify(x["to"]).decode()
    safe = "0x" + binascii.hexlify(x["safe"]).decode()
    out = ["to " + to[:22], to[22:], "on " + CHAINS.get(x["chain"], "chain %d" % x["chain"]),
           "from Safe " + safe[:10] + ".." + safe[-6:]]
    if x["data"]:
        out.append(("! %d bytes it can't read" % x["data"], RED))
    if x["op"]:
        out.append(("! runs its code as the Safe", RED))
    if x["gas"][2] or any(x["refund"]):
        out.append(("! pays a gas refund", RED))
    return out


def on_sign(mid, t):
    global note
    if not key:
        W.send({"id": mid, "type": "error", "error": "no key yet"})
        return
    try:
        x = read_tx(t)
    except Exception as e:
        W.send({"id": mid, "type": "error", "error": "bad tx: %s" % e})
        return
    hx = "0x" + binascii.hexlify(x["hash"]).decode()
    gc.collect()
    if not ask("Send %s ETH?" % eth(x["value"]), tx_lines(x), "sign"):
        note = "! not signed"
        W.send({"id": mid, "type": "refused", "safeTxHash": hx})
        return
    bar = ui.progress("Signing", "starting")
    import pqsafe_slh as S
    gc.collect()
    p = parts()
    st = bytearray(S.size())
    root = bytearray(16)
    r = bytearray(16)
    part = bytearray(608)          # the biggest piece. RAM is tight

    def out(b):
        for i in range(0, len(b), 512):
            print('@sig "%s"' % binascii.hexlify(b[i:i + 512]).decode())
    S.root(st, 1, p[:16], p[32:48], root)
    if binascii.hexlify(p[32:48] + root).decode() != key:
        note = "! the chip's key changed"
        W.send({"id": mid, "type": "error", "error": "the chip's key is not the saved one: its seed was rewritten"})
        return
    S.begin(st, 1, p[:16], p[16:32], p[32:48], root, b"\0\0" + x["hash"], r)
    out(r)
    for i in range(33):
        out(memoryview(part)[:S.fors(st, i, part)])
    for i in range(22):
        if bar:
            import loader
            loader.what("part %d of 23" % (i + 2))
            bar.to((i + 1) / 23)
        S.layer(st, part)
        out(memoryview(part)[:608])
    p = st = None
    note = "signed"
    W.send({"id": mid, "type": "pq_sig", "safeTxHash": hx, "pk": key, "bytes": SIG})


def on_make(mid):
    global key, note
    if not key:
        have = seeded()
        if not ask("Make a new key?", ["It writes a new secret", "into the secure chip."] if not have else ["From the secret already", "in the secure chip."], "make it"):
            W.send({"id": mid, "type": "refused"})
            return
        ui.progress("Making the key", "", False)
        if not have:
            make_seed()
        key = public_key()
        save.store("pk", key)
        note = "key made"
    W.send({"id": mid, "type": "pq_key", "pk": key})


# ---- USB -------------------------------------------------------------------------------------------

def handle(m):
    global dirty
    mid, t = m.get("id"), m.get("type")
    if t == "pq_key":
        W.send({"id": mid, "type": "pq_key", "pk": key, "app": FW})
    elif t == "pq_make":
        on_make(mid)
        dirty = True
    elif t == "pq_sign":
        on_sign(mid, m.get("tx") or {})
        dirty = True
    elif t == "hello":
        W.send(W.hello(mid, running="pqsafe", app=FW, pq=key))
    else:                               # hello's cousins, shots, jobs, open: the slot's
        import slot
        slot.handle(m)
        dirty = True


def pump():
    """One request per call, read through the one line reader (wedgie.lines)."""
    global dirty
    R = W.lines()
    line = R.pump(_poll)
    if R.intr:                          # a Ctrl-C while sealed: the red question (hatch.py)
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
    if line is False:
        W.send({"type": "error", "error": "line too long"})
    elif line and line.strip():
        try:
            m = json.loads(line)
        except Exception:
            line = None
            gc.collect()
            W.send({"type": "error", "error": "bad json"})
            return
        line = None
        if not isinstance(m, dict):
            return
        try:
            handle(m)
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as e:
            dirty = True
            W.failed(m.get("id"), e)
        gc.collect()


def run():
    global d, keys, _poll, dirty, note
    d = L.LCD()
    keys = L.Keys(physical=True)
    _poll = select.poll()
    _poll.register(sys.stdin, select.POLLIN)
    try:
        find_key()
    except Exception as e:              # no chip answered, or it said no: no key
        print("pqsafe: no key:", e)
    W.send(W.hello(None, type="ready", running="pqsafe", app=FW, pq=key))
    while True:
        keys.pressed()
        pump()
        if dirty:
            draw_home()
            dirty = False
        time.sleep_ms(20)
