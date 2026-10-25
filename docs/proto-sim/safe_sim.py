# Safe Signer: the clean screen from a simulation (PROTOTYPE, 10-25). The computer sends a signed clear-sim answer
# (sim.wedgie.dev, SPEC.md in github.com/clawdbotatg/clear-sim) with the tx (tx["sim"]); this checks the signature and
# the answer against the tx, then gives one short page and detail pages under it (the d-pad's down).
#   pages(tx, bundle) -> [(head, lines)], the short page first; or a reason string it can't
# Not yet: the wedgie's own nonce (the computer picks it now: an old answer for the same tx could come back).
import hashlib, binascii

# sim.wedgie.dev's public key (GET https://sim.wedgie.dev/). Later: a list, and your own added with one press.
KEY = (0x963d7c90cbcfef8f6ff9e745c097294340502c2efb0e8c65b7ed9c37ccfecba4,
       0xff9be230b6062fd80d2f78a6b00d744f745ae8d6e1647108646dcd230a024b92)
SUF = ((12, "T"), (9, "B"), (6, "M"), (3, "K"))


def short(n, d):
    """n / 10**d in 3 digits, rounded down: 0.00414, 9.66, 2.31B; past 999T, 8.45e17. d < 0: decimals unknown."""
    sign = "-" if n < 0 else ""
    n = abs(n)
    if not n:
        return "0"
    if d < 0:                           # raw units: no decimals to go by
        s = str(n)
        return sign + (s if len(s) <= 4 else "%s.%se%d" % (s[0], s[1:3], len(s) - 1)).rstrip("0").rstrip(".")
    s = str(n)
    e = len(s) - 1 - d                  # the leading digit's power of ten
    lead = (s + "00")[:3]
    if e >= 15:
        out = "%s.%se%d" % (lead[0], lead[1:], e)
    elif e >= 3:
        for p, l in SUF:
            if e >= p:
                k = e - p + 1           # digits before the point
                out = lead[:k] + ("." + lead[k:] if k < 3 else "") + l
                break
    elif e >= 0:
        out = lead[:e + 1] + "." + lead[e + 1:]
    else:
        out = "0." + "0" * (-e - 1) + lead
    if "." in out:                      # 2.10B -> 2.1B, 9.00 -> 9
        i = out.index(".")
        j = i + 1
        while j < len(out) and out[j].isdigit():
            j += 1
        m = out[i:j].rstrip("0").rstrip(".")
        out = out[:i] + m + out[j:]
    return sign + out


def usd(s):
    """"-9.66" -> "$9.66"; "" -> "" (no price)."""
    if not s:
        return ""
    v = abs(float(s))
    if v < 0.01:
        return "< $0.01"
    if v >= 1000:
        return "$" + _commas(int(v))
    return "$%.2f" % v


def _commas(n):
    t = str(n)
    out = ""
    while len(t) > 3:
        out = "," + t[-3:] + out
        t = t[:-3]
    return t + out


def _txhash(tx):
    h = hashlib.sha256()
    h.update(("%s\n%s\n%d\n0x" % (tx["safe"].lower(), tx["to"].lower(), tx["value"])).encode())
    d = tx["data"]
    for i in range(0, len(d), 256):
        h.update(binascii.hexlify(d[i:i + 256]))
    return binascii.hexlify(h.digest()).decode()


def check(tx, sim):
    """The signed answer, its changes [(token, symbol, decimals, amount, usd)], or raises ValueError."""
    import wedgie as W
    import p256
    if sim.get("sig", "p256") != "p256":
        raise ValueError("not p256")
    tx_h = _txhash(tx)
    ch = sim.get("changes") or []
    text = "\n".join(["clear-sim v1", sim["nonce"], str(tx["chainId"]), tx_h, str(int(sim["block"])), sim["ok"]] +
                     [",".join((c["token"], c["symbol"], str(c["decimals"]), c["amount"], c["usd"])) for c in ch])
    dg = hashlib.sha256(text.encode()).digest()
    r, s = int(sim["r"], 16), int(sim["s"], 16)
    ok = W.chip_verify(dg, r, s, KEY[0], KEY[1]) if hasattr(W, "chip_verify") else False
    if not ok and not p256.verify(KEY[0], KEY[1], dg, r, s):
        raise ValueError("sim.wedgie.dev didn't sign this")
    return [(c["token"], c["symbol"], int(c["decimals"]), int(c["amount"]), c["usd"]) for c in ch]


