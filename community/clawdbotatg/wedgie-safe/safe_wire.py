# Safe Signer: the ERC-7730 wire format (CBOR binding), read side. A copy of wedgie-dev wire/wire.py (keep them the
# same: its tests are tools/test_wire.py and tools/wirechip.mjs there). Loaded only with safe_7730.
# Spec: https://github.com/ZKNoxHQ/eth-universal-signer/blob/7730-wire-format-implementations/specs/7730_wire_format.md
# (v 29.09.26-1, Nicolas Bacca).
#   loads(b)              CBOR -> int, bytes, str, list, dict, None, True/False, Tag. Definite lengths only.
#   at(b, i, k), elements(b, i), load(b, i)   the same in place, a piece at a time (what a wedgie uses)
#   dumps(x)              the deterministic encoding (RFC 8949 4.2.1) of the same, a bytearray
#   signed_message(b)     a signed structure's bytes -> (the bytes its signature covers, its envelope)
#   path(calldata, p)     a slot program (the spec's DATA_PATH) on calldata without its selector -> [bytes]
#   value(v, calldata, tx)  a value ([type-family, type-size, source]) -> [bytes]
#   extra_bytes(calldata) bytes past the last whole slot (1inch-style trailers): the screen must warn
# Limits are the spec's minimums or more; past one it raises ValueError, never shows half an answer.

MAX_DEPTH = 16          # CBOR nesting
MAX_PATH = 16           # path elements
MAX_ARRAYS = 8          # nested arrays in a path
MAX_VALUES = 16         # values one value yields
MAX_ITER = 255          # elements per array level


class Tag:
    def __init__(self, tag, value):
        self.tag, self.value = tag, value

    def __eq__(self, o):
        return isinstance(o, Tag) and o.tag == self.tag and o.value == self.value

    def __repr__(self):
        return "Tag(%d, %r)" % (self.tag, self.value)


# ---- CBOR in --------------------------------------------------------------------------------------
def _head(b, i):
    """(major, argument, next index, info) of the item at i. Non-shortest heads are refused: the spec
    signs deterministic CBOR, so anything else can't verify anyway."""
    if i >= len(b):
        raise ValueError("cbor: cut short")
    ib = b[i]
    mt, ai = ib >> 5, ib & 31
    i += 1
    if ai < 24:
        return mt, ai, i, ai
    if ai > 27:
        raise ValueError("cbor: indefinite length" if ai == 31 else "cbor: reserved")
    n = 1 << (ai - 24)
    if i + n > len(b):
        raise ValueError("cbor: cut short")
    v = int.from_bytes(bytes(b[i:i + n]), "big")
    if mt != 7 and v < (24 if n == 1 else 1 << (4 * n)):
        raise ValueError("cbor: not shortest")
    return mt, v, i + n, ai


def _item(b, i, depth):
    if depth > MAX_DEPTH:
        raise ValueError("cbor: too deep")
    mt, v, i, ai = _head(b, i)
    if mt == 0:
        return v, i
    if mt == 1:
        return -1 - v, i
    if mt == 2 or mt == 3:
        if i + v > len(b):
            raise ValueError("cbor: cut short")
        s = bytes(b[i:i + v])
        return (s if mt == 2 else s.decode()), i + v
    if mt == 4:
        out = []
        for _ in range(v):
            x, i = _item(b, i, depth + 1)
            out.append(x)
        return out, i
    if mt == 5:
        out = {}
        for _ in range(v):
            k, i = _item(b, i, depth + 1)
            if isinstance(k, (list, dict)):
                raise ValueError("cbor: map key")
            if k in out:
                raise ValueError("cbor: duplicate key")
            out[k], i = _item(b, i, depth + 1)
        return out, i
    if mt == 6:
        x, i = _item(b, i, depth + 1)
        if v == 2 or v == 3:                # bignums: the spec's u256
            if not isinstance(x, bytes):
                raise ValueError("cbor: bignum")
            if not x or x[0] == 0 or len(x) <= 8:
                raise ValueError("cbor: bignum not shortest")
            n = int.from_bytes(x, "big")
            return (n if v == 2 else -1 - n), i
        return Tag(v, x), i
    if ai == 20:
        return False, i
    if ai == 21:
        return True, i
    if ai == 22:
        return None, i
    raise ValueError("cbor: simple/float %d" % ai)


def loads(b):
    x, i = _item(b, 0, 0)
    if i != len(b):
        raise ValueError("cbor: trailing bytes")
    return x


# In place: a 4 KB descriptor decoded whole is tens of KB of Python objects, so a wedgie walks the bytes
# and decodes one small piece at a time (one field, one value).
def load(b, i):
    """The item that starts at b[i], decoded."""
    return _item(b, i, 0)[0]


