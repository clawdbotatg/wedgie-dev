# tls: a wedgie's own TLS 1.3 connection to a site. The computer (and wedgie.dev) only carry the bytes: they
# can block them, never read or change them. Only what a wedgie can check fast: key exchange P-256, the cipher
# AES-128-GCM, certificates ECDSA P-256 or P-384, chained to a root built in here (ROOTS). The heavy math runs
# on the Trust M (ECDH, signature checks); AES on cryptolib; GHASH, HKDF and SHA-384 in Python.
#   c = tls.Conn("api.coinbase.com", send, recv)    # send(bytes); recv() -> bytes (b"" = closed)
#   body = c.get("/v2/prices/ETH-USD/spot")         # the HTTP/1.1 body (bytes); raises tls.Error
# Not checked: a certificate's dates (a wedgie has no clock) and revocation.
import hashlib

try:
    from cryptolib import aes
except ImportError:
    aes = None


class Error(Exception):
    pass


# ---- roots: subject (DER) -> (curve, public key 04 X Y). ECC roots only. tools/tlsroots.py makes this. ----
ROOTS = {}

P256, P384 = 3, 4
_CURVES = {b"\x2a\x86\x48\xce\x3d\x03\x01\x07": P256, b"\x2b\x81\x04\x00\x22": P384}
_ECDSA256 = b"\x2a\x86\x48\xce\x3d\x04\x03\x02"
_ECDSA384 = b"\x2a\x86\x48\xce\x3d\x04\x03\x03"
_SAN = b"\x55\x1d\x11"


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


_K512 = None
_M64 = 0xFFFFFFFFFFFFFFFF


