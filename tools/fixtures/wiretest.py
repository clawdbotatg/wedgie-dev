# tools/wirechip.mjs's app: wire.py on a real heap, the way a wedgie would use it. A 4 KB descriptor (the
# spec's minimum, made by blob() on the computer and put on the flash as wiretest_blob.bin) is read in place:
# its signed message cut out, its header read, then each field decoded alone and its value found by a slot
# program in 4 KB of calldata. Prints one line:
# {"type": "wiretest", "digest": sha256 of every result, "least": least free heap, "ms": ...}.
# On CPython: python3 tools/fixtures/wiretest.py blob <file> writes the blob; ... check <file> prints the digest.
import gc, json, time, hashlib
try:
    import wire
except ImportError:
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "wire"))
    import wire

least = [1 << 30]
ADDR = bytes(range(1, 21))


def note():
    gc.collect()
    try:
        least[0] = min(least[0], gc.mem_free())
    except AttributeError:
        pass


def word(n):
    return n.to_bytes(32, "big")


def blob():
    """56 token-amount fields: ~4 KB encoded."""
    fields = []
    for i in range(56):
        v = [1, 32, [0, [[0, 2], [2], [1, [2, i % 8, i % 8 + 8]], [0, 1], [3, 3]]]]
        tok = [5, 20, [0, [[0, 2], [2], [1, [2, i % 8, i % 8 + 8]], [0, 0], [3, 3]]]]
        fields.append(["Amount %d" % i, [2, v, tok, [], None, None, None], None, None, None])
    return wire.dumps([1, 1, ADDR, b"\x12\x34\x56\x78", "Pay several people", "wedgie", None, "https://wedgie.dev",
                       "Test", None, fields, None, [1, b"wedgie-test", 1792400000, bytes(72), []]])


def test(b):
    h = hashlib.sha256()
    note()
    msg, env = wire.signed_message(b)
    h.update(msg)
    msg = None
    note()
    for k in range(10):                     # the header, piece by piece
        h.update(repr(wire.load(b, wire.at(b, 0, k))).encode())
    n = 60                                  # calldata: (uint8, address, (address,uint256)[60]) = 4 KB
    cd = bytearray(32 * (4 + 2 * n))        # one buffer: growing it with += would copy it each time
    for k, w in enumerate([7, int.from_bytes(ADDR, "big"), 96, n]):
        cd[32 * k:32 * k + 32] = word(w)
    for i in range(n):
        cd[32 * (4 + 2 * i):32 * (5 + 2 * i)] = word(i + 1)
        cd[32 * (5 + 2 * i):32 * (6 + 2 * i)] = word(1000 + i)
    note()
    for j in wire.elements(b, wire.at(b, 0, 10)):      # each field alone, as a screen shows them
        f = wire.load(b, j)
        h.update(f[0].encode())
        for x in wire.value(f[1][1], cd):
            h.update(x)
        for x in wire.value(f[1][2], cd):
            h.update(x)
        f = None
    note()
    return len(b), len(cd), h.digest()


def run():
    with open("wiretest_blob.bin", "rb") as f:
        b = f.read()
    t = time.ticks_ms()
    nb, nc, dg = test(b)
    ms = time.ticks_diff(time.ticks_ms(), t)
    import binascii
    print(json.dumps({"type": "wiretest", "blob": nb, "calldata": nc, "digest": binascii.hexlify(dg).decode(), "least": least[0], "ms": ms}))
    while True:
        time.sleep_ms(100)


if __name__ == "__main__":
    import sys
    if sys.argv[1] == "blob":
        with open(sys.argv[2], "wb") as f:
            f.write(blob())
    else:
        with open(sys.argv[2], "rb") as f:
            print(test(f.read())[2].hex())
