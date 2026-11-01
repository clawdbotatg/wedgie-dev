#!/usr/bin/env python3
"""Safe Signer's key (the shelf's community/clawdbotatg/wedgie-safe/safe_key.py) against a fake Trust M and a
fake ATECC608 that keep the rules real ones showed (2026-10-15). Trust M: a key slot never reads out, a genkey
replaces an unlocked key, and once an object's lifecycle is 0x07 every write, genkey and metadata change is
refused. ATECC608: no key until the config is locked, the slot lock needs the data zone locked, and a locked
slot refuses a new key but still signs and gives its public key. The promise checked: the person's key is made once, kept in the chip with its public key, locked
for good, and never replaced, and a chip that holds someone else's locked key is never used.
    python3 tools/test_safekey.py   (or: python3 tools/test_safekey.py <wedgie-safe checkout>)"""
import hashlib, os, sys, types
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.utils import Prehashed, decode_dss_signature, encode_dss_signature
from cryptography.exceptions import InvalidSignature

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
app = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "community/clawdbotatg/wedgie-safe")
bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


class Refused(OSError):
    pass


def pub_of(k):
    n = k.public_key().public_numbers()
    return b"\x04" + n.x.to_bytes(32, "big") + n.y.to_bytes(32, "big")


class TrustM:
    """KEY2 and DATA[11] as a real chip keeps them."""
    KEY2, DATA = 0xE0F1, [0xF1D0 + i for i in range(12)]

    def __init__(self):
        self.keys = {}                          # oid -> private key
        self.data = {o: b"" for o in self.DATA}
        self.lcs = {}                           # oid -> lifecycle byte

    def _open(self, oid):
        if self.lcs.get(oid, 1) >= 7:
            raise Refused("optiga: access conditions not satisfied (0x07)")

    def metadata(self, oid):
        return {0xC0: bytes([self.lcs.get(oid, 1)])}

    def set_metadata(self, oid, tags):
        self._open(oid)
        for t, v in tags.items():
            if t == 0xC0:
                if v[0] < self.lcs.get(oid, 1):
                    raise Refused("optiga: invalid parameter in data (0x05)")     # a lifecycle only goes up
                self.lcs[oid] = v[0]

    def genkey(self, slot):
        self._open(slot)
        self.keys[slot] = ec.generate_private_key(ec.SECP256R1())
        return pub_of(self.keys[slot])

    def read(self, oid):
        if oid in (self.KEY2,):
            raise Refused("optiga: access conditions not satisfied (0x07)")
        return self.data[oid]

    def write(self, oid, b, erase=False):
        self._open(oid)
        self.data[oid] = b

    def random(self, n):
        return os.urandom(n)

    def sign(self, slot, digest):
        if slot not in self.keys:
            raise Refused("optiga: empty key slot")
        return decode_dss_signature(self.keys[slot].sign(digest, ec.ECDSA(Prehashed(hashes.SHA256()))))

    def verify(self, digest, r, s, pub):
        try:
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), pub).verify(
                encode_dss_signature(r, s), digest, ec.ECDSA(Prehashed(hashes.SHA256())))
            return True
        except (InvalidSignature, ValueError):
            return False


