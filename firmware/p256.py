# NIST P-256 ECDSA in pure Python. Runs on MicroPython (RP2350: ~1 s per signature).
# Stand-in for the ATECC608 until it is wired. Same output shape: (r, s) with low s.
import os

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5


def inv(a, m):
    return pow(a, m - 2, m)


# Jacobian coordinates (X, Y, Z); the point at infinity is None.
def _dbl(pt):
    if pt is None:
        return None
    X, Y, Z = pt
    if Y == 0:
        return None
    S = (4 * X * Y * Y) % P
    Zsq = Z * Z
    M = (3 * (X - Zsq) * (X + Zsq)) % P  # a = -3 shortcut
    X3 = (M * M - 2 * S) % P
    Y3 = (M * (S - X3) - 8 * Y * Y * Y * Y) % P
    Z3 = (2 * Y * Z) % P
    return (X3, Y3, Z3)


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    X1, Y1, Z1 = p1
    X2, Y2, Z2 = p2
    Z1sq = Z1 * Z1 % P
    Z2sq = Z2 * Z2 % P
    U1 = X1 * Z2sq % P
    U2 = X2 * Z1sq % P
    S1 = Y1 * Z2sq * Z2 % P
    S2 = Y2 * Z1sq * Z1 % P
    if U1 == U2:
        if S1 != S2:
            return None
        return _dbl(p1)
    H = (U2 - U1) % P
    R = (S2 - S1) % P
    Hsq = H * H % P
    Hcu = Hsq * H % P
    U1Hsq = U1 * Hsq % P
    X3 = (R * R - Hcu - 2 * U1Hsq) % P
    Y3 = (R * (U1Hsq - X3) - S1 * Hcu) % P
    Z3 = H * Z1 * Z2 % P
    return (X3, Y3, Z3)


def _mul(k, pt):
    acc = None
    while k:
        if k & 1:
            acc = _add(acc, pt)
        pt = _dbl(pt)
        k >>= 1
    return acc


def _affine(pt):
    X, Y, Z = pt
    zi = inv(Z, P)
    zi2 = zi * zi % P
    return (X * zi2 % P, Y * zi2 * zi % P)


def pubkey(d):
    """Private scalar -> (x, y)."""
    return _affine(_mul(d, (GX, GY, 1)))


def rand_scalar():
    while True:
        k = int.from_bytes(os.urandom(32), "big")
        if 0 < k < N:
            return k


def sign(d, digest, k=None):
    """ECDSA over a 32-byte digest. Returns (r, s) with s in the low half, as the verifier requires."""
    z = int.from_bytes(digest, "big")
    while True:
        k = k or rand_scalar()
        x, _ = _affine(_mul(k, (GX, GY, 1)))
        r = x % N
        if r == 0:
            k = None
            continue
        s = (inv(k, N) * (z + r * d)) % N
        if s == 0:
            k = None
            continue
        if s > N // 2:
            s = N - s
        return r, s


def verify(qx, qy, digest, r, s):
    if not (0 < r < N and 0 < s < N):
        return False
    z = int.from_bytes(digest, "big")
    w = inv(s, N)
    u1 = z * w % N
    u2 = r * w % N
    pt = _add(_mul(u1, (GX, GY, 1)), _mul(u2, (qx, qy, 1)))
    if pt is None:
        return False
    x, _ = _affine(pt)
    return x % N == r
