# Safe Signer's key: made once, locked for good, in a Trust M or an ATECC608. Loaded only at start and when
# the key is made, then dropped. The chip is the only truth; the Pico keeps nothing about the key.
#
# A Trust M keeps the private key (KEY2) and its public key (DATA[11]: MAGIC + X + Y;
# a Trust M hands a public key out only when it makes the key). Once made, both are locked: their
# lifecycle goes to operational (0x07), which closes their "LcsO < 0x07" change rules for good. Nothing,
# no app, no computer, no one, can replace the key, change the copy, or unlock them after that. Tried on a
# real Trust M (2026-10-15): a new key, a write, an unlock, a new use or read rule all refused; it still
# signs. Other apps keep their keys in KEY3 and KEY4 (trustm.md).
#
# Every start the chip signs a fresh digest and the copy has to check it: a copy that doesn't is no key.
#
# An ATECC608 keeps the private key in slot 0 and works its public key out again whenever asked. Made once:
# its config written and locked (atecc.CONFIG), its data zone locked, the key made, then slot 0 locked
# (Lock, one slot). Tried on a real ATECC608 (2026-10-15): after the slot lock a new key is refused, the
# public key is the same, it still signs, and the other slots are still free for other apps. A make cut
# off before the slot lock leaves an unlocked key no one has seen: the next start says no key, and making
# one replaces it.
import gc, hashlib, binascii
import ui

MAGIC = b"wsafe1"
LOCKED = b"\x07"
CHIP = "OPTIGA Trust M"


def hx(b):
    return "0x" + binascii.hexlify(b).decode()


def _signs(c, optiga, pub):
    """The key in KEY2 is the one whose public key is pub (65 bytes, 04 X Y): checked by the chip."""
    h = hashlib.sha256(c.random(32)).digest()
    r, s = c.sign(optiga.KEY2, h)
    return c.verify(h, r, s, pub)


def _locked(c, oid):
    return c.metadata(oid).get(0xC0) == LOCKED


def _lock(c, optiga):
    """Both locked for good (the copy first: a key is never locked without its public key kept)."""
    for oid in (optiga.DATA[11], optiga.KEY2):
        if not _locked(c, oid):
            c.set_metadata(oid, {0xC0: LOCKED})
        if not _locked(c, oid):
            raise OSError("the chip didn't lock")


def _key(pub):
    return {"x": hx(pub[1:33]), "y": hx(pub[33:65]), "chip": CHIP}


def start(saved, a=None):
    """What the chip holds, as (state, key):
        "ok", key       the key, locked, its copy checked
        "none", None    no key yet: the person makes one (A)
        "lock", key     a key from before locking (safe-12 and older, its public key only in the save):
                        the person locks it, or says no and makes their own
        "swap", None    a locked key that isn't Safe Signer's (or a copy that doesn't match): this chip
                        can't be used, swap it
    a: the ATECC608 (safe._atecc), or None for a Trust M. Raises when no Trust M answers. The caller drops
    optiga / atecc after (safe._unload)."""
    if a:
        return _a_start(a, saved)
    import optiga
    try:
        c = optiga.Chip()
        locked = _locked(c, optiga.KEY2)
        b = c.read(optiga.DATA[11])
        if b[:len(MAGIC)] == MAGIC:
            pub = b"\x04" + b[len(MAGIC):len(MAGIC) + 64]
            if not _signs(c, optiga, pub):  # a copy of some other key: fixable only while unlocked
                return ("swap" if locked or _locked(c, optiga.DATA[11]) else "none"), None
            _lock(c, optiga)            # a make cut off before its lock (unplugged): finish it
            return "ok", _key(pub)
        if saved and saved.get("chip") != "ATECC608":
            pub = b"\x04" + binascii.unhexlify(saved["x"][2:]) + binascii.unhexlify(saved["y"][2:])
            if _signs(c, optiga, pub):
                return "lock", _key(pub)
        return ("swap" if locked else "none"), None
    finally:
        gc.collect()


def lock(key, a=None):
    """Keep this key for good: its public key into the chip, then both locked. Checked first."""
    if a:
        return _a_lock(a, key)
    import optiga
    try:
        c = optiga.Chip()
        pub = b"\x04" + binascii.unhexlify(key["x"][2:]) + binascii.unhexlify(key["y"][2:])
        if not _signs(c, optiga, pub):
            raise OSError("that key isn't in the chip")
        c.write(optiga.DATA[11], MAGIC + pub[1:], erase=True)
        _lock(c, optiga)
    finally:
        gc.collect()


def make(a=None):
    """The person's own key: made in the chip (replacing an unlocked one), kept, locked for good."""
    ui.progress("Making your key", "in the chip", False)
    if a:
        return _a_make(a)
    import optiga
    try:
        c = optiga.Chip()
        if _locked(c, optiga.KEY2):
            raise OSError("this chip's key is locked: swap the chip")
        pub = c.genkey(optiga.KEY2)             # 65 bytes: 04 X Y
        c.write(optiga.DATA[11], MAGIC + pub[1:], erase=True)
        if not _signs(c, optiga, pub):
            raise OSError("the new key didn't check")
        _lock(c, optiga)
        return _key(pub)
    finally:
        gc.collect()


# ---- ATECC608 (slot 0) --------------------------------------------------------------------------

def _a_cfg(a):
    return b"".join(a.read_config(b) for b in range(4))


