# The OPTIGA Trust M, all of it, for apps: wedgie.dev/trustm.md explains every call with examples.
#
#   import optiga
#   c = optiga.Chip()                       # opens the chip (needs a Trust M on GP4/GP5)
#   c.random(32)                            # 32 true random bytes
#   pub = c.genkey(optiga.KEY2)             # a P-256 key made inside the chip; it never leaves
#   r, s = c.sign(optiga.KEY2, digest)      # ECDSA over a 32-byte digest
#
# Loaded only by an app that imports it (never at boot), and shipped compiled (.mpy). It talks to the chip
# through trustm.py's I2C layer and adds what that one leaves out: frames longer than one I2C frame (a
# 1 KB certificate, an RSA-2048 key) go as a chain both ways. The wire format is Infineon's: the OPTIGA
# Trust M Solution Reference Manual and their host library (github.com/Infineon/optiga-trust-m).
#
# Some calls change the chip FOR GOOD (marked IRREVERSIBLE below): a lifecycle or access-rule write can
# lock a key slot or data object forever. Nothing here does that unless you call it by name.
import trustm as T

# ---- objects (OIDs) --------------------------------------------------------------------------------
LCSG = 0xE0C0           # global lifecycle state
SECSTATUS = 0xE0C1      # global security status
UID = 0xE0C2            # coprocessor UID, 27 bytes
SLEEP_DELAY = 0xE0C3    # ms before it sleeps when idle (20-255)
CURRENT_LIMIT = 0xE0C4  # mA (6-15)
SEC = 0xE0C5            # security event counter
BUFFER = 0xE0C6         # max command size (0x0615)
CERT = 0xE0E0           # the factory certificate (Infineon-signed) for FACTORY_KEY
CERT2, CERT3, CERT4 = 0xE0E1, 0xE0E2, 0xE0E3
TRUST1, TRUST2, TRUST8 = 0xE0E8, 0xE0E9, 0xE0EF
FACTORY_KEY = 0xE0F0    # P-256, made at the factory, can't be changed
KEY2, KEY3, KEY4 = 0xE0F1, 0xE0F2, 0xE0F3       # ECC key slots for you
RSA1, RSA2 = 0xE0FC, 0xE0FD                     # RSA key slots for you
SESSION = (0xE100, 0xE101, 0xE102, 0xE103)      # session contexts: in RAM, gone at a reset
COUNTERS = (0xE120, 0xE121, 0xE122, 0xE123)     # monotonic counters: value(4) threshold(4)
BINDING = 0xE140        # platform binding secret (64 bytes)
AES_KEY = 0xE200        # AES key slot (V3)
LCSA = 0xF1C0           # application lifecycle state
APP_SECSTATUS = 0xF1C1
LAST_ERROR = 0xF1C2
DATA = tuple(range(0xF1D0, 0xF1DC))             # 12 x 140-byte data objects
BIG_DATA = (0xF1E0, 0xF1E1)                     # 2 x 1500-byte data objects

# ---- algorithms --------------------------------------------------------------------------------
P256, P384, P521 = 0x03, 0x04, 0x05
BP256, BP384, BP512 = 0x13, 0x15, 0x16          # Brainpool (V3)
RSA1024, RSA2048 = 0x41, 0x42
AES128, AES192, AES256 = 0x81, 0x82, 0x83       # (V3)
CURVE_BYTES = {P256: 32, P384: 48, P521: 66, BP256: 32, BP384: 48, BP512: 64}

# key usage, OR them together
AUTH, ENC, SIGN, KEY_AGREE = 0x01, 0x02, 0x10, 0x20

# ---- errors (LAST_ERROR) ------------------------------------------------------------------------
ERRORS = {
    0x01: "invalid OID", 0x03: "invalid param", 0x04: "invalid length", 0x05: "invalid parameter in data",
    0x06: "internal error", 0x07: "access conditions not satisfied", 0x08: "past the end of the object",
    0x09: "metadata truncated", 0x0A: "invalid command (not on this chip version)", 0x0B: "out of sequence",
    0x0C: "command not available", 0x0D: "not enough buffer", 0x0E: "counter threshold reached",
    0x0F: "invalid manifest", 0x10: "invalid payload version", 0x11: "invalid metadata",
    0x24: "unsupported extension or identifier", 0x25: "unsupported parameters",
    0x29: "invalid certificate", 0x2A: "unsupported certificate", 0x2C: "signature doesn't verify",
    0x2D: "integrity check failed", 0x2E: "decryption failed", 0x2F: "authorization failed",
}