def sha384(msg):
    """SHA-384 in Python (hashlib on a Pico has none): one certificate signature, ~1 KB."""
    global _K512
    if _K512 is None:
        _K512 = [int(x, 16) for x in (
            "428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538 59f111f1b605d019 "
            "923f82a4af194f9b ab1c5ed5da6d8118 d807aa98a3030242 12835b0145706fbe 243185be4ee4b28c 550c7dc3d5ffb4e2 "
            "72be5d74f27b896f 80deb1fe3b1696b1 9bdc06a725c71235 c19bf174cf692694 e49b69c19ef14ad2 efbe4786384f25e3 "
            "0fc19dc68b8cd5b5 240ca1cc77ac9c65 2de92c6f592b0275 4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5 "
            "983e5152ee66dfab a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 c6e00bf33da88fc2 d5a79147930aa725 "
            "06ca6351e003826f 142929670a0e6e70 27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed 53380d139d95b3df "
            "650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b a2bfe8a14cf10364 a81a664bbc423001 "
            "c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218 d69906245565a910 f40e35855771202a 106aa07032bbd1b8 "
            "19a4c116b8d2d0c8 1e376c085141ab53 2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb "
            "5b9cca4f7763e373 682e6ff3d6b2b8a3 748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec "
            "90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 c67178f2e372532b ca273eceea26619c d186b8c721c0c207 "
            "eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6 113f9804bef90dae 1b710b35131c471b "
            "28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc 431d67c49c100d4c 4cc5d4becb3e42b6 597f299cfc657e2a "
            "5fcb6fab3ad6faec 6c44198c4a475817").split()]
    h = [0xcbbb9d5dc1059ed8, 0x629a292a367cd507, 0x9159015a3070dd17, 0x152fecd8f70e5939,
         0x67332667ffc00b31, 0x8eb44a8768581511, 0xdb0c2e0d64f98fa7, 0x47b5481dbefa4fa4]
    n = len(msg)
    msg = msg + b"\x80" + bytes((111 - n) % 128) + (n * 8).to_bytes(16, "big")
    K = _K512
    r = lambda x, k: ((x >> k) | (x << (64 - k))) & _M64
    for o in range(0, len(msg), 128):
        w = [int.from_bytes(msg[o + 8 * i:o + 8 * i + 8], "big") for i in range(16)]
        for i in range(16, 80):
            a, b = w[i - 15], w[i - 2]
            w.append((w[i - 16] + (r(a, 1) ^ r(a, 8) ^ (a >> 7)) + w[i - 7] + (r(b, 19) ^ r(b, 61) ^ (b >> 6))) & _M64)
        a, b, c, d, e, f, g, hh = h
        for i in range(80):
            t1 = (hh + (r(e, 14) ^ r(e, 18) ^ r(e, 41)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) & _M64
            t2 = ((r(a, 28) ^ r(a, 34) ^ r(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & _M64
            hh, g, f, e, d, c, b, a = g, f, e, (d + t1) & _M64, c, b, a, (t1 + t2) & _M64
        h = [(x + y) & _M64 for x, y in zip(h, (a, b, c, d, e, f, g, hh))]
    return b"".join(x.to_bytes(8, "big") for x in h[:6])


# ---- the key schedule (RFC 8446 7.1) ----
def _extract(salt, ikm):
    return hmac256(salt, ikm)


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
        H = int.from_bytes(hk, "big")
        global _RED
        if _RED is None:
            _RED = [_x4(i) for i in range(16)]
        t = [0] * 16            # t[n]: the nibble n (as x^0..x^3) times H
        v = H
        for bit in (8, 4, 2, 1):
            t[bit] = v
            v = (v >> 1) ^ _R if v & 1 else v >> 1
        for n in range(16):
            if n & (n - 1):
                t[n] = t[n & -n] ^ t[n & (n - 1)]
        self.t = t

    def _mul(self, x):
        z, t, red = 0, self.t, _RED
        for j in range(32):                 # Horner: the low nibble (x^124..x^127) first
            z = (z >> 4) ^ red[z & 15] ^ t[x & 15]
            x >>= 4
        return z

    def _ghash(self, aad, ct):
        y = 0
        for d in (aad, ct):
            for o in range(0, len(d), 16):
                blk = d[o:o + 16]
                y = self._mul(y ^ int.from_bytes(blk + bytes(16 - len(blk)), "big"))
        return self._mul(y ^ ((len(aad) * 8) << 64 | len(ct) * 8))

    def _ctr(self, nonce, data, out):
        blk, ks = bytearray(16), bytearray(16)
        blk[:12] = nonce
        for i, o in enumerate(range(0, len(data), 16)):
            blk[12:] = (i + 2).to_bytes(4, "big")
            self.e(blk, ks)
            for k in range(min(16, len(data) - o)):
                out[o + k] = data[o + k] ^ ks[k]

    def _nonce(self):
        n = bytearray(self.iv)
        s = self.n.to_bytes(8, "big")
        for i in range(8):
            n[4 + i] ^= s[i]
        self.n += 1
        return bytes(n)

    def _tag(self, nonce, aad, ct):
        j0 = bytearray(nonce + b"\x00\x00\x00\x01")
        ek = bytearray(16)
        self.e(j0, ek)
        return (self._ghash(aad, ct) ^ int.from_bytes(ek, "big")).to_bytes(16, "big")

    def seal(self, aad, pt):
        nonce = self._nonce()
        ct = bytearray(len(pt))
        self._ctr(nonce, pt, ct)
        return bytes(ct) + self._tag(nonce, aad, ct)

    def open(self, aad, data):
        nonce = self._nonce()
        ct, tag = data[:-16], data[-16:]
        if self._tag(nonce, aad, ct) != tag:
            raise Error("tampered with")
        pt = bytearray(len(ct))
        self._ctr(nonce, ct, pt)
        return pt


class _EcbShim:          # the computer test (CPython): cryptolib's aes(key, 1).encrypt(in, out)
    def __init__(self, key):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        self.c = Cipher(algorithms.AES(key), modes.ECB()).encryptor()

    def __call__(self, i, o):
        o[:] = self.c.update(bytes(i))


# ---- DER ----
def _tlv(b, i):
    """(tag, start of value, end of value) of the DER element at i."""
    tag, n = b[i], b[i + 1]
    i += 2
    if n & 0x80:
        k = n & 0x7F
        n = int.from_bytes(b[i:i + k], "big")
        i += k
    return tag, i, i + n


def _kids(b, s, e):
    out = []
    while s < e:
        t, vs, ve = _tlv(b, s)
        out.append((t, s, vs, ve))
        s = ve
    return out


def _cert(der):
    """{tbs, sigalg, r, s, issuer, subject, curve, pub, names} from one certificate (DER)."""
    _, s, e = _tlv(der, 0)
    tbs, alg, sig = _kids(der, s, e)
    t = _kids(der, tbs[2], tbs[3])
    k = 1 if t[0][0] == 0xA0 else 0            # [0] version
    issuer, subject, spki = t[k + 2], t[k + 4], t[k + 5]
    salg, bits = _kids(der, spki[2], spki[3])
    a = _kids(der, salg[2], salg[3])
    curve = _CURVES.get(bytes(der[a[1][2]:a[1][3]])) if len(a) > 1 else None
    names = []
    for x in t[k + 6:]:
        if x[0] == 0xA3:                      # [3] extensions
            seq = _kids(der, x[2], x[3])[0]
            for ext in _kids(der, seq[2], seq[3]):
                f = _kids(der, ext[2], ext[3])
                if bytes(der[f[0][2]:f[0][3]]) == _SAN:
                    v = f[-1]
                    s2 = _kids(der, v[2], v[3])[0]
                    for n in _kids(der, s2[2], s2[3]):
                        if n[0] == 0x82:
                            names.append(bytes(der[n[2]:n[3]]))
    a = _kids(der, alg[2], alg[3])
    sigalg, r, s = bytes(der[a[0][2]:a[0][3]]), None, None
    if sigalg in (_ECDSA256, _ECDSA384):            # (an RSA one past the root is never checked)
        rs = _kids(der, sig[2] + 1, sig[3])         # BIT STRING: skip the unused-bits byte
        rs = _kids(der, rs[0][2], rs[0][3])
        r, s = int.from_bytes(der[rs[0][2]:rs[0][3]], "big"), int.from_bytes(der[rs[1][2]:rs[1][3]], "big")
    return {
        "tbs": der[tbs[1]:tbs[3]], "sigalg": sigalg, "r": r, "s": s,
        "issuer": bytes(der[issuer[1]:issuer[3]]), "subject": bytes(der[subject[1]:subject[3]]),
        "curve": curve, "pub": bytes(der[bits[2] + 1:bits[3]]), "names": names,
    }


def _host_ok(host, names):
    h = host.encode()
    for n in names:
        n = n.lower()
        if n == h or (n.startswith(b"*.") and h.count(b".") == n.count(b".") and h.split(b".", 1)[1] == n[2:]):
            return True
    return False


# ---- the crypto a wedgie has: the Trust M ----
class Chip:
    def __init__(self):
        import optiga
        self.o, self.c = optiga, optiga.Chip()

    def random(self, n):
        return self.c.random(n)

    def keyshare(self):
        return self.c.genkey(self.o.SESSION[0], self.o.P256, self.o.KEY_AGREE)

    def shared(self, peer):
        return self.c.ecdh(self.o.SESSION[0], peer)

    def verify(self, curve, digest, r, s, pub):
        return self.c.verify(digest, r, s, pub, alg=curve)


# ---- the connection ----
class Conn:
    def __init__(self, host, send, recv, chip=None, log=None):
        self.host, self.send, self.recv = host, send, recv
        self.chip = chip or Chip()
        self.log = log or (lambda *a: None)
        self.buf = bytearray()
        self.rd = self.wr = None
        self._handshake()

    def _need(self, n):
        while len(self.buf) < n:
            b = self.recv()
            if not b:
                raise Error("closed")
            self.buf += b

    def _record(self):
        self._need(5)
        n = int.from_bytes(self.buf[3:5], "big")
        if n > 16640:
            raise Error("record too big")
        self._need(5 + n)
        hdr, body = bytes(self.buf[:5]), bytes(self.buf[5:5 + n])
        self.buf = self.buf[5 + n:]
        typ = hdr[0]
        if typ == 20:                     # change_cipher_spec: ignored (RFC 8446 D.4)
            return self._record()
        if typ == 21:
            raise Error("alert %d" % body[1])
        if self.rd is None:
            return typ, body
        if typ != 23:
            raise Error("plain record after the handshake")
        pt = self.rd.open(hdr, body)
        i = len(pt) - 1
        while i >= 0 and pt[i] == 0:
            i -= 1
        if i < 0:
            raise Error("no content type")
        typ = pt[i]
        if typ == 21:
            if pt[1] == 0:
                return 21, b""            # close_notify
            raise Error("alert %d" % pt[1])
        return typ, bytes(pt[:i])

    def _write(self, typ, data):
        if self.wr is None:
            self.send(bytes([typ, 3, 1]) + len(data).to_bytes(2, "big") + data)
            return
        n = len(data) + 1 + 16
        hdr = b"\x17\x03\x03" + n.to_bytes(2, "big")
        self.send(hdr + self.wr.seal(hdr, data + bytes([typ])))

    def _messages(self):
        """Handshake messages, one at a time: (type, the whole message)."""
        hs = b""
        while True:
            while len(hs) < 4 or len(hs) < 4 + int.from_bytes(hs[1:4], "big"):
                typ, body = self._record()
                if typ != 22:
                    raise Error("expected a handshake record, got %d" % typ)
                hs += body
            n = 4 + int.from_bytes(hs[1:4], "big")
            yield hs[0], hs[:n]
            hs = hs[n:]

    def _handshake(self):
        c = self.chip
        pub = c.keyshare()
        rnd = c.random(32)
        host = self.host.encode()
        ext = lambda t, d: t.to_bytes(2, "big") + len(d).to_bytes(2, "big") + d
        sni = len(host).to_bytes(2, "big")
        exts = (ext(0, (len(host) + 3).to_bytes(2, "big") + b"\x00" + sni + host)          # server_name
                + ext(10, b"\x00\x02\x00\x17")                                              # groups: P-256
                + ext(13, b"\x00\x04\x04\x03\x05\x03")                                      # ECDSA P-256 / P-384
                + ext(43, b"\x02\x03\x04")                                                  # TLS 1.3
                + ext(51, (len(pub) + 4).to_bytes(2, "big") + b"\x00\x17" + len(pub).to_bytes(2, "big") + pub))
        body = b"\x03\x03" + rnd + b"\x20" + c.random(32) + b"\x00\x02\x13\x01\x01\x00" + len(exts).to_bytes(2, "big") + exts
        hello = b"\x01" + len(body).to_bytes(3, "big") + body
        self._write(22, hello)
        tr = hello                       # the transcript (a Pico's sha256 can't be copied)
        msgs = self._messages()

        typ, sh = next(msgs)
        if typ != 2:
            raise Error("no ServerHello")
        if sh[6:38] == bytes.fromhex("cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c"):
            raise Error("server asked to retry (HelloRetryRequest)")
        i = 38 + 1 + sh[38]
        if sh[i:i + 2] != b"\x13\x01":
            raise Error("cipher %s" % sh[i:i + 2].hex())
        i += 3
        end, i = i + 2 + int.from_bytes(sh[i:i + 2], "big"), i + 2
        peer = None
        while i < end:
            t, n = int.from_bytes(sh[i:i + 2], "big"), int.from_bytes(sh[i + 2:i + 4], "big")
            if t == 51:
                peer = sh[i + 8:i + 4 + n]
            i += 4 + n
        if not peer:
            raise Error("no key share")
        tr += sh
        z = bytes(32)
        early = _extract(z, z)
        dhs = c.shared(peer)
        hsec = _extract(_label(early, b"derived", sha256(b""), 32), dhs)
        th = sha256(tr)
        cs, ss = _label(hsec, b"c hs traffic", th, 32), _label(hsec, b"s hs traffic", th, 32)
        self.rd = _Gcm(_label(ss, b"key", b"", 16), _label(ss, b"iv", b"", 12))
        self.log("keys")

        leaf = None
        while True:
            typ, m = next(msgs)
            if typ == 8:                                      # EncryptedExtensions
                pass
            elif typ == 11:                                   # Certificate
                leaf = self._chain(m)
            elif typ == 15:                                   # CertificateVerify
                if leaf is None:
                    raise Error("no certificate")
                scheme, sig = int.from_bytes(m[4:6], "big"), m[8:]
                content = b" " * 64 + b"TLS 1.3, server CertificateVerify\x00" + sha256(tr)
                d = sha256(content) if scheme == 0x0403 else sha384(content) if scheme == 0x0503 else None
                if d is None or not self._ok(leaf["curve"], d, sig, leaf["pub"]):
                    raise Error("the site's signature is wrong")
                self.log("signed")
            elif typ == 20:                                   # Finished
                if hmac256(_label(ss, b"finished", b"", 32), sha256(tr)) != m[4:]:
                    raise Error("bad Finished")
                tr += m
                break
            else:
                raise Error("handshake message %d" % typ)
            tr += m
        if leaf is None:
            raise Error("no certificate")
        th = sha256(tr)
        ms = _extract(_label(hsec, b"derived", sha256(b""), 32), z)
        cap, sap = _label(ms, b"c ap traffic", th, 32), _label(ms, b"s ap traffic", th, 32)
        self.wr = _Gcm(_label(cs, b"key", b"", 16), _label(cs, b"iv", b"", 12))
        self._write(22, b"\x14\x00\x00\x20" + hmac256(_label(cs, b"finished", b"", 32), th))
        self.wr = _Gcm(_label(cap, b"key", b"", 16), _label(cap, b"iv", b"", 12))
        self.rd = _Gcm(_label(sap, b"key", b"", 16), _label(sap, b"iv", b"", 12))
        self.log("open")

    def _ok(self, curve, digest, sig, pub):
        t, s, e = _tlv(sig, 0)
        k = _kids(sig, s, e)
        r, s = int.from_bytes(sig[k[0][2]:k[0][3]], "big"), int.from_bytes(sig[k[1][2]:k[1][3]], "big")
        return self.chip.verify(curve, digest, r, s, pub)

    def _chain(self, m):
        """The leaf certificate, once the chain from it to a root in ROOTS checks out and it names this host."""
        i = 4 + 1 + m[4]                    # the context
        end, i = i + 3 + int.from_bytes(m[i:i + 3], "big"), i + 3
        certs = []
        while i < end:
            n = int.from_bytes(m[i:i + 3], "big")
            certs.append(_cert(m[i + 3:i + 3 + n]))
            i += 3 + n
            i += 2 + int.from_bytes(m[i:i + 2], "big")     # its extensions
        if not certs:
            raise Error("no certificate")
        leaf = certs[0]
        if not _host_ok(self.host, leaf["names"]):
            raise Error("certificate isn't for " + self.host)
        for k, c in enumerate(certs):
            root = ROOTS.get(c["issuer"])
            key = root if root else (certs[k + 1]["curve"], certs[k + 1]["pub"]) if k + 1 < len(certs) else None
            if key is None:
                raise Error("no known root")
            if not root and certs[k + 1]["subject"] != c["issuer"]:
                raise Error("broken chain")
            d = sha256(c["tbs"]) if c["sigalg"] == _ECDSA256 else sha384(c["tbs"]) if c["sigalg"] == _ECDSA384 else None
            if d is None or key[0] is None:
                raise Error("not an ECDSA chain")
            if not self.chip.verify(key[0], d, c["r"], c["s"], key[1]):
                raise Error("certificate signature is wrong")
            self.log("cert %d" % k)
            if root:
                return leaf
        raise Error("no known root")

    def get(self, path, headers=b""):
        """GET path over this connection; the body (bytes). Closes it."""
        self._write(23, b"GET " + path.encode() + b" HTTP/1.1\r\nHost: " + self.host.encode()
                    + b"\r\nConnection: close\r\nAccept-Encoding: identity\r\nUser-Agent: wedgie\r\n" + headers + b"\r\n")
        out = b""
        while True:
            try:
                typ, data = self._record()
            except Error as e:
                if str(e) == "closed":
                    break
                raise
            if typ == 23:
                out += data
            elif typ == 21:
                break
            # 22: NewSessionTicket and the like: ignored
        head, _, body = out.partition(b"\r\n\r\n")
        if b"transfer-encoding: chunked" in head.lower():
            b, body = body, b""
            while b:
                n, _, b = b.partition(b"\r\n")
                n = int(n.split(b";")[0], 16)
                if not n:
                    break
                body += b[:n]
                b = b[n + 2:]
        self.status = int(head.split(b" ", 2)[1])
        return body
