#!/usr/bin/env python3
# ERC-7730 JSON (calldata descriptors, the public registry's v2 files) -> the wire format's transaction-info,
# CBOR, signed with a test key. The computer's side: a wedgie never runs this. It lets us make real test
# messages ourselves until Bacca's tools publish some; when they do, compare byte for byte.
#   python3 wire/from7730.py <descriptor.json | registry dir> <out dir>   one .cbor per (chain, contract, selector)
#   convert(path) -> [(chain id, address bytes, selector bytes, cbor bytes)]
# Needs pycryptodome (keccak) and cryptography (the test signature). Spec: wire/README.md.
# Not yet carried (raises Unsupported, so the file is skipped, never half-converted): map references,
# encryption. addressName "sources" are strings in ERC-7730 but uints in the wire format: sent as [] (any).
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wire

VERSION = 1
FAMILY = {"uint": 1, "int": 2, "ufixed": 3, "fixed": 4, "address": 5, "bool": 6, "bytes": 7, "string": 8}
CONTAINER = {"from": 0, "to": 1, "value": 2, "chainId": 3}
NAME_TYPES = {"eoa": 1, "contract": 2, "collection": 3, "token": 4, "wallet": 5, "contextAddress": 6}
TUPLE, ARRAY, REF, LEAF, SLICE = 0, 1, 2, 3, 4
L_STATIC, L_DYNAMIC = 3, 4
TEST_KEY_ID = b"wedgie-test"


class Unsupported(ValueError):
    pass


def keccak(b):
    from Crypto.Hash import keccak as k
    return k.new(digest_bits=256, data=b).digest()


# ---- the function signature ------------------------------------------------------------------------
# A type: ("leaf", name) | ("tuple", [(name, type)]) | ("array", type, n or None)
def _split(s):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
            continue
        depth += ch == "("
        depth -= ch == ")"
        cur += ch
    if cur.strip():
        out.append(cur)
    return out


def _type(s):
    s = s.strip()
    m = re.match(r"^(.*)\[(\d*)\]$", s)
    if m and m.group(1).count("(") == m.group(1).count(")"):
        return ("array", _type(m.group(1)), int(m.group(2)) if m.group(2) else None)
    if s.startswith("tuple("):
        s = s[5:]
    if s.startswith("("):
        return ("tuple", _params(s[1:-1]))
    return ("leaf", {"uint": "uint256", "int": "int256"}.get(s, s))


def _params(s):
    out = []
    for p in _split(s):
        p = p.strip()
        i = len(p)                          # the name: the last word, if any, after the type
        m = re.match(r"^(.*[\])\w])\s+(\w+)$", p)
        if m and not re.fullmatch(r"(u?int\d*|bytes\d*|address|bool|string)", m.group(2)):
            out.append((m.group(2), _type(m.group(1))))
        else:
            out.append((None, _type(p[:i])))
    return out


def signature(key):
    """'transfer(address to, uint256 amount)' -> (selector, [(name, type)])."""
    m = re.match(r"^\s*(\w+)\s*\((.*)\)\s*$", key)
    if not m:
        raise Unsupported("format key %r" % key)
    params = _params(m.group(2))
    return keccak((m.group(1) + "(" + ",".join(_canon(t) for _, t in params) + ")").encode())[:4], params


def _canon(t):
    if t[0] == "leaf":
        return t[1]
    if t[0] == "tuple":
        return "(" + ",".join(_canon(x) for _, x in t[1]) + ")"
    return _canon(t[1]) + "[" + ("" if t[2] is None else str(t[2])) + "]"


def dynamic(t):
    if t[0] == "leaf":
        return t[1] in ("bytes", "string")
    if t[0] == "tuple":
        return any(dynamic(x) for _, x in t[1])
    return t[2] is None or dynamic(t[1])


def head(t):
    """Slots a type takes in its parent's head."""
    if dynamic(t):
        return 1
    if t[0] == "tuple":
        return sum(head(x) for _, x in t[1])
    if t[0] == "array":
        return t[2] * head(t[1])
    return 1


def family(t):
    """(type-family, type-size) of a leaf type."""
    n = t[1]
    for k in ("uint", "int"):
        if n.startswith(k) and n[len(k):].isdigit():
            return FAMILY[k], int(n[len(k):]) // 8
    if n == "address":
        return 5, 20
    if n == "bool":
        return 6, 1
    if n == "bytes" or n == "string":
        return FAMILY[n], None
    if n.startswith("bytes"):
        return 7, int(n[5:])
    raise Unsupported("type %s" % n)