def pages(tx, bundle, sim):
    from ui import INK, MUTED, GREEN_D, RED, COLS_SMALL
    from safe import BIG, ADDR, GAP
    import safe_7730 as C
    try:
        ch = check(tx, sim)
    except (ValueError, KeyError, TypeError) as e:
        return "simulation: %s" % e
    intent, owner, trust = "Call", "", None
    extra, minimum = 0, None
    if bundle:
        try:
            intent, owner, trust, its = C.items(tx, bundle)
            for label, text, kind in its:
                if kind == "warn" and text.endswith("(unknown token)"):
                    minimum = int(text.split(" ")[0])
        except Exception:
            pass
        import safe_wire as w
        extra = w.extra_bytes(tx["data"][4:]) if len(tx["data"]) > 4 else 0
    warns = []
    eth = [c for c in ch if c[0] == "eth"]
    sent = -eth[0][3] if eth and eth[0][3] < 0 else 0
    if sim["ok"] != "ok":
        warns.append("it fails if sent now")
    if tx["value"] and sent != tx["value"]:
        warns.append("ETH out isn't the tx's")
    got = [c for c in ch if c[3] > 0 and c[0] != "eth"]
    if minimum is not None and got and got[0][3] < minimum:
        warns.append("less than the tx's minimum")
    if extra:
        warns.append("%d extra bytes" % extra)
    if trust and trust != "a":
        pass                            # not audited: on the contract page
    who = (owner or "a contract")[:13]
    to = C._hex(tx["to"]) if not isinstance(tx["to"], str) else tx["to"]
    main = [(who + " " + to[:6] + ".." + to[-4:], MUTED)]
    for c in sorted(ch, key=lambda c: c[3]):     # out first, then in
        txt = ("+" if c[3] > 0 else "-") + short(abs(c[3]), c[2]) + " " + c[1]
        main.append((txt, GREEN_D if c[3] > 0 else INK, BIG))
        if c[4]:
            main.append((usd(c[4]), MUTED))
    if not ch:
        main.append(("nothing moves", RED))
    if warns:
        main.append(("! %s  (down)" % warns[0] if len(warns) == 1 else "! %d things  (down)" % len(warns), RED))
    else:
        main.append(("checked (down: details)", GREEN_D))
    out = [(intent[:15], main)]
    for c in sorted(ch, key=lambda c: c[3]):
        full = C.dec(abs(c[3]), c[2]) if c[2] >= 0 else str(abs(c[3]))
        if len(full) + 1 + len(c[1]) <= 15:          # big, as on the short page
            ls = [(full + " " + c[1], INK, BIG)]
        else:
            ls = [(full[i:i + COLS_SMALL], INK) for i in range(0, len(full), COLS_SMALL)][:3] + [(c[1], INK)]
        if c[4]:
            ls.append((usd(c[4]), MUTED))
        if c[0] == "eth" and tx["value"]:
            ls.append(("= the tx's value" if sent == tx["value"] else "not the tx's value!", GREEN_D if sent == tx["value"] else RED))
        if c[3] > 0 and minimum is not None:
            ls.append(("tx's minimum %s: %s" % (short(minimum, c[2]), "ok" if c[3] >= minimum else "LOW"), GREEN_D if c[3] >= minimum else RED))
        if c[0] != "eth":
            ls.append((c[0], MUTED, ADDR))
        out.append(("You send" if c[3] < 0 else "You get", ls))
    out.append(("Contract", [(owner or "unknown", INK), (to, INK, ADDR)] +
                ([("not audited", RED)] if trust and trust != "a" else [])))
    if extra:
        tail = binascii.hexlify(tx["data"][-extra:]).decode()
        out.append(("Extra bytes", [("%d after the call" % extra, RED), ("0x" + tail[:COLS_SMALL - 2], INK),
                                    ("the call doesn't read them", MUTED)]))
    out.append(("Checked", [("simulated at block", MUTED), (str(sim["block"]), INK), ("signed by sim.wedgie.dev", GREEN_D)] +
                [(w_, RED) for w_ in warns[:3]]))
    return out
