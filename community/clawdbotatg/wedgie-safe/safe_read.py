# Safe Signer: reading a transaction into pages (describe, batch, fold). Loaded only while a question is up
# (safe.confirm imports it and lets it go): the app's idle heap needs room for a 6 KB USB line.
import binascii
import safe as A
from ui import INK, MUTED, GREEN_D, RED
from safe import word, aword, unhex, hx, short, amount, CHAINS, BIG, ADDR

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
# Candide social recovery: a wallet starts on the 7-day one; pairing a wedgie puts the owner's own recovery address
# on the 14-day one and the DAO on the 60-day one (the same Candide code, Instant Wallet deployed it)
RECOVERY = {"0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2": 7, "0x9bacd92f4687db306d7ded5d4513a51ea05df25b": 14,
            "0x6aa9a8ad0582db61a97a6e30eba22ba143d1e960": 60}
PASSKEY_FACTORY = "0x1d31f259ee307358a26dfb23eb365939e8641195"  # safe-modules passkey 0.2.1 (a public contract; gitleaks:allow)
MODULE_FACTORY = "0x000000000000addb49795b0f9ba5bc298cdda236"   # Zodiac ModuleProxyFactory
ROLES_COPY = "0xf2964ce6161ce0e75964fe7927ce114cb0b283d5"       # Zodiac Roles 2.1.1
MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"       # the budget sends ETH through it
MODULES = {m: "%d-day recovery" % d for m, d in RECOVERY.items()}
# the Roles calls the limit pages read (assignRoles, enableModule, disableModule, scopeTarget, revokeTarget,
# scopeFunction, setAllowance, setTransactionUnwrapper)
ROLES_SELS = ("957ed2b3", "610b5925", "e009cfde", "0c6c76b8", "0172a43a", "7508dd98", "a8ec43ee", "2916a9af")
# Roles allowance keys Instant Wallet uses (keccak of the name): what they count
K_USDC = "8cf0b93cd9d3e32167f8de799f8e55df33697bb155a46b384f39bd78e75879b5"   # instant-wallet.burner.usdc
K_ETH = "45cc4838df5ba19e2e80bafaf996e5acf9194b3706f31dfa92fdfb8cc4fd3017"    # instant-wallet.burner.eth
K_FEE = "e0a4e7171a966a6c2f8a346d61492f1479248405e8f190113096dd36aed44e2b"    # instant-wallet.burner.fee-usdc
ROLE = "86c37482ef7146c27eb2859f3f7443e45fcbc4e32caa3c89515918953dd30949"     # instant-wallet.burner: the one role
# what each allowance is: (what it's called, symbol, decimals, what it's for)
LIMITS = {K_USDC: ("Daily limit", "USDC", 6, "a day with just Face ID"),
          K_ETH: ("Daily limit", "ETH", 18, "a day with just Face ID"),
          K_FEE: ("Fee limit", "USDC", 6, "a day for fees")}
# Instant Wallet's relay: it sends the transactions and is paid a fee in the batch. Built in, never from the host.
RELAY = "0x4cfab32186e65e2a39ec0e882e11380cbf2f8a2f"
NAMES = {RELAY: "the Instant relay"}
ROUTER_THIS = "0x0000000000000000000000000000000000000002"      # SwapRouter02: "the router", then unwrap
LIFI = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"
# LI.FI's swaps whose argument 3 is who gets paid (swapTokensGeneric and the six GenericSwapFacetV3 ones). Any
# other selector with this Safe in word 3 is not a swap to this Safe (audit 10-16: one was shown as one).
LIFI_SWAPS = (b"\x46\x30\xa0\xd8", b"\x5f\xd9\xae\x2e", b"\x2c\x57\xe8\x84", b"\x73\x6e\xac\x0b",
              b"\x46\x66\xfc\x80", b"\x73\x32\x14\xa3", b"\xaf\x70\x60\xfd")
# Roles reads a MultiSendCallOnly batch through this one (Instant Wallet's setup); any other reader can make the
# Roles module see a different call than the one sent, so it's red
UNWRAPPER = "0xb4cd4bb764c089f20da18700ce8bc5e49f369efd"