# ---- paths -----------------------------------------------------------------------------------------
def _steps(p):
    """'a.b.[].[0:32]' -> ['a', 'b', '[]', '[0:32]']"""
    return [s for s in re.split(r"\.(?![^\[]*\])", p) if s] if p else []


def _slice(s):
    m = re.fullmatch(r"\[(-?\d*):(-?\d*)\]", s)
    if m:
        return (int(m.group(1)) if m.group(1) else None, int(m.group(2)) if m.group(2) else None)
    m = re.fullmatch(r"\[(-?\d+)\]", s)
    if m:
        i = int(m.group(1))
        return (i, i + 1 if i != -1 else None)
    if s == "[]":
        return (None, None)
    return None


def program(params, steps):
    """ERC-7730 path steps (from the top-level parameters) -> (slot program, leaf type, size after a slice).
    The spec's 'Converting ERC-7730 paths'."""
    t, prog = ("tuple", params), []
    i = 0
    while i < len(steps):
        s = steps[i]
        sl = _slice(s)
        if t[0] == "tuple":
            if sl is not None:
                raise Unsupported("index into a tuple: %s" % s)
            names = [n for n, _ in t[1]]
            k = names.index(s) if s in names else (int(s) if s.isdigit() else None)
            if k is None or k >= len(names):
                raise Unsupported("no component %r" % s)
            prog.append([TUPLE, sum(head(x) for _, x in t[1][:k])])
            t = t[1][k][1]
            if dynamic(t):
                prog.append([REF])
        elif t[0] == "array":
            if sl is None:
                raise Unsupported("array step %r" % s)
            el = t[1]
            if t[2] is None:                # dynamic array: its length, then elements
                prog.append([ARRAY, [head(el), sl[0], sl[1]]])
            elif sl[0] is not None and (sl[1] == sl[0] + 1 or sl[1] is None and sl[0] == -1):
                k = sl[0] % t[2]            # one element of a fixed array: an offset
                prog.append([TUPLE, k * head(el)])
            else:
                raise Unsupported("slice of a fixed array")
            t = el
            if dynamic(t):
                prog.append([REF])
        else:                               # a leaf: only a slice of its bytes is left
            if sl is None or i != len(steps) - 1:
                raise Unsupported("path past a leaf: %s" % s)
            break
        i += 1
    if t[0] != "leaf":
        raise Unsupported("path ends on a %s" % t[0])
    prog.append([LEAF, L_DYNAMIC if dynamic(t) else L_STATIC])
    size = None
    if i < len(steps):
        a, z = _slice(steps[i])
        prog.append([SLICE, [a, z]])
        if a is not None and z is not None and (a >= 0) == (z >= 0):
            size = z - a
        elif a is not None and a < 0 and z is None:
            size = -a
    return prog, t, size


def _const(x, fam=None):
    """A constant (a hex string, a number, a bool) -> bytes, at most 32."""
    if isinstance(x, bool):
        return b"\x01" if x else b"\x00"
    if isinstance(x, int):
        return x.to_bytes(32, "big")
    if isinstance(x, str) and re.fullmatch(r"0x[0-9a-fA-F]*", x):
        b = bytes.fromhex(x[2:].rjust(len(x[2:]) + len(x[2:]) % 2, "0"))
        if fam == 1 and len(b) < 32:
            b = b.rjust(32, b"\x00")
        if len(b) > 32:
            raise Unsupported("constant over 32 bytes")
        return b
    if isinstance(x, str) and x.isdigit():
        return int(x).to_bytes(32, "big")
    if isinstance(x, str):
        b = x.encode()
        if len(b) > 32:
            raise Unsupported("constant over 32 bytes")
        return b
    raise Unsupported("constant %r" % (x,))


