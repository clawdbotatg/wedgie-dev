# The rare requests, in their own file, loaded only for one: every line kept out of safe.py and safe_key.py (both in
# RAM at every start) leaves the heap room big transactions need.
#
# ---- safe_message: a site's text message (personal_sign, "Sign in with Ethereum") signed for a Safe, the way Safe's
# fallback handler checks it (ERC-1271).
#
#   {"type":"safe_message","chainId":1,"safe":"0x..","hex":"0x.."}   the message's own bytes, at most MSG_MAX
#   -> the text on the screen, every line of it, a page at a time; on a real A:
#   {"type":"safe_sig","messageHash":"0x..","safeMessageHash":"0x..","x","y","r","s","authenticatorData","clientDataFields"}
#   or {"type":"refused"}
#
# The wedgie works out both hashes itself from the bytes it shows:
#   messageHash      keccak256("\x19Ethereum Signed Message:\n" + len + bytes)      (EIP-191, what the site checks)
#   safeMessageHash  EIP-712 SafeMessage(bytes message = messageHash), Safe's domain (chainId, the Safe)
# and signs safeMessageHash like a Safe tx hash (the WebAuthn message the signer contract rebuilds).
# Text only: printable ASCII, spaces and new lines. Anything else (other letters, raw bytes, typed data) it can't
# show as it is, so it won't sign it.
import binascii, hashlib

MSG_MAX = 1500


def rare(S, mid, m):
    """S: the safe module (its key, screen, sign)."""
    if m.get("type") == "safe_prove":
        prove(S, mid, m.get("text"), m.get("code"))
    else:
        sign_message(S, mid, m)
SAFE_MSG_TYPEHASH = binascii.unhexlify("60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca")


def text_of(b):
    """The bytes as text, or None if any byte isn't printable ASCII, a tab or a new line."""
    if not 0 < len(b) <= MSG_MAX or any(not (32 <= c < 127 or c in (9, 10, 13)) for c in b):
        return None
    return b.decode().replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")


def wrap(text, cols):
    """Every line of the text cut to fit across: at a space where it can, anywhere where it can't."""
    out = []
    for line in text.split("\n"):
        while len(line) > cols:
            i = line.rfind(" ", 0, cols + 1)
            if i <= 0:
                i = cols
            out.append(line[:i])
            line = line[i:].lstrip(" ")
        out.append(line)
    return out


def hashes(S, chain, safe, b):
    """(messageHash, safeMessageHash) for bytes b."""
    from safe_keccak import keccak256 as k
    mh = k(b"\x19Ethereum Signed Message:\n" + str(len(b)).encode() + b)
    domain = k(S.DOMAIN_TYPEHASH + S.word(chain) + S.aword(safe))
    return mh, k(b"\x19\x01" + domain + k(SAFE_MSG_TYPEHASH + k(mh)))


def sign_message(S, mid, m):
    """S: the safe module (its key, screen, sign)."""
    W = S.W
    if S.state != "ok":
        W.send({"id": mid, "type": "error", "error": "no key ready"})
        return
    try:
        chain = S.num(m.get("chainId"))
        safe = S.addr(m.get("safe"))
        b = S.unhex(m.get("hex"))
    except Exception as e:
        W.send({"id": mid, "type": "error", "error": "bad message: %s" % e})
        return
    text = text_of(b)
    if text is None:
        W.send({"id": mid, "type": "error", "error": "not plain text (or over %d bytes): Safe Signer won't sign what it can't show" % MSG_MAX})
        return
    mh, h = hashes(S, chain, safe, b)
    lines = [(l, S.INK) for l in wrap(text, S.ui.COLS_SMALL)]
    pages = S._fit(lines)
    n = len(pages)
    foot = S.CHAINS.get(chain, "chain %d" % chain)
    k = S.L.Keys(physical=True)
    k.pressed()
    for i, part in enumerate(pages):
        if not S._screen("Sign this text?", part, "sign" if i == n - 1 else "next", k,
                         "%d/%d %s" % (i + 1, n, foot) if n > 1 else foot, safe):
            S.note = "said no"
            W.send({"id": mid, "type": "refused", "safeMessageHash": S.hx(h)})
            return
    S.ui.progress("Signing", "in the chip", False)
    auth, dg = S.webauthn_digest(h)
    r, s = S.sign(dg)
    S.note = "signed a message"
    W.send({"id": mid, "type": "safe_sig", "messageHash": S.hx(mh), "safeMessageHash": S.hx(h), "x": S.key["x"],
            "y": S.key["y"], "r": "0x%064x" % r, "s": "0x%064x" % s, "authenticatorData": S.hx(auth),
            "clientDataFields": S.FIELDS})


# ---- safe_prove: "this wedgie, this key, just now" (wedgie.dev/telegram).
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
