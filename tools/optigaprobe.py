#!/usr/bin/env python3
"""firmware/optiga.py on a REAL Trust M: every feature, checked on this computer where it can be (signatures,
ECDH, hashes against Python's own). Only reversible things: random, reads, the user key slots (KEY3, RSA1:
re-keyed), a data object (put back), a counter (put back), session contexts. Never metadata or lifecycle.
The wedgie must be open first (python3 public/wedgie.py unlock, press A). One raw-REPL session: it never
restarts the wedgie. optiga goes on compiled (firmware/optiga.mpy, tools/mpy.py).
    uv run --with pyserial --with cryptography python3 tools/optigaprobe.py [--port /dev/cu.usbmodemXXXX]"""
import argparse, glob, hashlib, os, sys, json, time, binascii
import serial
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature, decode_dss_signature
from cryptography.exceptions import InvalidSignature

ap = argparse.ArgumentParser()
ap.add_argument("--port")
a = ap.parse_args()
port = a.port or (glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*"))[0]
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


class Repl:
    """One raw-REPL session for the whole run: no soft resets (a reset would restart and lock the wedgie),
    and nothing big to compile on it (optiga goes on compiled, in small pieces)."""
    def __init__(self):
        self.s = serial.Serial(port, 115200, timeout=0.2)
        self.buf = b""
        self.s.write(b"\r\x03\x03")
        time.sleep(0.2)
        self.s.reset_input_buffer()
        self.s.write(b"\x01")
        self.until(b"raw REPL; CTRL-B to exit\r\n>", 5)

    def until(self, m, t):
        end = time.time() + t
        while m not in self.buf:
            if time.time() > end:
                raise TimeoutError("no %r: %r" % (m, self.buf[-300:]))
            self.buf += self.s.read(4096)
        i = self.buf.index(m)
        out, self.buf = self.buf[:i], self.buf[i + len(m):]
        return out

    def ex(self, code, t=120):
        self.s.write(code.encode() + b"\x04")
        self.until(b"OK", 5)
        out, err = self.until(b"\x04", t), self.until(b"\x04", 5)
        self.until(b">", 5)
        return out.decode(), err.decode()


R = Repl()


def run(code, t=120):
    """Run code on the wedgie (c = the open Chip); it prints one JSON line starting with @."""
    out, err = R.ex("import json, binascii\nh = binascii.hexlify\n" + code, t)
    lines = [l for l in out.splitlines() if l.startswith("@")]
    if not lines:
        print(out[-600:], err[-600:])
        return None
    return json.loads(lines[-1][1:])


mpy = os.path.join(root, "firmware/optiga.mpy")
d = open(mpy, "rb").read()
R.ex("import binascii, gc, sys\nfor _m in [m for m in sys.modules if m not in ('lcd', 'wedgie', 'micropython', 'gc', 'sys', 'binascii')]:\n    del sys.modules[_m]\ngc.collect()\n_f = open('optiga.tmp', 'wb')")
for k in range(0, len(d), 384):
    R.ex("_f.write(binascii.a2b_base64(%r))" % binascii.b2a_base64(d[k:k + 384]).decode().strip())
R.ex("_f.close()\nimport os\nfor _n in ('optiga.mpy', 'optiga.py'):\n    try:\n        os.remove(_n)\n    except OSError:\n        pass\nos.rename('optiga.tmp', 'optiga.mpy')\nimport optiga\nc = optiga.Chip()")

i = run("i = c.info(); i['uid'] = h(i['uid']).decode(); t = c.random(32); d = c.random(16, drng=True)\n"
        "print('@' + json.dumps({'info': i, 'trng': len(t), 'drng': len(d), 'differ': t != c.random(32)}))")
check(i and i["trng"] == 32 and i["drng"] == 16 and i["differ"], "random: true and deterministic generators (%s)" % (i and i["info"]))

r = run("cert = c.read(optiga.CERT); ta = c.read(optiga.TRUST1)\n"
        "print('@' + json.dumps({'cert': h(cert).decode(), 'ta': len(ta), 'part': h(c.read(optiga.CERT, 4, 20)).decode()}))")
cert = bytes.fromhex(r["cert"]) if r else b""
check(r and len(cert) > 300 and cert[0] in (0x30, 0xC0) and bytes.fromhex(r["part"]) == cert[4:24], "read: the factory certificate (%d bytes, past one frame), a slice" % len(cert))

msg = bytes((i * 7 + 3) & 255 for i in range(700))     # made on the wedgie too (no 1.4 KB of hex to compile there)
r = run("import gc\nm = bytes((i * 7 + 3) & 255 for i in range(700))\ngc.collect()\nprint('@' + json.dumps({'one': h(c.sha256(m[:100])).decode(), 'big': h(c.sha256(m)).decode(), "
        "'obj': h(c.sha256_object(optiga.CERT)).decode()}))")
check(r and r["one"] == hashlib.sha256(msg[:100]).hexdigest() and r["big"] == hashlib.sha256(msg).hexdigest(), "sha256 on the chip: short and 700 bytes (in parts)")
check(r and r["obj"] == hashlib.sha256(cert).hexdigest(), "sha256 of an object inside the chip (the certificate)")

dg = hashlib.sha256(b"wedgie").digest()
r = run("pub = c.genkey(optiga.KEY3, optiga.P256, optiga.SIGN | optiga.KEY_AGREE)\nd = binascii.unhexlify(%r)\nr, s = c.sign(optiga.KEY3, d)\n"
        "print('@' + json.dumps({'pub': h(pub).decode(), 'r': r, 's': s, 'ok': c.verify(d, r, s, pub), 'no': c.verify(d, r, s + 1, pub)}))" % dg.hex())
if r:
    pk = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), bytes.fromhex(r["pub"]))
    try:
        pk.verify(encode_dss_signature(r["r"], r["s"]), b"wedgie", ec.ECDSA(hashes.SHA256()))
        ok = True
    except InvalidSignature:
        ok = False
    check(ok, "genkey P-256 into KEY3 + sign: this computer checks the signature")
    check(r["ok"] and not r["no"], "verify on the chip: a good signature yes, a changed one no")
    # the computer signs, the chip checks
    hk = ec.generate_private_key(ec.SECP256R1())
    hs = decode_dss_signature(hk.sign(b"from the computer", ec.ECDSA(hashes.SHA256())))
    hpub = hk.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    r2 = run("print('@' + json.dumps({'ok': c.verify(binascii.unhexlify(%r), %d, %d, binascii.unhexlify(%r))}))"
             % (hashlib.sha256(b"from the computer").hexdigest(), hs[0], hs[1], hpub.hex()))
    check(r2 and r2["ok"], "verify on the chip: a signature this computer made")
    # ECDH: the chip's KEY3 with this computer's key, both sides
    r3 = run("print('@' + json.dumps({'x': h(c.ecdh(optiga.KEY3, binascii.unhexlify(%r))).decode()}))" % hpub.hex())
    mine = hk.exchange(ec.ECDH(), pk)
    check(r3 and bytes.fromhex(r3["x"]) == mine, "ecdh: the chip and this computer get the same secret")
    # the same secret kept in a session, then derived (TLS PRF; HKDF is V3)
    r4 = run("c.ecdh(optiga.KEY3, binascii.unhexlify(%r), store=optiga.SESSION[0])\n"
             "print('@' + json.dumps({'prf': h(c.derive(optiga.SESSION[0], 32, b'label seed', method='prf256')).decode()}))" % hpub.hex())
    check(r4 and len(bytes.fromhex(r4["prf"])) == 32, "derive: TLS PRF from an ECDH secret kept in a session")