# Safe's MultiSend contracts (1.3.0 and 1.4.1, both deployments): a batch is a DELEGATECALL to one of
# these, and the wedgie shows every action in it. A DELEGATECALL to anything else stays red.
MULTISEND = ("0x9641d764fc13c8b624c04430c7356c1c7c8102e2", "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526",
             "0x40a2accbd92bca938b02010e17a5b8929b49130d", "0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b",
             "0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761", "0x998739bfdaadde7c933b942a68053933098f9eda")

def _arg(data, i):
    return data[4 + 32 * i:36 + 32 * i]


def _aarg(data, i):
    return "0x" + binascii.hexlify(_arg(data, i)[12:]).decode()


def _addr_lines(head, a, c=INK):
    """An address in full, its blockie beside it: nobody should have to trust 0x12..cdef. A name the wedgie
    knows itself (NAMES) goes on the line above."""
    n = NAMES.get(a)
    return [((head + " " + n).strip() if n else head, MUTED), (a, c, ADDR)]


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


def _lifi_to(data, safe):
    """Who a LI.FI call pays. 0: this Safe, here (a swap: its receiver is argument 3). A chain id: this Safe on that
    chain (a bridge: BridgeData's receiver and destinationChainId). None: anyone else, or it can't tell."""
    if data[:4] in LIFI_SWAPS and len(data) >= 4 + 32 * 5 and _aarg(data, 3) == safe:
        return 0
    try:
        o = 4 + int.from_bytes(_arg(data, 0), "big")
        # BridgeData: receiver (field 5), destinationChainId (7), hasDestinationCall (9) must be false: a call
        # on the far chain can send the money on to anyone
        if o + 320 <= len(data) and hx(data[o + 172:o + 192]) == safe and not any(data[o + 288:o + 320]):
            far = int.from_bytes(data[o + 224:o + 256], "big")
            return far if far >> 32 == 0 else None
    except Exception:
        pass
    return None


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
    get = "%s ETH" % amount(min_out, 18) if eth_out else _amt(tx, z, min_out)
    if tx["value"] and not (_tok(tx, a)[0] == "WETH" and amt_in == tx["value"]):   # ETH sent, but the swap pays
        pay = [(_amt(tx, a, amt_in), RED, BIG), ("and sends %s ETH" % amount(tx["value"], 18), RED)]   # something else
    else:                                                                            # (audit 10-18)
        pay = [("%s ETH" % amount(tx["value"], 18) if tx["value"] else _amt(tx, a, amt_in), INK, BIG)]
    return "Swap", [("pay", MUTED)] + pay + [("get at least", MUTED), (get, INK, BIG),
                    ("to this Safe", GREEN_D) if to == safe else ("to " + short(to) + "!", RED)]


_roles_of = {}          # safe -> its Roles address (the keccaks are slow in plain Python: once each)


def _init(safe):
    """Roles.setUp(abi.encode(safe, safe, safe)): how Instant Wallet makes a Safe's own daily limit."""
    return binascii.unhexlify("a4f9edbf") + word(32) + word(96) + aword(safe) * 3


def roles_of(safe):
    """The address of this Safe's own daily limit (Zodiac Roles, CREATE2 by the ModuleProxyFactory, salt
    keccak(keccak(init), 0)): the limit pages say "Daily limit" only for calls to it."""
    if safe not in _roles_of:
        from safe_keccak import keccak256 as k
        code = binascii.unhexlify("602d8060093d393df3363d3d373d3d3d363d73") + unhex(ROLES_COPY) + \
            binascii.unhexlify("5af43d82803e903d91602b57fd5bf3")
        h = k(b"\xff" + unhex(MODULE_FACTORY) + k(k(_init(safe)) + word(0)) + k(code))
        _roles_of[safe] = hx(h[12:])
    return _roles_of[safe]


