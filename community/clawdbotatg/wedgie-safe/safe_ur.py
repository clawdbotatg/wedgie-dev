# Safe Signer: Uniswap's Universal Router (what the Uniswap app swaps through) read into a Swap page. Loaded by
# safe_read only for a call to execute(): the RP2040's heap can't compile it with safe_read in one file.
from ui import INK, MUTED, GREEN_D, RED
from safe import hx, short, amount, coin, BIG
from safe_read import TOKENS, _big, _bigv

# Uniswap's Universal Router, by chain (v2.0, v2.1.1, v2.1.2: what the Uniswap app swaps through now). The same
# address on two chains can be someone else's, so only on its own chain. v2.0 reads a V4 multi-hop swap one word
# shorter (no minHopPriceX36), so it's listed again in UR20.
UR = {1: ("0x66a9893cc07d91d95644aedd05d03f95e1dba8af", "0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca",
          "0x23617e59a5925b2a4bf75d73ff6711cd0b29de85"),
      10: ("0x851116d9223fabed8e56c0e6b8ad0c31d98b3507", "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
           "0xc09255d86db563cbc11c2fcf4a0c512e160111b4"),
      56: ("0x1906c1d672b88cd1b9ac7593301ca990f94eae07", "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
           "0xdc264714f68d84cf29bc605589405e78bdbe7c9f"),
      137: ("0x1095692a6237d83c6a72f3f5efedb9a670c49223", "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
            "0xdc264714f68d84cf29bc605589405e78bdbe7c9f"),
      4663: ("0x8876789976decbfcbbbe364623c63652db8c0904", "0x204faca1764b154221e35c0d20abb3c525710498"),
      5042: ("0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1", "0x8702463e73f74d0b6765abceb314ef07acb92650"),
      8453: ("0x6ff5693b99212da76ad316178a184ab56d299b43", "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7",
             "0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40"),
      42161: ("0xa51afafe0263b40edaef0df8781ea9aa03e381a3", "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
              "0x2d01411773c8c24805306e89a41f7855c3c4fe65"),
      42220: ("0x8b844f885672f333bc0042cb669255f93a4c1e6b", "0xe2023f3fa515cf070e07fd9d51c1d236e07843f4"),
      43114: ("0x8b844f885672f333bc0042cb669255f93a4c1e6b", "0x661e93cca42afacb172121ef892830ca3b70f08d"),
      84532: ("0x95273d871c8156636e114b63797d78d7e1720d81", "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
              "0x8702463e73f74d0b6765abceb314ef07acb92650"),
      11155111: ("0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b", "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
                 "0x7e4f6c5e954da5c61b3423d81e2277431ac043f3")}
UR20 = ("0x66a9893cc07d91d95644aedd05d03f95e1dba8af", "0x851116d9223fabed8e56c0e6b8ad0c31d98b3507",
        "0x1906c1d672b88cd1b9ac7593301ca990f94eae07", "0x1095692a6237d83c6a72f3f5efedb9a670c49223",
        "0x6ff5693b99212da76ad316178a184ab56d299b43", "0xa51afafe0263b40edaef0df8781ea9aa03e381a3",
        "0x95273d871c8156636e114b63797d78d7e1720d81", "0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b")
NATIVE = "0x" + "00" * 20                  # the chain's coin, as V4 and SWEEP name it
CB = 1 << 255                               # CONTRACT_BALANCE: whatever the router holds


def _at(b, o):
    """The word at byte o of b. Past the end: ValueError (the router would read the calldata after it)."""
    if o < 0 or o + 32 > len(b):
        raise ValueError("short")
    return int.from_bytes(b[o:o + 32], "big")


def _ad(b, o):
    """An address word. Anything in its top 12 bytes and the router may read it another way: ValueError."""
    if _at(b, o) >> 160:
        raise ValueError("dirty")
    return hx(b[o + 12:o + 32])


def _off(b, o):
    """An offset or length word (the router masks them to 32 bits: a bigger one reads differently)."""
    n = _at(b, o)
    if n >> 32:
        raise ValueError("big")
    return n


def _bytes(b, p):
    """The `bytes` whose length word is at byte p."""
    n = _off(b, p)
    if p + 32 + n > len(b):
        raise ValueError("short")
    return b[p + 32:p + 32 + n]


def _arr(b, o, base=0):
    """Where each element of the dynamic array whose offset word (from base) is at byte o starts."""
    s = base + _off(b, o)
    return [s + 32 + _off(b, s + 32 + 32 * k) for k in range(_off(b, s))]


