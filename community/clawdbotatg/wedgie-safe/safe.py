# Safe Signer: the wedgie signs Safe{Wallet} transactions with a key that lives in its secure chip, an
# ATECC608 or an OPTIGA Trust M (whichever it has).
#
# The key: made once, by the person, on the wedgie (A on its screen), and locked in the chip for good, so
# nothing can ever replace or lose it (safe_key.py). It never leaves the chip, and the chip is the only truth:
# every start reads the public key from it. A Trust M: KEY2, its public key in DATA[11]. An ATECC608: slot 0.
# A chip whose key is already locked and isn't Safe Signer's: swap it.
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
#   hello answers also carry "safe": {"x","y","chip"} (or null: no key yet) and "signer": its Safe owner address
#   (safe_addr.py; the home screen shows it, wedgie.dev/safe checks it against its own).
#   {"type":"safe_list"} -> {"type":"safe_list","safes":["8453:0x..", ...]}: the Safes this wedgie knows it's
#   in, newest first, so any computer can list them. {"type":"safe_note","chainId":8453,"safe":"0x.."} adds
#   one (a host that made or opened it); signing for a Safe adds it too. Just a list of addresses: a host
#   checks on chain that the wedgie really is an owner before it shows one.
#   {"type":"safe_remove","tx":{..the fields, "dataHash":"0x.." instead of data..},"totp":<hour>} -> safe_sig with
#   "deleteHash": the wedgie works out the Safe tx hash, shows "Remove #n?", and on A signs Safe's DeleteRequest
#   (EIP-712, what Safe's Transaction Service asks a proposer to sign) for it. Hosts drop it from their list; it
#   can still run (only a tx at its nonce stops it), and the screen says so.
#   {"type":"safe_prove","text":"Join Telegram","code":".."} -> "Prove it" on screen; on A, safe_proof: the key signs
#   the code and the chip's factory key vouches for the key (safe_msg.prove; wedgie.dev/telegram).
#   {"type":"safe_nonce"} -> {"type":"safe_nonce","nonce":"<32 hex>"}: a fresh nonce for the next safe_sign's "sim",
#   a clear-sim answer the host asked for with it (hello says "safe_sim": "p256"). One use; safe_sim.py.
#   {"type":"safe_review","round":n,"registry":"<40 hex>","root":"<64 hex>","signature":"<128 hex>"} -> {"type":
#   "safe_review","round":n}: clear-review's signed round (wedgie.dev/clear/review/<n>/round.json), checked with its
#   key and saved; then descriptors with its proofs show as robot-checked. hello says "safe_review": <saved round>.
import sys, select, json, time, gc, binascii, hashlib
import lcd as L
import wedgie as W
import save
import ui
from ui import WHITE, INK, MUTED, GREY, GREEN_D, RED

FW = "safe-50"         # and "version" in wedgie.json: the site shows it (v50)
RP_ID = b"wedgie.dev"
FIELDS = '"origin":"https://wedgie.dev"'
ASK_MS = 120000
SETTLE = 600        # ms a page is up before a press can answer it

DOMAIN_TYPEHASH = binascii.unhexlify("47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218")
SAFE_TX_TYPEHASH = binascii.unhexlify("bb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8")
# Safe's Transaction Service's delete message: EIP712Domain(name,version,chainId,verifyingContract), DeleteRequest
NAMED_DOMAIN_TYPEHASH = binascii.unhexlify("8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f")
DELETE_TYPEHASH = binascii.unhexlify("ea0e2920ae94ffdb9d98b7bbb85bc34fe4df5ccca3a98a2e3bfec8b64919fc08")
STS_NAME = binascii.unhexlify("8f99caf1d944cedaf6deae4902281b08b040f5928da79e5d758da2e7bc8ab237")      # "Safe Transaction Service"
STS_VERSION = binascii.unhexlify("e6bbd6277e1bf288eed5e8d1780f9a50b239e86b153736bceebccf4ea79d90b3")   # "1.0"

CHAINS = {1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 100: "Gnosis", 137: "Polygon", 146: "Sonic", 999: "HyperEVM",
          4663: "Robinhood", 5042: "Arc", 8453: "Base", 9745: "Plasma", 42161: "Arbitrum", 42220: "Celo",
          43114: "Avalanche", 84532: "Base Sepolia", 11155111: "Sepolia"}
# the coin a tx's value is in, where it isn't ETH (18 decimals on all of them, Arc's USDC too)
NATIVE = {56: "BNB", 100: "XDAI", 137: "POL", 146: "S", 999: "HYPE", 5042: "USDC", 9745: "XPL", 42220: "CELO",
          43114: "AVAX"}


def coin(tx):
    return NATIVE.get(tx["chainId"], "ETH")
SAFES_MAX = 32          # Safes the wedgie remembers (save "safes")
CHUNK = 4000            # hex chars per safe_data line (a USB line is at most 6 KB)
# bytes of tx data the wedgie takes in pieces. Joining them needs one free block that size, and how big a
# block a used RP2040 heap still has varies: on a virtual RP2040 (wedgie-dev tools/safechip.mjs) 12 KB
# passed one run and failed another, 16 KB once, 20 KB never. 8 KB passes every run, with room.
MAX_DATA = 8000