class Ctx:
    def __init__(self, doc, params):
        self.doc, self.params = doc, params

    def ref(self, x):
        """'$.metadata.constants.usdc' -> its value; anything else as is."""
        if isinstance(x, str) and x.startswith("$."):
            v = self.doc
            for k in x[2:].split("."):
                if not isinstance(v, dict) or k not in v:
                    raise Unsupported("no %s" % x)
                v = v[k]
            return v
        return x

    def value(self, path=None, const=None, base=(), fam=None):
        """A wire value from an ERC-7730 path (relative to base, the group's steps) or a constant."""
        if path is None:
            x = self.ref(const)
            c = _const(x, fam)
            if fam is None:             # a literal: its own type (a text constant is a STRING, not BYTES)
                fam = (6 if isinstance(x, bool) else 1 if isinstance(x, int) or isinstance(x, str) and x.isdigit()
                       else 8 if isinstance(x, str) and not x.startswith("0x") else 5 if len(c) == 20 else 7)
            return [fam, len(c), [2, c]]
        path = self.ref(path)
        if not isinstance(path, str):
            return self.value(const=path, fam=fam)
        if path.startswith("@."):
            k = path[2:]
            if k not in CONTAINER:
                raise Unsupported("container %s" % path)
            return [5, 20, [1, CONTAINER[k]]] if k in ("from", "to") else [1, 32, [1, CONTAINER[k]]]
        if path.startswith("$."):
            raise Unsupported("path %s" % path)
        path = re.sub(r"(?<=\w)\[", ".[", path)        # "inputs[]" (ERC-8362's examples) = "inputs.[]"
        steps = _steps(path[2:]) if path.startswith("#.") else list(base) + _steps(path)
        prog, t, size = program(self.params, steps)
        f, n = family(t)
        return [f, size if size is not None else n, [0, prog]]


def _vis(v, field, ctx):
    if v is None or v == "always":
        return None
    if v == "optional":
        return [3, []]
    if isinstance(v, dict):
        mode, cs = (1, v["mustMatch"]) if "mustMatch" in v else (2, v["ifNotIn"]) if "ifNotIn" in v else (None, None)
        if mode is None:
            raise Unsupported("visible %r" % v)
        return [mode, [_const(ctx.ref(c)) for c in cs]]
    raise Unsupported("visible %r" % v)


def _field_def(f, doc):
    if "$ref" in f:                         # $.display.definitions.x, the field's own keys win
        d = Ctx(doc, None).ref(f["$ref"])
        g = dict(d)
        g.update({k: v for k, v in f.items() if k != "$ref"})
        if "params" in d and "params" in f:
            g["params"] = dict(d["params"], **f["params"])
        return g
    return f


def _param(f, ctx, base):
    fmt = f.get("format", "raw")
    p = {k: ctx.ref(v) for k, v in (f.get("params") or {}).items()}
    if "$ref" in p and fmt == "enum":
        p["enum"] = p.pop("$ref")
    val = ctx.value(f.get("path"), f.get("value"), base)
    pv = lambda path_k, const_k, fam=None: (ctx.value(p[path_k], None, base) if path_k in p
                                            else ctx.value(const=p[const_k], fam=fam) if const_k in p else None)
    natives = lambda: [_const(ctx.ref(a)) for a in (p.get("nativeCurrencyAddress") or [])]
    if isinstance(p.get("nativeCurrencyAddress"), str):
        p["nativeCurrencyAddress"] = [p["nativeCurrencyAddress"]]
    if fmt == "raw":
        return [0, val]
    if fmt == "amount":
        return [1, val]
    if fmt == "tokenAmount":
        th = p.get("threshold")
        out = [2, val, pv("tokenPath", "token", 5), natives(),
               int.from_bytes(_const(th), "big") if th is not None else None, p.get("message"),
               pv("chainIdPath", "chainId", 1)]
        if p.get("specialValues"):          # ours: a value the contract reads as words (Uniswap v4's 0 = "all of it")
            out.append(sorted([int(k, 0), v] for k, v in p["specialValues"].items()))
        return out
    if fmt == "nftName":
        c = pv("collectionPath", "collection", 5)
        if c is None:
            raise Unsupported("nftName without a collection")
        return [3, val, c]
    if fmt == "date":
        return [4, val, {"timestamp": 0, "blockheight": 1}[p.get("encoding", "timestamp")]]
    if fmt == "duration":
        return [5, val]
    if fmt == "unit":
        return [6, val, p["base"], p.get("decimals"), p.get("prefix")]
    if fmt == "enum":
        e = p.get("enum")
        if not isinstance(e, dict):
            raise Unsupported("enum %r" % (e,))
        key = lambda k: {"false": 0, "true": 1}.get(k) if k in ("false", "true") else int(k, 0)
        return [7, val, sorted([key(k), v] for k, v in e.items())]
    if fmt == "addressName":
        return [8, val, [NAME_TYPES[x] for x in p.get("types") or []], [],
                [_const(ctx.ref(a)) for a in ([p["senderAddress"]] if isinstance(p.get("senderAddress"), str) else p.get("senderAddress") or [])],
                None]
    if fmt == "calldata":
        callee = pv("calleePath", "callee", 5)
        if callee is None:
            raise Unsupported("calldata without a callee")
        out = [9, val, callee, pv("chainIdPath", "chainId", 1), pv("selectorPath", "selector", 7),
               pv("amountPath", "amount", 1), pv("spenderPath", "spender", 5)]
        op = p.get("operation")             # ERC-8362: [value, [[key, op]], default op]; op 1 CALL, 2 DELEGATECALL..
        if op is not None:
            ops = {"CALL": 1, "DELEGATECALL": 2, "CREATE": 3, "CREATE2": 4, "CALLCODE": 5}
            if isinstance(op, str):
                out.append([None, [], ops[op]])
            else:
                ex = op["expression"]
                cs = op.get("cases") or {}
                out.append([ctx.value(ex if isinstance(ex, str) else ex["path"], None, base),
                            [[int(k, 0), ops[v]] for k, v in cs.items() if k != "$default"], ops.get(cs.get("$default"))])
        return out
    if fmt == "tokenTicker":
        return [10, val, natives(), pv("chainIdPath", "chainId", 1)]
    if fmt == "chainId":
        return [11, val]
    if fmt == "customEncoding":
        return [13, val, _node(f.get("params") or {}, ctx), f.get("label")]
    raise Unsupported("format %s" % fmt)


