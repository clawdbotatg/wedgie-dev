#!/usr/bin/env python3
"""wire/wire.py (the ERC-7730 wire format's CBOR and slot programs) on CPython, against independent
implementations: cbor2 (canonical CBOR), eth-abi (the calldata), cryptography (a secp256k1 signature over
signed_message, as the spec's algorithm 1). What's checked: CBOR round-trips byte for byte, everything
non-deterministic or cut short is refused, a signed structure's message is exactly what its signer signed
(and a changed byte fails it), and slot programs find the right values in real ABI encodings (static,
dynamic, arrays of tuples, arrays of bytes, slices, negative indexes) and refuse bad offsets and limits.
    uv run -q --with cbor2 --with eth-abi --with cryptography python3 tools/test_wire.py"""
import hashlib, os, random, sys
import cbor2
from eth_abi import encode
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.exceptions import InvalidSignature

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "wire"))
import wire

bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


def refuses(f, what):
    try:
        f()
        check(False, what)
    except ValueError:
        check(True, what)


# ---- CBOR ----
rnd = random.Random(7730)


def thing(d=0):
    k = rnd.randrange(9 if d < 4 else 6)
    if k == 0:
        return rnd.choice([0, 1, 23, 24, 255, 256, 65535, 65536, 2**32 - 1, 2**32, 2**64 - 1, 2**64, 2**256 - 1, rnd.getrandbits(rnd.randrange(1, 260))])
    if k == 1:
        return -rnd.choice([1, 24, 25, 256, 257, 2**64, 2**64 + 1, rnd.getrandbits(100) + 1])
    if k == 2:
        return rnd.randbytes(rnd.choice([0, 4, 20, 23, 24, 32, 300]))
    if k == 3:
        return rnd.choice(["", "a", "ETH-USD", "Swap", "ünïcödé €", "x" * 30])
    if k == 4:
        return rnd.choice([None, True, False])
    if k == 5:
        return cbor2.CBORTag(rnd.choice([304, 401, 37]), rnd.randbytes(4))
    if k == 6:
        return [thing(d + 1) for _ in range(rnd.randrange(5))]
    return {rnd.randrange(20): thing(d + 1) for _ in range(rnd.randrange(5))}


def ours(x):                                # cbor2's CBORTag -> wire.Tag, recursively
    if isinstance(x, cbor2.CBORTag):
        return wire.Tag(x.tag, ours(x.value))
    if isinstance(x, list):
        return [ours(e) for e in x]
    if isinstance(x, dict):
        return {k: ours(v) for k, v in x.items()}
    return x


same = 0
for _ in range(2000):
    x = thing()
    b = cbor2.dumps(x, canonical=True)
    same += wire.dumps(ours(x)) == b and wire.loads(b) == ours(x)
check(same == 2000, "CBOR: 2000 random items encode and decode exactly as cbor2's canonical CBOR (%d)" % same)
for hexs, v in [("00", 0), ("17", 23), ("1818", 24), ("1903e8", 1000), ("1bffffffffffffffff", 2**64 - 1),
                ("c249010000000000000000", 2**64), ("20", -1), ("3903e7", -1000), ("c349010000000000000000", -2**64 - 1),
                ("40", b""), ("6449455446", "IETF"), ("80", []), ("83010203", [1, 2, 3]), ("a201020304", {1: 2, 3: 4}),
                ("f4", False), ("f5", True), ("f6", None)]:
    check(wire.loads(bytes.fromhex(hexs)) == v and wire.dumps(v).hex() == hexs, "CBOR: RFC 8949 example %s" % hexs)
refuses(lambda: wire.loads(bytes.fromhex("1817")), "CBOR: refuses a non-shortest int (0x18 0x17)")
refuses(lambda: wire.loads(bytes.fromhex("190017")), "CBOR: refuses a non-shortest int (2 bytes for 23)")
refuses(lambda: wire.loads(bytes.fromhex("c2420100")), "CBOR: refuses a bignum that fits in 64 bits")
refuses(lambda: wire.loads(bytes.fromhex("9f0102ff")), "CBOR: refuses an indefinite array")
refuses(lambda: wire.loads(bytes.fromhex("5f4101ff")), "CBOR: refuses an indefinite byte string")
refuses(lambda: wire.loads(bytes.fromhex("8301")), "CBOR: refuses an array cut short")
refuses(lambda: wire.loads(bytes.fromhex("4501")), "CBOR: refuses bytes cut short")
refuses(lambda: wire.loads(bytes.fromhex("0000")), "CBOR: refuses trailing bytes")
refuses(lambda: wire.loads(bytes.fromhex("f93c00")), "CBOR: refuses a float")
refuses(lambda: wire.loads(bytes.fromhex("a201020103")), "CBOR: refuses a duplicate map key")
refuses(lambda: wire.loads(b"\x81" * 40 + b"\x00"), "CBOR: refuses nesting past MAX_DEPTH")