def _roles(tx, sel):
    """Zodiac Roles (the daily budget): what each setting call does, as (title, lines), or None."""
    data = tx["data"]
    if sel == "957ed2b3" and len(data) >= 4 + 32 * 7:      # assignRoles(module, keys[], memberOf[])
        ko, o = int.from_bytes(_arg(data, 1), "big"), int.from_bytes(_arg(data, 2), "big")
        if int.from_bytes(data[4 + ko:36 + ko], "big") != 1 or int.from_bytes(data[4 + o:36 + o], "big") != 1 or \
                binascii.hexlify(data[36 + ko:68 + ko]).decode() != ROLE:      # one role, Instant Wallet's (audit 10-18)
            return "Daily limit", [("roles", MUTED), ("can't read it", RED, BIG)]
        on = data[4 + o + 32 + 31] == 1
        return "Daily limit", [("this key may spend" if on else "this key can't spend", INK if on else RED)] + \
            _addr_lines("", _aarg(data, 0), INK if on else RED)[1:]
    if sel == "610b5925" and len(data) == 36:               # enableModule(key)
        return "Daily limit", [("turn it on", INK)] + _addr_lines("", _aarg(data, 0))[1:]
    if sel == "e009cfde" and len(data) == 68:               # disableModule(prev, key)
        return "Daily limit", [("turn it off", RED)] + _addr_lines("", _aarg(data, 1), RED)[1:]
    t = _aarg(data, 1) if len(data) >= 68 else ""
    if sel in ("0c6c76b8", "0172a43a", "7508dd98") and binascii.hexlify(_arg(data, 0)).decode() != ROLE:
        return "Daily limit", [("another role", MUTED), ("can't read it", RED, BIG)]     # (audit 10-18)
    what = _tok(tx, t)[0] or ("ETH sends" if t == MULTICALL3 else short(t))
    if sel == "0c6c76b8" and len(data) == 68:               # scopeTarget(role, target)
        ok = _tok(tx, t)[0] == "USDC" or t == MULTICALL3     # what Instant Wallet's limits spend through
        return "Daily limit", [("can spend", MUTED), (what, INK if ok else RED, BIG)]
    if sel == "0172a43a" and len(data) == 68:               # revokeTarget(role, target)
        return "Daily limit", [("can't spend", MUTED), (what, RED, BIG)]
    if sel == "7508dd98":                                   # scopeFunction(role, target, selector, conditions, options)
        try:
            r = _rule(tx, data, t)
        except Exception:
            r = None
        return r or ("Daily limit", [("rule for", MUTED), (what, INK, BIG), ("can't read it", RED)])
    if sel == "a8ec43ee" and len(data) == 4 + 32 * 6:       # setAllowance(key, balance, max, refill, period, ts)
        k = binascii.hexlify(_arg(data, 0)).decode()
        refill, per = int.from_bytes(_arg(data, 3), "big"), int.from_bytes(_arg(data, 4), "big")
        bal, most = int.from_bytes(_arg(data, 1), "big"), int.from_bytes(_arg(data, 2), "big")
        if k in LIMITS and (bal > refill or most != refill):     # spendable now / at most: more than a day's (audit 10-18)
            name, sym, dec, why = LIMITS[k]
            return name, [("%s %s" % (amount(max(bal, most), dec), sym), RED, BIG), ("can go at once", RED),
                          ("then %s %s" % (amount(refill, dec), sym), MUTED)]
        if k in LIMITS:
            name, sym, dec, why = LIMITS[k]
            return name, [("%s %s" % (amount(refill, dec), sym), INK, BIG),
                                                 (why if per == 86400 else "every %ds" % per, MUTED if per == 86400 else RED)]
        return "Daily limit", [("%d" % refill, RED, BIG), ("of what? can't tell", RED)]
    if sel == "2916a9af" and len(data) == 100:              # setTransactionUnwrapper(to, selector, adapter)
        if _aarg(data, 0) == MULTISEND[0] and data[36:40] == b"\x8d\x80\xff\x0a" and _aarg(data, 2) == UNWRAPPER:
            return "Daily limit", [("works in bundles", INK)]
        return "Daily limit", [("reads bundles with", RED)] + _addr_lines("", _aarg(data, 2), RED)[1:]
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