for alg, curve, n in (("P384", ec.SECP384R1(), 97), ("P256", ec.SECP256R1(), 65)):
    r = run("pub, priv = c.genkey(None, optiga.%s)\nprint('@' + json.dumps({'pub': h(pub).decode(), 'priv': h(priv).decode()}))" % alg)
    ok = False
    if r:
        k = ec.derive_private_key(int(r["priv"], 16), curve)
        ok = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint).hex() == r["pub"] and len(bytes.fromhex(r["pub"])) == n
    check(ok, "genkey %s exported (nothing kept): the private key matches the public one" % alg)

r = run("pub = c.genkey(optiga.RSA1, optiga.RSA1024, optiga.ENC | optiga.SIGN)\nct = c.rsa_encrypt(b'hello rsa', pub, optiga.RSA1024)\n"
        "d = binascii.unhexlify(%r)\nsig = c.sign_rsa(optiga.RSA1, d)\n"
        "print('@' + json.dumps({'pub': h(pub).decode(), 'pt': c.rsa_decrypt(optiga.RSA1, ct).decode(), 'sig': h(sig).decode(), 'v': c.verify_rsa(d, sig, pub, optiga.RSA1024)}))" % dg.hex())
if r:
    rk = serialization.load_der_public_key(bytes.fromhex("30819f300d06092a864886f70d010101050003818d00") + bytes.fromhex(r["pub"]))
    try:
        rk.verify(bytes.fromhex(r["sig"]), b"wedgie", padding.PKCS1v15(), hashes.SHA256())
        ok = True
    except Exception:
        ok = False
    check(r["pt"] == "hello rsa", "RSA-1024: encrypt with its public key, the chip decrypts")
    check(ok and r["v"], "RSA-1024 signature: this computer and the chip both check it")
    ct = rk.encrypt(b"from the computer", padding.PKCS1v15())
    r2 = run("print('@' + json.dumps({'pt': c.rsa_decrypt(optiga.RSA1, binascii.unhexlify(%r)).decode()}))" % ct.hex())
    check(r2 and r2["pt"] == "from the computer", "RSA: this computer encrypts, the chip decrypts")
