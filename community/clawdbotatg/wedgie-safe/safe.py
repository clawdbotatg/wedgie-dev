# Safe signer: the wedgie signs Safe{Wallet} transactions with a key that lives in its Trust M chip.
#
# The key: made once, on the wedgie, in the chip's key slot 2 (A on its screen). It never leaves the chip.
# Its public key is saved (/saves/safe/key) because the chip hands it out only when it makes the key.
# On chain the key is a passkey-style Safe owner: Safe's SafeWebAuthnSignerFactory makes a small signer
# contract from (x, y), and that contract's address is added as an owner of the Safe.
#
# A host sends the transaction's fields, not a hash. The wedgie works out the Safe tx hash itself
# (EIP-712, safe_keccak), shows what the transaction does, and signs only on a real A press. What it
# signs is the WebAuthn message the signer contract checks: sha256(authenticatorData + sha256(clientDataJSON)),
# with the Safe tx hash as the challenge. The wedgie picks authenticatorData and clientDataJSON itself.
#
# USB (one JSON line each way; everything else goes to the slot, so hello/shot/jobs still work):
#   {"id":1,"type":"safe_sign","tx":{"chainId":8453,"safe":"0x..","to":"0x..","value":"0","data":"0x",
#    "operation":0,"safeTxGas":0,"baseGas":0,"gasPrice":0,"gasToken":"0x0..","refundReceiver":"0x0..","nonce":0}}
#   -> {"id":1,"type":"safe_sig","safeTxHash":"0x..","x":"0x..","y":"0x..","r":"0x..","s":"0x..",
#       "authenticatorData":"0x..","clientDataFields":"\"origin\":\"https://wedgie.dev\""}
#   -> {"id":1,"type":"refused"} (Y, or no answer in 2 minutes) or {"type":"error","error":".."}
#   hello answers also carry "safe": {"x","y"} (or null: no key yet).
import sys, select, json, time, gc, binascii, hashlib
import lcd as L
import wedgie as W
import save
import ui
from ui import WHITE, INK, MUTED, GREEN_D, RED

FW = "safe-1"
RP_ID = b"wedgie.dev"
FIELDS = '"origin":"https://wedgie.dev"'
ASK_MS = 120000

DOMAIN_TYPEHASH = binascii.unhexlify("47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218")
SAFE_TX_TYPEHASH = binascii.unhexlify("bb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8")

CHAINS = {1: "Ethereum", 10: "Optimism", 100: "Gnosis", 137: "Polygon", 8453: "Base", 42161: "Arbitrum",
          84532: "Base Sepolia", 11155111: "Sepolia"}