d = None
keys = None
_poll = None
key = None          # {"x": "0x..", "y": "0x..", "chip": "ATECC608" | "OPTIGA Trust M"} or None
state = "none"      # "ok" signs; "none" no key yet; "lock" a key from before locking; "swap" not ours (safe_key)
signer = None       # its Safe owner address, "0x.." checksummed (safe_addr.py), or None
note = ""           # one line under the home screen (the last thing that happened)
sim_nonce = None    # the nonce the next tx's simulation must carry (safe_nonce), used up by the next safe_sign
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
    """n / 10**dec, cut (not rounded) to 6 decimals, or to 4 digits past the zeros when under 1 (0.0009026)."""
    s = "-" if n < 0 else ""
    n = abs(n)
    if not dec:
        return s + str(n)
    w, f = divmod(n, 10 ** dec)
    f = ("%0" + str(dec) + "d") % f
    k = 6 if w else max(6, len(f) - len(f.lstrip("0")) + 4)
    f = f[:k].rstrip("0")
    return s + ("%d.%s" % (w, f) if f else str(w))


def hx(b):
    return "0x" + binascii.hexlify(b).decode()


# ---- the transaction --------------------------------------------------------------------------

# Kept as bytes, each piece decoded as it comes: hex strings joined and then decoded needed ~5x the data at
# once and ran a virtual RP2040 out of memory at 12 KB (wedgie-dev tools/safechip.mjs). As bytes the join
# needs 2x, once.
pieces = []             # a big tx's data, sent ahead in safe_data lines (bytes, one per piece)
have = 0                # bytes of it so far
# The join needs one free block of up to MAX_DATA, and any code change moves what's left of a used heap (a
# change to the screens alone made 8 KB fail every run; 10-28, one more sector in the firmware's drive did too).
# So that block is taken at start, while the heap is in one piece, and kept: parse frees it just before the join,
# which then lands in it, and _keep takes it again once the tx is done. Given back only on a MemoryError (_lend).
room = None


def hold():
    global room
    if room is None:
        gc.collect()
        try:
            room = bytearray(MAX_DATA + 64)
        except MemoryError:
            pass


def on_data(mid, m):
    """{"type":"safe_data","at":<bytes so far>,"hex":"..."}: a piece of the next tx's data. at 0 starts over."""
    global pieces, have
    at, h = m.get("at"), str(m.get("hex") or "")
    if at == 0:
        pieces, have = [], 0
        hold()
    if have + len(h) // 2 > MAX_DATA:
        pieces, have = [], 0
        W.send({"id": mid, "type": "error", "error": "too big: a wedgie takes up to %d bytes of tx data" % MAX_DATA})
        return
    if at != have or len(h) % 2 or len(h) > CHUNK:
        pieces, have = [], 0
        W.send({"id": mid, "type": "error", "error": "bad piece"})
        return
    try:
        b = binascii.unhexlify(h)
    except Exception:
        pieces, have = [], 0
        W.send({"id": mid, "type": "error", "error": "bad piece"})
        return
    h = m = None
    pieces.append(b)
    have += len(b)
    W.send({"id": mid, "type": "safe_data", "have": have})


# Clear signing (safe_7730.py): the host sends a bundle of ERC-7730 wire-format structures ahead of a tx, in
# safe_clear pieces; the next safe_sign uses it and drops it. The bundle proves itself (a Merkle proof per
# structure to a root built into this app), so a host can only leave things out, never make them up.
clear = []              # the bundle, in pieces (bytes), or a view of clear_buf
# made once at start, while the heap is in one piece, and reused: made at a bundle's first piece, after a few
# transactions had broken the heap up, it found no block that big (virtual RP2040, 10-27: 6504 bytes). CLEAR_BUF,
# not CLEAR_MAX: kept for good, 10 KB left a swap batch's reading short. Instant Wallet sends up to 6000.
CLEAR_BUF = 6600
clear_buf = None
clear_have = 0
CLEAR_MAX = 10000       # bytes: a descriptor (the spec's minimum is 4 KB; our Universal Router's is 5.5), its proof, a few tokens


def _lend():
    """On a MemoryError: a block kept for later back to the heap, where nothing is using it. room first (only an
    8 KB tx needs it); clear_buf on the next one (every clear-signed tx needs it, and on a broken-up heap _keep
    can't take it again: safechip --frag, a V4 swap after the daily limit). _keep takes them again once the
    request is done, if it can."""
    global clear_buf, room
    if room is not None and not have:
        room = None
    elif clear_buf and not clear_have and not isinstance(clear, memoryview):
        clear_buf = None
    gc.collect()


def _keep():
    """room and clear_buf again once nothing big is in flight (after a request is done; at start)."""
    global clear_buf
    if have or clear_have:
        return
    hold()
    if clear_buf is None:
        gc.collect()
        try:
            clear_buf = bytearray(CLEAR_BUF)
        except MemoryError:             # no clear signing then (a bundle's pieces join at sign time, as before)
            pass


