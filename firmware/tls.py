# tls: a wedgie's own TLS 1.3 connection to a site. The computer (and wedgie.dev) only carry the bytes: they
# can block them, never read or change them. Key exchange P-256, the cipher AES-128-GCM, certificates ECDSA
# (P-256, P-384) or RSA (PKCS#1 v1.5 in the chain, PSS for the site's own signature; 0.3.69+), chained to a root in
# roots.bin. The Trust M does ECDH and the ECDSA checks; an RSA check is one pow() (MicroPython's C bigints: 0.1 s
# for 2048 bits, 0.5 s for 4096 on an RP2040); AES on cryptolib; GHASH, HKDF and SHA-384/512 in Python.
#   c = tls.Conn("api.coinbase.com", send, recv)    # send(bytes); recv() -> bytes (b"" = closed)
#   body = c.get("/v2/prices/ETH-USD/spot")         # the HTTP/1.1 body (bytes); raises tls.Error
# net.get uses it (0.3.67+); the computer carries the bytes (wedgie.dev's relay, relay/, or wedgie.py net).
# Tests: tls/ (test_tls.py: a computer that attacks; tlschip.mjs; tlsboard.py).
# RAM: each record is decrypted in place and read through memoryviews (no copies), the transcript is hashed
# as it comes, roots.bin is read one root at a time. Import it to fetch, then drop it from sys.modules.
# Not checked: a certificate's dates (a wedgie has no clock) and revocation.
import hashlib

try:
    from cryptolib import aes
except ImportError:
    aes = None


class Error(Exception):
    pass


# per root: sha256(subject DER)[:12], its kind (3 P-256, 4 P-384: the key 04 X Y; 16 RSA: 2 bytes of length, then
# the RSAPublicKey DER). tls/mkroots.py makes it.
ROOTS = "/roots.bin"
P256, P384, RSA = 3, 4, 16
_CURVES = {b"\x2a\x86\x48\xce\x3d\x03\x01\x07": P256, b"\x2b\x81\x04\x00\x22": P384}
_RSAKEY = b"\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01"
_ECDSA256 = b"\x2a\x86\x48\xce\x3d\x04\x03\x02"
_ECDSA384 = b"\x2a\x86\x48\xce\x3d\x04\x03\x03"
# a certificate's signature algorithm -> (ECDSA or not, its hash)
_SIGALGS = {_ECDSA256: (True, 256), _ECDSA384: (True, 384), b"\x2a\x86\x48\x86\xf7\x0d\x01\x01\x0b": (False, 256),
            b"\x2a\x86\x48\x86\xf7\x0d\x01\x01\x0c": (False, 384), b"\x2a\x86\x48\x86\xf7\x0d\x01\x01\x0d": (False, 512)}
_SAN = b"\x55\x1d\x11"
_BC, _KU, _EKU = b"\x55\x1d\x13", b"\x55\x1d\x0f", b"\x55\x1d\x25"
_SERVER_AUTH, _ANY_EKU = b"\x2b\x06\x01\x05\x05\x07\x03\x01", b"\x55\x1d\x25\x00"
_KEYLEN = {P256: 65, P384: 97}


def root(issuer):
    """(kind, key) of the root whose subject is issuer (DER), or None."""
    want = hashlib.sha256(issuer).digest()[:12]
    with open(ROOTS, "rb") as f:
        while True:
            h = f.read(13)
            if len(h) < 13:
                return None
            n = _KEYLEN.get(h[12]) or int.from_bytes(f.read(2), "big")
            if h[:12] == want:
                return h[12], f.read(n)
            f.seek(n, 1)


# ---- hashes ----
def sha256(b):
    return hashlib.sha256(b).digest()


def hmac256(key, msg):
    if len(key) > 64:
        key = sha256(key)
    key = key + bytes(64 - len(key))
    h = hashlib.sha256(bytes(x ^ 0x36 for x in key))
    h.update(msg)
    o = hashlib.sha256(bytes(x ^ 0x5C for x in key))
    o.update(h.digest())
    return o.digest()