def _v4(i, v20, safe, pay, held, out):
    """A V4_SWAP's actions (swaps, settle, take) into the caller's books: (fee bips, the coin it settles from
    the router: CB all of it, None can't tell, an exact-out swap in it), or None for anything else. credit: the least the
    pool owes the router in each currency; debt: the most the router owes (None: can't tell). An exact-in swap
    owes at most its amountIn (exact-out: amountInMaximum), hooks or not: a hook's own deltas land on the output side, which the minimum checks."""
    if _at(i, 0) != 64:
        return None
    acts = _bytes(i, 64)
    ps = [_bytes(i, p) for p in _arr(i, 32)]
    if not acts or len(acts) != len(ps) or _at(i, 32) != 96 + (len(acts) + 31) // 32 * 32:
        return None
    credit, debt, fee, eth, most = {}, {}, 0, 0, False
    for a, p in zip(acts, ps):
        if 0x06 <= a <= 0x09:          # SWAP_EXACT_IN_SINGLE, SWAP_EXACT_IN, SWAP_EXACT_OUT_SINGLE, SWAP_EXACT_OUT
            if len(p) < (0x160 if a in (6, 8) else 0xe0):
                return None
            s = _off(p, 0)
            if a in (6, 8):             # (poolKey(c0, c1, fee, tickSpacing, hooks), zeroForOne, amountIn/Out, min/max, ..)
                z = _at(p, s + 160)
                if z > 1:
                    return None
                cin, cout = _ad(p, s + 32 * (1 - z)), _ad(p, s + 32 * z)
                n, mn = _at(p, s + 192), _at(p, s + 224)
            else:                       # (currencyIn/Out, PathKey[] path, [minHopPriceX36,] amountIn/Out, min/max)
                cin, ks = _ad(p, s), _arr(p, s + 32, s)
                if not ks:
                    return None
                cout = _ad(p, ks[0 if a == 9 else -1])     # PathKey(intermediateCurrency, ..); exact-out walks it back
                n, mn = _at(p, s + (64 if v20 else 96)), _at(p, s + (96 if v20 else 128))
            if a == 9:
                cin, cout = cout, cin
            if n >> 128 or mn >> 128 or cin == cout or debt.get(cout, 0) != 0:
                return None
            if a >= 8:                  # exact-out: it owes at most mn, the pool owes it n
                if not n:
                    return None
                n, mn, most = mn, n, True
            if n:
                d = debt.get(cin, 0)
                debt[cin] = None if d is None or credit.get(cin) else d + n
                credit[cin] = max(0, credit.get(cin, 0) - n)
            else:                       # OPEN_DELTA: all the credit in cin (an earlier swap's output)
                credit[cin] = 0
            credit[cout] = credit.get(cout, 0) + mn
        elif a in (0x0b, 0x0c):         # SETTLE(currency, amount, payerIsUser) / SETTLE_ALL(currency, maxAmount)
            c, n = _ad(p, 0), _at(p, 32)
            user = 1 if a == 0x0c else _at(p, 64)
            d = debt.get(c, 0)
            if user > 1 or user and n == CB:
                return None
            v = n if a == 0x0b and n else d if a == 0x0b or d is not None and d <= n else n
            debt[c] = 0 if a == 0x0c or not n else None if d is None or v is None else max(0, d - v)
            if c == NATIVE:             # always from the router's own coin
                eth = CB if n == CB and a == 0x0b else None if v is None or eth is None or eth == CB else eth + v
            elif user:
                if v is None:
                    return None
                pay[c] = pay.get(c, 0) + v
            else:
                held[c] = 0
        elif a in (0x0e, 0x0f):         # TAKE(currency, recipient, amount) / TAKE_ALL(currency, minAmount)
            c = _ad(p, 0)
            if a == 0x0e:
                r, n = _ad(p, 32), _at(p, 64)
                g = n if n else credit.get(c, 0)
                credit[c] = max(0, credit.get(c, 0) - n) if n else 0
            else:
                r, g = safe, max(_at(p, 32), credit.get(c, 0))
                credit[c] = 0
            out(c, r, g)
        elif a == 0x10:                 # TAKE_PORTION(currency, recipient, bips): a fee
            c, bips = _ad(p, 0), _at(p, 64)
            if bips > 10000:
                return None
            credit[c] = credit.get(c, 0) * (10000 - bips) // 10000
            fee += bips
        else:
            return None
    return fee, eth, most