def _join(parts):
    """The pieces in one block; clear_buf's room, then once more, when there's no block that big (safechip 10-28:
    a bundle in pieces, 6682 bytes, after _keep found no room for clear_buf)."""
    gc.collect()
    try:
        return b"".join(parts)
    except MemoryError:
        _lend()
        return b"".join(parts)


def review_round():
    """The clear-review round saved (safe_review), 0 for none: hello says it, so a host sends a newer one."""
    v = save.load("review", None)
    return v["round"] if v else 0


def clear_tag():
    """Which clear-signing data this app trusts (wedgie.dev/clear/<tag>/), for hello: the host sends only that."""
    try:
        import safe_roots
        return safe_roots.TAG
    except ImportError:
        return None


def on_clear(mid, m):
    """{"type":"safe_clear","at":<bytes so far>,"hex":"...","n":<bundle bytes, on the first>}: a piece of the next tx's
    clear-signing bundle. With n, the first piece takes one block for all of it while the heap is still in one piece,
    and every piece goes straight in: joining pieces at sign time needed a free block that size on top of them (a real
    wedgie on a phone, 10-27: MemoryError, 1784 bytes)."""
    global clear, clear_have
    at, h = m.get("at"), str(m.get("hex") or "")
    if at == 0:
        clear, clear_have = [], 0
        n = m.get("n")
        if isinstance(n, int) and 0 < n <= CLEAR_MAX:
            if clear_buf and n <= len(clear_buf):
                clear = memoryview(clear_buf)[:n]
            else:                       # bigger than the one made at start (wedgie.dev's up to CLEAR_MAX): try now
                gc.collect()
                try:
                    clear = memoryview(bytearray(n))
                except MemoryError:     # no block that big: pieces, joined at sign time if there's room then
                    pass
    if at != clear_have or len(h) % 2 or len(h) > CHUNK or clear_have + len(h) // 2 > (len(clear) if isinstance(clear, memoryview) else CLEAR_MAX):
        clear, clear_have = [], 0
        W.send({"id": mid, "type": "error", "error": "bad clear piece (a bundle is up to %d bytes)" % CLEAR_MAX})
        return
    try:
        b = binascii.unhexlify(h)
    except Exception:
        clear, clear_have = [], 0
        W.send({"id": mid, "type": "error", "error": "bad clear piece"})
        return
    h = m = None
    if isinstance(clear, memoryview):
        clear[clear_have:clear_have + len(b)] = b
    else:
        clear.append(b)
    clear_have += len(b)
    W.send({"id": mid, "type": "safe_clear", "have": clear_have})


def parse(t):
    """The fields, checked and normalized. Raises ValueError on anything off. data "@" = the pieces sent ahead.
    A clear-signing bundle sent ahead comes along as tx["clear"] (and is used up)."""
    global pieces, have, room, clear, clear_have
    if t.get("data") == "@":            # only the join needs room. Freed for every tx, a small one's screens took
        room = None                     # the block, and on a broken-up heap _keep found none (safe-49, safechip --frag)
    # used up first, whatever happens: a join that ran out of memory left them for the next tx, which failed too
    parts, n, clear, clear_have = clear, clear_have, [], 0
    cb = (parts if n == len(parts) else None) if isinstance(parts, memoryview) else _join(parts) if parts else None
    parts = None
    data = t.get("data") or "0x"
    if data == "@":
        parts, pieces, have = pieces, [], 0
        data = _join(parts)
        parts = None
        gc.collect()
    else:
        data = unhex(data)
    tx = {"chainId": num(t["chainId"]), "safe": addr(t["safe"]), "to": addr(t["to"]),
          "value": num(t.get("value", 0)), "data": data,
          "operation": num(t.get("operation", 0)), "safeTxGas": num(t.get("safeTxGas", 0)),
          "baseGas": num(t.get("baseGas", 0)), "gasPrice": num(t.get("gasPrice", 0)),
          "gasToken": addr(t.get("gasToken") or "0x" + "0" * 40),
          "refundReceiver": addr(t.get("refundReceiver") or "0x" + "0" * 40), "nonce": num(t["nonce"])}
    if tx["operation"] > 1:
        raise ValueError("bad operation")
    tx["clear"] = cb
    tx["sim"] = t.get("sim") if isinstance(t.get("sim"), dict) else None     # a signed clear-sim answer (safe_sim)
    return tx


def safe_tx_hash(tx):
    """EIP-712, as Safe 1.3+ computes getTransactionHash."""
    from safe_keccak import keccak256 as k
    domain = k(DOMAIN_TYPEHASH + word(tx["chainId"]) + aword(tx["safe"]))
    dh = tx["dataHash"] if "dataHash" in tx else k(tx["data"])
    st = k(b"".join((SAFE_TX_TYPEHASH, aword(tx["to"]), word(tx["value"]), dh,
                     word(tx["operation"]), word(tx["safeTxGas"]), word(tx["baseGas"]), word(tx["gasPrice"]),
                     aword(tx["gasToken"]), aword(tx["refundReceiver"]), word(tx["nonce"]))))
    return k(b"\x19\x01" + domain + st)