def item_end(b, i=0, depth=0):
    """The index right after the item at i, found without decoding it (nothing allocated)."""
    if depth > MAX_DEPTH:
        raise ValueError("cbor: too deep")
    mt, v, i, ai = _head(b, i)
    if mt == 2 or mt == 3:
        if i + v > len(b):
            raise ValueError("cbor: cut short")
        return i + v
    if mt == 4 or mt == 5:
        for _ in range(v * (mt - 3)):
            i = item_end(b, i, depth + 1)
        return i
    if mt == 6:
        return item_end(b, i, depth + 1)
    if mt == 7 and ai not in (20, 21, 22):
        raise ValueError("cbor: simple/float %d" % ai)
    return i


def array(b, i):
    """(length, index of its first element) of the array at b[i]."""
    mt, n, j, _ = _head(b, i)
    if mt != 4:
        raise ValueError("cbor: not an array")
    return n, j


def at(b, i, k):
    """The index of element k of the array at b[i]."""
    n, j = array(b, i)
    if not 0 <= k < n:
        raise ValueError("cbor: no element %d" % k)
    for _ in range(k):
        j = item_end(b, j)
    return j


def elements(b, i):
    """The index of each element of the array at b[i], in order."""
    n, j = array(b, i)
    for _ in range(n):
        yield j
        j = item_end(b, j)


# ---- CBOR out (deterministic) ----------------------------------------------------------------------
# Two passes: measure, then write into one buffer. Joining pieces made a copy at every level and ran out
# of memory on an RP2040 with 119 KB free ("allocating 3745 bytes" for a 4 KB descriptor, wirechip.mjs).
def _hput(buf, i, mt, n):
    if n < 24:
        k, ai = 0, n
    else:
        k, ai = next((k, ai) for ai, k in ((24, 1), (25, 2), (26, 4), (27, 8)) if n < 1 << (8 * k))
    if buf is not None:
        buf[i] = mt << 5 | ai
        for j in range(k):
            buf[i + 1 + j] = (n >> (8 * (k - 1 - j))) & 255
    return i + 1 + k


def _bput(buf, i, mt, s):
    i = _hput(buf, i, mt, len(s))
    if buf is not None:
        buf[i:i + len(s)] = s
    return i + len(s)


def _put(buf, i, x):
    """Write x at buf[i:] (buf None: only measure). Returns the index after it."""
    if x is None or x is True or x is False:
        if buf is not None:
            buf[i] = 0xf6 if x is None else 0xf5 if x else 0xf4
        return i + 1
    if isinstance(x, int):
        mt, n = (0, x) if x >= 0 else (1, -1 - x)
        if n < 1 << 64:
            return _hput(buf, i, mt, n)
        k = 9                               # a bignum (tag 2 or 3) in as few bytes as it takes
        while n >> (8 * k):                 # (MicroPython ints have no bit_length)
            k += 1
        i = _hput(buf, i, 6, 2 + mt)
        return _bput(buf, i, 2, n.to_bytes(k, "big"))
    if isinstance(x, (bytes, bytearray, memoryview)):
        return _bput(buf, i, 2, x)
    if isinstance(x, str):
        return _bput(buf, i, 3, x.encode())
    if isinstance(x, (list, tuple)):
        i = _hput(buf, i, 4, len(x))
        for e in x:
            i = _put(buf, i, e)
        return i
    if isinstance(x, dict):                 # 4.2.1: keys sorted by their encoded bytes
        i = _hput(buf, i, 5, len(x))
        for k in sorted(x, key=dumps):
            i = _put(buf, _put(buf, i, k), x[k])
        return i
    if isinstance(x, Tag):
        return _put(buf, _hput(buf, i, 6, x.tag), x.value)
    raise ValueError("cbor: can't encode %r" % (x,))


def dumps(x):
    """The deterministic CBOR of x, as a bytearray."""
    buf = bytearray(_put(None, 0, x))
    _put(buf, 0, x)
    return buf


# ---- signed structures -----------------------------------------------------------------------------
def signed_message(b):
    """b: one signed structure (a CBOR array whose last element is the signature envelope
    [algorithm, key-id, issued-at, signature, merkle-proof]). Returns (message, envelope): message is
    what the signature covers, the same array with the envelope cut to [algorithm, key-id, issued-at].
    Built from b's own bytes, so it costs one small encode, not a re-encode of the whole structure."""
    n, i = array(b, 0)
    if n < 2:
        raise ValueError("signed: not an array")
    for _ in range(n - 1):
        i = item_end(b, i)
    if item_end(b, i) != len(b):
        raise ValueError("signed: trailing bytes")
    env = load(b, i)
    if not isinstance(env, list) or len(env) != 5:
        raise ValueError("signed: bad envelope")
    tail = dumps(env[:3])
    msg = bytearray(i + len(tail))
    msg[:i] = b[:i]
    msg[i:] = tail
    return msg, env