class ATECC:
    """Slot 0 as a real ATECC608 keeps it; the config zone as read_config returns it."""
    def __init__(self, cfg=None):
        self.cfg = bytearray(cfg or bytes(128))
        self.cfg[86] = self.cfg[87] = 0x55              # data, config: unlocked
        self.cfg[88] = self.cfg[89] = 0xFF              # SlotLocked: none
        self.keys = {}

    def read_config(self, b):
        return bytes(self.cfg[b * 32:b * 32 + 32])

    def lock_state(self):
        return {"configLocked": self.cfg[87] == 0, "dataLocked": self.cfg[86] == 0}

    def write_config(self):
        if self.cfg[87] == 0:
            raise Refused("status 0x0f")
        self.cfg[16:84] = atecc.CONFIG[16:84]
        self.cfg[90:128] = atecc.CONFIG[90:128]

    def lock_config(self):
        if self.cfg[87] == 0:
            raise Refused("config zone is already locked")
        self.cfg[87] = 0

    def run(self, op, mode, p2, **kw):
        assert op == atecc.OP_LOCK
        if mode == 0x81 and self.cfg[87] == 0 and self.cfg[86] != 0:
            self.cfg[86] = 0
        elif mode & 3 == 2 and self.cfg[86] == 0 and self.cfg[96 + 2 * (mode >> 2 & 15)] & 0x20:
            self.cfg[88] &= ~(1 << (mode >> 2 & 15))
        else:
            raise Refused("status 0x0f on opcode 0x17")

    def genkey_new(self, slot=0):
        if self.cfg[87] != 0 or not self.cfg[88] & 1 << slot:
            raise Refused("status 0x0f on opcode 0x40")
        self.keys[slot] = ec.generate_private_key(ec.SECP256R1())
        return self.pubkey(slot)

    def pubkey(self, slot=0):
        if slot not in self.keys:
            raise Refused("status 0x0f on opcode 0x40")
        n = self.keys[slot].public_key().public_numbers()
        return n.x, n.y


chip = None
atecc = types.ModuleType("atecc")
atecc.OP_LOCK = 0x17
_src = open(os.path.join(root, "firmware/atecc.py")).read()
atecc.CONFIG = eval(_src[_src.index("bytes([", _src.index("CONFIG = ")):_src.index("])", _src.index("CONFIG = ")) + 2])
sys.modules["atecc"] = atecc
optiga = types.ModuleType("optiga")
optiga.KEY2, optiga.DATA = TrustM.KEY2, TrustM.DATA
optiga.Chip = lambda: chip
sys.modules["optiga"] = optiga
ui = types.ModuleType("ui")
ui.progress = lambda *a, **k: None
sys.modules["ui"] = ui
sys.path.insert(0, app)
import safe_key as K

# the shelf ships safe.mpy (safe-59+): safe.py's source is the checkout beside this repo
src = open(next(f for f in (os.path.join(app, "safe.py"), os.path.join(root, "..", "wedgie-safe", "safe.py")) if os.path.exists(f))).read() + open(os.path.join(app, "safe_key.py")).read()
check(src.count("genkey(optiga.KEY2)") == 1, "one place makes a Trust M key (safe_key.make)")
check("optiga.KEY3" not in src and "optiga.KEY4" not in src, "Safe Signer never touches KEY3 / KEY4 (other apps' slots)")

# a fresh chip: no key; the person makes one; it's kept in the chip and locked for good
chip = TrustM()
check(K.start(None) == ("none", None), "fresh chip: no key")
k = K.make()
check(K.start(None) == ("ok", k), "made: the chip gives it back (the Pico keeps nothing)")
check(chip.lcs.get(TrustM.KEY2) == 7 and chip.lcs.get(TrustM.DATA[11]) == 7, "made: key and public key locked")
try:
    K.make()
    check(False, "a second make is refused")
except OSError:
    check(True, "a second make is refused")
check(K.start(None) == ("ok", k), "still the same key after the refused make")
for what, f in (("a new key", lambda: chip.genkey(TrustM.KEY2)), ("a new public key", lambda: chip.write(TrustM.DATA[11], b"x")),
                ("an unlock", lambda: chip.set_metadata(TrustM.KEY2, {0xC0: b"\x01"}))):
    try:
        f()
        check(False, "after the lock, %s from any app is refused" % what)
    except Refused:
        check(True, "after the lock, %s from any app is refused" % what)
check(K.start({"x": "0x" + "11" * 32, "y": "0x" + "22" * 32}) == ("ok", k), "a planted save changes nothing")

# someone else's key, locked: never used
chip = TrustM()
chip.genkey(TrustM.KEY2)
chip.set_metadata(TrustM.KEY2, {0xC0: b"\x07"})
check(K.start(None) == ("swap", None), "someone else's locked key: swap the chip")
chip.write(TrustM.DATA[11], K.MAGIC + pub_of(ec.generate_private_key(ec.SECP256R1()))[1:])
check(K.start(None) == ("swap", None), "a public key copy that isn't the chip's key: swap the chip")