# ---- ERC-8362 draft (Custom Encoding Layout, ERCs PR #1925, as of 10-19) ----------------------------
# customEncoding, sequence, object, switch, mask, $index. Not yet: interaction, $fallback, @.data, a display field
# addressing an entry by path (an entry shows itself inline), operation. The wire format has no binding for them
# yet, so this is ours (safe_7730 reads it):
#   param 13 customEncoding: [13, value, node, label]
#     node: [0, n] uint of n bytes | [1, how, n] bytes: how 0 n bytes, 1 as long as entry n says, 2 to the end
#           | [2, n] address in 20 or 32 bytes | [3] bool | [4, [[skip, node, field or null]]] object
#           | [5, node, count or null] sequence (null: until the bytes run out)
#   param 14 switch: [14, value, [expression value, element size or null, mask or null], [[key, case]], default]
#     case: [0, intent, fields] (the value is the ABI encoding of the case's tuple) | [1, node] | null (reject)
#           | [2, param] (ours: a case that is a display format, e.g. tokenAmount, for the switch's own value;
#             param's value is null: the switch's)
#   tokenAmount, ours: [2, value, token, natives, threshold, message, chain, [[n, text]]] (params.specialValues
#     {"0": "all the {token} the swap gives"}: n shows as its text, "{token}" the ticker; only when given)
#     element size: "x[$index]", the i-th element of the uint sequence x, i = which value of the switch's own path
#   value source 3: [3, k], entry k of the object being decoded
IMPLIED = {"addressName": {"type": "address", "bytes": 32}}
for _f in ("amount", "tokenAmount", "date", "duration", "unit", "enum", "chainId", "nftName"):
    IMPLIED[_f] = {"type": "uint", "bytes": 32}


class Entries(Ctx):
    """An object's entries, for its own display: "~.name" (or a bare name) is entry k."""
    def __init__(self, ctx, names, types):
        Ctx.__init__(self, ctx.doc, ctx.params)
        self.names, self.types = names, types

    def value(self, path=None, const=None, base=(), fam=None):
        if isinstance(path, str):
            n = path[2:] if path.startswith("~.") else path
            if n in self.names:
                t = self.types[self.names.index(n)]
                if t is None:
                    raise Unsupported("entry %s isn't a value" % n)
                return [t[0], t[1], [3, self.names.index(n)]]
            if path.startswith("~."):
                raise Unsupported("no entry %s" % path)
        return Ctx.value(self, path, const, base, fam)


def _kind(n):
    """(family, size) a node decodes to, or None (a sequence or object)."""
    t = n.get("type")
    return {"uint": (1, n.get("bytes")), "address": (5, 20), "bool": (6, 1), "bytes": (7, None)}.get(t)