def delete_hash(chain, safe, h, totp):
    """Safe's DeleteRequest(safeTxHash, totp) for this Safe, EIP-712."""
    from safe_keccak import keccak256 as k
    domain = k(NAMED_DOMAIN_TYPEHASH + STS_NAME + STS_VERSION + word(chain) + aword(safe))
    return k(b"\x19\x01" + domain + k(DELETE_TYPEHASH + h + word(totp)))


BIG = "big"         # a line kind: big text (the amount, the limit)
ADDR = "addr"       # a line kind: an address in full, with its blockie (safe_blockie) beside it
GAP = ("", INK, "gap")  # a line: 6 px of space
ROOM = 94           # px of lines a page has, under the Safe card and the title


def _h(line, big=False):
    """Pixels a line takes on a page (big: addresses with the big blockie)."""
    k = line[2] if len(line) > 2 else None
    return (30 if len(line[0]) <= 10 else 22) if k == BIG else (52 if big else 38) if k == ADDR else 6 if k == "gap" else 12


def _iconed(s, c, i, y):
    """A big amount with its token's picture before it (safe_icons), at the size it has without one; False, and
    nothing drawn, if the two don't fit across."""
    sc = 3 if len(s) <= 10 else 2 if len(s) <= ui.COLS_BIG else 1
    for n in (24, 16) if sc == 3 else (16,):
        w = 8 * len(s) * sc + n + 4
        if w <= d.width - 4:
            import safe_icons
            x, ty = (d.width - w) // 2, y + 5 - sc
            safe_icons.draw(d, i, x, ty + (8 * sc - n) // 2, n)
            if sc == 1:
                d.text(s, x + n + 4, ty, c)
            else:
                d.big_text(s, x + n + 4, ty, c, sc)
            return True
    return False


def _draw(lines, y, bottom=182, big=False):
    """Lines of (text, color) or (text, color, kind) from y; stops before bottom. Returns the y under them.
    big: each address gets a 48 px blockie and 3 lines of 14 (the caller checks they fit)."""
    import safe_blockie
    for l in lines:
        if y + _h(l, big) > bottom:
            break
        s, c, k = l[0], l[1], (l[2] if len(l) > 2 else None)
        if k == BIG and len(l) > 3 and l[3] is not None and _iconed(s, c, l[3], y):
            pass
        elif k == BIG and len(s) <= 10:
            d.center_text(s, y + 3, c, 3)
        elif k == BIG and len(s) <= ui.COLS_BIG:
            d.center_text(s, y + 2, c, 2)
        elif k == ADDR and big:
            safe_blockie.draw(d, s, 30, y + 2, 6, MUTED)
            for i in range(3):
                d.text(s[i * 14:i * 14 + 14], 94, y + 4 + i * 15, c)
        elif k == ADDR:
            safe_blockie.draw(d, s, 12, y + 2, 4, MUTED)
            d.text(s[:22], 54, y + 6, c)
            d.text(s[22:], 54, y + 20, c)
        elif s:
            d.center_text(s, y + (4 if k == BIG else 0), c)
        y += _h(l, big)
    return y


def webauthn_digest(h):
    """What the chip signs: the WebAuthn message the signer contract rebuilds (WebAuthn.sol)."""
    auth = hashlib.sha256(RP_ID).digest() + b"\x05\x00\x00\x00\x00"     # user present + verified
    ch = binascii.b2a_base64(h).decode().strip().rstrip("=").replace("+", "-").replace("/", "_")
    cdj = '{"type":"webauthn.get","challenge":"' + ch + '",' + FIELDS + "}"
    return auth, hashlib.sha256(auth + hashlib.sha256(cdj.encode()).digest()).digest()


# ---- the chip ---------------------------------------------------------------------------------

N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551     # P-256's order


def _atecc():
    """The ATECC608 if one answers on GP4/GP5, else None (then it's a Trust M)."""
    try:
        import atecc
        a = atecc.ATECC608(sda=4, scl=5)
        a.wake()
        a.sleep()
        return a
    except MemoryError:                 # out of memory isn't "no ATECC608"
        raise
    except Exception:
        return None


def _unload():
    for m in ("optiga", "trustm", "atecc"):
        if m in sys.modules:
            del sys.modules[m]
    gc.collect()


def key_module():
    """safe_key.py (the key's start, make and lock), loaded only for those."""
    import safe_key
    return safe_key


def drop_key_module():
    if "safe_key" in sys.modules:
        del sys.modules["safe_key"]
    _unload()


def make_key():
    global key, state
    try:
        key = key_module().make(_atecc())
    finally:
        drop_key_module()
    state = "ok"
    save.delete("key")                          # the chip keeps it
    save.delete("signer")                       # a new key, a new address
    save.delete("safes")                        # and none of the old key's Safes
    find_signer()


def lock_key():
    """A key from before locking, kept for good (the person said it's theirs)."""
    global state
    try:
        key_module().lock(key, _atecc())
    finally:
        drop_key_module()
    state = "ok"
    save.delete("key")


def load_key():
    """key and state from the chip (a safe-12 key's save only says which key to offer to lock)."""
    global key, state
    try:
        state, key = key_module().start(save.load("key", None), _atecc())
    finally:
        drop_key_module()


def find_signer():
    """Its Safe owner address, worked out once per key (two keccaks in plain Python) and saved."""
    global signer
    if not key:
        signer = None
        return
    s = save.load("signer", None)
    if s and s.get("x") == key["x"]:
        signer = s["address"]
        return
    ui.progress("Finding your address", "Safe owner", False)
    import safe_addr
    try:
        signer = safe_addr.address(unhex(key["x"]), unhex(key["y"]))
    finally:
        del sys.modules["safe_addr"]
        gc.collect()
    save.store("signer", {"x": key["x"], "address": signer})


def sign(digest):
    """(r, s) by the key's chip, s low (N - s is the same signature)."""
    try:
        if key.get("chip") == "ATECC608":
            a = _atecc()
            if not a:
                raise OSError("the key is in an ATECC608 and none answered")
            r, s = a.sign(digest, 0)
        else:
            import optiga
            r, s = optiga.Chip().sign(optiga.KEY2, digest)
    finally:
        _unload()
    return r, (N - s if s > N // 2 else s)


# ---- screens ----------------------------------------------------------------------------------

def draw_home():
    """The title, its Safe owner address (the same on every chain) as a big blockie and big text."""
    d.fill(WHITE)
    ui.band(d)
    ui.title(d, "Safe Signer", 42, 1)
    if state == "ok" and signer:
        import safe_blockie
        safe_blockie.draw(d, signer, 84, 70, 9, MUTED)
        for i in range(3):
            d.center_text(signer[i * 14:i * 14 + 14], 154 + i * 22, INK, 2)
    elif state == "ok":
        _draw([(key["x"][:22], INK), (key["x"][22:44], INK), (key["x"][44:], INK)], 80, 220)
    elif state == "lock":
        _draw([("Not locked", RED, BIG), ("A key from before.", INK), ("Lock it to keep it.", INK)], 80, 180)
    elif state == "swap":
        _draw([("Swap the chip", RED, BIG), ("Its key is locked and", INK), ("isn't Safe Signer's.", INK)], 80, 180)
    else:
        _draw([("No key", INK, BIG)], 90, 180)
    if note:
        d.center_text(note[:ui.COLS_SMALL], 226 if state == "ok" else 170, MUTED)
    if state == "none":
        ui.buttons(d, "make a key", "not now")
    elif state == "lock":
        ui.buttons(d, "lock it", "not now")
    d.show()


def _checksum(a):
    """EIP-55: the mixed-case spelling wedgie.dev/safe and every wallet show."""
    from safe_keccak import keccak256
    h = a[2:].lower()
    kh = binascii.hexlify(keccak256(h.encode())).decode()
    return "0x" + "".join(c.upper() if int(kh[i], 16) >= 8 else c for i, c in enumerate(h))


def _card(safe):
    """Which Safe, as wedgie.dev/safe shows it: a dark rounded card, its blockie, its address with the first 6
    and last 4 in white."""
    import safe_blockie
    r = 8
    for y in range(46):                 # rounded corners: each row inset by the circle's edge
        e = min(y, 45 - y)
        i = int(r - (r * r - (r - e - 0.5) ** 2) ** 0.5 + 0.5) if e < r else 0
        d.hline(2 + i, 2 + y, 236 - 2 * i, INK)
    safe_blockie.draw(d, safe, 9, 5, 5)
    a = _checksum(safe)
    for i in range(3):
        s, x, y = a[i * 14:i * 14 + 14], 60, 7 + i * 13
        for j, ch in enumerate(s):
            n = i * 14 + j
            d.text(ch, x + 8 * j, y, WHITE if n < 6 or n >= 38 else GREY)


def _screen(head, lines, yes, k, foot="", safe=None, nav=False):
    """One page of the question: which Safe in a card at the top, the action big, its lines, the chain small
    at the bottom. True on a real A, False on Y or no answer; nav: "up" or "down" on the d-pad."""
    d.fill(WHITE)
    if safe:
        _card(safe)
    else:
        ui.band(d)
    ui.title(d, head, 54, 1, RED if any(l[1] == RED and len(l) > 2 for l in lines) else INK)   # a big red line: a red page
    _draw(lines, 76, 170, sum(_h(l, True) for l in lines) <= ROOM)    # the big blockie wherever it fits
    if foot:
        d.center_text(foot[:ui.COLS_SMALL], 172, MUTED)
    ui.buttons(d, yes, "no")
    d.show()
    k.pressed()                         # a press made before this page was up doesn't answer it
    t0 = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), t0) < ASK_MS:
        for kk in k.pressed():          # nor one in its first SETTLE ms: a press meant for what was there (audit 10-18)
            if kk in ("A", "Y") and time.ticks_diff(time.ticks_ms(), t0) >= SETTLE:
                return kk == "A"
            if nav and kk in ("up", "down"):
                return kk
        time.sleep_ms(20)
    return False