def _rule(tx, data, target):
    """The rules Instant Wallet sets for the burner's USDC and ETH, in words; None for any other."""
    c = _conds(data)
    sel = binascii.hexlify(data[68:72]).decode()
    opt = int.from_bytes(_arg(data, 4), "big")      # ExecutionOptions: 0 none, 1 send ETH, 2/3 delegatecall: the key
    if opt != (1 if target == MULTICALL3 else 0):   # would run any code as the Safe (audit 10-18)
        return None
    if sel == "a9059cbb" and _tok(tx, target)[0] != "USDC":   # the USDC rules on another token: not what it says
        return None
    if sel == "a9059cbb" and c == [(0, 5, 5, ""), (0, 1, 0, ""), (0, 1, 28, K_USDC)]:
        return "Daily limit", [("USDC", INK, BIG), ("to anyone", INK)]
    if sel == "a9059cbb" and len(c) == 7 and c[:3] == [(0, 0, 2, ""), (0, 5, 5, ""), (0, 5, 5, "")] and \
            c[3][:3] == (1, 1, 16) and len(c[3][3]) == 64 and c[4:] == [(1, 1, 28, K_FEE), (2, 1, 0, ""), (2, 1, 28, K_USDC)]:
        r = "0x" + c[3][3][24:]
        if r == RELAY:
            return "Fee limit", [("fees get", INK), ("their own limit", INK)]
        return "Fee limit", [("fees to", RED)] + _addr_lines("", r, RED)[1:] + [("get their own limit", INK)]
    if target == MULTICALL3 and sel == "174dea71" and c == [(0, 5, 5, ""), (0, 4, 0, ""), (0, 0, 29, K_ETH), (1, 3, 0, ""),
                                                            (3, 1, 0, ""), (3, 1, 0, ""), (3, 1, 0, ""), (3, 2, 0, "")]:
        return "Daily limit", [("ETH", INK, BIG), ("to anyone", INK)]
    return None


def _owner(a, c):
    """An owner being added or removed: THIS wedgie, big, when it's this one; else its address."""
    if A.signer and a == A.signer.lower():
        return [("THIS wedgie", c, BIG)]
    return _addr_lines("", a, c)[1:]


def _then(n):
    return ("then %d must sign" % n, INK)