_K512 = (b"428a2f98d728ae227137449123ef65cdb5c0fbcfec4d3b2fe9b5dba58189dbbc3956c25bf348b53859f111f1b605d019"
         b"923f82a4af194f9bab1c5ed5da6d8118d807aa98a303024212835b0145706fbe243185be4ee4b28c550c7dc3d5ffb4e2"
         b"72be5d74f27b896f80deb1fe3b1696b19bdc06a725c71235c19bf174cf692694e49b69c19ef14ad2efbe4786384f25e3"
         b"0fc19dc68b8cd5b5240ca1cc77ac9c652de92c6f592b02754a7484aa6ea6e4835cb0a9dcbd41fbd476f988da831153b5"
         b"983e5152ee66dfaba831c66d2db43210b00327c898fb213fbf597fc7beef0ee4c6e00bf33da88fc2d5a79147930aa725"
         b"06ca6351e003826f142929670a0e6e7027b70a8546d22ffc2e1b21385c26c9264d2c6dfc5ac42aed53380d139d95b3df"
         b"650a73548baf63de766a0abb3c77b2a881c2c92e47edaee692722c851482353ba2bfe8a14cf10364a81a664bbc423001"
         b"c24b8b70d0f89791c76c51a30654be30d192e819d6ef5218d69906245565a910f40e35855771202a106aa07032bbd1b8"
         b"19a4c116b8d2d0c81e376c085141ab532748774cdf8eeb9934b0bcb5e19b48a8391c0cb3c5c95a634ed8aa4ae3418acb"
         b"5b9cca4f7763e373682e6ff3d6b2b8a3748f82ee5defb2fc78a5636f43172f6084c87814a1f0ab728cc702081a6439ec"
         b"90befffa23631e28a4506cebde82bde9bef9a3f7b2c67915c67178f2e372532bca273eceea26619cd186b8c721c0c207"
         b"eada7dd6cde0eb1ef57d4f7fee6ed17806f067aa72176fba0a637dc5a2c898a6113f9804bef90dae1b710b35131c471b"
         b"28db77f523047d8432caab7b40c724933c9ebe0a15c9bebc431d67c49c100d4c4cc5d4becb3e42b6597f299cfc657e2a"
         b"5fcb6fab3ad6faec6c44198c4a475817")
_M64 = 0xFFFFFFFFFFFFFFFF


def sha384(msg):
    return _sha512(msg, (0xcbbb9d5dc1059ed8, 0x629a292a367cd507, 0x9159015a3070dd17, 0x152fecd8f70e5939,
                         0x67332667ffc00b31, 0x8eb44a8768581511, 0xdb0c2e0d64f98fa7, 0x47b5481dbefa4fa4), 6)


def sha512(msg):
    return _sha512(msg, (0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
                         0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179), 8)


def digest(bits, msg):
    return sha256(msg) if bits == 256 else sha384(msg) if bits == 384 else sha512(msg)


