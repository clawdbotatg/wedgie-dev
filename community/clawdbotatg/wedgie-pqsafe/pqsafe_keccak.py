# keccak256 (Ethereum's hash) in plain Python, for MicroPython. The wedgie has only sha256 built in.
# The state is one flat list of 25 lanes (x + 5*y), reused: nothing new per round but the ints.

_RC = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)
_M = 0xFFFFFFFFFFFFFFFF
# rho + pi in one table: lane i goes to _PI[i], rotated left by _ROT[i]
_ROT = (0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14)
_PI = tuple((y + 5 * ((2 * x + 3 * y) % 5)) for i in range(25) for x, y in ((i % 5, i // 5),))
_A = [0] * 25
_B = [0] * 25


def _f(A, B):
    M = _M
    for rc in _RC:
        c0 = A[0] ^ A[5] ^ A[10] ^ A[15] ^ A[20]
        c1 = A[1] ^ A[6] ^ A[11] ^ A[16] ^ A[21]
        c2 = A[2] ^ A[7] ^ A[12] ^ A[17] ^ A[22]
        c3 = A[3] ^ A[8] ^ A[13] ^ A[18] ^ A[23]
        c4 = A[4] ^ A[9] ^ A[14] ^ A[19] ^ A[24]
        d = (c4 ^ (((c1 << 1) | (c1 >> 63)) & M),
             c0 ^ (((c2 << 1) | (c2 >> 63)) & M),
             c1 ^ (((c3 << 1) | (c3 >> 63)) & M),
             c2 ^ (((c4 << 1) | (c4 >> 63)) & M),
             c3 ^ (((c0 << 1) | (c0 >> 63)) & M))
        for i in range(25):
            v = A[i] ^ d[i % 5]
            r = _ROT[i]
            B[_PI[i]] = (((v << r) | (v >> (64 - r))) & M) if r else v
        for y in range(0, 25, 5):
            b0, b1, b2, b3, b4 = B[y], B[y + 1], B[y + 2], B[y + 3], B[y + 4]
            A[y] = b0 ^ ((b1 ^ M) & b2)
            A[y + 1] = b1 ^ ((b2 ^ M) & b3)
            A[y + 2] = b2 ^ ((b3 ^ M) & b4)
            A[y + 3] = b3 ^ ((b4 ^ M) & b0)
            A[y + 4] = b4 ^ ((b0 ^ M) & b1)
        A[0] ^= rc


def keccak256(data):
    A, B = _A, _B
    for i in range(25):
        A[i] = 0
    n = len(data)
    full = n - n % 136
    for off in range(0, full, 136):
        for i in range(17):
            A[i] ^= int.from_bytes(data[off + 8 * i:off + 8 * i + 8], "little")
        _f(A, B)
    last = bytearray(136)                   # the last block, padded (keccak's 0x01 ... 0x80)
    last[:n - full] = data[full:]
    last[n - full] ^= 0x01
    last[135] ^= 0x80
    for i in range(17):
        A[i] ^= int.from_bytes(last[8 * i:8 * i + 8], "little")
    _f(A, B)
    return b"".join(A[i].to_bytes(8, "little") for i in range(4))