def _node(n, ctx, names=()):
    t = n.get("type")
    if t == "uint":
        if not 0 < int(n.get("bytes", 0)) <= 32:
            raise Unsupported("uint of %r bytes" % n.get("bytes"))
        return [0, int(n["bytes"])]
    if t == "address":
        if n.get("bytes") not in (20, 32):
            raise Unsupported("address of %r bytes" % n.get("bytes"))
        return [2, n["bytes"]]
    if t == "bool":
        return [3]
    if t == "bytes":
        ways = [k for k in ("length", "lengthFrom", "toEnd") if k in n]
        if len(ways) != 1:
            raise Unsupported("bytes: one of length, lengthFrom, toEnd")
        if ways[0] == "length":
            return [1, 0, int(n["length"])]
        if ways[0] == "toEnd":
            return [1, 2, None]
        if n["lengthFrom"] not in names:
            raise Unsupported("lengthFrom %s: not an earlier entry" % n["lengthFrom"])
        return [1, 1, list(names).index(n["lengthFrom"])]
    if t == "sequence":
        return [5, _node(n["element"], ctx), n.get("count")]
    if t == "object":
        es = n.get("entries") or []
        nm = [e["name"] for e in es]
        if len(set(nm)) != len(nm):
            raise Unsupported("entry names not unique")
        sch = [e.get("schema") or IMPLIED.get(e.get("format")) for e in es]
        if None in sch:
            raise Unsupported("entry without a schema")
        ec = Entries(ctx, nm, [_kind(x) for x in sch])
        out = []
        for i, (e, x) in enumerate(zip(es, sch)):
            shown = ("label" in e or "format" in e) and e.get("visible") not in ("never", False)
            fd = None
            if shown:
                if e.get("format") == "customEncoding":
                    raise Unsupported("an entry can't be customEncoding")
                g = dict(e, path="~." + e["name"])
                fd = [e.get("label") or "", _param(g, ec, ()), _vis(e.get("visible"), g, ec), e.get("separator"), None]
            out.append([int(e.get("offset", 0)), _node(x, ctx, nm[:i]), fd])
        return [4, out]
    raise Unsupported("node type %r" % t)


def _switch(f, ctx, doc, base, seqs):
    sw = f["switch"]
    val = ctx.value(f.get("path"), None, base)
    ex = sw["expression"]
    ep, mask = (ex.get("path"), ex.get("mask")) if isinstance(ex, dict) else (ex, None)
    size = None
    if ep.endswith("[$index]"):
        ep = ep[:-8]
        if ep not in seqs:
            raise Unsupported("%s[$index]: not a uint sequence here" % ep)
        size = seqs[ep]
    ev = ctx.value(ep, None, base)
    cases, default = [], None
    for k, c in sw["cases"].items():
        if c == "reject":
            cc = None
        elif c.get("format") == "customEncoding":
            cc = [1, _node(c.get("params") or {}, ctx)]
        elif "format" in c:                 # ours: a display format for the switch's own value (its token by a flag)
            cc = [2, _param(dict(c, path=f.get("path")), ctx, base)]
            cc[1][1] = None                 # the switch's own value: not sent twice
        else:
            if len(c) != 1:
                raise Unsupported("a case is one tuple")
            sig, spec = next(iter(c.items()))
            sig = sig.strip()
            if not (sig.startswith("(") and sig.endswith(")")):
                raise Unsupported("case %r" % sig)
            cctx = Ctx(doc, _params(sig[1:-1]))
            cc = [0, spec.get("intent"), fields(spec.get("fields") or [], cctx, doc)]
        if k == "$default":
            default = cc
        else:
            cases.append([int(k, 0), cc])
    return [14, val, [ev, size, int(mask, 0) if isinstance(mask, str) else mask], cases, default]


def fields(fs, ctx, doc, base=()):
    out = []
    seqs = {}                               # path -> element size, of a customEncoding sequence of uints (for $index)
    for f in fs:
        p = f.get("params") or {}
        if f.get("format") == "customEncoding" and p.get("type") == "sequence" and p["element"].get("type") == "uint":
            seqs[f["path"]] = int(p["element"]["bytes"])
    for f in fs:
        f = _field_def(f, doc)
        if "encryption" in f:
            raise Unsupported("encryption")
        if "switch" in f:
            out.append([f.get("label") or "", _switch(f, ctx, doc, base, seqs), _vis(f.get("visible"), f, ctx), None, None])
            continue
        if "interaction" in f:
            raise Unsupported("interaction")
        if "fields" in f:                   # a group: its fields' paths are relative to its own
            gb = list(base) + _steps(f.get("path", "")) if not f.get("path", "").startswith("#.") else _steps(f["path"][2:])
            sub = fields(f["fields"], ctx, doc, gb)
            if sub:
                out.append([f.get("label") or "", [12, {"bundled": 0, "sequential": 1}.get(f.get("iteration"), None), sub, f.get("label")],
                            None, None, None])
            continue
        v = f.get("visible")
        if v == "never" or v is False:      # not encoded, as the spec says
            continue
        out.append([f.get("label") or "", _param(f, ctx, base), _vis(v, f, ctx), f.get("separator"), None])
    return out