def _fit(lines, room=None):
    """The lines in parts that each fit a page (_screen draws 76..170)."""
    room = room or ROOM
    parts, part, h = [], [], 0
    for l in lines:
        if part and h + _h(l) > room:
            parts.append(part)
            part, h = [], 0
        part.append(l)
        h += _h(l)
    return parts + [part] if part or not parts else parts


def _sim_info(C, tx):
    """(owner, trust, minimum) from the descriptor, for a simulation's check, or None. minimum: what the call
    says comes back at least, when the token isn't known (its raw "(unknown token)" amount)."""
    try:
        _, owner, trust, its = C.items(tx, tx["clear"])
    except Exception:
        return None
    minimum = None
    for label, text, kind in its:
        if kind == "warn" and text.endswith("(unknown token)"):
            minimum = int(text.split(" ")[0])
    return owner, trust, minimum


def _unclear():
    for m in ("safe_8362", "safe_7730", "safe_wire", "safe_book"):     # loaded only while reading one
        sys.modules.pop(m, None)
    gc.collect()


def confirm(tx):
    """The transaction on the screen, a page per action in a batch. True only on A through every page."""
    global sim_nonce
    k = L.Keys(physical=True)
    k.pressed()
    sf = tx["safe"]
    foot = CHAINS.get(tx["chainId"], "chain %d" % tx["chainId"])
    nonce, sim_nonce, info = sim_nonce, None, None
    pages = None
    if tx.get("clear"):                 # descriptors came along: they say what the calls do, read before safe_read
        try:                            # takes the heap (a Universal Router swap's needs it all), a batch's too
            import safe_7730
            if tx["operation"]:
                tx["pre"] = safe_7730.reads(tx)
            else:
                c = safe_7730.read(tx, tx["clear"])
                if isinstance(c, tuple):
                    pages = [c]
                    if tx["sim"]:       # what a simulation is checked against, while the descriptor is loaded
                        info = _sim_info(safe_7730, tx)
                else:                   # it can't: safe_read's own page, with the reason
                    tx["why"] = c
            tx["clear"] = None
        finally:
            _unclear()
    if pages is None:
        try:
            import safe_read
        except MemoryError:             # clear_buf's room, then once more (a real wedgie, safe-42, a Uniswap swap + fee
            sys.modules.pop("safe_read", None)     # from Instant Wallet: MemoryError, 1280 bytes, here)
            _lend()
            import safe_read
        acts = None
        try:
            acts = safe_read.batch(tx)
            # A DELEGATECALL runs someone else's code as this Safe: only Safe's own MultiSend, whose every action
            # the wedgie reads, and none inside it (audit 10-16: a red page could still be signed)
            if tx["operation"] and acts is None or acts and any(a["operation"] for a in acts):
                raise ValueError("a DELEGATECALL: Safe Signer won't sign that")
            pages = [safe_read.describe(tx)] if acts is None else safe_read.fold(acts)
            if acts:                    # a simulation checks a batch against all its calls: the ETH they send
                tx["out"], tx["calls"] = tx["value"] + sum(a["value"] for a in acts), len(acts)
        finally:
            del acts
            del sys.modules["safe_read"]
            _unclear()
    # a signed simulation: a short page first, the usual under it. A DELEGATECALL got here only as Safe's own MultiSend
    # of plain calls (safe_read.batch, above): clear-sim runs it as the Safe would (its hash says so, safe_sim._txhash)
    sim = bool(tx["sim"])
    # A page that doesn't fit goes on over more pages: every line is seen before the press (wedgie-dev 10-15:
    # an unknown token's recipient fell off the bottom).
    pages = [(head, part) for head, lines in pages for part in _fit(lines)]
    if not pages:                       # nothing on the screen: never a signature (audit 10-18)
        raise ValueError("nothing to show")
    if sim:
        for again in (True, False):     # a MemoryError: clear_buf's room, then once more (safe-47 on a real wedgie,
            try:                        # an Instant Wallet swap: MemoryError, 1280 bytes, loading safe_sim)
                import safe_sim
                sim = safe_sim.check(tx, tx["sim"], nonce)
                if not sim[1]:          # nothing moves (an approval, a vote): the usual pages say it better
                    raise ValueError("nothing moves")
                out, warns = safe_sim.pages(tx, tx["sim"], sim[0], sim[1], info)
                break
            except MemoryError:
                sys.modules.pop("safe_sim", None)
                _lend()
                if again:
                    continue
                print("simulation: no room")    # never an error on the screen: the usual pages
                sim = None
            except (ValueError, KeyError, TypeError) as e:
                print("simulation:", e)     # can't use it: the usual pages
                sim = None
                break
            finally:
                sys.modules.pop("safe_sim", None)
                gc.collect()
    if sim:
        who = sim[0]
        n = len(warns) + sum(1 for _, ls in pages if any(l[1] == RED for l in ls))
        main = out[0][1]
        main.append(("! %s  (down)" % warns[0] if n == 1 and warns else "! %d warnings (down)" % n if n else
                     "says %s (down)" % who[:ui.COLS_SMALL - 12], RED if n else GREEN_D))
        if sum(_h(l) for l in main) > ROOM:    # the contract is on its own page too
            main.pop(0)
        if sum(_h(l) for l in main) > ROOM and not n:      # and who simulated it (the Checked page)
            main.pop()
        usd = [l for l in main if l[1] == MUTED]
        while sum(_h(l) for l in main) > ROOM and usd:    # still too tall: dollars go (on each page)
            main.remove(usd.pop())
        out[0] = (pages[0][0], main)
        return _browse([(h, part) for h, ls in out for part in _fit(ls)] + pages, k, foot, sf)
    n = len(pages)
    for i, (head, lines) in enumerate(pages):
        last = i == n - 1
        if not _screen(head, lines, "sign" if last else "next", k,
                       "%d/%d %s" % (i + 1, n, foot) if n > 1 else foot, sf):
            return False
    return True