# tokens the wedgie knows itself: (chain, address) -> (symbol, decimals). Others show their raw amount.
TOKENS = {
    (1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"): ("USDC", 6),
    (8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"): ("USDC", 6),
    (84532, "0x036cbd53842c5426634e7929541ec2318f3dcf7e"): ("USDC", 6),
}

# Safe's MultiSend contracts (1.3.0 and 1.4.1, both deployments): a batch is a DELEGATECALL to one of
# these, and the wedgie shows every action in it. A DELEGATECALL to anything else stays red.
MULTISEND = ("0x9641d764fc13c8b624c04430c7356c1c7c8102e2", "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526",
             "0x40a2accbd92bca938b02010e17a5b8929b49130d", "0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b",
             "0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761", "0x998739bfdaadde7c933b942a68053933098f9eda")

d = None
keys = None
_poll = None
key = None          # {"x": "0x..", "y": "0x.."} or None
note = ""           # one line under the home screen (the last thing that happened)
dirty = True


# ---- small helpers ----------------------------------------------------------------------------

def unhex(s):
    s = str(s or "")
    if s[:2] in ("0x", "0X"):
        s = s[2:]
    if len(s) % 2:
        raise ValueError("odd hex")
    return binascii.unhexlify(s)


def num(v):
    if isinstance(v, int):
        n = v
    else:
        v = str(v or "0")
        n = int(v[2:], 16) if v[:2] in ("0x", "0X") else int(v)
    if n < 0 or n >> 256:
        raise ValueError("bad number")
    return n


def addr(v):
    b = unhex(v)
    if len(b) != 20:
        raise ValueError("bad address")
    return "0x" + binascii.hexlify(b).decode()


def word(n):
    return n.to_bytes(32, "big")


def aword(a):
    return bytes(12) + unhex(a)


def short(a):
    return a[:6] + ".." + a[-4:]


def amount(n, dec):
    if not dec:
        return str(n)
    w, f = n // 10 ** dec, n % 10 ** dec
    f = ("%0" + str(dec) + "d") % f
    f = f.rstrip("0")[:6]
    return "%d.%s" % (w, f) if f else str(w)


def hx(b):
    return "0x" + binascii.hexlify(b).decode()


# ---- the transaction --------------------------------------------------------------------------

def parse(t):
    """The fields, checked and normalized. Raises ValueError on anything off."""
    tx = {"chainId": num(t["chainId"]), "safe": addr(t["safe"]), "to": addr(t["to"]),
          "value": num(t.get("value", 0)), "data": unhex(t.get("data") or "0x"),
          "operation": num(t.get("operation", 0)), "safeTxGas": num(t.get("safeTxGas", 0)),
          "baseGas": num(t.get("baseGas", 0)), "gasPrice": num(t.get("gasPrice", 0)),
          "gasToken": addr(t.get("gasToken") or "0x" + "0" * 40),
          "refundReceiver": addr(t.get("refundReceiver") or "0x" + "0" * 40), "nonce": num(t["nonce"])}
    if tx["operation"] > 1:
        raise ValueError("bad operation")
    return tx


def safe_tx_hash(tx):
    """EIP-712, as Safe 1.3+ computes getTransactionHash."""
    from safe_keccak import keccak256 as k
    domain = k(DOMAIN_TYPEHASH + word(tx["chainId"]) + aword(tx["safe"]))
    st = k(b"".join((SAFE_TX_TYPEHASH, aword(tx["to"]), word(tx["value"]), k(tx["data"]),
                     word(tx["operation"]), word(tx["safeTxGas"]), word(tx["baseGas"]), word(tx["gasPrice"]),
                     aword(tx["gasToken"]), aword(tx["refundReceiver"]), word(tx["nonce"]))))
    return k(b"\x19\x01" + domain + st)


def _arg(data, i):
    return data[4 + 32 * i:36 + 32 * i]


def _aarg(data, i):
    return "0x" + binascii.hexlify(_arg(data, i)[12:]).decode()


def _addr_lines(head, a, c=INK):
    """An address in full on two lines: nobody should have to trust 0x12..cdef."""
    return [(head, MUTED), (a[:22], c), ("  " + a[22:], c)]


def describe(tx):
    """What the transaction does, as (text, color) lines: at most 6."""
    data, to, safe = tx["data"], tx["to"], tx["safe"]
    sel = binascii.hexlify(data[:4]).decode() if len(data) >= 4 else ""
    out = []
    if tx["operation"] == 1:
        out.append(("DELEGATECALL: can do anything", RED))
    if not data:
        out.append(("send %s ETH to" % amount(tx["value"], 18), INK))
        return out + _addr_lines("", to)[1:]
    if tx["value"]:
        out.append(("+ %s ETH" % amount(tx["value"], 18), RED))
    if to == safe and sel == "0d582f13" and len(data) == 68:
        return out + [("add owner", INK)] + _addr_lines("", _aarg(data, 0))[1:] + \
            [("then %d signer(s) needed" % int.from_bytes(_arg(data, 1), "big"), INK)]
    if to == safe and sel == "f8dc5dd9" and len(data) == 100:
        return out + [("remove owner", RED)] + _addr_lines("", _aarg(data, 1), RED)[1:] + \
            [("then %d signer(s) needed" % int.from_bytes(_arg(data, 2), "big"), INK)]
    if to == safe and sel == "e318b52b" and len(data) == 100:
        return out + [("swap owner", RED), (_aarg(data, 1)[:22] + "..", RED), ("for", MUTED)] + \
            _addr_lines("", _aarg(data, 2))[1:]
    if to == safe and sel == "694e80c3" and len(data) == 36:
        return out + [("change: %d signer(s) needed" % int.from_bytes(_arg(data, 0), "big"), INK)]
    if sel == "a9059cbb" and len(data) == 68:
        tok = TOKENS.get((tx["chainId"], to))
        n = int.from_bytes(_arg(data, 1), "big")
        what = "%s %s" % (amount(n, tok[1]), tok[0]) if tok else "%d of token %s" % (n, short(to))
        return out + [("send " + what + " to", INK)] + _addr_lines("", _aarg(data, 0))[1:]
    return out + [("call " + sel + ", %d bytes, on" % len(data), RED)] + _addr_lines("", to, RED)[1:]


def batch(tx):
    """The actions in a MultiSend batch, each a tx-like dict, or None if this isn't one."""
    data = tx["data"]
    if not (tx["operation"] == 1 and tx["to"] in MULTISEND and data[:4] == b"\x8d\x80\xff\x0a"):
        return None
    n = int.from_bytes(data[36:68], "big")
    b = data[68:68 + n]
    out, i = [], 0
    while i < len(b):
        dl = int.from_bytes(b[i + 53:i + 85], "big")
        if b[i] > 1 or i + 85 + dl > len(b):
            raise ValueError("bad batch")
        out.append({"chainId": tx["chainId"], "safe": tx["safe"], "operation": b[i],
                    "to": hx(b[i + 1:i + 21]), "value": int.from_bytes(b[i + 21:i + 53], "big"),
                    "data": b[i + 85:i + 85 + dl]})
        i += 85 + dl
    return out


def webauthn_digest(h):
    """What the chip signs: the WebAuthn message the signer contract rebuilds (WebAuthn.sol)."""
    auth = hashlib.sha256(RP_ID).digest() + b"\x05\x00\x00\x00\x00"     # user present + verified
    ch = binascii.b2a_base64(h).decode().strip().rstrip("=").replace("+", "-").replace("/", "_")
    cdj = '{"type":"webauthn.get","challenge":"' + ch + '",' + FIELDS + "}"
    return auth, hashlib.sha256(auth + hashlib.sha256(cdj.encode()).digest()).digest()


# ---- the chip ---------------------------------------------------------------------------------

def _chip():
    import optiga
    return optiga, optiga.Chip()


def _unload():
    for m in ("optiga", "trustm"):
        if m in sys.modules:
            del sys.modules[m]
    gc.collect()


def make_key():
    global key
    ui.progress("Making your key", "in the chip", False)
    try:
        o, c = _chip()
        pub = c.genkey(o.KEY2)                  # 65 bytes: 04 X Y
        key = {"x": hx(pub[1:33]), "y": hx(pub[33:65])}
        save.store("key", key)
    finally:
        _unload()


def sign(digest):
    try:
        o, c = _chip()
        return c.sign(o.KEY2, digest)
    finally:
        _unload()


# ---- screens ----------------------------------------------------------------------------------

def draw_home():
    d.fill(WHITE)
    ui.band(d)
    y = ui.title(d, "Safe signer", 48) + 14
    if key:
        lines = [("your key", MUTED), (key["x"][:22], INK), (key["x"][22:44], INK), (key["x"][44:], INK)]
        lines += [("", INK), ("waiting for a Safe tx", GREEN_D)]
    else:
        lines = [("No key yet.", INK), ("The chip makes one and", MUTED), ("never lets it out.", MUTED)]
    if note:
        lines.append((note, MUTED))
    for s, c in lines:
        d.center_text(s, y, c)
        y += 14
    if not key:
        ui.buttons(d, "make a key", "not now")
    d.show()


def _screen(head, lines, yes, k):
    """One page of the question; True on a real A, False on Y or no answer."""
    d.fill(WHITE)
    ui.band(d)
    ui.title(d, head, 40, 1)
    y = 64
    for s, c in lines[:10]:
        d.center_text(s, y, c)
        y += 12
    ui.buttons(d, yes, "no")
    d.show()
    t0 = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), t0) < ASK_MS:
        for kk in k.pressed():
            if kk in ("A", "Y"):
                return kk == "A"
        time.sleep_ms(20)
    return False