class Error(OSError):
    """The chip said no. .code is its error code (ERRORS)."""
    def __init__(self, cmd, code):
        self.code = code
        super().__init__("optiga: command %02x: %s (0x%02x)" % (cmd, ERRORS.get(code, "?"), code))


WAIT_MS = 60000         # the longest a command may take: an RSA-2048 key takes the chip seconds
MAX_DATA = 271          # APDU bytes in one I2C frame (277 - frame header 5 - PCTR 1)
READ_STEP = 267         # a read's answer fits one frame: 267 + 4
WRITE_STEP = 263        # a write's command fits one frame: 4 + OID 2 + offset 2 + 263


def _data(ms):
    """One frame from the chip, waiting up to ms for it."""
    return T.reg(0x80, T.wait_response(ms))


def _frame(ms):
    """The next data frame (the chip may first hand back its empty ACK of our last frame: skipped)."""
    while True:
        f = _data(ms)
        if len(f) > 5 or f[1:3] != b"\x00\x00":
            return f


def _tlv(tag, v):
    return bytes([tag]) + len(v).to_bytes(2, "big") + v


def _tlvs(b):
    """{tag: value} from TLVs with 2-byte lengths."""
    out, i = {}, 0
    while i + 3 <= len(b):
        n = int.from_bytes(b[i + 1:i + 3], "big")
        out[b[i]] = b[i + 3:i + 3 + n]
        i += 3 + n
    return out


def _oid(o):
    return o.to_bytes(2, "big")


def _int(b):
    """A DER INTEGER's value bytes -> int."""
    return int.from_bytes(b, "big")