def _browse(pages, k, foot, sf):
    """The short page first, the d-pad's up and down through the rest. Red says no on any page. Green goes to the
    next page not seen yet, and signs once every page has been: the short page doesn't say who gets paid, or what
    else the call does, so every line is still seen before the press (as without a simulation)."""
    i, n, seen = 0, len(pages), 1
    while True:
        head, lines = pages[i]
        ok = seen >= n
        r = _screen(head, lines, "sign" if ok else "next", k,
                    "%d/%d %s" % (i + 1, n, "down: more" if i < n - 1 else foot), sf, True)
        if r is True and not ok:
            i = seen
        elif r == "down":
            i = min(i + 1, n - 1)
        elif r == "up":
            i = max(i - 1, 0)
        else:
            return r
        seen = max(seen, i + 1)


# ---- requests ---------------------------------------------------------------------------------

def on_sign(mid, t):
    global note
    if state != "ok":
        W.send({"id": mid, "type": "error", "error": {"lock": "key not locked yet: press A on the wedgie",
                "swap": "this chip's key is locked and isn't Safe Signer's: swap the chip"}.get(state,
                "no key yet: press A on the wedgie to make one")})
        return
    try:
        tx = parse(t or {})
    except Exception as e:
        W.send({"id": mid, "type": "error", "error": "bad tx: %s" % e})
        return
    if tx["gasPrice"]:                  # a refund the screen can't show in full (token, receiver, how much)
        W.send({"id": mid, "type": "error", "error": "pays a gas refund (gasPrice > 0): Safe Signer won't sign that"})
        return
    try:
        for again in (True, True, False):       # room, then clear_buf (_lend), then it's an error
            try:
                ui.progress("Reading the transaction", "Safe tx hash", False)
                h = safe_tx_hash(tx)
                gc.collect()
                yes = confirm(tx)
                break
            except MemoryError:         # never an error for want of memory (Instant Wallet's EXPECTATIONS, rule 0):
                if not again:           # what's kept back to the heap, then the usual pages from the top, without
                    raise               # the extras (a real wedgie, safe-47, an IW swap: MemoryError, 1280 bytes)
                tx["sim"] = tx["clear"] = None
                _unclear()
                _lend()
    except ValueError as e:             # a bad batch, a DELEGATECALL: nothing on screen to say yes to
        W.send({"id": mid, "type": "error", "error": str(e)})
        return
    # the data's block back now, before anything small lands in it: kept back for the next big tx (room). Taken
    # later, the small things signing leaves behind had broken it up (safechip: an 8 KB tx after a 17-send batch)
    tx["data"] = None
    _keep()
    if not yes:
        note = "said no"
        W.send({"id": mid, "type": "refused", "safeTxHash": hx(h)})
        return
    ui.progress("Signing", "in the chip", False)
    auth, dg = webauthn_digest(h)
    r, s = sign(dg)
    note = "signed"
    try:
        keep_safe(tx["chainId"], tx["safe"])
    except Exception as e:              # the list is a convenience: never lose a signature over it
        sys.print_exception(e)
    W.send({"id": mid, "type": "safe_sig", "safeTxHash": hx(h), "x": key["x"], "y": key["y"],
            "r": "0x%064x" % r, "s": "0x%064x" % s, "authenticatorData": hx(auth), "clientDataFields": FIELDS})