def read(tx):
    """Universal Router execute(commands, inputs[, deadline]) as (title, lines), or None for anything it can't
    follow. It follows the money: what leaves the Safe (the tx's value, tokens Permit2 pulls), the least that
    reaches it (each minimum the router checks, after fees), and anything paid to anyone else, red.
    The only commands it reads: V3/V2/V4 swaps (V4 with settle/take), wrap, unwrap, sweep and a fee portion.
    Any other (permits, transfers, sub-plans, an allow-revert flag) is None. An exact-out swap: "pay at most"."""
    b, safe, ur, chain = tx["data"][4:], tx["safe"], tx["to"], tx["chainId"]
    weth = ([a for (c, a), t in TOKENS.items() if c == chain and t[0] == "WETH"] or ["weth"])[0]
    cmds = _bytes(b, _off(b, 0))
    ins = [_bytes(b, p) for p in _arr(b, 32)]
    if not cmds or len(cmds) != len(ins):
        return None
    pay, get, held = {}, {}, {}         # token -> what the Safe pays / the least it gets / the least the router holds
    eth = tx["value"]                   # the Safe's coin still in the router (None: can't tell)
    fee, bad, most = 0, [], False

    def to(r):
        return "safe" if r in (safe, "0x" + "00" * 19 + "01") else "router" if r in (ur, "0x" + "00" * 19 + "02") else r

    def out(t, r, n):                   # n of t, at least, goes to r
        r = to(r)
        if r == "safe":
            get[t] = get.get(t, 0) + n
        elif r == "router":
            held[t] = held.get(t, 0) + n
        else:
            bad.append(("pays " + short(r) + "!", RED))

    def less(t, bips):                  # a fee portion of what the router holds
        if bips > 10000:
            raise ValueError("bips")
        held[t] = held.get(t, 0) * (10000 - bips) // 10000

    for c, i in zip(cmds, ins):
        if c in (0x00, 0x01, 0x08, 0x09):   # V3/V2_SWAP_EXACT_IN/OUT(recipient, amountIn/Out, min/max, path, payerIsUser)
            r, n, mn, user = _ad(i, 0), _at(i, 32), _at(i, 64), _at(i, 128)
            if c & 1:                   # exact-out: it pays at most mn, r gets n
                n, mn, most = mn, n, True
            if c < 8:
                p = _bytes(i, _off(i, 96))
                if len(p) < 43 or (len(p) - 20) % 23:
                    return None
                a, z = (hx(p[-20:]), hx(p[:20])) if c else (hx(p[:20]), hx(p[-20:]))     # V3 exact-out: path backwards
            else:
                s = _off(i, 96)         # address[]
                m = _off(i, s)
                if m < 2:
                    return None
                a, z = _ad(i, s + 32), _ad(i, s + 32 * m)
            if user > 1:
                return None
            if user:
                if n >= CB:
                    return None
                pay[a] = pay.get(a, 0) + n
            else:                       # it spends what the router holds of a
                held[a] = 0 if n >= CB else max(0, held.get(a, 0) - n)
            out(z, r, mn)
        elif c == 0x04:                 # SWEEP(token, recipient, amountMin): all the router holds of it
            t, mn = _ad(i, 0), _at(i, 64)
            if mn >> 160:
                return None
            n = max(mn, held.pop(t, 0))
            if t == NATIVE:
                eth = 0                 # what's left of the Safe's coin goes too
            if n or to(_ad(i, 32)) != "safe":
                out(t, _ad(i, 32), n)
        elif c == 0x06:                 # PAY_PORTION(token, recipient, bips): a fee
            t, bips = _ad(i, 0), _at(i, 64)
            less(t, bips)
            if t == NATIVE:
                eth = None
            fee += bips
        elif c == 0x0b:                 # WRAP_ETH(recipient, amount): kept in the router, for a swap
            n = _at(i, 32)
            if to(_ad(i, 0)) != "router":
                return None
            n = eth if n == CB else n
            if eth is not None:
                eth = 0 if n is None else max(0, eth - n)
            held[weth] = held.get(weth, 0) + (n or 0)
        elif c == 0x0c:                 # UNWRAP_WETH(recipient, amountMin): all the router's WETH
            out(NATIVE, _ad(i, 0), max(_at(i, 32), held.pop(weth, 0)))
        elif c == 0x10:                 # V4_SWAP(actions, params)
            r = _v4(i, ur in UR20, safe, pay, held, out)
            if r is None:
                return None
            fee, most = fee + r[0], most or r[2]
            if eth is not None:
                eth = 0 if r[1] == CB else None if r[1] is None else max(0, eth - r[1])
        else:
            return None
    lines = [("pay at most" if most else "pay", MUTED)]
    if tx["value"]:
        lines.append(_bigv(tx, tx["value"]))
    lines += [_big(tx, t, n) for t, n in pay.items()]
    if len(lines) == 1:
        return None
    gets = [_bigv(tx, n) if t == NATIVE else _big(tx, t, n)
            for t, n in get.items() if n]
    f = "%d.%02d" % (fee // 100, fee % 100)
    lines.append(("get at least" + (" (%s%% fee)" % f.rstrip("0").rstrip(".") if fee else ""), RED if fee > 100 else MUTED))
    lines += gets or [("nothing", RED, BIG)]
    if eth is None and tx["value"]:
        bad.append(("can't tell what's left", RED))
    elif eth:
        bad.append(("%s %s left behind!" % (amount(eth, 18), coin(tx)), RED))
    return "Swap", lines + (bad or [("to this Safe", GREEN_D)])
