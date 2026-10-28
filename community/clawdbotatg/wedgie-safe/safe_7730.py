# Safe Signer: clear signing from ERC-7730 descriptors, in the wire format (Bacca's CBOR binding, v 29.09.26-1).
# The host sends a bundle with the transaction (safe_clear): {8: [token-information], 13: [transaction-info]}, every
# structure signed with algorithm 4, a Merkle proof to a root built into this app (safe_roots.py, made by
# wedgie-dev wire/release.py from the public registry). Root "a": descriptors an auditor we trust signed (Cyfrin),
# and tokens. Root "b": the rest of the registry, shown as "not audited". Nothing here trusts the host: a structure
# whose proof doesn't reach a root is ignored. Loaded only while a question is up and a bundle came with it.
#   read(tx, bundle) -> (title, lines) or a reason string it can't (the caller shows its red page with the reason)
#   items(tx, bundle) -> (intent, owner, trust, [(label, text, kind)]): the same before it's drawn (tests)
import binascii, hashlib
import safe_wire as w
import safe_roots as R
import safe_icons as I

MAX_DEPTH = 1           # calldata inside calldata: one level, the spec's minimum


class Bad(Exception):
    pass


def _map(b, i):
    """The CBOR map at b[i]: key -> index of its value, read in place."""
    mt, n, j, _ = w._head(b, i)
    if mt != 5:
        raise Bad("bundle isn't a map")
    out = {}
    for _ in range(n):
        k = w.load(b, j)
        j = w.item_end(b, j)
        out[k] = j
        j = w.item_end(b, j)
    if j != len(b):
        raise Bad("bundle has trailing bytes")
    return out


def trust(b, j):
    """Which root the signed structure at b[j] reaches: "a", "b", or None. Hashed where it lies: a 5 KB descriptor
    copied whole needs 5 KB in one piece, which a busy heap may not have (w.signed_message, done in place)."""
    n, i = w.array(b, j)
    if n < 2:
        return None
    for _ in range(n - 1):
        i = w.item_end(b, i)
    env = w.load(b, i)
    if not isinstance(env, list) or len(env) != 5:
        return None
    proof = env[4]
    if env[0] != 4 or env[3] != b"" or not isinstance(proof, list) or len(proof) > 32:
        return None
    h = hashlib.sha256(b"\x00")
    h.update(memoryview(b)[j:i])
    h.update(w.dumps(env[:3]))
    h = h.digest()
    for p in proof:                     # pairs sorted, as Trezor's definitions tree
        if not isinstance(p, bytes) or len(p) != 32:
            return None
        h = hashlib.sha256(b"\x01" + (p + h if p < h else h + p)).digest()
    for k in R.ROOTS:
        if h == R.ROOTS[k]:
            return k
    return None


class Ctx:
    def __init__(self, tx, b):
        self.tx, self.b, self.chain = tx, b, tx["chainId"]
        m = _map(b, 0)
        self.descs, self.tokens = m.get(13), m.get(8)
        self.value_shown = False
        self.small = False              # on the screen: optional fields left out

    def find(self, arr, key):
        """The index in b of the first structure in the array at arr whose elements 1.. start with key, and the
        root it reaches; (None, None) if none does."""
        if arr is None:
            return None, None
        b = self.b
        for j in w.elements(b, arr):
            n, k = w.array(b, j)
            if n < len(key) + 2:
                continue
            k = w.item_end(b, k)        # past version
            ok = True
            for want in key:
                if w.load(b, k) != want:
                    ok = False
                    break
                k = w.item_end(b, k)
            if ok:
                t = trust(b, j)
                if t:
                    return j, t
        return None, None

    def token(self, chain, a):
        """(ticker, decimals) of a token from a token-information that checks out, or None."""
        j, t = self.find(self.tokens, (chain, a))
        if j is None:
            return None
        return w.load(self.b, w.at(self.b, j, 3)), w.load(self.b, w.at(self.b, j, 4))


# ---- values to text --------------------------------------------------------------------------------
def _int(v, fam, size):
    n = int.from_bytes(v, "big")
    bits = 8 * len(v)
    if size and size < len(v) and n >> (8 * size) and fam == 1:
        raise Bad("number wider than its type")
    if fam == 2 and n >> (bits - 1):    # signed: two's complement over the bytes read
        n -= 1 << bits
    return n


def _addr(v):
    if len(v) == 32:
        if int.from_bytes(v[:12], "big"):
            raise Bad("address with bits above it")
        v = v[12:]
    if len(v) != 20:
        raise Bad("address of %d bytes" % len(v))
    return _hex(v)


