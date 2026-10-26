# tls.py against a site we control (Python's ssl, TLS 1.3) and a computer in the middle that attacks it. The rule
# under test: tls.py returns the site's exact answer or raises tls.Error. Never anything else, never a changed answer.
#   python3 test_tls.py            (needs `cryptography`)
#   python3 test_tls.py --live     also real sites
import os, sys, ssl, socket, threading, tempfile, random, hashlib, datetime, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tls
from soft import Soft
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

TMP = tempfile.mkdtemp()
HOST = "api.wedgie.test"
fails = 0


def check(ok, what):
    global fails
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        fails += 1


# ---- certificates ----
def name(cn):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def cert(subject, key, issuer=None, ikey=None, ca=False, san=None, ku=None, eku=None, h=None):
    now = datetime.datetime.now(datetime.timezone.utc)
    b = (x509.CertificateBuilder().subject_name(name(subject)).issuer_name(name(issuer or subject))
         .public_key(key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=30)))
    if ca is not None:
        b = b.add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
    if san:
        b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in san]), critical=False)
    if ku is not None:
        b = b.add_extension(x509.KeyUsage(digital_signature="sig" in ku, key_cert_sign="cert" in ku, crl_sign="cert" in ku,
                                          content_commitment=False, key_encipherment=False, data_encipherment=False,
                                          key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
    if eku:
        b = b.add_extension(x509.ExtendedKeyUsage(eku), critical=False)
    return b.sign(ikey or key, h or (hashes.SHA384() if isinstance(ikey or key, ec.EllipticCurvePrivateKey) and (ikey or key).curve.name == "secp384r1" else hashes.SHA256()))


def p256():
    return ec.generate_private_key(ec.SECP256R1())


def p384():
    return ec.generate_private_key(ec.SECP384R1())


def roots(*certs):
    """A roots.bin with these roots (tls.py's format)."""
    p = os.path.join(TMP, "roots-%d.bin" % random.getrandbits(32))
    out = b""
    for c in certs:
        k = c.public_key()
        out += hashlib.sha256(c.subject.public_bytes()).digest()[:12] + bytes([3 if k.curve.name == "secp256r1" else 4])
        out += k.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    open(p, "wb").write(out)
    return p


rootk = p384()
root = cert("Test Root P-384", rootk, ca=True, ku="cert")
interk = p256()
inter = cert("Test CA", interk, "Test Root P-384", rootk, ca=True, ku="cert")
root256k = p256()
root256 = cert("Test Root P-256", root256k, ca=True, ku="cert")
ROOTS = roots(root, root256)
tls.ROOTS = ROOTS


def leaf(san=(HOST,), key=None, issuer="Test CA", ikey=None, **kw):
    kw.setdefault("ku", "sig")
    kw.setdefault("eku", [ExtendedKeyUsageOID.SERVER_AUTH])
    key = key or p256()
    return key, cert("leaf", key, issuer, ikey or interk, ca=False, san=list(san), **kw)


# ---- the site ----
class Site:
    """A TLS 1.3 server on 127.0.0.1 with this key and chain. answer: what it sends for a GET."""

    def __init__(self, key, chain, answer=b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello", tls12=False, close=True):
        self.answer, self.close = answer, close
        cf, kf = os.path.join(TMP, "c%d.pem" % id(self)), os.path.join(TMP, "k%d.pem" % id(self))
        open(cf, "wb").write(b"".join(c.public_bytes(serialization.Encoding.PEM) for c in chain))
        open(kf, "wb").write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ctx.load_cert_chain(cf, kf)
        if tls12:
            self.ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        else:
            self.ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(20)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            c, _ = self.sock.accept()
            threading.Thread(target=self._one, args=(c,), daemon=True).start()

    def _one(self, c):
        try:
            c.settimeout(5)
            s = self.ctx.wrap_socket(c, server_side=True)
            req = b""
            while b"\r\n\r\n" not in req:
                d = s.recv(4096)
                if not d:
                    return
                req += d
            s.sendall(self.answer)
            if self.close:
                s.unwrap()                      # close_notify
            c.close()
        except Exception:
            c.close()


# ---- the computer in the middle ----
class Pipe:
    """Carries bytes between tls.py and the site, and attacks them. down/up: f(stream offset, bytes) -> bytes, for
    what the site sends / what the wedgie sends. records: f(list of whole records from the site) -> list."""

    def __init__(self, port, down=None, up=None, records=None):
        self.s = socket.create_connection(("127.0.0.1", port))
        self.s.settimeout(5)
        self.down, self.up, self.records = down, up, records
        self.din = self.uin = 0
        self.raw = b""
        self.q = []

    def send(self, b):
        b = bytes(b)
        if self.up:
            b = self.up(self.uin, b)
        self.uin += len(b)
        self.s.sendall(b)

    def recv(self):
        if self.records:
            return self._recv_records()
        try:
            b = self.s.recv(700)
        except socket.timeout:
            return b""
        if self.down and b:
            b = self.down(self.din, b)
        self.din += len(b)
        return b

    def _recv_records(self):
        while not self.q:
            try:
                d = self.s.recv(65536)
            except socket.timeout:
                d = b""
            if not d:
                return b""
            self.raw += d
            got = []
            while len(self.raw) >= 5 and len(self.raw) >= 5 + int.from_bytes(self.raw[3:5], "big"):
                n = 5 + int.from_bytes(self.raw[3:5], "big")
                got.append(self.raw[:n])
                self.raw = self.raw[n:]
            if got:
                self.q += self.records(got)
        return self.q.pop(0)


def fetch(site, host=HOST, **pipe):
    """('ok', body) or ('error', why). Anything else tls.py raises is a bug: ('crash', traceback)."""
    p = Pipe(site.port, **pipe)
    try:
        c = tls.Conn(host, p.send, p.recv, chip=Soft())
        return "ok", c.get("/")
    except tls.Error as e:
        return "error", str(e)
    except Exception:
        return "crash", traceback.format_exc(limit=3)
    finally:
        p.s.close()


def must_fail(site, what, **kw):
    r = fetch(site, **kw)
    check(r[0] == "error", "%s -> %s" % (what, r[1] if r[0] != "crash" else "CRASH " + r[1]))


def flip_at(k):
    def f(o, b):
        if o <= k < o + len(b):
            b = bytearray(b)
            b[k - o] ^= 1 << random.randrange(8)
        return bytes(b)
    return f


def cut_at(k):
    def f(o, b):
        return b[:max(0, k - o)]
    return f


# ---- the tests ----
def main():
    k, c = leaf()
    good = Site(k, [c, inter])
    r = fetch(good)
    check(r == ("ok", b"hello"), "good site: %r" % (r,))

    # the chain
    k2 = p256()
    check(fetch(Site(k2, [cert("leaf", k2, "Test Root P-256", root256k, ca=False, san=[HOST], ku="sig")]))[0] == "ok",
          "a leaf straight from a P-256 root")
    evil_rootk = p384()
    evil_root = cert("Test Root P-384", evil_rootk, ca=True, ku="cert")       # same name, other key
    ek = p256()
    evil_inter = cert("Test CA", ek, "Test Root P-384", evil_rootk, ca=True, ku="cert")
    k3 = p256()
    must_fail(Site(k3, [cert("leaf", k3, "Test CA", ek, ca=False, san=[HOST], ku="sig"), evil_inter]),
              "a root with the right name but another key")
    k4, c4 = leaf(issuer="Nobody CA", ikey=p256())
    must_fail(Site(k4, [c4]), "an unknown CA")
    k5 = p256()
    must_fail(Site(k5, [cert("self", k5, ca=False, san=[HOST], ku="sig")]), "a self-signed certificate")
    k6, c6 = leaf(san=("other.wedgie.test",))
    must_fail(Site(k6, [c6, inter]), "a certificate for another site")
    k7, c7 = leaf(san=("*.wedgie.test",))
    check(fetch(Site(k7, [c7, inter]))[0] == "ok", "a wildcard *.wedgie.test for api.wedgie.test")
    must_fail(Site(k7, [c7, inter]), "*.wedgie.test for a.api.wedgie.test", host="a.api.wedgie.test")
    k8, c8 = leaf(san=("*.test",))
    must_fail(Site(k8, [c8, inter]), "a wildcard one level too high (*.test)")
    k9, c9 = leaf(san=("api.wedgie.test.evil.com", "evil.com"))
    must_fail(Site(k9, [c9, inter]), "a certificate naming a longer host")
    # the classic: a real leaf (for the attacker's own site) used as a CA to sign one for ours
    ak, ac = leaf(san=("attacker.wedgie.test",))
    fk = p256()
    fake = cert("leaf", fk, "leaf", ak, ca=False, san=[HOST], ku="sig")
    must_fail(Site(fk, [fake, ac, inter]), "a leaf signed by another site's leaf (not a CA)")
    nk = p256()
    noca = cert("Test CA", nk, "Test Root P-384", rootk, ca=None, ku=None)    # no basicConstraints at all
    k10 = p256()
    must_fail(Site(k10, [cert("leaf", k10, "Test CA", nk, ca=False, san=[HOST], ku="sig"), noca]),
              "an intermediate with no basicConstraints")
    sk = p256()
    nosign = cert("Test CA", sk, "Test Root P-384", rootk, ca=True, ku="sig")  # a CA that may not sign certificates
    k11 = p256()
    must_fail(Site(k11, [cert("leaf", k11, "Test CA", sk, ca=False, san=[HOST], ku="sig"), nosign]),
              "an intermediate without keyCertSign")
    k12, c12 = leaf(eku=[ExtendedKeyUsageOID.EMAIL_PROTECTION])
    must_fail(Site(k12, [c12, inter]), "a leaf for email only")
    k13, c13 = leaf(ku="cert")
    must_fail(Site(k13, [c13, inter]), "a leaf without digitalSignature")
    ck = p256()
    codeca = cert("Test CA", ck, "Test Root P-384", rootk, ca=True, ku="cert", eku=[ExtendedKeyUsageOID.CODE_SIGNING])
    k14 = p256()
    must_fail(Site(k14, [cert("leaf", k14, "Test CA", ck, ca=False, san=[HOST], ku="sig", eku=[ExtendedKeyUsageOID.SERVER_AUTH]), codeca]),
              "an intermediate for code signing only")
    leafpub = c.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)

    class NoCV(Soft):           # the chip says the site's own signature (CertificateVerify) is wrong
        def verify(self, curve, d, r, s, pub):
            return False if bytes(pub) == leafpub else Soft.verify(self, curve, d, r, s, pub)
    p = Pipe(good.port)
    try:
        tls.Conn(HOST, p.send, p.recv, chip=NoCV()).get("/")
        check(False, "a bad CertificateVerify was taken")
    except tls.Error as e:
        check(True, "a bad CertificateVerify -> %s" % e)
    rk = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    must_fail(Site(rk, [cert("leaf", rk, "Test CA", interk, ca=False, san=[HOST], ku="sig"), inter]), "an RSA certificate")
    must_fail(Site(k, [c, inter], tls12=True), "a TLS 1.2 site")
    k16 = p384()
    check(fetch(Site(k16, [cert("leaf", k16, "Test CA", interk, ca=False, san=[HOST], ku="sig"), inter]))[0] == "ok",
          "a P-384 leaf key")

    # the answer
    big = bytes(random.getrandbits(8) for _ in range(6000))
    r = fetch(Site(k, [c, inter], answer=b"HTTP/1.1 200 OK\r\nContent-Length: 6000\r\n\r\n" + big))
    check(r == ("ok", big), "6000 bytes over several records")
    chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"
    check(fetch(Site(k, [c, inter], answer=chunked)) == ("ok", b"hello world"), "a chunked answer")
    check(fetch(Site(k, [c, inter], answer=b"HTTP/1.1 200 OK\r\n\r\nno length")) == ("ok", b"no length"),
          "no length, ended by close_notify")
    must_fail(Site(k, [c, inter], answer=b"HTTP/1.1 200 OK\r\n\r\nno length", close=False), "no length, no close_notify")
    must_fail(Site(k, [c, inter], answer=b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nshort"), "shorter than its Content-Length")
    must_fail(Site(k, [c, inter], answer=chunked[:-5]), "a chunked answer without its last chunk")
    must_fail(Site(k, [c, inter], answer=b"HTTP/1.1 200 OK\r\nContent-Length: 20000\r\n\r\n" + bytes(20000)), "too big")

    # the computer attacks: every answer must be the true one or an Error
    site = Site(k, [c, inter], answer=b"HTTP/1.1 200 OK\r\nContent-Length: 6000\r\n\r\n" + big)
    probe = []
    p = Pipe(site.port, down=lambda o, b: (probe.append(len(b)), b)[1])
    tls.Conn(HOST, p.send, p.recv, chip=Soft()).get("/")
    total = sum(probe)
    res = {"ok": 0, "error": 0, "crash": 0, "changed": 0}
    random.seed(7)
    spots = sorted(set(list(range(0, 200)) + [random.randrange(total) for _ in range(400)]))
    for at in spots:
        r = fetch(site, down=flip_at(at))
        res["changed" if r[0] == "ok" and r[1] != big else r[0]] += 1
        if r[0] == "crash":
            print("     crash at", at, r[1].splitlines()[-1])
    check(res["changed"] == 0 and res["crash"] == 0,
          "one bit flipped from the site, at %d places of %d bytes: %s" % (len(spots), total, res))
    res = {"ok": 0, "error": 0, "crash": 0, "changed": 0}
    for at in range(0, 400, 3):
        r = fetch(site, up=flip_at(at))
        res["changed" if r[0] == "ok" and r[1] != big else r[0]] += 1
    check(res["changed"] == 0 and res["crash"] == 0, "one bit flipped from the wedgie: %s" % res)
    res = {"ok": 0, "error": 0, "crash": 0, "changed": 0}
    cuts = sorted(set([random.randrange(total) for _ in range(200)] + list(range(0, total, 97))))
    for at in cuts:
        r = fetch(site, down=cut_at(at))
        res["changed" if r[0] == "ok" and r[1] != big else r[0]] += 1
        if r[0] == "crash":
            print("     crash at", at, r[1].splitlines()[-1])
    check(res["changed"] == 0 and res["crash"] == 0, "cut off at %d places: %s" % (len(cuts), res))

    def per_record(fn, what):
        res = {"ok": 0, "error": 0, "crash": 0, "changed": 0}
        n = 0
        while n < 12:
            state = {"i": 0}

            def rec(rs, n=n, state=state):
                out = []
                for r in rs:
                    out += fn(state["i"], n, r)
                    state["i"] += 1
                return out
            r = fetch(site, records=rec)
            res["changed" if r[0] == "ok" and r[1] != big else r[0]] += 1
            n += 1
        check(res["changed"] == 0 and res["crash"] == 0, "%s: %s" % (what, res))
    per_record(lambda i, n, r: [] if i == n else [r], "each record dropped in turn")
    per_record(lambda i, n, r: [r, r] if i == n else [r], "each record sent twice")
    swap = {}

    def swapper(i, n, r):
        if i == n:
            swap["r"] = r
            return []
        if i == n + 1 and "r" in swap:
            return [r, swap.pop("r")]
        return [r]
    per_record(swapper, "each pair of records swapped")
    per_record(lambda i, n, r: [r[:5] + bytes(len(r) - 5)] if i == n else [r], "each record's body zeroed")

    if "--live" in sys.argv:
        tls.ROOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roots.bin")
        for host, path in [("api.coinbase.com", "/v2/prices/ETH-USD/spot"), ("api.coingecko.com", "/api/v3/ping"),
                           ("api.github.com", "/zen"), ("www.cloudflare.com", "/cdn-cgi/trace"), ("poidh.xyz", "/robots.txt"),
                           ("api.kraken.com", "/0/public/Time"), ("api.binance.com", "/api/v3/time"),
                           ("hacker-news.firebaseio.com", "/v0/maxitem.json"), ("api.llama.fi", "/v2/chains"),
                           ("blockstream.info", "/api/blocks/tip/height"), ("mempool.space", "/api/blocks/tip/height")]:
            try:
                s = socket.create_connection((host, 443), timeout=10)
                s.settimeout(10)
                cn = tls.Conn(host, s.sendall, lambda: s.recv(4096), chip=Soft())
                b = cn.get(path, most=200000)
                print("ok   live %s%s: %d %r" % (host, path, cn.status, b[:60]))
            except tls.Error as e:
                print("--   live %s%s: %s" % (host, path, e))
            except Exception:
                check(False, "live %s crashed: %s" % (host, traceback.format_exc(limit=2)))

    print("\n%s" % ("all passed" if not fails else "%d FAILED" % fails))
    sys.exit(1 if fails else 0)


main()