# ---- slot programs ---------------------------------------------------------------------------------
def _slot(cd, k):
    if k < 0 or 32 * k + 32 > len(cd):
        raise ValueError("path: past the calldata")
    return cd[32 * k:32 * k + 32]


def _uint(s):
    return int.from_bytes(bytes(s), "big")


def _cut(n, start, end):
    """[start:end) of n items, negatives from the end, as Python slices but refusing out of range."""
    a = 0 if start is None else (start + n if start < 0 else start)
    z = n if end is None else (end + n if end < 0 else end)
    if not 0 <= a <= z <= n:
        raise ValueError("path: index out of range")
    return a, z


def path(cd, p):
    """Evaluate a slot program on calldata (no selector). p: the CBOR path-element list. Returns the leaf
    bytes, one per value (arrays iterate). Semantics: the spec's DATA_PATH (Ledger's generic parser)."""
    if not 0 < len(p) <= MAX_PATH:
        raise ValueError("path: length")
    # Calldata needn't be a whole number of slots (1inch appends bytes after the ABI part): only the slots
    # read must be inside it. Whether such bytes are harmless is the caller's call (extra_bytes).
    out = []
    _walk(cd, p, 0, 0, 0, 0, out)
    return out


def extra_bytes(cd):
    """How many bytes of calldata (no selector) sit past the last whole slot. Bacca (10-20): a neutral
    tracker or note is fine, anything that changes the tx is not, and a signer can't tell which. So not 0
    = warn on screen (A still signs). A trailer that is itself whole slots can't be seen: the wire format
    has no parameter types, so it doesn't know where the ABI part ends."""
    return len(cd) % 32


def _walk(cd, p, k, offset, ref, arrays, out):
    while k < len(p):
        e = p[k]
        t = e[0]
        if t == 0:                          # tuple: move n slots
            ref, offset = offset, offset + e[1]
        elif t == 1:                        # array: its length here, then each chosen element
            if e[1] is None:                # the CDDL allows null; with no weight we can't step: refuse
                raise ValueError("path: array without weight")
            if arrays >= MAX_ARRAYS:
                raise ValueError("path: arrays too deep")
            w, start, end = e[1]
            n = _uint(_slot(cd, offset))
            if n > MAX_ITER:
                raise ValueError("path: array too long")
            a, z = _cut(n, start, end)
            offset += 1
            for i in range(a, z):
                _walk(cd, p, k + 1, offset + i * w, offset, arrays + 1, out)
            return
        elif t == 2:                        # ref: the slot is a byte offset from ref
            o = _uint(_slot(cd, offset))
            if o % 32 or o > len(cd):
                raise ValueError("path: bad offset")
            offset = ref + o // 32
        elif t == 3:                        # leaf: what the value is
            if e[1] == 3:
                leaf = _slot(cd, offset)
            elif e[1] == 4:
                n = _uint(_slot(cd, offset))
                if 32 * (offset + 1) + n > len(cd):
                    raise ValueError("path: past the calldata")
                leaf = cd[32 * (offset + 1):32 * (offset + 1) + n]
            else:
                raise ValueError("path: leaf %d not supported" % e[1])
            if k + 1 < len(p) and p[k + 1][0] == 4:      # slice: part of the leaf
                a, z = _cut(len(leaf), p[k + 1][1][0], p[k + 1][1][1])
                leaf = leaf[a:z]
                k += 1
            if k + 1 != len(p):
                raise ValueError("path: elements after the leaf")
            if len(out) >= MAX_VALUES:
                raise ValueError("path: too many values")
            out.append(bytes(leaf))
            return
        else:
            raise ValueError("path: element %r" % (t,))
        k += 1
    raise ValueError("path: no leaf")


def value(v, cd, tx=None):
    """v: [type-family, type-size, source]. Returns [bytes] (a data path can give several). tx: the
    container, [from, to, value, chain id] as bytes (20, 20, 32, 32)."""
    src = v[2]
    if src[0] == 0:
        return path(cd, src[1])
    if src[0] == 1:
        if tx is None or not 0 <= src[1] <= 3:
            raise ValueError("value: no container")
        return [tx[src[1]]]
    if src[0] == 2:
        if len(src[1]) > 32:
            raise ValueError("value: constant too long")
        return [src[1]]
    raise ValueError("value: source %r not supported" % (src[0],))