def _a_ours(a, c):
    """Slot 0 set up as atecc.CONFIG sets it (a P-256 key that GenKey makes)."""
    import atecc
    return c[20:22] == atecc.CONFIG[20:22] and c[96:98] == atecc.CONFIG[96:98]


def _a_locked(c):
    return not c[88] & 1                    # SlotLocked, bit 0 = slot 0: 0 is locked


def _a_key(a):
    x, y = a.pubkey(0)
    return {"x": "0x%064x" % x, "y": "0x%064x" % y, "chip": "ATECC608"}


def _a_start(a, saved):
    c = _a_cfg(a)
    if c[87] != 0:                          # config not locked: a fresh chip
        return "none", None
    if not _a_ours(a, c):
        return "swap", None
    locked = _a_locked(c)
    try:
        k = _a_key(a)
    except Exception:                       # slot 0 empty
        return ("swap" if locked else "none"), None
    if locked:
        return "ok", k
    if saved and saved.get("x") == k["x"] and saved.get("y") == k["y"]:
        return "lock", k                    # safe-12 and older: made, saved, never locked
    return "none", None


def _a_lock_slot(a):
    """Data zone locked (once per chip, needed first), then slot 0 locked for good. Checked."""
    import atecc
    if not a.lock_state()["dataLocked"]:
        a.run(atecc.OP_LOCK, 0x81, 0, resp_len=1, wait_ms=35)      # data zone, no summary CRC
    if not _a_locked(_a_cfg(a)):
        a.run(atecc.OP_LOCK, 0x02, 0, resp_len=1, wait_ms=35)      # one slot: slot 0 (bits 2-5)
    if not _a_locked(_a_cfg(a)):
        raise OSError("the chip didn't lock")


def _a_lock(a, key):
    k = _a_key(a)
    if k["x"] != key["x"] or k["y"] != key["y"]:
        raise OSError("that key isn't in the chip")
    _a_lock_slot(a)


def _a_make(a):
    if not a.lock_state()["configLocked"]:
        a.write_config()                    # checked byte for byte, then locked: permanent
        a.lock_config()
    c = _a_cfg(a)
    if not _a_ours(a, c) or _a_locked(c):
        raise OSError("this chip's key is locked: swap the chip")
    x, y = a.genkey_new(0)
    k = _a_key(a)
    if k["x"] != "0x%064x" % x or k["y"] != "0x%064x" % y:
        raise OSError("the new key didn't check")
    _a_lock_slot(a)
    return k


# ---- safe_prove: "this wedgie, this key, just now" (wedgie.dev/telegram). Here, not in its own file: every app
# file is a line in wedgie.dev's signed release list, and that list must fit one 6 KB USB line.
#
#   {"type":"safe_prove","text":"Join Telegram","code":".."} -> the screen asks "Prove it" with the text; on a real A:
#   {"type":"safe_proof","text","code","x","y","r","s","cert","fr","fs"}  or {"type":"refused"}
#
# Two signatures, both checked by the site:
#   r, s    the Safe key (KEY2) over sha256("wedgie prove\0" + sha256(text "\n" code)): the site's fresh code, after a press.
#   fr, fs  the chip's factory key over sha256("wedgie safe key\0" + X + Y): this key lives in this chip. X, Y are the key
#           the app read from the chip and checked at start, never from the computer. cert: the chip's Infineon
#           certificate for the factory key (it chains to Infineon's roots), so one chip is one wedgie.
# What each key signs can't be anything else: the Safe key's preimage is 45 bytes (a Safe signature's is 69 or
# more), the factory key's 80 (the firmware's chip check signs 100 random bytes of its own).
TEXT_MAX = 24
CODE_MAX = 200


def _ok_text(s):
    return isinstance(s, str) and 0 < len(s) <= TEXT_MAX and all(32 <= ord(c) < 127 for c in s)


def prove(S, mid, text, code):
    """S: the safe module (its key, screen, sign)."""
    W = S.W
    if S.state != "ok":
        W.send({"id": mid, "type": "error", "error": "no key yet: make one in Safe Signer first"})
        return
    if S.key.get("chip") == "ATECC608":
        W.send({"id": mid, "type": "error", "error": "needs a Trust M chip"})
        return
    if not _ok_text(text) or not isinstance(code, str) or not 0 < len(code) <= CODE_MAX:
        W.send({"id": mid, "type": "error", "error": "bad text or code"})
        return
    k = S.L.Keys(physical=True)
    k.pressed()
    if not S._screen("Prove it", [S.GAP, (text, S.INK, S.BIG)], "sign", k):
        S.note = "said no"
        W.send({"id": mid, "type": "refused"})
        return
    S.ui.progress("Signing", "in the chip", False)
    inner = hashlib.sha256(text.encode() + b"\n" + code.encode()).digest()
    r, s = S.sign(hashlib.sha256(b"wedgie prove\x00" + inner).digest())
    xy = binascii.unhexlify(S.key["x"][2:]) + binascii.unhexlify(S.key["y"][2:])
    import optiga
    try:
        c = optiga.Chip()
        cert = c.read(optiga.CERT)
        fr, fs = c.sign(optiga.FACTORY_KEY, hashlib.sha256(b"wedgie safe key\x00" + xy).digest())
    finally:
        S._unload()
    S.note = "proved"
    W.send({"id": mid, "type": "safe_proof", "text": text, "code": code, "x": S.key["x"], "y": S.key["y"],
            "r": "0x%064x" % r, "s": "0x%064x" % s, "cert": binascii.hexlify(cert).decode(),
            "fr": "0x%064x" % fr, "fs": "0x%064x" % fs})