def describe(tx):
    """What the transaction does: (title, lines of (text, color[, kind])), at most 6 lines. Few words, big
    (wedgie-dev docs/STYLE.md rule 0): the title is the action, the amount or the one fact that matters big."""
    data, to, safe = tx["data"], tx["to"], tx["safe"]
    sel = binascii.hexlify(data[:4]).decode() if len(data) >= 4 else ""
    out = []
    if tx["operation"] == 1:            # (a MultiSend batch never gets here: confirm reads its actions)
        return "Danger", [("can take all", RED, BIG)] + _addr_lines("", to, RED)[1:]
    if not data:
        return "Fee" if to == RELAY else "Send", out + [("%s ETH" % amount(tx["value"], 18), INK, BIG)] + _who(to, safe)
    if tx["value"] and to not in ROUTERS:
        out.append(("+ %s ETH" % amount(tx["value"], 18), RED))
    n1, n2 = lambda: int.from_bytes(_arg(data, 1), "big"), lambda: int.from_bytes(_arg(data, 2), "big")
    if to == safe and sel == "0d582f13" and len(data) == 68:
        return "Add owner", out + _owner(_aarg(data, 0), INK) + [_then(n1())]
    if to == safe and sel == "f8dc5dd9" and len(data) == 100:
        return "Remove owner", out + _owner(_aarg(data, 1), RED) + [_then(n2())]
    if to == safe and sel == "e318b52b" and len(data) == 100:
        return "Swap owner", out + [("out: " + short(_aarg(data, 1)), RED), ("in:", MUTED)] + _addr_lines("", _aarg(data, 2))[1:]
    if to == safe and sel == "694e80c3" and len(data) == 36:
        return "Must sign", out + [("%d" % int.from_bytes(_arg(data, 0), "big"), INK, BIG)]
    if to == safe and sel == "610b5925" and len(data) == 36:
        m = _aarg(data, 0)
        if m == roles_of(safe):
            return "Turn on", out + [("Daily limit", INK, BIG)]
        return "Turn on", out + ([(MODULES[m], INK)] if m in MODULES else
                                 [("can move any money", RED)] + _addr_lines("", m, RED)[1:])
    if to == safe and sel == "e009cfde" and len(data) == 68:
        m = _aarg(data, 1)
        return "Turn off", out + ([("Daily limit" if m == roles_of(safe) else MODULES[m], RED)] if m in MODULES or
                                  m == roles_of(safe) else _addr_lines("", m, RED)[1:])
    if to in RECOVERY and sel == "be0e54d7" and len(data) == 68:
        return "Add helper", out + _addr_lines("", _aarg(data, 0))[1:] + [("can swap owners", MUTED), ("after %d days" % RECOVERY[to], MUTED)]
    if to in RECOVERY and sel == "936f7d86" and len(data) == 100:
        return "Drop helper", out + _addr_lines("", _aarg(data, 1), RED)[1:]
    if to in RECOVERY and sel == "0ba234d6" and len(data) == 4:
        return "Cancel recovery", out
    if to == PASSKEY_FACTORY and sel == "0d2f0489":
        return "Make a key", out + [("not an owner yet", MUTED)]
    if to == MODULE_FACTORY and sel == "f1ab873c" and _aarg(data, 0) == ROLES_COPY and len(data) >= 100 and \
            not int.from_bytes(_arg(data, 2), "big") and _bytes_at(data[4:], int.from_bytes(_arg(data, 1), "big")) == _init(safe):
        return "Daily limit", out + [("set it up", INK)]
    if sel == "095ea7b3" and len(data) == 68:
        sp, n = _aarg(data, 0), int.from_bytes(_arg(data, 1), "big")
        c = INK if not n or sp in ROUTERS else RED
        if not n:
            return "Stop spending", out + [(_name(sp, safe), INK), ("can't take any", INK)]
        if n >> 128:                    # "unlimited": every one of them, now and later
            c = RED
        who = [("by " + ROUTERS[sp], c)] if sp in ROUTERS else [("by", c)] + _addr_lines("", sp, c)[1:]
        return "Allow taking", out + [("ALL " + (_tok(tx, to)[0] or "of it") if n >> 128 else _amt(tx, to, n), c, BIG)] + who
    if to in UNISWAP and sel == "5ae401dc":
        try:
            u = _uniswap(tx)
        except Exception:
            u = None
        if u:
            return u[0], out + u[1]
    if to in ROUTERS:
        far = _lifi_to(data, safe) if to == LIFI else None     # a Uniswap call _uniswap couldn't read: can't tell
        return ("Bridge" if far else "Swap"), out + [("via " + ROUTERS[to], INK)] + \
            ([("pay", MUTED), ("%s ETH" % amount(tx["value"], 18), INK, BIG)] if tx["value"] else []) + \
            ([("to this Safe", GREEN_D)] if far == 0 else
             [("to this Safe on", INK), (CHAINS.get(far, "chain %d" % far), INK, BIG)] if far else
             [("can't tell who gets it", RED)]) + \
            [("trust " + ROUTERS[to], RED, BIG), ("can't check what you get", RED)]   # it reads who gets paid, not how much
    r = _roles(tx, sel) if sel in ROLES_SELS and to == roles_of(safe) else None
    if r:
        return r[0], out + r[1]
    if sel == "a9059cbb" and len(data) == 68:
        tok = TOKENS.get((tx["chainId"], to))
        n = int.from_bytes(_arg(data, 1), "big")
        if not tok:
            return "Send", out + [("%d of token" % n, INK)] + _addr_lines("", to, RED)[1:] + _who(_aarg(data, 0), safe)
        r = _aarg(data, 0)
        return "Fee" if r == RELAY else "Send", out + [("%s %s" % (amount(n, tok[1]), tok[0]), INK, BIG)] + _who(r, safe)
    return "Unknown", out + [("can't read this", RED, BIG)] + _addr_lines("on", to, RED)