def on_remove(mid, t, totp):
    """Sign Safe's delete request for one queued tx. The hash is worked out here from its fields; the screen says
    which one (its number) and that it can still run."""
    global note
    if state != "ok":
        W.send({"id": mid, "type": "error", "error": "no key ready"})
        return
    try:
        t = dict(t or {})
        dh = unhex(t.get("dataHash") or "")
        if len(dh) != 32:
            raise ValueError("dataHash")
        t["data"] = "0x"
        tx = parse(t)
        tx["dataHash"] = dh
        totp = num(totp)
    except Exception as e:
        W.send({"id": mid, "type": "error", "error": "bad tx: %s" % e})
        return
    h = safe_tx_hash(tx)
    k = L.Keys(physical=True)
    k.pressed()
    foot = CHAINS.get(tx["chainId"], "chain %d" % tx["chainId"])
    if not _screen("Remove it?", [("#%d" % tx["nonce"], INK, BIG), GAP, ("Off the list. It can", INK),
                                  ("still run till another", INK), ("tx takes #%d." % tx["nonce"], INK)],
                   "remove", k, foot, tx["safe"]):
        note = "said no"
        W.send({"id": mid, "type": "refused", "safeTxHash": hx(h)})
        return
    ui.progress("Signing", "in the chip", False)
    dg = delete_hash(tx["chainId"], tx["safe"], h, totp)
    auth, w = webauthn_digest(dg)
    r, s = sign(w)
    note = "removed #%d" % tx["nonce"]
    W.send({"id": mid, "type": "safe_sig", "safeTxHash": hx(h), "deleteHash": hx(dg), "x": key["x"], "y": key["y"],
            "r": "0x%064x" % r, "s": "0x%064x" % s, "authenticatorData": hx(auth), "clientDataFields": FIELDS})