def _sha512(msg, h, words):
    """SHA-384/512 in Python (a Pico's hashlib has none): a certificate signature, ~1 KB. msg: any buffer."""
    import binascii
    K = binascii.unhexlify(_K512)           # 640 bytes; each constant read as it's used (a list of 80 would be 3 KB)
    h = list(h)
    n = len(msg)
    full = n - n % 128
    tail = bytes(msg[full:]) + b"\x80" + bytes((111 - n) % 128) + (n * 8).to_bytes(16, "big")
    r = lambda x, k: ((x >> k) | (x << (64 - k))) & _M64
    w = [0] * 80
    for src, o in [(msg, o) for o in range(0, full, 128)] + [(tail, o) for o in range(0, len(tail), 128)]:
        for i in range(16):
            w[i] = int.from_bytes(src[o + 8 * i:o + 8 * i + 8], "big")
        for i in range(16, 80):
            a, b = w[i - 15], w[i - 2]
            w[i] = (w[i - 16] + (r(a, 1) ^ r(a, 8) ^ (a >> 7)) + w[i - 7] + (r(b, 19) ^ r(b, 61) ^ (b >> 6))) & _M64
        a, b, c, d, e, f, g, hh = h
        for i in range(80):
            t1 = (hh + (r(e, 14) ^ r(e, 18) ^ r(e, 41)) + ((e & f) ^ (~e & g)) + int.from_bytes(K[8 * i:8 * i + 8], "big") + w[i]) & _M64
            t2 = ((r(a, 28) ^ r(a, 34) ^ r(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & _M64
            hh, g, f, e, d, c, b, a = g, f, e, (d + t1) & _M64, c, b, a, (t1 + t2) & _M64
        h = [(x + y) & _M64 for x, y in zip(h, (a, b, c, d, e, f, g, hh))]
    return b"".join(x.to_bytes(8, "big") for x in h[:words])


# ---- RSA (software: pow() is C) ----
_INFO = {256: b"\x30\x31\x30\x0d\x06\x09\x60\x86\x48\x01\x65\x03\x04\x02\x01\x05\x00\x04\x20",
         384: b"\x30\x41\x30\x0d\x06\x09\x60\x86\x48\x01\x65\x03\x04\x02\x02\x05\x00\x04\x30",
         512: b"\x30\x51\x30\x0d\x06\x09\x60\x86\x48\x01\x65\x03\x04\x02\x03\x05\x00\x04\x40"}


def _rsa(key, sig):
    """sig^e mod n as bytes (the modulus's length), or None. key: RSAPublicKey DER."""
    a = _kids(key, *_tlv(key, 0))
    nb = bytes(key[a[0][2]:a[0][3]]).lstrip(b"\x00")
    n, e = int.from_bytes(nb, "big"), int.from_bytes(key[a[1][2]:a[1][3]], "big")
    k = len(nb)
    bits = 8 * k - 8 + len(bin(nb[0])) - 2          # (MicroPython's int has no bit_length)
    s = int.from_bytes(sig, "big")
    if len(sig) != k or s >= n or bits < 2048 or e < 3:
        return None
    return pow(s, e, n).to_bytes(k, "big"), bits


def rsa_pkcs1(key, sig, bits, d):
    """PKCS#1 v1.5 (a certificate's signature): True if sig signs the digest d (SHA-bits)."""
    r = _rsa(key, sig)
    if not r:
        return False
    em, _ = r
    want = _INFO[bits] + d
    return em == b"\x00\x01" + b"\xff" * (len(em) - len(want) - 3) + b"\x00" + want


def rsa_pss(key, sig, bits, d):
    """RSASSA-PSS, salt as long as the hash (TLS 1.3's rsa_pss_rsae_*): True if sig signs the digest d."""
    r = _rsa(key, sig)
    if not r:
        return False
    em, nbits = r
    hl, embits = bits // 8, nbits - 1
    emlen = (embits + 7) // 8
    if len(em) > emlen:
        if em[0]:
            return False
        em = em[1:]
    if em[-1] != 0xBC or emlen < 2 * hl + 2:
        return False
    db, h = bytearray(em[:emlen - hl - 1]), em[emlen - hl - 1:-1]
    top = 0xFF >> (8 * emlen - embits)
    if db[0] & ~top & 0xFF:
        return False
    c, o = 0, 0
    while o < len(db):                      # MGF1
        m = digest(bits, h + c.to_bytes(4, "big"))
        for x in m[:len(db) - o]:
            db[o] ^= x
            o += 1
        c += 1
    db[0] &= top
    z = emlen - 2 * hl - 2
    if any(db[:z]) or db[z] != 1:
        return False
    return digest(bits, bytes(8) + d + bytes(db[-hl:])) == h


# ---- the key schedule (RFC 8446 7.1) ----
def _label(secret, label, ctx, n):
    info = n.to_bytes(2, "big") + bytes([6 + len(label)]) + b"tls13 " + label + bytes([len(ctx)]) + ctx
    return hmac256(secret, info + b"\x01")[:n]          # n <= 32: one block of HKDF-Expand


# ---- AES-128-GCM ----
_R = 0xE1 << 120


def _x4(z):
    for _ in range(4):
        z = (z >> 1) ^ _R if z & 1 else z >> 1
    return z


_RED = None


class _Gcm:
    def __init__(self, key, iv):
        self.e = aes(key, 1).encrypt if aes else _EcbShim(key)
        self.iv, self.n = iv, 0
        hk = bytearray(16)
        self.e(bytes(16), hk)
        global _RED
        if _RED is None:
            _RED = [_x4(i) for i in range(16)]
        t = [0] * 16            # t[n]: the nibble n (as x^0..x^3) times H
        v = int.from_bytes(hk, "big")
        for bit in (8, 4, 2, 1):
            t[bit] = v
            v = (v >> 1) ^ _R if v & 1 else v >> 1
        for n in range(16):
            if n & (n - 1):
                t[n] = t[n & -n] ^ t[n & (n - 1)]
        self.t = t

    def _mul(self, x):
        z, t, red = 0, self.t, _RED
        for _ in range(32):                 # Horner: the low nibble (x^124..x^127) first
            z = (z >> 4) ^ red[z & 15] ^ t[x & 15]
            x >>= 4
        return z

    def _ghash(self, aad, ct):
        y = 0
        for d in (aad, ct):
            n = len(d)
            for o in range(0, n - 15, 16):
                y = self._mul(y ^ int.from_bytes(d[o:o + 16], "big"))
            if n % 16:
                y = self._mul(y ^ int.from_bytes(bytes(d[n - n % 16:]) + bytes(16 - n % 16), "big"))
        return self._mul(y ^ ((len(aad) * 8) << 64 | len(ct) * 8))

    def _ctr(self, nonce, src, n, dst):
        blk, ks = bytearray(16), bytearray(16)
        blk[:12] = nonce
        c = 2
        for o in range(0, n, 16):
            blk[12:] = c.to_bytes(4, "big")
            c += 1
            self.e(blk, ks)
            for k in range(min(16, n - o)):
                dst[o + k] = src[o + k] ^ ks[k]

    def _nonce(self):
        n = bytearray(self.iv)
        s = self.n.to_bytes(8, "big")
        for i in range(8):
            n[4 + i] ^= s[i]
        self.n += 1
        return bytes(n)

    def _tag(self, nonce, aad, ct):
        ek = bytearray(16)
        self.e(nonce + b"\x00\x00\x00\x01", ek)
        return (self._ghash(aad, ct) ^ int.from_bytes(ek, "big")).to_bytes(16, "big")

    def seal(self, aad, pt):
        nonce = self._nonce()
        ct = bytearray(len(pt) + 16)
        self._ctr(nonce, pt, len(pt), ct)
        ct[len(pt):] = self._tag(nonce, aad, memoryview(ct)[:len(pt)])
        return ct

    def open(self, aad, buf):
        """buf (bytearray): ciphertext + tag. Checked, then decrypted in place; the plaintext is buf[:-16]."""
        nonce = self._nonce()
        n = len(buf) - 16
        mv = memoryview(buf)
        if self._tag(nonce, aad, mv[:n]) != bytes(mv[n:]):
            raise Error("tampered with")
        self._ctr(nonce, mv, n, mv)


class _EcbShim:          # the computer test (CPython): cryptolib's aes(key, 1).encrypt(in, out)
    def __init__(self, key):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        self.c = Cipher(algorithms.AES(key), modes.ECB()).encryptor()

    def __call__(self, i, o):
        o[:] = self.c.update(bytes(i))


# ---- DER (b: a memoryview; nothing is copied but what's kept) ----
def _tlv(b, i):
    """(start of value, end of value) of the DER element at i."""
    n = b[i + 1]
    i += 2
    if n & 0x80:
        k = n & 0x7F
        n = int.from_bytes(b[i:i + k], "big")
        i += k
    return i, i + n


def _kids(b, s, e):
    """[(tag, start, value start, value end)] of the elements in b[s:e]."""
    out = []
    while s < e:
        vs, ve = _tlv(b, s)
        out.append((b[s], s, vs, ve))
        s = ve
    return out


def _cert(der, host=None):
    """One certificate (a memoryview) -> (tbs view, (ECDSA?, hash bits), signature, issuer, subject, key kind, key).
    host: the leaf, whose
    SAN must name host; None: a CA, which must say so (basicConstraints cA, keyUsage keyCertSign). Either way, if it
    lists what it's for (extendedKeyUsage), websites must be one."""
    s, e = _tlv(der, 0)
    tbs, alg, sig = _kids(der, s, e)
    t = _kids(der, tbs[2], tbs[3])
    k = 1 if t[0][0] == 0xA0 else 0            # [0] version
    issuer, subject, spki = t[k + 2], t[k + 4], t[k + 5]
    salg, bits = _kids(der, spki[2], spki[3])
    a = _kids(der, salg[2], salg[3])
    kind = RSA if bytes(der[a[0][2]:a[0][3]]) == _RSAKEY else _CURVES.get(bytes(der[a[1][2]:a[1][3]])) if len(a) > 1 else None
    ca, named, web, ku = False, False, True, None
    for x in t[k + 6:]:
        if x[0] != 0xA3:                          # [3] extensions
            continue
        seq = _kids(der, x[2], x[3])[0]
        for ext in _kids(der, seq[2], seq[3]):
            f = _kids(der, ext[2], ext[3])
            oid, v = bytes(der[f[0][2]:f[0][3]]), f[-1]       # v: the OCTET STRING around the value
            inner = _kids(der, v[2], v[3])[0]
            if oid == _SAN and host is not None:
                for n in _kids(der, inner[2], inner[3]):
                    if n[0] == 0x82 and _host_ok(host, der[n[2]:n[3]]):
                        named = True
            elif oid == _BC:
                f = _kids(der, inner[2], inner[3])
                ca = bool(f) and f[0][0] == 0x01 and der[f[0][2]] != 0
            elif oid == _KU:
                ku = der[inner[2] + 1] if inner[3] - inner[2] > 1 else 0
            elif oid == _EKU:
                web = False
                for o in _kids(der, inner[2], inner[3]):
                    if bytes(der[o[2]:o[3]]) in (_SERVER_AUTH, _ANY_EKU):
                        web = True
    if not web:
        raise Error("a certificate that isn't for websites")
    if host is not None:
        if not named:
            raise Error("certificate isn't for " + host)
        if ku is not None and not ku & 0x80:
            raise Error("certificate can't sign")
    elif not ca or (ku is not None and not ku & 0x04):
        raise Error("a certificate in the chain isn't a CA")
    a = _kids(der, alg[2], alg[3])
    how = _SIGALGS.get(bytes(der[a[0][2]:a[0][3]]))   # None: one we can't check (fine past the root: never checked)
    sig = bytes(der[sig[2] + 1:sig[3]])             # BIT STRING: skip the unused-bits byte
    return (der[tbs[1]:tbs[3]], how, sig, bytes(der[issuer[1]:issuer[3]]), bytes(der[subject[1]:subject[3]]),
            kind, bytes(der[bits[2] + 1:bits[3]]))


def _host_ok(host, name):
    h, n = host.encode(), bytes(name).lower()
    return n == h or (n.startswith(b"*.") and h.count(b".") == n.count(b".") and h.split(b".", 1)[1] == n[2:])


# ---- the crypto a wedgie has: the Trust M (trustm.py, the firmware's own; optiga.py costs 11 KB more) ----
def _t(tag, v):
    return bytes([tag]) + len(v).to_bytes(2, "big") + v


def _bits(pub):
    return b"\x03" + bytes([len(pub) + 1]) + b"\x00" + pub


def _int(v):
    b = v.to_bytes(48, "big").lstrip(b"\x00") or b"\x00"
    return b"\x02" + bytes([len(b) + (b[0] >> 7)]) + b"\x00" * (b[0] >> 7) + b


class Chip:
    def __init__(self):
        import trustm
        if trustm.i2c is None:
            trustm.bus()
        self.s = trustm.Session()

    def random(self, n):
        return self.s.random(n)

    def keyshare(self):
        """A P-256 key pair in session context 0xE100 (key agreement); its public key."""
        r = self.s.command(0x38, P256, b"\x01\x00\x02\xe1\x00\x02\x00\x01\x20")
        return bytes(r[6:71])                   # 02 len(2) | 03 42 00 | 04 X Y

    def shared(self, peer):
        return self.s.command(0x33, 0x01, b"\x01\x00\x02\xe1\x00" + _t(5, b"\x03") + _t(6, _bits(bytes(peer))) + _t(7, b""))

    def verify(self, curve, digest, r, s, pub):
        try:
            self.s.command(0x32, 0x11, _t(1, digest) + _t(2, _int(r) + _int(s)) + _t(5, bytes([curve])) + _t(6, _bits(pub)))
            return True
        except OSError:
            if self.s.get(0xF1C2, 0, 1) == b"\x2c":     # the chip's last error: the signature doesn't verify
                return False
            raise


# ---- the connection ----
def _sure(f, *a):
    """f(*a), where anything that goes wrong (garbled bytes: a bad key, a short message) is an Error."""
    try:
        return f(*a)
    except (Error, MemoryError):
        raise
    except Exception as e:
        raise Error("garbled (%s)" % (type(e).__name__,))


class Conn:
    def __init__(self, host, send, recv, chip=None, log=None):
        self.host, self.send, self.recv = host, send, recv
        self.chip = chip or Chip()
        self.log = log or (lambda *a: None)
        self.rb = bytearray(4096)
        self.pend, self.pi = b"", 0
        self.rd = self.wr = None
        self.checks = []                    # signatures to check (_checks) before reading the answer
        _sure(self._handshake)

    def _read(self, mv):
        """Fill mv (a memoryview) from the computer."""
        n, got = len(mv), 0
        while got < n:
            if self.pi >= len(self.pend):
                self.pend, self.pi = self.recv(), 0
                if not self.pend:
                    raise Error("closed")
            k = min(n - got, len(self.pend) - self.pi)
            mv[got:got + k] = memoryview(self.pend)[self.pi:self.pi + k]
            got += k
            self.pi += k
        return mv

    def _record(self):
        """(content type, a memoryview of its plaintext)."""
        hdr = bytes(self._read(memoryview(bytearray(5))))
        n = int.from_bytes(hdr[3:5], "big")
        if n > 16640:
            raise Error("record too big")
        if n > len(self.rb):                  # one buffer for every record, made first (a fragmented heap
            self.rb = None                    # has no 3 KB in one piece later)
            self.rb = bytearray(n)
        body = self._read(memoryview(self.rb)[:n])
        typ = hdr[0]
        if typ == 20:                     # change_cipher_spec: ignored (RFC 8446 D.4)
            return self._record()
        if typ == 21:
            raise Error("alert %d" % body[1])
        if self.rd is None:
            return typ, body
        if typ != 23 or n < 17:
            raise Error("plain record after the handshake")
        self.rd.open(hdr, body)
        i = n - 17
        while i >= 0 and body[i] == 0:
            i -= 1
        if i < 0:
            raise Error("no content type")
        typ = body[i]
        if typ == 21:
            if body[1] == 0:
                return 21, memoryview(b"")    # close_notify
            raise Error("alert %d" % body[1])
        return typ, body[:i]

    def _write(self, typ, data):
        if self.wr is None:
            self.send(bytes([typ, 3, 1]) + len(data).to_bytes(2, "big") + data)
            return
        hdr = b"\x17\x03\x03" + (len(data) + 17).to_bytes(2, "big")
        self.send(hdr + self.wr.seal(hdr, data + bytes([typ])))

    def _messages(self):
        """Handshake messages, one at a time: (type, a memoryview of the whole message). A view into the record:
        done with it before asking for the next one."""
        carry = None
        while True:
            typ, mv = self._record()
            if typ != 22:
                raise Error("expected a handshake record, got %d" % typ)
            if carry is not None:         # a message across records (rare): joined
                carry += mv
                mv, carry = memoryview(carry), None
            i = 0
            while i < len(mv):
                left = len(mv) - i
                if left < 4 or left < 4 + int.from_bytes(mv[i + 1:i + 4], "big"):
                    carry = bytearray(mv[i:])
                    break
                n = 4 + int.from_bytes(mv[i + 1:i + 4], "big")
                yield mv[i], mv[i:i + n]
                i += n

    def _handshake(self):
        c = self.chip
        pub = c.keyshare()
        host = self.host.encode()
        ext = lambda t, d: t.to_bytes(2, "big") + len(d).to_bytes(2, "big") + d
        exts = (ext(0, (len(host) + 3).to_bytes(2, "big") + b"\x00" + len(host).to_bytes(2, "big") + host)  # server_name
                + ext(10, b"\x00\x02\x00\x17")                                              # groups: P-256
                + ext(13, b"\x00\x0e\x04\x03\x05\x03\x08\x04\x08\x05\x04\x01\x05\x01\x06\x01")   # ECDSA, RSA-PSS, RSA (certs)
                + ext(43, b"\x02\x03\x04")                                                  # TLS 1.3
                + ext(51, (len(pub) + 4).to_bytes(2, "big") + b"\x00\x17" + len(pub).to_bytes(2, "big") + pub))
        body = b"\x03\x03" + c.random(32) + b"\x20" + c.random(32) + b"\x00\x02\x13\x01\x01\x00" + len(exts).to_bytes(2, "big") + exts
        hello = b"\x01" + len(body).to_bytes(3, "big") + body
        self._write(22, hello)
        # the transcript hash at 4 points, no copies of it (a Pico's sha256 can't be copied): 4 running hashes,
        # one finished at each point
        hs = [hashlib.sha256(hello) for _ in range(4)]

        def tr(m):
            for h in hs:
                h.update(m)
        msgs = self._messages()

        typ, sh = next(msgs)
        if typ != 2:
            raise Error("no ServerHello")
        if bytes(sh[6:38]) == b"\xcf\x21\xad\x74\xe5\x9a\x61\x11\xbe\x1d\x8c\x02\x1e\x65\xb8\x91\xc2\xa2\x11\x16\x7a\xbb\x8c\x5e\x07\x9e\x09\xe2\xc8\xa8\x33\x9c":
            raise Error("server asked to retry (HelloRetryRequest)")
        i = 38 + 1 + sh[38]
        if bytes(sh[i:i + 2]) != b"\x13\x01":
            raise Error("cipher %s" % bytes(sh[i:i + 2]).hex())
        i += 3
        end, i = i + 2 + int.from_bytes(sh[i:i + 2], "big"), i + 2
        peer, v13 = None, False
        while i < end:
            t, n = int.from_bytes(sh[i:i + 2], "big"), int.from_bytes(sh[i + 2:i + 4], "big")
            if t == 51 and bytes(sh[i + 4:i + 8]) == b"\x00\x17\x00\x41" and n == 69 and sh[i + 8] == 4:
                peer = sh[i + 8:i + 73]
            elif t == 43 and bytes(sh[i + 4:i + 4 + n]) == b"\x03\x04":
                v13 = True
            i += 4 + n
        if not v13:
            raise Error("not TLS 1.3")
        if not peer:
            raise Error("no P-256 key share")
        dhs = c.shared(peer)
        tr(sh)
        del sh, peer
        z = bytes(32)
        empty = sha256(b"")
        hsec = hmac256(_label(hmac256(z, z), b"derived", empty, 32), dhs)
        th = hs.pop(0).digest()
        cs, ss = _label(hsec, b"c hs traffic", th, 32), _label(hsec, b"s hs traffic", th, 32)
        self.rd = _Gcm(_label(ss, b"key", b"", 16), _label(ss, b"iv", b"", 12))
        self.log("keys")

        leaf = None
        while True:
            typ, m = next(msgs)
            if typ == 8:                                      # EncryptedExtensions
                tr(m)
            elif typ == 11:                                   # Certificate
                leaf = self._chain(m)
                tr(m)
                th = hs.pop(0).digest()
            elif typ == 15:                                   # CertificateVerify
                if leaf is None:
                    raise Error("no certificate")
                # ECDSA P-256/SHA-256 or P-384/SHA-384 by an EC key, RSA-PSS SHA-256/384 by an RSA key; nothing else
                how = {0x0403: (True, 256), 0x0503: (True, 384), 0x0804: (False, 256), 0x0805: (False, 384)}.get(int.from_bytes(m[4:6], "big"))
                if how is None or how[0] != (leaf[0] != RSA):
                    raise Error("the site's signature is wrong")
                content = b" " * 64 + b"TLS 1.3, server CertificateVerify\x00" + th
                self.checks.append((how, digest(how[1], content), True, bytes(m[8:]), leaf, "signed", "the site's signature is wrong"))
                tr(m)
                th = hs.pop(0).digest()
            elif typ == 20:                                   # Finished
                if leaf is None or hmac256(_label(ss, b"finished", b"", 32), th) != bytes(m[4:]):
                    raise Error("bad Finished")
                tr(m)
                break
            else:
                raise Error("handshake message %d" % typ)
        th = hs.pop(0).digest()
        ms = hmac256(_label(hsec, b"derived", empty, 32), z)
        cap, sap = _label(ms, b"c ap traffic", th, 32), _label(ms, b"s ap traffic", th, 32)
        self.wr = _Gcm(_label(cs, b"key", b"", 16), _label(cs, b"iv", b"", 12))
        self._write(22, b"\x14\x00\x00\x20" + hmac256(_label(cs, b"finished", b"", 32), th))
        self.wr = _Gcm(_label(cap, b"key", b"", 16), _label(cap, b"iv", b"", 12))
        self.rd = _Gcm(_label(sap, b"key", b"", 16), _label(sap, b"iv", b"", 12))
        self.log("open")

    def _chain(self, m):
        """(curve, key) of the leaf, once it names this host and the chain from it to a root checks out. One
        certificate at a time: each is checked with the next one's key (or a root's)."""
        i = 4 + 1 + m[4]                    # the context
        end, i = i + 3 + int.from_bytes(m[i:i + 3], "big"), i + 3
        leaf, prev, k = None, None, 0
        while i < end:
            n = int.from_bytes(m[i:i + 3], "big")
            tbs, how, sig, issuer, subject, kind, key = _cert(m[i + 3:i + 3 + n], self.host if leaf is None else None)
            i += 3 + n
            i += 2 + int.from_bytes(m[i:i + 2], "big")     # its extensions
            if leaf is None:
                leaf = (kind, key)
            if prev is not None:            # the one before, signed by this one
                if prev[0] != subject:
                    raise Error("broken chain")
                self._later(prev[1:], (kind, key), "cert %d" % (k - 1))
                prev = None
            got = root(issuer)
            if got:
                self._later((how, sig, tbs), got, "cert %d" % k)
                return leaf
            if how and how[1] == 256:       # SHA-256 now (hashlib); SHA-384/512 (Python, ~1 s) in _checks
                prev = (issuer, how, sig, sha256(tbs), True)
            else:
                prev = (issuer, how, sig, bytes(tbs), False)
            k += 1
        raise Error("no known root")

    def _later(self, signed, key, what):
        how, sig, data = signed[:3]
        done = signed[3] if len(signed) > 3 else False
        if how is None or key[0] is None:
            raise Error("a certificate signature a wedgie can't check")
        if how[1] == 256 and not done:
            data, done = sha256(data), True
        elif not done:
            data = bytes(data)
        self.checks.append((how, data, done, sig, key, what, "certificate signature is wrong"))

    def _checks(self):
        """The signatures (ECDSA on the Trust M ~0.2 s, RSA 0.1-0.5 s, SHA-384 ~1 s): run while the site's answer is
        on its way. Nothing the site sent is read before they all pass."""
        while self.checks:
            how, d, done, sig, key, what, why = self.checks.pop(0)
            ecdsa, bits = how
            if not done:
                d = digest(bits, d)
            kind, pub = key
            if ecdsa:
                ok = kind in (P256, P384) and self._ecdsa(kind, d, sig, pub)
            else:
                ok = kind == RSA and (rsa_pss if what == "signed" else rsa_pkcs1)(pub, sig, bits, d)
            if not ok:
                raise Error(why)
            self.log(what)

    def _ecdsa(self, kind, d, sig, pub):
        a = _kids(sig, *_tlv(sig, 0))
        return self.chip.verify(kind, d, int.from_bytes(sig[a[0][2]:a[0][3]], "big"), int.from_bytes(sig[a[1][2]:a[1][3]], "big"), pub)

    def get(self, path, headers=b"", most=8192, body=None):
        return _sure(self._get, path, headers, most, body)

    def _get(self, path, headers, most, body):
        """GET path over this connection (POST `body`, JSON bytes, if given); the answer's body (bytes, up to
        `most`). Closes it. Only a whole answer: its Content-Length, its last chunk, or the site's close_notify;
        cut short by the computer, it's an Error."""
        # The request goes before the signatures are checked: sites hang up ~10 s after connecting without one, and a
        # virtual wedgie at half speed took longer than that. The cost: a fake site would see the path asked for.
        # It can't change the answer: nothing is read until every check passes.
        if body is not None:
            headers += b"Content-Type: application/json\r\nContent-Length: %d\r\n" % len(body)    # small: once, ~50 bytes
        self._write(23, (b"POST " if body is not None else b"GET ") + path.encode() + b" HTTP/1.1\r\nHost: " + self.host.encode()
                    + b"\r\nConnection: close\r\nAccept-Encoding: identity\r\nUser-Agent: wedgie\r\n" + headers + b"\r\n"
                    + (body or b""))
        self.log("asked")
        self._checks()
        out, hl, cl, chunked, closed = bytearray(), -1, None, False, False
        while True:
            try:
                typ, data = self._record()
            except Error as e:
                if str(e) == "closed":
                    break
                raise
            if typ == 21:                     # close_notify
                closed = True
                break
            if typ != 23:
                continue                      # 22: NewSessionTicket and the like
            if len(out) + len(data) > most + 2048:
                raise Error("answer too big")
            out += data
            if hl < 0:
                hl = out.find(b"\r\n\r\n")
                if hl >= 0:
                    for line in bytes(out[:hl]).lower().split(b"\r\n")[1:]:
                        if line.startswith(b"content-length:"):
                            cl = int(line[15:])
                        elif line.startswith(b"transfer-encoding:"):
                            chunked = b"chunked" in line
            if hl >= 0 and cl is not None and not chunked and len(out) - hl - 4 >= cl:
                break
            if hl >= 0 and chunked and out.endswith(b"\r\n0\r\n\r\n"):
                break
        if hl < 0:
            raise Error("no answer")
        self.log("answer")
        self.status = int(bytes(out[:hl]).split(b" ", 2)[1])
        body = memoryview(out)[hl + 4:]
        if chunked:
            got, j = bytearray(), 0
            while True:
                e = bytes(body[j:j + 12]).find(b"\r\n")
                if e < 0:
                    raise Error("cut short")
                n = int(bytes(body[j:j + e]).split(b";")[0], 16)
                if not n:
                    return bytes(got)
                if j + e + 4 + n > len(body):
                    raise Error("cut short")
                got += body[j + e + 2:j + e + 2 + n]
                j += e + 4 + n
        if cl is not None:
            if len(body) != cl:
                raise Error("cut short")
        elif not closed:
            raise Error("cut short")
        return bytes(body)