def batch(tx):
    """The actions in a MultiSend batch, each a tx-like dict, or None if this isn't one."""
    data = tx["data"]
    if not (tx["operation"] == 1 and tx["to"] in MULTISEND and data[:4] == b"\x8d\x80\xff\x0a"):
        return None
    # multiSend(bytes): the bytes must start right after their offset word, where the wedgie reads them.
    # Solidity follows the offset; a batch pointed elsewhere signed one thing and showed another (audit 10-16).
    n = int.from_bytes(data[36:68], "big")
    if data[4:36] != word(32) or len(data) < 68 + n or not n:     # empty: nothing to show, nothing signed (audit 10-18)
        raise ValueError("bad batch")
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


def _sel(a):
    return binascii.hexlify(a["data"][:4]).decode()


def fold(acts):
    """A batch's pages, as few as can be without hiding anything that matters:
    - the Instant relay's fee (at most 1 USDC or 0.001 ETH) is a small line on the page before it;
    - an exact approval for a swap router, then that router's swap: one Swap page;
    - setting up or changing this Safe's own daily limit (every part checked, nothing red): one page with the
      amounts. Which key may spend keeps its own page."""
    pages, lim = [], None               # lim: the daily-limit page being built, [amounts, fee cap, rest]
    for a in acts:
        head, lines = describe(a)
        sel, red = _sel(a), any(l[1] == RED for l in lines)
        if pages and head == "Fee" and lines[0][2:] == (BIG,) and (
                a["value"] <= 10 ** 15 if not a["data"] else
                _tok(a, a["to"])[0] == "USDC" and int.from_bytes(a["data"][36:68], "big") <= 1000000):
            pages[-1][1].append(("+ %s fee" % lines[0][0], MUTED))
            continue
        app = pages[-1] if pages and pages[-1][0] == "Allow taking" else None
        if app and head in ("Swap", "Bridge") and app[2] == a["to"] and not any(l[1] == RED for l in app[1]):
            amt = app[1][0][0]
            fees = [l for l in app[1] if l[0][:2] == "+ "]     # fees folded onto the approval stay (audit 10-18)
            if any(l[0] == amt for l in lines):
                pages[-1] = (head, lines + fees, None)
                continue
            if not any(l[0] == "pay" for l in lines):
                pages[-1] = (head, lines[:1] + [("pay", MUTED), (amt, INK, BIG)] + lines[1:] + fees, None)
                continue
        mine = head in ("Daily limit", "Fee limit") or head == "Turn on" and lines == [("Daily limit", INK, BIG)]
        if mine and not red and not (a["to"] != a["safe"] and sel in ("957ed2b3", "610b5925")):
            if lim is None:
                lim = [[], None, None, ("Daily limit", [], None)]
                pages.append(lim[3])
            if sel == "a8ec43ee":
                if head == "Fee limit":
                    lim[1] = ("fees: %s a day" % lines[0][0], MUTED)
                else:
                    lim[0].append(lines[0])
            _limit_page(lim)
            continue
        if pages and not red and a["to"] != a["safe"] and sel == "957ed2b3" and pages[-1][2] == ("key", _aarg(a["data"], 0)):
            pages[-1] = (head, lines, None)     # turn the key on, then let it spend: one page
            continue
        pages.append((head, lines, _aarg(a["data"], 0) if head == "Allow taking" else
                      ("key", _aarg(a["data"], 0)) if not red and a["to"] != a["safe"] and sel == "610b5925" and
                      head == "Daily limit" else None))
    return [(p[0], p[1]) for p in pages]


def _limit_page(lim):
    """The one daily-limit page: the amounts big, then what they're for."""
    l = lim[3][1]
    keep = [x for x in l if x[0][:2] == "+ "]   # a fee folded in already: never dropped
    del l[:]
    l.extend(lim[0])
    if lim[0]:
        l.append(("a day with just Face ID", MUTED))
    if lim[1]:
        l.append(lim[1])
    if not l:
        l.append(("set it up", INK))
    l.extend(keep)