def keep_safe(chain, safe):
    """Remember a Safe (newest first, at most SAFES_MAX). Writes the flash only for a new one."""
    k = "%d:%s" % (chain, safe.lower())
    l = save.load("safes", [])
    if l[:1] == [k]:
        return len(l)
    if k in l:
        l.remove(k)
    l.insert(0, k)
    del l[SAFES_MAX:]
    save.store("safes", l)
    return len(l)


def handle(m):
    global dirty, sim_nonce
    mid, t = m.get("id"), m.get("type")
    if t == "safe_sign":
        on_sign(mid, m.get("tx"))
        dirty = True
    elif t == "safe_data":
        on_data(mid, m)
    elif t == "safe_clear":
        on_clear(mid, m)
    elif t == "safe_remove":
        on_remove(mid, m.get("tx"), m.get("totp"))
        dirty = True
    elif t == "safe_prove" or t == "safe_message":    # rare: in safe_msg.py, loaded only for one
        try:
            import safe_msg
            safe_msg.rare(sys.modules[__name__], mid, m)
        finally:
            sys.modules.pop("safe_msg", None)
            _unload()
        dirty = True
    elif t == "safe_nonce":
        import os
        sim_nonce = binascii.hexlify(os.urandom(16)).decode()
        W.send({"id": mid, "type": "safe_nonce", "nonce": sim_nonce})
    elif t == "safe_review":           # a signed clear-review round: robot-checked descriptors (safe_7730 root "c")
        import safe_7730
        try:
            W.send({"id": mid, "type": "safe_review", "round": safe_7730.take_review(m)})
        finally:
            _unclear()
    elif t == "safe_list":
        W.send({"id": mid, "type": "safe_list", "safes": save.load("safes", [])})
    elif t == "safe_note":
        try:
            n = keep_safe(num(m.get("chainId")), addr(m.get("safe")))
        except ValueError as e:
            W.send({"id": mid, "type": "error", "error": "bad safe: %s" % e})
            return
        W.send({"id": mid, "type": "ok", "safes": n})
    elif t == "hello":
        W.send(W.hello(mid, running="safe", app=FW, safe=key if state == "ok" else None, signer=signer if state == "ok" else None,
                       safe_state=state, safe_chunk=CHUNK,
                       safe_clear=clear_tag(), safe_sim="p256", safe_review=review_round()))
    else:                               # hello's cousins, shots, jobs, open: the slot's
        import slot
        slot.handle(m)
        dirty = True


def pump():
    """One request per call, read through the one line reader (wedgie.lines)."""
    global dirty
    R = W.lines()
    try:
        line = R.pump(_poll)
    except MemoryError:                 # the line's one copy found no block: it's gone, clear_buf's room back
        _lend()
        W.send({"type": "error", "error": "no room for that line: send it again"})
        return
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
            try:
                m = json.loads(line)
            except MemoryError:         # clear_buf's room, then once more
                _lend()
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
        m = None
        _keep()


def run():
    global d, keys, _poll, key, state, dirty, note
    d = L.LCD()
    keys = L.Keys(physical=True)
    _poll = select.poll()
    _poll.register(sys.stdin, select.POLLIN)
    try:
        load_key()
    except Exception as e:              # no chip answered: no key (making one says what's wrong)
        print("safe: no key:", e)       # one line, not a traceback: a wedgie with no secure chip is normal
        key, state = None, "none"
    try:
        find_signer()
    except Exception as e:              # the address is for the screen; signing works without it
        sys.print_exception(e)
    _keep()
    W.send(W.hello(None, type="ready", running="safe", app=FW, safe=key if state == "ok" else None,
                   signer=signer if state == "ok" else None, safe_state=state, safe_chunk=CHUNK,
                   safe_clear=clear_tag()))
    while True:
        for k in keys.pressed():
            if k == "A" and state == "lock":
                if ui.ask(d, "Lock this key?", ["Only if you made it.", "Locked for good:", "never replaced."]):
                    try:
                        lock_key()
                        note = "key locked"
                    except Exception as e:
                        sys.print_exception(e)
                        note = "not locked: %s" % e
                elif ui.ask(d, "Make your own key?", ["Replaces this one", "and locks yours", "for good."]):
                    try:
                        make_key()
                        note = "key made"
                    except Exception as e:
                        sys.print_exception(e)
                        note = "no key: %s" % e
                dirty = True
            elif k == "A" and state == "none":
                if ui.ask(d, "Make a key?", ["Your own key, made in", "the chip and locked", "for good. Can't undo."]):
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