def confirm(tx, h):
    """The transaction on the screen, a page per action in a batch. True only on A through every page."""
    k = L.Keys(physical=True)
    k.pressed()
    top = [("%s  nonce %d" % (CHAINS.get(tx["chainId"], "chain %d" % tx["chainId"]), tx["nonce"]), INK),
           ("Safe " + short(tx["safe"]), MUTED)]
    tail = [("pays a gas refund", RED)] if tx["gasPrice"] else []
    tail.append(("hash " + short(hx(h)), MUTED))
    acts = batch(tx)
    if acts is None:
        return _screen("Sign for Safe?", (top + describe(tx))[:9 - len(tail) + 1] + tail, "sign", k)
    n = len(acts)
    if not _screen("Safe batch", top + [("%d actions in one transaction" % n, INK),
                                         ("A shows each one", MUTED)] + tail, "next", k):
        return False
    for i, a in enumerate(acts):
        last = i == n - 1
        if not _screen("%d of %d" % (i + 1, n), describe(a) + ([("", INK)] + tail if last else []),
                       "sign all" if last else "next", k):
            return False
    return True


# ---- requests ---------------------------------------------------------------------------------

def on_sign(mid, t):
    global note
    if not key:
        W.send({"id": mid, "type": "error", "error": "no key yet: press A on the wedgie to make one"})
        return
    try:
        tx = parse(t or {})
    except Exception as e:
        W.send({"id": mid, "type": "error", "error": "bad tx: %s" % e})
        return
    ui.progress("Reading the transaction", "Safe tx hash", False)
    h = safe_tx_hash(tx)
    gc.collect()
    if not confirm(tx, h):
        note = "said no to nonce %d" % tx["nonce"]
        W.send({"id": mid, "type": "refused", "safeTxHash": hx(h)})
        return
    ui.progress("Signing", "in the chip", False)
    auth, dg = webauthn_digest(h)
    r, s = sign(dg)
    note = "signed nonce %d" % tx["nonce"]
    W.send({"id": mid, "type": "safe_sig", "safeTxHash": hx(h), "x": key["x"], "y": key["y"],
            "r": "0x%064x" % r, "s": "0x%064x" % s, "authenticatorData": hx(auth), "clientDataFields": FIELDS})


def handle(m):
    global dirty
    mid, t = m.get("id"), m.get("type")
    if t == "safe_sign":
        on_sign(mid, m.get("tx"))
        dirty = True
    elif t == "hello":
        W.send(W.hello(mid, running="safe", app=FW, safe=key))
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


def run():
    global d, keys, _poll, key, dirty, note
    d = L.LCD()
    keys = L.Keys(physical=True)
    _poll = select.poll()
    _poll.register(sys.stdin, select.POLLIN)
    key = save.load("key", None)
    W.send(W.hello(None, type="ready", running="safe", app=FW, safe=key))
    while True:
        for k in keys.pressed():
            if k == "A" and not key:
                if ui.ask(d, "Make a new key?", ["The chip makes it and keeps it.",
                                                  "It replaces anything in the chip's key slot 2."]):
                    try:
                        make_key()
                        note = "key made"
                    except Exception as e:
                        sys.print_exception(e)
                        note = "no key: %s" % e
                dirty = True
        pump()
        if dirty:
            draw_home()
            dirty = False
        time.sleep_ms(20)