# ---- in place: the same answers without decoding everything ----
inplace = 0
for _ in range(500):
    x = [thing() for _ in range(rnd.randrange(1, 6))]
    b = bytes(wire.dumps(ours(x)))
    js = list(wire.elements(b, 0))
    inplace += (wire.item_end(b, 0) == len(b) and len(js) == len(x)
                and all(wire.load(b, j) == ours(e) for j, e in zip(js, x))
                and all(wire.at(b, 0, k) == js[k] for k in range(len(x))))
check(inplace == 500, "in place: item_end, elements, at and load agree with loads on 500 random arrays (%d)" % inplace)
refuses(lambda: wire.at(wire.dumps([1, 2]), 0, 2), "in place: refuses an element past the end")
refuses(lambda: wire.at(wire.dumps({1: 2}), 0, 0), "in place: refuses a non-array")
refuses(lambda: wire.item_end(bytes.fromhex("83010203")[:3]), "in place: refuses an array cut short")

# ---- signed structures: token-information, signed as the spec's algorithm 1 ----
key = ec.generate_private_key(ec.SECP256K1())
USDC = bytes.fromhex("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
body = [1, 1, USDC, "USDC", 6, "USD Coin"]
env = [1, b"wedgie-test", 1792400000]
msg = wire.dumps(body + [env])                         # what a registry signs
sig = key.sign(msg, ec.ECDSA(hashes.SHA256()))
blob = wire.dumps(body + [env + [sig, []]])            # what it publishes
m, e = wire.signed_message(blob)
check(bytes(m) == msg, "signed: the message is the structure with the envelope cut to 3 elements")
check(e == [1, b"wedgie-test", 1792400000, sig, []], "signed: the envelope comes back whole")
try:
    key.public_key().verify(e[3], m, ec.ECDSA(hashes.SHA256()))
    check(True, "signed: the signature verifies over that message (secp256k1, SHA-256, DER)")
except InvalidSignature:
    check(False, "signed: the signature verifies over that message (secp256k1, SHA-256, DER)")
tam = bytearray(blob)
tam[blob.index(b"USDC")] ^= 1                          # "TSDC"
try:
    key.public_key().verify(sig, wire.signed_message(bytes(tam))[0], ec.ECDSA(hashes.SHA256()))
    check(False, "signed: one changed byte fails the signature")
except InvalidSignature:
    check(True, "signed: one changed byte fails the signature")
refuses(lambda: wire.signed_message(wire.dumps([1, 2, [1, b"k", None]])), "signed: refuses a 3-element envelope")
refuses(lambda: wire.signed_message(wire.dumps({1: 2})), "signed: refuses a non-array")
refuses(lambda: wire.signed_message(blob + b"\x00"), "signed: refuses trailing bytes")

# ---- slot programs on real ABI encodings ----
def cd(types, vals):
    return encode(types, vals)                         # calldata without its selector


A = [bytes([i]) * 20 for i in range(1, 30)]
word = lambda n: n.to_bytes(32, "big")
addr = lambda a: bytes(12) + a
T, ARR, REF, LEAF, SLICE = 0, 1, 2, 3, 4
STATIC, DYNAMIC = 3, 4

c = cd(["address", "uint256"], [A[0], 10**18])        # transfer(to, amount)
check(wire.path(c, [[T, 0], [LEAF, STATIC]]) == [addr(A[0])], "path: transfer's to")
check(wire.path(c, [[T, 1], [LEAF, STATIC]]) == [word(10**18)], "path: transfer's amount")
check(wire.path(c, [[T, 0], [LEAF, STATIC], [SLICE, [-20, None]]]) == [A[0]], "path: a slice keeps an address's 20 bytes")

c = cd(["uint256", "uint256", "address[]", "address", "uint256"], [5, 4, [A[1], A[2], A[3]], A[4], 99])
p0 = [[T, 2], [REF], [ARR, [1, 0, 1]], [LEAF, STATIC]]
check(wire.path(c, p0) == [addr(A[1])], "path: swap's path[0] (a dynamic array)")
check(wire.path(c, [[T, 2], [REF], [ARR, [1, -1, None]], [LEAF, STATIC]]) == [addr(A[3])], "path: path[-1], a negative index")
check(wire.path(c, [[T, 2], [REF], [ARR, [1, None, None]], [LEAF, STATIC]]) == [addr(a) for a in A[1:4]], "path: path[], every element")
check(wire.path(c, [[T, 3], [LEAF, STATIC]]) == [addr(A[4])], "path: the static after a dynamic")

items = [(A[i], 100 + i) for i in range(5)]
c = cd(["uint8", "(address,uint256)[]"], [7, items])
check(wire.path(c, [[T, 1], [REF], [ARR, [2, None, None]], [T, 1], [LEAF, STATIC]]) == [word(100 + i) for i in range(5)],
      "path: an array of static tuples (weight 2), the second component of each")
check(wire.path(c, [[T, 1], [REF], [ARR, [2, 1, 3]], [T, 0], [LEAF, STATIC]]) == [addr(A[1]), addr(A[2])], "path: [1:3] of it")

inner = bytes.fromhex("a9059cbb") + cd(["address", "uint256"], [A[5], 42])
c = cd(["address", "bytes"], [A[6], inner])
check(wire.path(c, [[T, 1], [REF], [LEAF, DYNAMIC]]) == [inner], "path: a bytes param (nested calldata)")
check(wire.path(c, [[T, 1], [REF], [LEAF, DYNAMIC], [SLICE, [0, 4]]]) == [inner[:4]], "path: its selector, a slice")

calls = [bytes([i]) * (i * 7) for i in range(1, 5)]
c = cd(["bytes[]"], [calls])
check(wire.path(c, [[T, 0], [REF], [ARR, [1, None, None]], [REF], [LEAF, DYNAMIC]]) == calls, "path: bytes[] (each a ref inside the array)")
c = cd(["string"], ["Swap ETH for USDC"])
check(wire.path(c, [[T, 0], [REF], [LEAF, DYNAMIC]]) == [b"Swap ETH for USDC"], "path: a string")

c = cd(["address[]"], [A[:20]])
refuses(lambda: wire.path(c, [[T, 0], [REF], [ARR, [1, None, None]], [LEAF, STATIC]]), "path: refuses more than MAX_VALUES values")
check(len(wire.path(c, [[T, 0], [REF], [ARR, [1, 0, 16]], [LEAF, STATIC]])) == 16, "path: 16 values is fine")
c = cd(["address", "uint256"], [A[0], 1])
refuses(lambda: wire.path(c, [[T, 2], [LEAF, STATIC]]), "path: refuses a slot past the calldata")
check(wire.path(c + b"\x00", [[T, 0], [LEAF, STATIC]]) == [addr(A[0])], "path: extra bytes after the ABI part are fine (1inch)")
refuses(lambda: wire.path(c[:40], [[T, 1], [LEAF, STATIC]]), "path: refuses a slot cut short")
refuses(lambda: wire.path(c, [[T, 1], [REF], [LEAF, STATIC]]), "path: refuses an offset that isn't a multiple of 32")
evil = word(2**255) + word(0)
refuses(lambda: wire.path(evil, [[T, 0], [REF], [LEAF, DYNAMIC]]), "path: refuses a huge offset")
evil = word(32) + word(2**200)
refuses(lambda: wire.path(evil, [[T, 0], [REF], [LEAF, DYNAMIC]]), "path: refuses a huge length")
evil = word(32) + word(1000)
refuses(lambda: wire.path(evil, [[T, 0], [REF], [ARR, [1, None, None]], [LEAF, STATIC]]), "path: refuses an array past MAX_ITER")
refuses(lambda: wire.path(c, [[T, 0], [ARR, None], [LEAF, STATIC]]), "path: refuses an array element with no weight")
refuses(lambda: wire.path(c, [[T, 0]]), "path: refuses a program with no leaf")
refuses(lambda: wire.path(c, [[T, 0], [LEAF, STATIC], [T, 1]]), "path: refuses elements after the leaf")
refuses(lambda: wire.path(c, [[T, 0]] * 17 + [[LEAF, STATIC]]), "path: refuses more than MAX_PATH elements")

# ---- values, through CBOR as they'd arrive ----
c = cd(["address", "uint256"], [A[0], 10**18])
tx = [A[7], USDC, word(0), word(1)]
v = wire.loads(wire.dumps([1, 32, [0, [[T, 1], [LEAF, STATIC]]]]))
check(wire.value(v, c, tx) == [word(10**18)], "value: a data path, decoded from CBOR")
check(wire.value([5, 20, [1, 1]], c, tx) == [USDC], "value: the container's to")
check(wire.value([5, 20, [2, USDC]], c, tx) == [USDC], "value: a constant")
refuses(lambda: wire.value([5, 20, [3, 0, [1, 1, [2, b"\x01"]]]], c, tx), "value: refuses a map reference (not yet)")

print("%d FAILED" % bad if bad else "all ok")
sys.exit(1 if bad else 0)