def _hex(v):
    return "0x" + binascii.hexlify(bytes(v)).decode()


def _raw(a):
    """"0x.." -> its 20 bytes."""
    return binascii.unhexlify(a[2:])


def dec(n, d):
    """n / 10**d, every digit, no trailing zeros."""
    s = "-" if n < 0 else ""
    n = abs(n)
    if not d:
        return s + str(n)
    i, f = divmod(n, 10 ** d)
    f = ("%0" + str(d) + "d") % f
    f = f.rstrip("0")
    return s + str(i) + ("." + f if f else "")


def date(t):
    """A unix time as 2026-12-31 20:00:00Z (no time module: MicroPython's epoch differs by port)."""
    days, r = divmod(t, 86400)
    z = days + 719468                   # days to civil date (Howard Hinnant's algorithm)
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    y = yoe + era * 400 + (m <= 2)
    return "%04d-%02d-%02d %02d:%02d:%02dZ" % (y, m, d, r // 3600, r // 60 % 60, r % 60)


def duration(n):
    return "%02d:%02d:%02d" % (n // 3600, n // 60 % 60, n % 60)


SI = ((24, "Y"), (21, "Z"), (18, "E"), (15, "P"), (12, "T"), (9, "G"), (6, "M"), (3, "k"))


def unit(n, base, d, prefix):
    if prefix:
        for e, p in SI:
            if abs(n) >= 10 ** (e + (d or 0)):
                return dec(n, (d or 0) + e) + p + base
    return dec(n, d or 0) + base


def _same(v, c, fam):
    """A value against a visibility constraint, by type family (the spec's Visibility rules)."""
    if fam in (1, 2):
        return int.from_bytes(v, "big") == int.from_bytes(c, "big")
    if fam == 5:
        return v[-20:] == c[-20:] and not int.from_bytes(v[:-20], "big")
    if fam == 6:
        return bool(int.from_bytes(v, "big")) == bool(int.from_bytes(c, "big"))
    # bytes: exact, except that empty and all-zero bytes match a zero constraint (LI.FI's ifNotIn [0] on a
    # nonEVMReceiver: the registry's runners hide it; the spec says "exact bytes", a gap to report)
    return bytes(v) == bytes(c) or not any(v) and not any(c)


def _pick(vals, i):
    """A parameter's i-th value: arrays of parameters go with the field's array, one value goes with all."""
    if len(vals) == 1:
        return vals[0]
    if i < len(vals):
        return vals[i]
    raise Bad("parameter array of another length")


class Call:
    """One call being read: its data (no selector) and container [from, to, value, chain id]. env: the entries of
    the ERC-8362 object being decoded (value source 3)."""
    def __init__(self, to, data, value, sender, chain, depth):
        self.to, self.cd, self.depth, self.chain = to, data[4:], depth, chain
        self.value = value
        self.txc = [sender, to, value.to_bytes(32, "big"), chain.to_bytes(32, "big")]
        self.env = None


def _sub(call, cd=None, env=None):
    """The same call, reading other bytes (a switch case's payload) or an object's entries."""
    c = Call(call.to, b"", call.value, call.txc[0], call.chain, call.depth)
    c.cd, c.txc, c.env = call.cd if cd is None else cd, call.txc, env
    return c


def _values(ctx, call, v):
    if v[2][0] == 1 and v[2][1] == 2:
        ctx.value_shown = True
    if v[2][0] == 3:                    # an entry of the object being decoded
        if call.env is None or not 0 <= v[2][1] < len(call.env) or not isinstance(call.env[v[2][1]], bytes):
            raise Bad("no such entry")
        return [call.env[v[2][1]]]
    try:
        return w.value(v, call.cd, call.txc)
    except ValueError as e:
        raise Bad(str(e))


def _amount(pic):
    """The kind of an amount: "amount", or "amount<n>" with the token's picture n (safe_icons, by address)."""
    return "amount" if pic is None else "amount%d" % pic


def _text(ctx, call, param, val, i):
    """One value as (text, kind). kind: "amount", "addr", "safe" (this Safe), "warn" (red), "token?" (an amount of a
    token no list knows), "addr?" (a token no list knows), or None."""
    import safe as A
    k = param[0]
    fam, size = param[1][0], param[1][1]
    safe = ctx.tx["safe"].lower()
    if k == 0:                          # raw
        if fam in (1, 2):
            return str(_int(val, fam, size)), None
        if fam == 5:
            a = _addr(val)
            return a, "safe" if a == safe else "addr"
        if fam == 6:
            return ("true" if int.from_bytes(val, "big") else "false"), None
        if fam == 7 and size and len(val) == 32:     # bytesN: its N bytes, left-aligned in the slot
            val = val[:size]
        if fam == 8:
            try:
                return bytes(val).decode(), None
            except Exception:
                pass
        return _hex(val), None
    if k == 1:                          # amount: the chain's coin
        return "%s %s" % (A.amount(_int(val, 1, None), 18), ctx.coin), _amount(I.of(ctx.coin))
    if k == 2:                          # token amount
        n = _int(val, fam, size)
        tok = _pick(_values(ctx, call, param[2]), i) if param[2] else None
        chain = call.chain
        if len(param) > 6 and param[6]:
            chain = _int(_pick(_values(ctx, call, param[6]), i), 1, None)
        natives = param[3] or []
        if tok is not None and any(_same(tok, x, 5) for x in natives):
            tok = None
            ticker, d, pic = ctx.coin, 18, I.of(ctx.coin)
        elif tok is None:               # no token named: the number, red (the spec's "Unknown token")
            return "%d (unknown token)" % n, "warn"
        else:
            t = ctx.token(chain, _raw(_addr(tok)))
            if t is None:
                return "%d of %s" % (n, _addr(tok)), "token?"
            ticker, d = t
            pic = I.at(chain, _addr(tok))
        if param[4] is not None and n >= param[4]:      # "!": red on an approval (read's RISKY)
            return "%s %s" % (param[5] or "Unlimited", ticker), _amount(pic) + "!"
        return "%s %s" % (A.amount(n, d), ticker), _amount(pic)
    if k == 3:                          # nft
        c = _addr(_pick(_values(ctx, call, param[2]), i))
        return "#%d of %s" % (_int(val, 1, None), c), None
    if k == 4:                          # date
        n = _int(val, 1, None)
        return (date(n) if param[2] == 0 else "block %d" % n), None
    if k == 5:
        return duration(_int(val, 1, None)), None
    if k == 6:
        return unit(_int(val, fam, size), param[2], param[3], param[4]), None
    if k == 7:                          # enum: its entries inline (the spec's other form, enum-value, isn't sent)
        n = _int(val, fam, size)
        if not isinstance(param[2], list):
            raise Bad("enum by id")
        for e in param[2]:
            if e[0] == n:
                return e[1], None
        raise Bad("enum value %d not in the descriptor" % n)
    if k == 8:                          # trusted name: none are sent; the ones the wedgie knows itself (safe_book)
        if len(param) > 5 and param[5] == 1:
            raise Bad("interoperable address")
        a = _addr(val)
        if any(_same(val, x, 5) for x in (param[4] or [])):
            a = safe
        if a == safe:
            return a, "safe"
        import safe_book
        n = safe_book.name(a, safe, _hex(call.to) == safe)
        if param[4]:                    # the descriptor expects the sender here (a swap's recipient): anyone else, red
            return (n or a), "else"
        return (n, "me" if n == "THIS wedgie" else "named") if n else (a, "addr")
    if k == 10:                         # token ticker
        if any(_same(val, x, 5) for x in (param[2] or [])):
            return ctx.coin, None
        t = ctx.token(call.chain, _raw(_addr(val)))
        if t is None:
            return _addr(val), "addr?"
        return t[0], None
    if k == 11:
        n = _int(val, 1, None)
        return A.CHAINS.get(n, "chain %d" % n), None
    raise Bad("param %r" % (k,))


def _fieldat(ctx, call, fi, out):
    """The field at b[fi]. A switch (ERC-8362) is read where it lies, only the case it takes loaded: the whole
    of a Universal Router one as Python lists is more than the heap has."""
    b = ctx.b
    if w.load(b, w.at(b, w.at(b, fi, 1), 0)) == 14:
        import safe_8362
        safe_8362.switch_at(ctx, call, fi, out)
        return
    _field(ctx, call, w.load(b, fi), out)


def _field(ctx, call, f, out, pick=None):
    label, param = f[0], f[1]
    vis = f[2] if len(f) > 2 else None
    if len(f) > 4 and f[4] is not None:
        raise Bad("encrypted field")
    k = param[0]
    if k == 12:                         # group
        subs = param[2]
        if param[3]:
            out.append((param[3], None, "label"))
        if param[1] == 1:               # sequential
            for s in subs:
                _field(ctx, call, s, out, pick)
            return
        n = None                        # bundled: element i of every field, then i + 1
        for s in subs:
            if s[1][0] == 12:
                raise Bad("group in a group")
            m = len(_values(ctx, call, s[1][1]))
            if m > 1:
                if n is not None and m != n:
                    raise Bad("bundled arrays of different lengths")
                n = m
        for i in range(n or 1):
            for s in subs:
                _field(ctx, call, s, out, i if n else pick)
        return
    vals = _values(ctx, call, param[1])
    if pick is not None and len(vals) > 1:
        vals = [vals[pick]]
    fam = param[1][0]
    for i, v in enumerate(vals):
        ii = pick if pick is not None else i
        if vis:
            hit = any(_same(v, c, fam) for c in vis[1])
            if vis[0] == 1:             # must be: hidden, and the tx is refused if it isn't
                if not hit:
                    raise Bad("%s isn't what the descriptor requires" % label)
                continue
            if vis[0] == 2 and hit:     # if not in
                continue
            if vis[0] == 3 and ctx.small:   # optional: a small screen leaves it out (the spec lets it)
                continue
        if k == 9:
            _calldata(ctx, call, label, param, v, ii, out)
            continue
        if k in (13, 14):               # ERC-8362: its own file, loaded only for these
            import safe_8362
            safe_8362.field(ctx, call, label, param, v, ii, out)
            continue
        t, kind = _text(ctx, call, param, v, ii)
        out.append((label, t, kind))


def _calldata(ctx, call, label, param, data, i, out):
    callee = _raw(_addr(_pick(_values(ctx, call, param[2]), i)))
    if param[4]:                        # a selector given apart from the data
        data = bytes(_pick(_values(ctx, call, param[4]), i))[:4] + bytes(data)
    amt = _int(_pick(_values(ctx, call, param[5]), i), 1, None) if param[5] else 0
    sender = call.txc[0]
    if param[6]:
        sender = _raw(_addr(_pick(_values(ctx, call, param[6]), i)))
    chain = call.chain
    if param[3]:
        chain = _int(_pick(_values(ctx, call, param[3]), i), 1, None)
    if len(param) > 7 and param[7]:      # ERC-8362 operation: anything but CALL, red
        ex, cs, op = param[7]
        if ex is not None:
            n = _int(_pick(_values(ctx, call, ex), i), 1, None)
            op = ([o for k, o in cs if k == n] or [op])[0]
        if op != 1:
            out.append(("", {2: "DELEGATECALL: can do anything", 3: "creates a contract", 4: "creates a contract",
                             5: "CALLCODE: can do anything"}.get(op, "an unknown operation"), "warn"))
    if call.depth >= MAX_DEPTH or len(data) < 4:
        out.append((label, ("call", None, None, None, callee), "call"))
        return
    inner = Call(callee, bytes(data), amt, sender, chain, call.depth + 1)
    j, t = _find(ctx, chain, callee, bytes(data[:4]))
    if j is None:
        out.append((label, ("call", None, None, None, callee), "call"))
        return
    sub = []
    for fi in w.elements(ctx.b, w.at(ctx.b, j, 10)):
        _fieldat(ctx, inner, fi, sub)
    out.append((label, ("call", w.load(ctx.b, w.at(ctx.b, j, 4)), w.load(ctx.b, w.at(ctx.b, j, 5)), sub, callee), "call"))


def _key(ctx, to):
    """The address a call's descriptor is under: this Safe calling itself is under safe_book.THIS_SAFE."""
    if _hex(to) == ctx.tx["safe"].lower():
        import safe_book
        return _raw(safe_book.THIS_SAFE)
    return to


def _find(ctx, chain, to, sel):
    """The descriptor for a call: under its own address (this Safe's under THIS_SAFE), else the one for any
    contract of its kind (safe_book.ANY: the registry's ERC-20 transfer and approve)."""
    j, t = ctx.find(ctx.descs, (chain, _key(ctx, to), sel))
    if j is None:
        import safe_book
        j, t = ctx.find(ctx.descs, (chain, _raw(safe_book.ANY), sel))
    return j, t


def items(tx, bundle, small=False):
    """(intent, owner, trust, [(label, text, kind)]) for tx's call, or raises Bad. small: leave out optional fields."""
    import safe as A
    ctx = Ctx(tx, bundle)
    ctx.small = small
    ctx.coin = A.coin(tx)
    data = tx["data"]
    if len(data) < 4:
        raise Bad("no function")
    j, t = _find(ctx, tx["chainId"], _raw(tx["to"]), bytes(data[:4]))
    if j is None:
        raise Bad("no descriptor for this call")
    call = Call(_raw(tx["to"]), data, tx["value"], _raw(tx["safe"]), tx["chainId"], 0)
    out = []
    for fi in w.elements(ctx.b, w.at(ctx.b, j, 10)):
        _fieldat(ctx, call, fi, out)
    if w.extra_bytes(call.cd):
        # said, in grey: Uniswap's app adds a 22-byte tag to every swap (a signer can't tell a tag from more)
        out.append(("", "+%d bytes at the end" % w.extra_bytes(call.cd), "note"))
    if tx["value"] and not ctx.value_shown:
        out.append(("", "+ %s %s" % (A.amount(tx["value"], 18), ctx.coin), "warn"))
    return w.load(ctx.b, w.at(ctx.b, j, 4)), w.load(ctx.b, w.at(ctx.b, j, 5)), t, out


def reads(tx):
    """A batch's calls read from their descriptors ahead of safe_read (safe.confirm: in a batch, safe_read loaded
    first left no room to compile this module; a real wedgie, 10-27, a swap + the relay fee: MemoryError, 1784
    bytes). {i: page or reason} by the call's place in the MultiSend batch. safe_read.batch checks the batch."""
    d, out = tx["data"], {}
    b = d[68:68 + int.from_bytes(d[36:68], "big")]
    i = 0
    while i + 85 <= len(b):
        n = int.from_bytes(b[i + 53:i + 85], "big")
        if not b[i] and n >= 4:
            a = {"chainId": tx["chainId"], "safe": tx["safe"], "operation": 0, "data": b[i + 85:i + 85 + n],
                 "to": "0x" + "".join("%02x" % c for c in b[i + 1:i + 21]), "value": int.from_bytes(b[i + 21:i + 53], "big")}
            out[len(out)] = read(a, tx["clear"])
        else:
            out[len(out)] = None
        i += 85 + n
    return out


# approve, increaseAllowance; enableModule, setGuard, setFallbackHandler, setModuleGuard
RISKY = (b"\x09\x5e\xa7\xb3", b"\x39\x50\x93\x51", b"\x61\x0b\x59\x25", b"\xe1\x9a\x9d\xd9",
         b"\xf0\x8a\x03\x23", b"\xe0\x68\xdf\x37")


def read(tx, bundle):
    """(title, lines) for the Swap/Repay/... page, or a reason string it can't."""
    try:
        intent, owner, t, its = items(tx, bundle, True)
    except (Bad, ValueError, KeyError, IndexError, TypeError) as e:
        return "descriptor: %s" % e
    from ui import INK, MUTED, GREEN_D, RED
    from safe import BIG, ADDR
    lines = []
    # calls that hand over money or the Safe itself (an approval; a module, guard or fallback): an address the
    # wedgie has no name for, and an unlimited amount, are red. Whose call it is doesn't matter: the same rule
    # for every dapp
    risky = bytes(tx["data"][:4]) in RISKY

    def add(label, text, kind):
        if kind == "label":
            lines.append((label, INK))
            return
        if label:
            lines.append((label, MUTED))
        if kind == "call":
            _, ci, co, cs, callee = text
            if cs is None:
                lines.extend([("a call to", MUTED), (_hex(callee), RED, ADDR),
                              ("can't read it", RED)])
                return
            if ci:
                lines.append((ci + (" (" + co + ")" if co else ""), INK))
            for x in cs:
                add(*x)
        elif kind and kind[:6] == "amount":
            p = kind[6:].rstrip("!")
            lines.append((text, RED if risky and kind[-1] == "!" else INK, BIG, int(p) if p else None))
        elif kind == "addr":
            lines.append((text, RED if risky else INK, ADDR))
        elif kind == "else":                # someone other than this Safe where the Safe is expected
            lines.extend([(text, RED, ADDR) if text[:2] == "0x" else (text, RED), ("not this Safe!", RED)])
        elif kind == "safe":
            lines.append(("this Safe", GREEN_D))
        elif kind == "me":
            lines.append((text, INK, BIG))
        elif kind == "named":
            lines.append((text, INK))
        elif kind == "token?":              # a token no list knows: the number, and whose
            n, a = text.split(" of ")
            lines.extend([(n, RED), ("of a token it doesn't know", RED), (a, RED, ADDR)])
        elif kind == "addr?":
            lines.extend([("a token it doesn't know", RED), (text, RED, ADDR)])
        elif kind == "warn":
            lines.append((text, RED))
        elif kind == "note":
            lines.append((text, MUTED))
        else:
            lines.append((text, INK))
    for x in its:
        add(*x)
    if owner:
        lines.append(("by " + owner, MUTED))
    if t != "a":
        lines.append(("not audited", RED))
    return intent[:30], lines