else:
    check(False, "RSA-1024")

r = run("pub = c.genkey(optiga.RSA1, optiga.RSA2048, optiga.ENC | optiga.SIGN)\nct = c.rsa_encrypt(b'big', pub)\n"
        "print('@' + json.dumps({'n': len(pub), 'pt': c.rsa_decrypt(optiga.RSA1, ct).decode()}))")
check(r and r["pt"] == "big" and r["n"] > 260, "RSA-2048 (answers and commands over one I2C frame: chained)")

r = run("o = optiga.DATA[11]\nold = c.read(o)\nc.write(o, b'wedgie' * 23 + b'we', erase=True)\nback = c.read(o)\nc.write(o, old, erase=True)\n"
        "m = c.metadata(o)\nprint('@' + json.dumps({'back': back.decode(), 'restored': c.read(o) == old, 'meta': {('%02X' % k): h(v).decode() for k, v in m.items()}}))")
check(r and r["back"] == "wedgie" * 23 + "we" and r["restored"], "write + read a full 140-byte data object, then put back")
check(r and "C4" in r["meta"], "metadata parsed (%s)" % (r and r["meta"]))

r = run("o = optiga.COUNTERS[3]\nold = c.read(o)\nc.set_counter(o, 5, 7)\na = c.count(o)\nb = c.count(o)\n"
        "try:\n    c.count(o)\n    over = False\nexcept optiga.Error as e:\n    over = e.code\nc.write(o, old, erase=True)\n"
        "print('@' + json.dumps({'a': a, 'b': b, 'over': over, 'restored': c.read(o) == old}))")
check(r and r["a"] == [6, 7] and r["b"] == [7, 7], "counter counts up (%s)" % r)
check(r and r["over"] == 0x0E and r["restored"], "counter stops at its threshold, then put back")

r = run("import time\nt0 = time.ticks_ms()\nwhile c.info()['security_events'] and time.ticks_diff(time.ticks_ms(), t0) < 150000:\n    time.sleep(2)\nctx = c.hibernate()\nc.open(ctx)\nprint('@' + json.dumps({'ctx': len(ctx), 'r': len(c.random(8))}))")
check(r and r["ctx"] == 8 and r["r"] == 8, "hibernate and pick up again (the 8-byte context), once the security event count is back to 0")

r = run("try:\n    c.read(0xF1D0, 500, 4)\n    e = 0\nexcept optiga.Error as x:\n    e = x.code\nprint('@' + json.dumps({'e': e, 'then': c.last_error()}))")
check(r and r["e"] == 0x08 and r["then"] == 0, "errors: reading past the end says 0x08, and reading the error clears it")

r = run("out = {}\nfor n, f in (('aes', lambda: c.aes_genkey(128, export=True)), ('hmac', lambda: c.hmac(optiga.DATA[0], b'x')), ('bp256', lambda: c.genkey(None, optiga.BP256)), ('hkdf', lambda: c.derive(optiga.SESSION[0], 16)), ('p521', lambda: c.genkey(None, optiga.P521))):\n"
        "    try:\n        f()\n        out[n] = 'yes'\n    except optiga.Error as e:\n        out[n] = '%02x' % e.code\nprint('@' + json.dumps(out))")
print("     V3 features on this chip:", r)

print("all ok" if not bad else "%d FAILED" % bad)
sys.exit(1 if bad else 0)