# ---- a file ----------------------------------------------------------------------------------------
def _merge(a, b):
    """b over a, dicts deeply (ERC-7730 includes: the including file wins)."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = dict(a)
        for k, v in b.items():
            out[k] = _merge(a[k], v) if k in a else v
        return out
    return b


def load(path):
    with open(path) as f:
        d = json.load(f)
    inc = d.pop("includes", None)
    if inc:
        d = _merge(load(os.path.join(os.path.dirname(path), inc)), d)
    return d


def _date(s):
    import datetime
    if s is None:
        return None
    return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def sign(body, key=None, issued=None):
    """body (a transaction-info without its envelope) -> CBOR, signed with the test key (algorithm 1:
    secp256k1 over SHA-256, DER), the way a registry would."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import hashes
    key = key or test_key()
    env = [1, TEST_KEY_ID, issued]
    sig = key.sign(bytes(wire.dumps(body + [env])), ec.ECDSA(hashes.SHA256()))
    return bytes(wire.dumps(body + [env + [sig, []]]))


_key = None


def test_key():
    """A fixed secp256k1 test key (its secret is public: it signs test data only)."""
    global _key
    if _key is None:
        from cryptography.hazmat.primitives.asymmetric import ec
        _key = ec.derive_private_key(int.from_bytes(keccak(b"wedgie wire test key"), "big"), ec.SECP256K1())
    return _key


def convert(path, issued=None, doc=None, seal=None):
    """doc: the file already merged with its includes (release.py passes clearsig's merge, what auditors hash).
    seal: body -> stored bytes (default: signed with the test key)."""
    doc = doc if doc is not None else load(path)
    seal = seal or (lambda body: sign(body, issued=issued))
    meta = doc.get("metadata") or {}
    info = meta.get("info") or {}
    deps = doc["context"]["contract"]["deployments"]
    out = []
    for key, fmt in (doc.get("display") or {}).get("formats", {}).items():
        sel, params = signature(key)
        ctx = Ctx(doc, params)
        fs = fields(fmt.get("fields") or [], ctx, doc)     # pause(): none, just the intent. The CDDL says
                                                            # [+ field]; sent as [] (a question for the spec)
        ext = {1: fmt["interpolatedIntent"]} if fmt.get("interpolatedIntent") else None
        intent = fmt.get("intent")
        if isinstance(intent, dict):
            intent = " ".join("%s: %s" % kv for kv in intent.items())
        for d in deps:
            a = bytes.fromhex(d["address"][2:])
            body = [VERSION, int(d["chainId"]), a, sel, intent or key.split("(")[0], meta.get("owner"),
                    info.get("legalName"), info.get("url"), meta.get("contractName") or doc["context"].get("$id"),
                    _date(info.get("deploymentDate")), fs, ext]
            out.append((int(d["chainId"]), a, sel, seal(body)))
    return out


def files(root):
    if os.path.isfile(root):
        return [root]
    return sorted(os.path.join(dp, n) for dp, _, ns in os.walk(root) for n in ns
                  if n.startswith("calldata-") and n.endswith(".json") and ".tests." not in n
                  and os.path.basename(dp) != "sigs")      # sigs/: Ledger's signatures, not descriptors


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    os.makedirs(dst, exist_ok=True)
    made, skipped = 0, {}
    for fn in files(src):
        try:
            for chain, a, sel, b in convert(fn):
                with open(os.path.join(dst, "%d-%s-%s.cbor" % (chain, a.hex(), sel.hex())), "wb") as f:
                    f.write(b)
                made += 1
        except (ValueError, KeyError) as e:     # Unsupported is a ValueError
            skipped[fn] = str(e)
    print("%d descriptors, %d files skipped" % (made, len(skipped)))
    for fn, why in sorted(skipped.items()):
        print("  skip %s: %s" % (os.path.relpath(fn, src) if os.path.isdir(src) else fn, why))
