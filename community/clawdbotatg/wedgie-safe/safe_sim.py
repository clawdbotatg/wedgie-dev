# A signed simulation: one short page (what goes out, what comes in, in dollars) with the usual pages under it.
# The host asks a clear-sim server (github.com/clawdbotatg/clear-sim; sim.wedgie.dev) with a nonce this wedgie
# picked (safe_nonce), and sends the signed answer with the tx (tx["sim"]). This checks the signature against the
# keys below, the nonce, and the answer against the tx: ETH out must be the tx's value, a token in at least the
# descriptor's minimum. A simulator can still lie about names and prices: the short page says whose word it is.
# Loaded only while a question is up (safe.confirm).
#   check(tx, sim, nonce) -> (server, changes) or raises ValueError; pages(tx, sim, server, changes, info) ->
#   ([(head, lines)], [warnings]), info from safe._sim_info. safe.confirm runs them after the usual pages are read,
#   puts those under these, and ends the short page.
import hashlib, binascii, sys

# clear-sim servers this app trusts, by name: (x, y) of each P-256 key (GET the server for its key)
KEYS = {"sim.wedgie.dev": (0x963d7c90cbcfef8f6ff9e745c097294340502c2efb0e8c65b7ed9c37ccfecba4,
                           0xff9be230b6062fd80d2f78a6b00d744f745ae8d6e1647108646dcd230a024b92)}
SUF = ((12, "T"), (9, "B"), (6, "M"), (3, "K"))


def short(n, d):
    """n / 10**d in 3 digits, rounded down: 0.00414, 9.66, 2.31B; past 999T, 8.45e17. d < 0: decimals unknown."""
    sign = "-" if n < 0 else ""
    n = abs(n)
    if not n:
        return "0"
    s = str(n)
    if d < 0:                           # raw units: no decimals to go by
        return sign + (s if len(s) <= 4 else "%s.%se%d" % (s[0], s[1:3], len(s) - 1))
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
        out = out[:i] + out[i:j].rstrip("0").rstrip(".") + out[j:]
    return sign + out


def usd(s):
    """"-9.66" -> "$9.66"; "" -> "" (no price)."""
    if not s:
        return ""
    v = abs(float(s))
    if v < 0.01:
        return "< $0.01"
    if v >= 1000:
        t, out = str(int(v)), ""
        while len(t) > 3:
            out, t = "," + t[-3:] + out, t[:-3]
        return "$" + t + out
    return "$%.2f" % v


def _txhash(tx):
    """sha256 of "<from>\n<to>\n<value>\n<data>" (clear-sim's SPEC.md), worked out here from what gets signed."""
    h = hashlib.sha256()
    h.update(("%s\n%s\n%d\n0x" % (tx["safe"].lower(), tx["to"].lower(), tx["value"])).encode())
    d = tx["data"]
    for i in range(0, len(d), 256):
        h.update(binascii.hexlify(d[i:i + 256]))
    return binascii.hexlify(h.digest()).decode()


def check(tx, sim, nonce):
    """(server name, changes [(token, symbol, decimals, amount, usd)]), or raises ValueError."""
    import wedgie as W
    if not nonce or sim.get("nonce") != nonce:
        raise ValueError("not for this question (nonce)")
    if sim.get("sig", "p256") != "p256":
        raise ValueError("not p256")
    ch = sim.get("changes") or []
    if len(ch) > 8:
        raise ValueError("too many changes")
    text = "\n".join(["clear-sim v1", nonce, str(tx["chainId"]), _txhash(tx), str(int(sim["block"])), str(sim["ok"])] +
                     [",".join((str(c["token"]), str(c["symbol"]), str(int(c["decimals"])), str(int(c["amount"])), str(c["usd"])))
                      for c in ch])
    dg = hashlib.sha256(text.encode()).digest()
    r, s = int(sim["r"], 16), int(sim["s"], 16)
    for name, (x, y) in KEYS.items():
        ok = W.chip_verify(dg, r, s, x, y) if hasattr(W, "chip_verify") else False
        if not ok:
            import p256
            ok = p256.verify(x, y, dg, r, s)
        sys.modules.pop("p256", None)
        if ok:
            return name, [(c["token"], c["symbol"], int(c["decimals"]), int(c["amount"]), c["usd"]) for c in ch]
    raise ValueError("no trusted simulator signed this")


def dec(n, d):
    """n / 10**d, every digit, no trailing zeros (as safe_7730.dec)."""
    i, f = divmod(n, 10 ** d)
    f = ("%0" + str(d) + "d") % f if d else ""
    f = f.rstrip("0")
    return str(i) + ("." + f if f else "")


def pages(tx, sim, who, ch, info):
    """The short page (its title and last line left to safe.confirm) and the detail pages, and the warnings.
    info: (owner, trust, minimum) from the descriptor, or None."""
    from ui import INK, MUTED, GREEN_D, RED, COLS_SMALL
    from safe import BIG, ADDR
    owner, trust, minimum = info or ("", None, None)
    eth = [c for c in ch if c[0] == "eth"]
    sent = -eth[0][3] if eth and eth[0][3] < 0 else 0
    got = [c for c in ch if c[3] > 0 and c[0] != "eth"]
    warns = []
    if sim["ok"] != "ok":
        warns.append("it fails if sent now")
    if sent > tx["value"]:                          # less is fine: change sent back
        warns.append("more ETH out than the tx's")
    if minimum is not None and got and got[0][3] < minimum:
        warns.append("less than the tx's minimum")
    if trust and trust != "a":
        warns.append("contract not audited")
    to = tx["to"]
    ch = sorted(ch, key=lambda c: c[3])            # out first, then in
    main = [((owner or "a contract")[:13] + " " + to[:6] + ".." + to[-4:], MUTED)]
    for c in ch:
        main.append((("+" if c[3] > 0 else "-") + short(abs(c[3]), c[2]) + " " + c[1], GREEN_D if c[3] > 0 else INK, BIG))
        if c[4]:
            main.append((usd(c[4]), MUTED))
    out = [("", main)]
    for c in ch:
        full = dec(abs(c[3]), c[2]) if c[2] >= 0 else str(abs(c[3]))
        if len(full) + 1 + len(c[1]) <= 15:
            ls = [(full + " " + c[1], INK, BIG)]
        else:
            ls = [(full[i:i + COLS_SMALL], INK) for i in range(0, len(full), COLS_SMALL)][:3] + [(c[1], INK)]
        if c[4]:
            ls.append((usd(c[4]), MUTED))
        if c[0] == "eth" and c[3] < 0:
            ls.append(("= the tx's value" if sent == tx["value"] else "more than the tx's!" if sent > tx["value"] else
                       "tx's value, less change", RED if sent > tx["value"] else GREEN_D))
        if c[3] > 0 and minimum is not None:
            ls.append(("tx's minimum %s: %s" % (short(minimum, c[2]), "ok" if c[3] >= minimum else "LOW"),
                       GREEN_D if c[3] >= minimum else RED))
        if c[0] != "eth":
            ls.append((c[0], MUTED, ADDR))
        out.append(("You send" if c[3] < 0 else "You get", ls))
    out.append(("Checked", [("simulated at block", MUTED), (str(sim["block"]), INK), ("by " + who, INK),
                            ("names, prices: its word", MUTED)] + [(x, RED) for x in warns[:3]]))
    return out, warns