# someone else's key, not locked, no copy: no key; making one replaces it
chip = TrustM()
chip.genkey(TrustM.KEY2)
check(K.start(None) == ("none", None), "someone else's unlocked key: treated as no key")
old = chip.keys[TrustM.KEY2]
k = K.make()
check(chip.keys[TrustM.KEY2] is not old and K.start(None) == ("ok", k), "making a key replaces it")

# unplugged between the copy and the lock: the next start finishes the lock
chip = TrustM()
p = chip.genkey(TrustM.KEY2)
chip.write(TrustM.DATA[11], K.MAGIC + p[1:])
check(K.start(None)[0] == "ok" and chip.lcs.get(TrustM.KEY2) == 7, "a make cut off before its lock: locked at next start")

# a key from safe-12 (public key only in the save): the person locks it, or makes their own
chip = TrustM()
p = chip.genkey(TrustM.KEY2)
saved = {"x": "0x" + p[1:33].hex(), "y": "0x" + p[33:65].hex(), "chip": "OPTIGA Trust M"}
st, k = K.start(saved)
check(st == "lock", "a safe-12 key: asked to lock it, never locked by itself")
check(chip.lcs.get(TrustM.KEY2, 1) == 1, "a safe-12 key: still unlocked until the person says")
K.lock(k)
check(K.start(None) == ("ok", k), "locked: the chip gives it back")

# ATECC608: a fresh chip; the person makes a key; slot 0 locked for good; the public key from the chip
a = ATECC()
check(K.start(None, a) == ("none", None), "ATECC608 fresh: no key")
k = K.make(a)
check(K.start(None, a) == ("ok", k), "ATECC608 made: the chip gives it back (the Pico keeps nothing)")
check(a.lock_state() == {"configLocked": True, "dataLocked": True} and not a.cfg[88] & 1, "ATECC608 made: slot 0 locked")
for what, f in (("a second make", lambda: K.make(a)), ("a new key from any app", lambda: a.genkey_new(0))):
    try:
        f()
        check(False, "ATECC608: %s is refused" % what)
    except OSError:
        check(True, "ATECC608: %s is refused" % what)
check(K.start({"x": "0x" + "11" * 32, "y": "0x" + "22" * 32, "chip": "ATECC608"}, a) == ("ok", k), "ATECC608: a planted save changes nothing")
check(a.genkey_new(2) and True, "ATECC608: other slots still free for other apps")

# ATECC608: a key from safe-12 (made, saved, never locked): the person locks it, or makes their own
a = ATECC()
a.write_config(); a.lock_config()
x, y = a.genkey_new(0)
saved = {"x": "0x%064x" % x, "y": "0x%064x" % y, "chip": "ATECC608"}
st, k = K.start(saved, a)
check(st == "lock" and a.cfg[88] & 1, "ATECC608 safe-12 key: asked to lock it, never locked by itself")
K.lock(k, a)
check(K.start(None, a) == ("ok", k), "ATECC608 safe-12 key locked: the chip gives it back")

# ATECC608: an unlocked key with no save (a make cut off, or someone else's): no key; making one replaces it
a = ATECC()
a.write_config(); a.lock_config()
a.genkey_new(0)
old = a.keys[0]
check(K.start(None, a) == ("none", None), "ATECC608 unlocked key, no save: no key")
k = K.make(a)
check(a.keys[0] is not old and K.start(None, a) == ("ok", k), "ATECC608: making a key replaces it")

# ATECC608: config locked by someone else with slot 0 set up another way: never used
cfg = bytearray(atecc.CONFIG); cfg[96] = 0x13
a = ATECC(cfg); a.lock_config()
check(K.start(None, a) == ("swap", None), "ATECC608 config not Safe Signer's: swap the chip")
try:
    K.make(a)
    check(False, "ATECC608 config not Safe Signer's: make refused")
except OSError:
    check(True, "ATECC608 config not Safe Signer's: make refused")

print("%d FAILED" % bad if bad else "all ok")
sys.exit(1 if bad else 0)