class Chip:
    """One session with the chip. Every call sends one command (or a few, for big data) and waits for it."""

    def __init__(self, sda=4, scl=5):
        T.bus(sda, scl)
        T.soft_reset()
        self.frnr, self.acknr = 0, 3
        self.open()

    # ---- the I2C frames, chained both ways ----
    def _frame(self, pctr, part):
        body = bytes([(self.frnr << 2) | self.acknr]) + (len(part) + 1).to_bytes(2, "big") + bytes([pctr]) + part
        T._write(b"\x80" + body + T._crc(body).to_bytes(2, "big"))
        self.frnr = (self.frnr + 1) & 3

    def _send(self, apdu):
        if len(apdu) <= MAX_DATA:
            return self._frame(0x00, apdu)
        for i in range(0, len(apdu), MAX_DATA):
            last = i + MAX_DATA >= len(apdu)
            self._frame(0x04 if last else (0x01 if i == 0 else 0x02), apdu[i:i + MAX_DATA])
            if not last:                    # one frame at a time: the chip ACKs each before the next
                while True:
                    f = _data(1000)
                    if f[0] & 0x80:         # a control frame: the ACK
                        break

    def _recv(self):
        out = b""
        while True:
            f = _frame(WAIT_MS)
            if T._crc(f[:-2]) != int.from_bytes(f[-2:], "big"):
                raise OSError("optiga: bad frame checksum")
            self.acknr = (f[0] >> 2) & 3
            ack = bytes([0x80 | self.acknr, 0, 0])
            T._write(b"\x80" + ack + T._crc(ack).to_bytes(2, "big"))
            out += f[4:-2]                  # small: a chained answer is at most a few frames, once
            if f[3] & 0x07 in (0x00, 0x04):     # single or last
                return out

    def command(self, cmd, param=0, data=b""):
        """Any APDU: cmd, param, data -> the answer's data. Raises Error with the chip's error code."""
        self._send(bytes([cmd, param]) + len(data).to_bytes(2, "big") + data)
        r = self._recv()
        if r[0] != 0:
            raise Error(cmd, self.last_error())
        return r[4:4 + int.from_bytes(r[2:4], "big")]

    def last_error(self):
        """The chip's last error code (reading it clears it). 0: none."""
        self._send(b"\x01\x00\x00\x06" + _oid(LAST_ERROR) + b"\x00\x00\x00\x01")
        r = self._recv()
        return r[4] if r[0] == 0 and len(r) > 4 else 0

    # ---- application ----
    def open(self, context=None):
        """OpenApplication. context: the 8 bytes hibernate() returned, to pick up where it left off."""
        self.command(0x70, 0x01 if context else 0x00, bytes.fromhex("D276000004" "47656E417574684170706C") + (context or b""))

    def close(self):
        """CloseApplication: the chip forgets this session (sessions E100-E103 too)."""
        self.command(0x71, 0x00)

    def hibernate(self):
        """Save the session in the chip and close it: 8 bytes, for open(context) later (even after power
        off). Only when the security event counter (info()['security_events']) is 0: right after a key was
        used it isn't, and this raises error 0x0B; it drops by 1 about every 5 s."""
        return self.command(0x71, 0x01)

    # ---- data objects ----
    def read(self, oid, offset=0, n=None):
        """An object's data (all of it, or n bytes from offset)."""
        out = b""
        while n is None or len(out) < n:
            want = READ_STEP if n is None else min(READ_STEP, n - len(out))
            try:
                part = self.command(0x01, 0x00, _oid(oid) + (offset + len(out)).to_bytes(2, "big") + want.to_bytes(2, "big"))
            except Error as e:
                if e.code == 0x08 and out:  # past the end: that was all of it
                    return out
                raise
            out += part                     # small: an object is at most 1.7 KB, read once
            if len(part) < want:
                break
        return out

    def write(self, oid, data, offset=0, erase=False):
        """Write data into an object at offset. erase: empty the whole object first."""
        for i in range(0, max(1, len(data)), WRITE_STEP):
            self.command(0x02, 0x40 if erase and i == 0 else 0x00, _oid(oid) + (offset + i).to_bytes(2, "big") + data[i:i + WRITE_STEP])

    def metadata(self, oid):
        """An object's metadata as {tag: bytes} (tags in trustm.md: C0 lifecycle, C4 max size, C5 used size,
        D0 change rule, D1 read rule, D3 use rule, E0 algorithm, E1 key usage, E8 type...)."""
        m = self.command(0x01, 0x01, _oid(oid))
        out, i = {}, 2
        while i + 2 <= len(m):
            out[m[i]] = m[i + 2:i + 2 + m[i + 1]]
            i += 2 + m[i + 1]
        return out

    def set_metadata(self, oid, tags):
        """IRREVERSIBLE, can lock an object FOREVER. Write metadata tags {tag: bytes}. A lifecycle (C0) only
        goes up; once it's 0x07 (operational) every 'LcsO < 0x07' rule closes for good: that slot can never
        be written or re-keyed again. Read trustm.md first."""
        b = b""
        for t in tags:
            b += bytes([t, len(tags[t])]) + tags[t]     # small: metadata is at most 44 bytes
        self.command(0x02, 0x01, _oid(oid) + b"\x00\x00" + b"\x20" + bytes([len(b)]) + b)

    def count(self, oid, n=1):
        """Add n (1-255) to a monotonic counter (COUNTERS). Fails at its threshold. Returns (value, threshold)."""
        self.command(0x02, 0x02, _oid(oid) + b"\x00\x00" + bytes([n]))
        return self.counter(oid)

    def counter(self, oid):
        """(value, threshold) of a monotonic counter."""
        b = self.read(oid)
        return int.from_bytes(b[0:4], "big"), int.from_bytes(b[4:8], "big")

    def set_counter(self, oid, value, threshold):
        """Set a counter's value and threshold (only while its change rule allows it)."""
        self.write(oid, value.to_bytes(4, "big") + threshold.to_bytes(4, "big"), erase=True)

    # ---- random ----
    def random(self, n, drng=False):
        """n random bytes (8-256): from the true random generator, or drng=True for its deterministic one."""
        return self.command(0x0C, 0x01 if drng else 0x00, n.to_bytes(2, "big"))

    # ---- hashing ----
    def sha256(self, data):
        """SHA-256 of data, computed on the chip."""
        step = MAX_DATA - 4 - 3
        if len(data) <= step:
            return self.command(0x30, 0xE2, _tlv(0x01, data))[3:]
        for i in range(0, len(data), step):
            tag = 0x00 if i == 0 else (0x03 if i + step >= len(data) else 0x02)
            r = self.command(0x30, 0xE2, _tlv(tag, data[i:i + step]))
        return r[3:]

    def sha256_object(self, oid, offset=0, n=None):
        """SHA-256 of an object's data, without it leaving the chip."""
        if n is None:
            n = len(self.read(oid))
        return self.command(0x30, 0xE2, _tlv(0x11, _oid(oid) + offset.to_bytes(2, "big") + n.to_bytes(2, "big")))[3:]

    # ---- keys ----
    def genkey(self, slot=None, alg=P256, usage=SIGN):
        """Make a key pair. slot (KEY2-4, RSA1-2, a SESSION): kept inside the chip, returns the public key.
        slot=None: returns (public, private) and keeps nothing. Public key: ECC 65 bytes (04 X Y); RSA the
        DER bit string's contents (see trustm.md). Overwrites what was in the slot."""
        if slot is None:
            t = _tlvs(self.command(0x38, alg, _tlv(0x07, b"")))
        else:
            t = _tlvs(self.command(0x38, alg, _tlv(0x01, _oid(slot)) + _tlv(0x02, bytes([usage]))))
        pub = _bits(t[0x02])
        if slot is None:
            priv = t[0x01]
            return pub, priv[2:] if priv[1] < 0x80 else priv[2 + (priv[1] & 0x7F):]
        return pub

    def public_key(self, slot):
        """There is no command for it: the chip hands a public key out only when it makes the key (genkey),
        and the factory key's is in its certificate (CERT). Keep what genkey returns."""
        raise NotImplementedError("save genkey()'s return value; the factory key's is in CERT")

    def sign(self, slot, digest):
        """ECDSA over a digest (usually 32 bytes) with an ECC key slot. Returns (r, s) as ints."""
        t = self.command(0x31, 0x11, _tlv(0x01, digest) + _tlv(0x03, _oid(slot)))
        out = []
        while t:
            n = t[1]
            out.append(_int(t[2:2 + n]))
            t = t[2 + n:]
        return out[0], out[1]

    def sign_rsa(self, slot, digest, sha=256):
        """RSA PKCS#1 v1.5 signature over a SHA-256/384/512 digest with an RSA key slot. Raw bytes."""
        return self.command(0x31, {256: 0x01, 384: 0x02, 512: 0x03}[sha], _tlv(0x01, digest) + _tlv(0x03, _oid(slot)))

    def verify(self, digest, r, s, pub=None, alg=P256, cert=None):
        """True if (r, s) is a valid ECDSA signature of digest by pub (65 bytes, 04 X Y) or by the key in
        the certificate stored in object cert. False if it isn't."""
        return self._verify(0x11, digest, _der_int(r) + _der_int(s), pub, alg, cert)

    def verify_rsa(self, digest, sig, pub=None, alg=RSA2048, cert=None, sha=256):
        """True if sig is a valid RSA PKCS#1 v1.5 signature of digest."""
        return self._verify({256: 0x01, 384: 0x02, 512: 0x03}[sha], digest, sig, pub, alg, cert)

    def _verify(self, scheme, digest, sig, pub, alg, cert):
        d = _tlv(0x01, digest) + _tlv(0x02, sig)
        d += _tlv(0x04, _oid(cert)) if cert else _tlv(0x05, bytes([alg])) + _tlv(0x06, _bitstring(pub))
        try:
            self.command(0x32, scheme, d)
            return True
        except Error as e:
            if e.code == 0x2C:
                return False
            raise

    def ecdh(self, slot, peer, alg=P256, store=None):
        """Shared secret of the key in slot (usage KEY_AGREE) and peer's public key (04 X Y): the X
        coordinate. store=a SESSION: kept inside the chip instead (for derive), returns None."""
        d = _tlv(0x01, _oid(slot)) + _tlv(0x05, bytes([alg])) + _tlv(0x06, _bitstring(peer))
        d += _tlv(0x08, _oid(store)) if store else _tlv(0x07, b"")
        r = self.command(0x33, 0x01, d)
        return None if store else r

    def derive(self, secret, n, data=b"", info=None, method="hkdf256", store=None):
        """Derive n bytes (16+) from a secret inside the chip: a SESSION (after ecdh(store=)) or a data object
        of type 'pre-shared secret'. method: hkdf256/384/512 (V3; data = salt, info) or prf256/384/512
        (TLS 1.2 PRF; data = label + seed). store=a SESSION: kept inside instead, returns None."""
        p = {"prf256": 0x01, "prf384": 0x02, "prf512": 0x03, "hkdf256": 0x08, "hkdf384": 0x09, "hkdf512": 0x0A}[method]
        d = _tlv(0x01, _oid(secret)) + _tlv(0x03, max(16, n).to_bytes(2, "big"))
        if info is not None:
            d += _tlv(0x04, info)
        d += _tlv(0x02, data) + (_tlv(0x08, _oid(store)) if store else _tlv(0x07, b""))
        r = self.command(0x34, p, d)
        return None if store else r[:n]

    # ---- RSA encryption ----
    def rsa_encrypt(self, message, pub=None, alg=RSA2048, cert=None):
        """RSAES PKCS#1 v1.5 encryption with a public key (the DER bit string's contents, as genkey returns
        for RSA) or a certificate object. Message up to key size - 11 bytes."""
        d = _tlv(0x61, message) + (_tlv(0x04, _oid(cert)) if cert else _tlv(0x05, bytes([alg])) + _tlv(0x06, _bitstring(pub)))
        return _tlvs(self.command(0x1E, 0x11, d))[0x61]

    def rsa_decrypt(self, slot, ciphertext):
        """Decrypt with an RSA key slot (usage ENC)."""
        return _tlvs(self.command(0x1F, 0x11, _tlv(0x61, ciphertext) + _tlv(0x03, _oid(slot))))[0x61]

    # ---- AES and HMAC (Trust M V3) ----
    def aes_genkey(self, bits=128, usage=ENC, export=False):
        """Make an AES key in AES_KEY (export=True: return it and keep nothing)."""
        p = {128: AES128, 192: AES192, 256: AES256}[bits]
        if export:
            return _tlvs(self.command(0x39, p, _tlv(0x07, b"")))[0x01]
        self.command(0x39, p, _tlv(0x01, _oid(AES_KEY)) + _tlv(0x02, bytes([usage])))

    def aes(self, data, decrypt=False, mode="cbc", iv=None, key=AES_KEY):
        """AES-ECB/CBC with the chip's AES key. data: a multiple of 16 bytes (no padding is added)."""
        p = {"ecb": 0x08, "cbc": 0x09}[mode]
        return self._sym(0x15 if decrypt else 0x14, p, key, data, _tlv(0x41, iv) if iv else b"", True)

    def mac(self, data, mode="cmac", key=AES_KEY):
        """AES-CMAC (or mode='cbcmac', data padded by you to 16) of data with the chip's AES key."""
        return self._sym(0x14, {"cbcmac": 0x0A, "cmac": 0x0B}[mode], key, data, b"", False)

    def hmac(self, key, data, sha=256):
        """HMAC-SHA256/384/512 of data, keyed by a data object of type 'pre-shared secret' or a SESSION."""
        return self._sym(0x14, {256: 0x20, 384: 0x21, 512: 0x22}[sha], key, data, b"", False)

    def _sym(self, cmd, p, key, data, extra, every):
        step = (MAX_DATA - 4 - 2 - 3 - len(extra)) // 16 * 16
        if len(data) <= step:
            return _tlvs(self.command(cmd, p, _oid(key) + _tlv(0x01, data) + extra)).get(0x61, b"")
        out = b""
        for i in range(0, len(data), step):
            tag = 0x00 if i == 0 else (0x03 if i + step >= len(data) else 0x02)
            r = _tlvs(self.command(cmd, p, _oid(key) + _tlv(tag, data[i:i + step]) + (extra if i == 0 else b"")))
            if every or tag == 0x03:
                out += r.get(0x61, b"")     # small: this call's own output, a few parts
        return out

    # ---- state ----
    def info(self):
        """What the chip says about itself."""
        return {"uid": self.read(UID), "lifecycle": self.read(LCSG)[0], "app_lifecycle": self.read(LCSA)[0],
                "security_events": self.read(SEC)[0], "sleep_ms": self.read(SLEEP_DELAY)[0],
                "current_ma": self.read(CURRENT_LIMIT)[0], "buffer": int.from_bytes(self.read(BUFFER), "big")}


def _bitstring(pub):
    """A public key as the chip wants it: a DER BIT STRING (03 LL 00 key)."""
    n = len(pub) + 1
    return b"\x03" + (bytes([n]) if n < 0x80 else bytes([0x81, n]) if n < 0x100 else b"\x82" + n.to_bytes(2, "big")) + b"\x00" + pub


def _bits(b):
    """The contents of a DER BIT STRING (03 LL 00 ...)."""
    i = 2 if b[1] < 0x80 else 2 + (b[1] & 0x7F)
    return b[i + 1:]


def _der_int(v):
    h = "%x" % v                        # (MicroPython ints have no bit_length)
    b = bytes.fromhex(("0" if len(h) % 2 else "") + h)
    if b[0] & 0x80:
        b = b"\x00" + b
    return b"\x02" + bytes([len(b)]) + b
