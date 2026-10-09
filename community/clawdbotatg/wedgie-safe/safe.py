# Safe Signer: the wedgie signs Safe{Wallet} transactions with a key that lives in its Trust M chip.
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
#   hello answers also carry "safe": {"x","y"} (or null: no key yet) and "signer": its Safe owner address
#   (safe_addr.py; the home screen shows it, wedgie.dev/safe checks it against its own).
#   {"type":"safe_list"} -> {"type":"safe_list","safes":["8453:0x..", ...]}: the Safes this wedgie knows it's
#   in, newest first, so any computer can list them. {"type":"safe_note","chainId":8453,"safe":"0x.."} adds
#   one (a host that made or opened it); signing for a Safe adds it too. Just a list of addresses: a host
#   checks on chain that the wedgie really is an owner before it shows one.
import sys, select, json, time, gc, binascii, hashlib
import lcd as L
import wedgie as W
import save
import ui
from ui import WHITE, INK, MUTED, GREEN_D, RED

FW = "safe-6"
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
    (1, "0xdac17f958d2ee523a2206206994597c13d831ec7"): ("USDT", 6),
    (1, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"): ("WETH", 18),
    (1, "0x2260fac5e5542a773aa44fbcfed7c193bc2c599"): ("WBTC", 8),
    (1, "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"): ("cbBTC", 8),
    (1, "0x6b175474e89094c44da98b954eedeac495271d0f"): ("DAI", 18),
    (8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"): ("USDC", 6),
    (8453, "0x4200000000000000000000000000000000000006"): ("WETH", 18),
    (8453, "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"): ("cbBTC", 8),
    (8453, "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"): ("DAI", 18),
    (8453, "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"): ("USDT", 6),
    (84532, "0x036cbd53842c5426634e7929541ec2318f3dcf7e"): ("USDC", 6),
    (10, "0x0b2c639c533813f4aa9d7837caf62653d097ff85"): ("USDC", 6),
    (42161, "0xaf88d065e77c8cc2239327c5edb3a432268e5831"): ("USDC", 6),
    (11155111, "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"): ("USDC", 6),
}

# contracts with a name: the same address on every chain unless the chain is in the key.
# A swap router gets an exact approval and the swap names this Safe as who gets paid (checked below).
ROUTERS = {"0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": "LI.FI",
           "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap",     # SwapRouter02, Base
           "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap"}     # SwapRouter02, Ethereum
UNISWAP = ("0x2626664c2603336e57b271c5c0b26f421741e481", "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45")
RECOVERY = "0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2"         # Candide social recovery, 7 days
PASSKEY_FACTORY = "0x1d31f259ee307358a26dfb23eb365939e8641195"  # safe-modules passkey 0.2.1
MODULE_FACTORY = "0x000000000000addb49795b0f9ba5bc298cdda236"   # Zodiac ModuleProxyFactory
ROLES_COPY = "0xf2964ce6161ce0e75964fe7927ce114cb0b283d5"       # Zodiac Roles 2.1.1
MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"       # the budget sends ETH through it
MODULES = {RECOVERY: "7-day recovery"}
# Roles allowance keys Instant Wallet uses (keccak of the name): what they count
K_USDC = "8cf0b93cd9d3e32167f8de799f8e55df33697bb155a46b384f39bd78e75879b5"   # instant-wallet.burner.usdc
K_ETH = "45cc4838df5ba19e2e80bafaf996e5acf9194b3706f31dfa92fdfb8cc4fd3017"    # instant-wallet.burner.eth
K_FEE = "e0a4e7171a966a6c2f8a346d61492f1479248405e8f190113096dd36aed44e2b"    # instant-wallet.burner.fee-usdc
# what each allowance is: (what it's called, symbol, decimals, what it's for)
LIMITS = {K_USDC: ("daily limit", "USDC", 6, "Face ID alone, a day"),
          K_ETH: ("daily limit", "ETH", 18, "Face ID alone, a day"),
          K_FEE: ("fee cap", "USDC", 6, "relay fees, a day")}
# Instant Wallet's relay: it sends the transactions and is paid a fee in the batch. Built in, never from the host.
RELAY = "0x4cfab32186e65e2a39ec0e882e11380cbf2f8a2f"
NAMES = {RELAY: "the Instant relay"}
ROUTER_THIS = "0x0000000000000000000000000000000000000002"      # SwapRouter02: "the router", then unwrap

SAFES_MAX = 32          # Safes the wedgie remembers (save "safes")
CHUNK = 4000            # hex chars per safe_data line (a USB line is at most 6 KB)
# bytes of tx data the wedgie takes in pieces. Joining them needs one free block that size, and how big a
# block a used RP2040 heap still has varies: on a virtual RP2040 (wedgie-dev tools/safechip.mjs) 12 KB
# passed one run and failed another, 16 KB once, 20 KB never. 8 KB passes every run, with room.
MAX_DATA = 8000

# Safe's MultiSend contracts (1.3.0 and 1.4.1, both deployments): a batch is a DELEGATECALL to one of
# these, and the wedgie shows every action in it. A DELEGATECALL to anything else stays red.
MULTISEND = ("0x9641d764fc13c8b624c04430c7356c1c7c8102e2", "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526",
             "0x40a2accbd92bca938b02010e17a5b8929b49130d", "0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b",
             "0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761", "0x998739bfdaadde7c933b942a68053933098f9eda")

d = None
keys = None
_poll = None
key = None          # {"x": "0x..", "y": "0x.."} or None
signer = None       # its Safe owner address, "0x.." checksummed (safe_addr.py), or None
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

# Kept as bytes, each piece decoded as it comes: hex strings joined and then decoded needed ~5x the data at
# once and ran a virtual RP2040 out of memory at 12 KB (wedgie-dev tools/safechip.mjs). As bytes the join
# needs 2x, once.
pieces = []             # a big tx's data, sent ahead in safe_data lines (bytes, one per piece)
have = 0                # bytes of it so far


def on_data(mid, m):
    """{"type":"safe_data","at":<bytes so far>,"hex":"..."}: a piece of the next tx's data. at 0 starts over."""
    global pieces, have
    at, h = m.get("at"), str(m.get("hex") or "")
    if at == 0:
        pieces, have = [], 0
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


def parse(t):
    """The fields, checked and normalized. Raises ValueError on anything off. data "@" = the pieces sent ahead."""
    global pieces, have
    data = t.get("data") or "0x"
    if data == "@":
        gc.collect()
        data = b"".join(pieces)
        pieces, have = [], 0
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


BIG = "big"         # a line kind: big text (the amount, the limit)
ADDR = "addr"       # a line kind: an address in full, with its blockie (safe_blockie) beside it
PIC = "pic"         # a line kind: a blockie of the Safe tx hash and its short form
GAP = ("", INK, "gap")  # a line: 6 px of space


def _addr_lines(head, a, c=INK):
    """An address in full, its blockie beside it: nobody should have to trust 0x12..cdef. A name the wedgie
    knows itself (NAMES) goes on the line above."""
    n = NAMES.get(a)
    return [((head + " " + n).strip() if n else head, MUTED), (a, c, ADDR)]


def _h(line):
    """Pixels a line takes on a page."""
    k = line[2] if len(line) > 2 else None
    return (30 if len(line[0]) <= 10 else 22) if k == BIG else 38 if k in (ADDR, PIC) else 6 if k == "gap" else 12


def _draw(lines, y, bottom=182):
    """Lines of (text, color) or (text, color, kind) from y; stops before bottom. Returns the y under them."""
    import safe_blockie
    for l in lines:
        if y + _h(l) > bottom:
            break
        s, c, k = l[0], l[1], (l[2] if len(l) > 2 else None)
        if k == BIG and len(s) <= 10:
            d.center_text(s, y + 3, c, 3)
        elif k == BIG and len(s) <= ui.COLS_BIG:
            d.center_text(s, y + 2, c, 2)
        elif k == ADDR:
            safe_blockie.draw(d, s, 12, y + 2, 4, MUTED)
            d.text(s[:22], 54, y + 6, c)
            d.text(s[22:], 54, y + 20, c)
        elif k == PIC:
            safe_blockie.draw(d, s, 70, y + 2, 4, MUTED)
            d.text("tx", 112, y + 6, MUTED)
            d.text(short(s), 112, y + 20, MUTED)
        elif s:
            d.center_text(s, y + (4 if k == BIG else 0), c)
        y += _h(l)
    return y


def _tok(tx, a):
    t = TOKENS.get((tx["chainId"], a))
    return t if t else (None, 0)


def _who(a, safe):
    """Who gets paid: this Safe, a name the wedgie knows, or the address with its blockie."""
    if a == safe:
        return [("to this Safe", GREEN_D)]
    return _addr_lines("to", a)


def _amt(tx, a, n):
    sym, dec = _tok(tx, a)
    return "%s %s" % (amount(n, dec), sym) if sym else "%d of %s" % (n, short(a))


def _name(a, safe):
    return "this Safe" if a == safe else ROUTERS.get(a) or MODULES.get(a) or short(a)


def _bytes_at(data, off):
    """An ABI `bytes` whose head word is at `off` (offsets count from `base`)."""
    n = int.from_bytes(data[off:off + 32], "big")
    return data[off + 32:off + 32 + n]


def _uniswap(tx):
    """SwapRouter02 multicall(deadline, [exactInput, unwrapWETH9?]) as (title, lines), or None."""
    data, safe = tx["data"], tx["safe"]
    b = data[4:]
    arr = int.from_bytes(b[32:64], "big")
    n = int.from_bytes(b[arr:arr + 32], "big")
    calls = []
    for i in range(n):
        o = int.from_bytes(b[arr + 32 + 32 * i:arr + 64 + 32 * i], "big")
        calls.append(_bytes_at(b, arr + 32 + o))
    if not calls or calls[0][:4] != b"\xb8\x58\x18\x3f":
        return None
    p = calls[0][4:]
    t = int.from_bytes(p[0:32], "big")
    path = _bytes_at(p, t + int.from_bytes(p[t:t + 32], "big"))
    to = hx(p[t + 44:t + 64])
    amt_in = int.from_bytes(p[t + 64:t + 96], "big")
    min_out = int.from_bytes(p[t + 96:t + 128], "big")
    a, z = hx(path[:20]), hx(path[-20:])
    eth_out = False
    if to == ROUTER_THIS and len(calls) == 2 and calls[1][:4] == b"\x49\x40\x4b\x7c":
        to, eth_out = hx(calls[1][4 + 44:4 + 64]), True
    elif len(calls) != 1:
        return None
    pay = "%s ETH" % amount(tx["value"], 18) if tx["value"] else _amt(tx, a, amt_in)
    get = "%s ETH" % amount(min_out, 18) if eth_out else _amt(tx, z, min_out)
    return "Swap", [("pay", MUTED), (pay, INK, BIG), ("get at least", MUTED), (get, INK, BIG),
                    ("to this Safe", GREEN_D) if to == safe else ("to " + short(to) + "!", RED)]


def _roles(tx, sel):
    """Zodiac Roles (the daily budget): what each setting call does, as (title, lines), or None."""
    data = tx["data"]
    if sel == "957ed2b3" and len(data) >= 4 + 32 * 7:      # assignRoles(module, keys[], memberOf[])
        o = int.from_bytes(_arg(data, 2), "big")
        on = data[4 + o + 32 + 31] == 1
        return "Budget", [("%s key" % ("allow" if on else "drop"), INK if on else RED)] + \
            _addr_lines("", _aarg(data, 0), INK if on else RED)[1:]
    if sel == "610b5925" and len(data) == 36:               # enableModule(key)
        return "Budget", [("allow key", INK)] + _addr_lines("", _aarg(data, 0))[1:]
    if sel == "e009cfde" and len(data) == 68:               # disableModule(prev, key)
        return "Budget", [("drop key", RED)] + _addr_lines("", _aarg(data, 1), RED)[1:]
    t = _aarg(data, 1) if len(data) >= 68 else ""
    what = _tok(tx, t)[0] or ("ETH sends" if t == MULTICALL3 else short(t))
    if sel == "0c6c76b8" and len(data) == 68:               # scopeTarget(role, target)
        return "Budget", [("may use", MUTED), (what, INK, BIG)]
    if sel == "0172a43a" and len(data) == 68:               # revokeTarget(role, target)
        return "Budget", [("no longer uses", MUTED), (what, INK, BIG)]
    if sel == "7508dd98":                                   # scopeFunction(role, target, selector, conditions, options)
        try:
            r = _rule(data, t)
        except Exception:
            r = None
        return "Budget", r or [("rule for", MUTED), (what, INK, BIG), ("it can't read the rule", RED)]
    if sel == "a8ec43ee" and len(data) == 4 + 32 * 6:       # setAllowance(key, balance, max, refill, period, ts)
        k = binascii.hexlify(_arg(data, 0)).decode()
        refill, per = int.from_bytes(_arg(data, 3), "big"), int.from_bytes(_arg(data, 4), "big")
        if k in LIMITS:
            name, sym, dec, why = LIMITS[k]
            return name[0].upper() + name[1:], [("%s %s" % (amount(refill, dec), sym), INK, BIG),
                                                 (why if per == 86400 else "every %ds" % per, MUTED if per == 86400 else RED)]
        return "Budget", [("up to", MUTED), ("%d units, unknown limit" % refill, RED)]
    if sel == "2916a9af":                                   # setTransactionUnwrapper
        return "Budget", [("read batches", INK)]
    return None


def _conds(data):
    """scopeFunction's ConditionFlat[]: [(parent, paramType, operator, compValue hex)]."""
    b = data[4:]
    o = int.from_bytes(b[96:128], "big")
    n = int.from_bytes(b[o:o + 32], "big")
    out = []
    for i in range(n):
        t = o + 32 + int.from_bytes(b[o + 32 + 32 * i:o + 64 + 32 * i], "big")
        v = _bytes_at(b, t + int.from_bytes(b[t + 96:t + 128], "big"))
        out.append((b[t + 31], b[t + 63], b[t + 95], binascii.hexlify(v).decode()))
    return out


def _rule(data, target):
    """The rules Instant Wallet sets for the burner's USDC and ETH, in words; None for any other."""
    c = _conds(data)
    sel = binascii.hexlify(data[68:72]).decode()
    if sel == "a9059cbb" and c == [(0, 5, 5, ""), (0, 1, 0, ""), (0, 1, 28, K_USDC)]:
        return [("USDC", INK, BIG), ("to anyone,", INK), ("up to the daily limit", INK)]
    if sel == "a9059cbb" and len(c) == 7 and c[:3] == [(0, 0, 2, ""), (0, 5, 5, ""), (0, 5, 5, "")] and \
            c[3][:3] == (1, 1, 16) and len(c[3][3]) == 64 and c[4:] == [(1, 1, 28, K_FEE), (2, 1, 0, ""), (2, 1, 28, K_USDC)]:
        r = "0x" + c[3][3][24:]
        return [("USDC", INK, BIG), ("fees up to the fee cap", INK)] + _addr_lines("to", r, INK if r in NAMES else RED) + \
            [("others up to the daily limit", INK)]
    if target == MULTICALL3 and sel == "174dea71" and c == [(0, 5, 5, ""), (0, 4, 0, ""), (0, 0, 29, K_ETH), (1, 3, 0, ""),
                                                            (3, 1, 0, ""), (3, 1, 0, ""), (3, 1, 0, ""), (3, 2, 0, "")]:
        return [("ETH", INK, BIG), ("to anyone,", INK), ("up to the daily limit", INK)]
    return None


def _owner(a, c):
    """An owner being added or removed: THIS wedgie, big, when it's this one; else its address."""
    if signer and a == signer.lower():
        return [("THIS wedgie", c, BIG)]
    return _addr_lines("", a, c)[1:]


def _then(n):
    return ("then %d signer%s" % (n, "" if n == 1 else "s"), INK)


def describe(tx):
    """What the transaction does: (title, lines of (text, color[, kind])), at most 6 lines. Few words, big
    (wedgie-dev docs/STYLE.md rule 0): the title is the action, the amount or the one fact that matters big."""
    data, to, safe = tx["data"], tx["to"], tx["safe"]
    sel = binascii.hexlify(data[:4]).decode() if len(data) >= 4 else ""
    out = []
    if tx["operation"] == 1:
        out.append(("DELEGATECALL: can do anything", RED))
    if not data:
        return "Send", out + [("%s ETH" % amount(tx["value"], 18), INK, BIG)] + _who(to, safe)
    if tx["value"] and to not in ROUTERS:
        out.append(("+ %s ETH" % amount(tx["value"], 18), RED))
    n1, n2 = lambda: int.from_bytes(_arg(data, 1), "big"), lambda: int.from_bytes(_arg(data, 2), "big")
    if to == safe and sel == "0d582f13" and len(data) == 68:
        return "Add owner", out + _owner(_aarg(data, 0), INK) + [_then(n1())]
    if to == safe and sel == "f8dc5dd9" and len(data) == 100:
        return "Remove owner", out + _owner(_aarg(data, 1), RED) + [_then(n2())]
    if to == safe and sel == "e318b52b" and len(data) == 100:
        return "Swap owner", out + [(_aarg(data, 1)[:22] + "..", RED), ("for", MUTED)] + _addr_lines("", _aarg(data, 2))[1:]
    if to == safe and sel == "694e80c3" and len(data) == 36:
        return "Signers needed", out + [("%d" % int.from_bytes(_arg(data, 0), "big"), INK, BIG)]
    if to == safe and sel == "610b5925" and len(data) == 36:
        m = _aarg(data, 0)
        return "Turn on module", out + ([(MODULES[m], INK)] if m in MODULES else _addr_lines("", m, RED)[1:])
    if to == safe and sel == "e009cfde" and len(data) == 68:
        m = _aarg(data, 1)
        return "Turn off module", out + ([(MODULES[m], RED)] if m in MODULES else _addr_lines("", m, RED)[1:])
    if to == RECOVERY and sel == "be0e54d7" and len(data) == 68:
        return "Add guardian", out + _addr_lines("", _aarg(data, 0))[1:] + [("can replace your keys", MUTED), ("after 7 days", MUTED)]
    if to == RECOVERY and sel == "936f7d86" and len(data) == 100:
        return "Drop guardian", out + _addr_lines("", _aarg(data, 1), RED)[1:]
    if to == RECOVERY and sel == "0ba234d6" and len(data) == 4:
        return "Cancel recovery", out
    if to == PASSKEY_FACTORY and sel == "0d2f0489":
        return "Passkey signer", out + [("changes nothing yet", MUTED)]
    if to == MODULE_FACTORY and sel == "f1ab873c" and _aarg(data, 0) == ROLES_COPY:
        return "Set up budget", out
    if sel == "095ea7b3" and len(data) == 68:
        sp, n = _aarg(data, 0), int.from_bytes(_arg(data, 1), "big")
        c = INK if not n or sp in ROUTERS else RED
        return "Approve", out + [(_amt(tx, to, n) if n else "0", c, BIG), ("for " + _name(sp, safe), c)]
    if to in UNISWAP and sel == "5ae401dc":
        try:
            u = _uniswap(tx)
        except Exception:
            u = None
        if u:
            return u[0], out + u[1]
    if to in ROUTERS:
        mine = binascii.unhexlify(safe[2:]) in data
        return "Swap", out + [("via " + ROUTERS[to], INK)] + \
            ([("pay", MUTED), ("%s ETH" % amount(tx["value"], 18), INK, BIG)] if tx["value"] else []) + \
            [("pays this Safe", GREEN_D) if mine else ("doesn't pay this Safe!", RED)]
    r = _roles(tx, sel) if to != safe else None
    if r:
        return r[0], out + r[1]
    if sel == "a9059cbb" and len(data) == 68:
        tok = TOKENS.get((tx["chainId"], to))
        n = int.from_bytes(_arg(data, 1), "big")
        if not tok:
            return "Send", out + [("%d of token" % n, INK)] + _addr_lines("", to, RED)[1:] + _who(_aarg(data, 0), safe)
        r = _aarg(data, 0)
        return "Fee" if r == RELAY else "Send", out + [("%s %s" % (amount(n, tok[1]), tok[0]), INK, BIG)] + _who(r, safe)
    return "Contract call", out + [("%s, %d bytes, on" % (sel, len(data)), RED)] + _addr_lines("", to, RED)[1:]


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
        save.delete("signer")                   # a new key, a new address
        save.delete("safes")                    # and none of the old key's Safes
    finally:
        _unload()
    find_signer()


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
    try:
        o, c = _chip()
        return c.sign(o.KEY2, digest)
    finally:
        _unload()


# ---- screens ----------------------------------------------------------------------------------

def draw_home():
    """The title, its Safe owner address (the same on every chain) as a big blockie and big text."""
    d.fill(WHITE)
    ui.band(d)
    ui.title(d, "Safe Signer", 42, 1)
    if key and signer:
        import safe_blockie
        safe_blockie.draw(d, signer, 84, 70, 9, MUTED)
        for i in range(3):
            d.center_text(signer[i * 14:i * 14 + 14], 154 + i * 22, INK, 2)
    elif key:
        _draw([(key["x"][:22], INK), (key["x"][22:44], INK), (key["x"][44:], INK)], 80, 220)
    else:
        _draw([("No key", INK, BIG)], 90, 180)
    if note:
        d.center_text(note[:ui.COLS_SMALL], 226 if key else 170, MUTED)
    if not key:
        ui.buttons(d, "make a key", "not now")
    d.show()


def _screen(head, lines, yes, k, foot=""):
    """One page of the question: the action big, its lines, which Safe small at the bottom. True on a
    real A, False on Y or no answer."""
    d.fill(WHITE)
    ui.band(d)
    ui.title(d, head, 42, 1)
    _draw(lines, 68, 166)
    if foot:
        d.center_text(foot[:ui.COLS_SMALL], 170, MUTED)
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
    foot = "%s  Safe %s" % (CHAINS.get(tx["chainId"], "chain %d" % tx["chainId"]), short(tx["safe"]))
    tail = [("pays a gas refund", RED)] if tx["gasPrice"] else []
    pic = (hx(h), MUTED, PIC)       # the phone and computer draw the same blockie of this hash (if it fits)
    acts = batch(tx)
    if acts is None:
        head, lines = describe(tx)
        return _screen(head, lines + tail + [pic], "sign", k, foot)
    n = len(acts)
    if not _screen("Batch", [("%d actions" % n, INK, BIG)] + tail + [pic], "next", k, foot):
        return False
    for i, a in enumerate(acts):
        last = i == n - 1
        head, lines = describe(a)
        if not _screen(head, lines + (tail if last else []), "sign all" if last else "next", k,
                       "%d/%d %s" % (i + 1, n, foot)):
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
    global dirty
    mid, t = m.get("id"), m.get("type")
    if t == "safe_sign":
        on_sign(mid, m.get("tx"))
        dirty = True
    elif t == "safe_data":
        on_data(mid, m)
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
        W.send(W.hello(mid, running="safe", app=FW, safe=key, signer=signer, safe_chunk=CHUNK))
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
    try:
        find_signer()
    except Exception as e:              # the address is for the screen; signing works without it
        sys.print_exception(e)
    W.send(W.hello(None, type="ready", running="safe", app=FW, safe=key, signer=signer, safe_chunk=CHUNK))
    while True:
        for k in keys.pressed():
            if k == "A" and not key:
                if ui.ask(d, "Make a key?", ["Replaces chip key slot 2."]):
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
