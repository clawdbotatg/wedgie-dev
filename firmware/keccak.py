# keccak256 in pure Python, MicroPython-compatible. Used to rebuild the EIP-712 digest on the
# device so the screen shows exactly what gets signed. Slow (tens of ms per block on RP2350) but
# a transfer digest is only a few blocks.

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_M = 0xFFFFFFFFFFFFFFFF


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M


def _f(A):
    for rc in _RC:
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
        Bm = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                Bm[y][(2 * x + 3 * y) % 5] = _rol(A[x][y] ^ D[x], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                A[x][y] = Bm[x][y] ^ ((~Bm[(x + 1) % 5][y]) & Bm[(x + 2) % 5][y])
        A[0][0] ^= rc


def keccak256(data):
    rate = 136
    A = [[0] * 5 for _ in range(5)]
    # pad10*1 with keccak (not SHA-3) domain byte 0x01
    pad = rate - (len(data) % rate)
    data = data + (b"\x01" + b"\x00" * (pad - 2) + b"\x80" if pad >= 2 else b"\x81")
    for off in range(0, len(data), rate):
        for i in range(rate // 8):
            lane = int.from_bytes(data[off + 8 * i:off + 8 * i + 8], "little")
            A[i % 5][i // 5] ^= lane
        _f(A)
    out = b""
    for i in range(4):
        out += A[i % 5][i // 5].to_bytes(8, "little")
    return out
