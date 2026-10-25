#!/usr/bin/env python3
"""trustm.Session.verify (0.3.64+: every P-256 check goes to a Trust M first, wedgie.chip_verify): the VerifySign
command it builds is one a real chip takes. A stand-in chip parses it the way the datasheet says (digest, DER r and s,
curve, the key as a BIT STRING), checks it with `cryptography`, and answers ok or error 0x2C, as a real one does.
Covers r and s with the top bit set (DER puts a 0 in front) and short ones.
    uv run --with cryptography python3 tools/test_trustm_verify.py"""
import sys, types, os, hashlib
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware"))
m = types.ModuleType("machine")
class Pin:
    IN = 0; PULL_UP = 1
    def __init__(s, *a, **k): pass
    def value(s, *a): return 1
class I2C:
    def __init__(s, *a, **k): pass
m.Pin = Pin; m.I2C = I2C; sys.modules["machine"] = m
import time
time.sleep_ms = lambda ms: None; time.sleep_us = lambda us: None; time.ticks_ms = lambda: 0; time.ticks_diff = lambda a, b: a - b
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature, decode_dss_signature, Prehashed
from cryptography.hazmat.primitives import hashes
from cryptography.exceptions import InvalidSignature
import trustm as T

chip = {"expect": 0, "out": None, "err": 0, "seen": 0}


def tlvs(b):
    out, i = {}, 0
    while i < len(b):
        n = int.from_bytes(b[i + 1:i + 3], "big")
        out[b[i]] = b[i + 3:i + 3 + n]
        i += 3 + n
    return out


def answer(apdu):
    """(status, data) for one APDU."""
    cmd, d = apdu[0], apdu[4:]
    if cmd == 0x70:
        return 0, b""
    if cmd == 0x01 and d[:2] == b"\xf1\xc2":
        e, chip["err"] = chip["err"], 0
        return 0, bytes([e]) if e else b""
    if cmd == 0x32:
        assert apdu[1] == 0x11, "ECDSA FIPS 186-3 without hash"
        t = tlvs(d)
        assert t[5] == b"\x03", "curve: P-256"
        k = t[6]
        assert k[:4] == b"\x03\x42\x00\x04" and len(k) == 68, "the key: a DER BIT STRING, 04 X Y"
        sig, ints = t[2], []
        while sig:
            assert sig[0] == 0x02
            v = sig[2:2 + sig[1]]
            assert v and (v[0] < 0x80) and not (len(v) > 1 and v[0] == 0 and v[1] < 0x80), "a minimal DER INTEGER: %s" % v.hex()
            ints.append(int.from_bytes(v, "big"))
            sig = sig[2 + sig[1]:]
        chip["seen"] += 1
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), k[3:])
        try:
            pub.verify(encode_dss_signature(*ints), t[1], ec.ECDSA(Prehashed(hashes.SHA256())))
            return 0, b""
        except InvalidSignature:
            chip["err"] = 0x2C
            return 0xFF, b""
    raise AssertionError("unexpected command %02x" % cmd)


def w(d):
    if d[0] == 0x88:
        chip["expect"] = 0; return
    if d[1] & 0x80:
        return
    fr = (d[1] >> 2) & 3
    chip["expect"] = (fr + 1) & 3
    st, data = answer(d[5:-2])
    apdu = bytes([st, 0]) + len(data).to_bytes(2, "big") + data
    body = bytes([(fr << 2) | fr]) + (len(apdu) + 1).to_bytes(2, "big") + b"\x00" + apdu
    chip["out"] = b"\x00" + body + T._crc(body).to_bytes(2, "big")
T._write = w


def rf():
    f, chip["out"] = chip["out"][1:], None
    return f
T.read_frame = rf

c = T.Session()
key = ec.generate_private_key(ec.SECP256R1())
n = key.public_key().public_numbers()
hi = lo = 0
for i in range(200):
    d = hashlib.sha256(b"wedgie %d" % i).digest()
    r, s = decode_dss_signature(key.sign(d, ec.ECDSA(Prehashed(hashes.SHA256()))))
    hi += r >> 255 or s >> 255
    lo += r < 1 << 248 or s < 1 << 248
    assert c.verify(d, r, s, n.x, n.y) is True, i
    assert c.verify(d, r, s + 1, n.x, n.y) is False, i
    assert c.verify(hashlib.sha256(d).digest(), r, s, n.x, n.y) is False, i
assert hi and lo, (hi, lo)
other = ec.generate_private_key(ec.SECP256R1()).public_key().public_numbers()
assert c.verify(d, r, s, other.x, other.y) is False
print("ok trustm.verify: 200 signatures (%d with a top bit set, %d short), tampered ones and another key refused, %d chip checks" % (hi, lo, chip["seen"]))
