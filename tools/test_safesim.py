#!/usr/bin/env python3
"""Safe Signer's simulation check (safe_sim.check) can't be fooled by the computer (audit 11-13). The signed
text is the fields joined by commas and newlines, so a field that holds a comma or a newline could hide a
signed line: the server signs "-5 ETH" and "+1 TOK", the computer folds the ETH line into TOK's token field,
the signature still passes and the screen showed only "+1 TOK". Every field must be what a clear-sim server
writes (SPEC.md), or there's no simulation on the screen.
    uv run --with cryptography python3 tools/test_safesim.py [<wedgie-safe checkout>] [--live]
--live also asks sim.wedgie.dev for a real answer and checks it still passes."""
import hashlib, json, os, sys, types, urllib.request
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.utils import Prehashed, decode_dss_signature

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
args = [a for a in sys.argv[1:] if not a.startswith("--")]
app = args[0] if args else os.path.join(root, "../wedgie-safe")     # the shelf ships safe_sim.mpy: the checkout beside this repo
sys.path[:0] = [app, os.path.join(root, "firmware")]
sys.modules["wedgie"] = types.SimpleNamespace(chip_verify=lambda *a: False)     # no chip: p256.py checks it
import safe_sim

bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


REAL = dict(safe_sim.KEYS)
key = ec.generate_private_key(ec.SECP256R1())
pub = key.public_key().public_numbers()
safe_sim.KEYS = {"test": (pub.x, pub.y)}

NONCE = "ab" * 16
TOK = "0x" + "7a" * 20
TX = {"safe": "0x" + "11" * 20, "to": "0x" + "22" * 20, "value": 5 * 10 ** 18, "data": b"", "operation": 0, "chainId": 1}
ETH = {"token": "eth", "symbol": "ETH", "decimals": 18, "amount": "-5000000000000000000", "usd": "-9000.00"}
GOT = {"token": TOK, "symbol": "TOK", "decimals": 18, "amount": "1", "usd": ""}


def line(c):
    return ",".join((c["token"], c["symbol"], str(c["decimals"]), str(c["amount"]), c["usd"]))


def signed(changes, ok="ok", send=None, send_ok=None):
    """A server signs `changes` and `ok`; the computer sends `send` and `send_ok` with that signature."""
    text = "\n".join(["clear-sim v1", NONCE, "1", safe_sim._txhash(TX), "100", ok] + [line(c) for c in changes])
    r, s = decode_dss_signature(key.sign(hashlib.sha256(text.encode()).digest(), ec.ECDSA(Prehashed(hashes.SHA256()))))
    return {"nonce": NONCE, "block": 100, "ok": ok if send_ok is None else send_ok,
            "changes": changes if send is None else send, "r": "%064x" % r, "s": "%064x" % s}


def run(sim):
    try:
        return safe_sim.check(TX, sim, NONCE)
    except ValueError as e:
        return str(e)


def refused(sim, what):
    got = run(sim)
    check(isinstance(got, str), "%s: no simulation shown (%s)" % (what, got if isinstance(got, str) else
                                                                  "SHOWN: %s" % [c[:4] for c in got[1]]))


# 1. honest
got = run(signed([ETH, GOT]))
check(not isinstance(got, str) and [(c[0], c[1], c[2], c[3]) for c in got[1]] ==
      [("eth", "ETH", 18, -5 * 10 ** 18), (TOK, "TOK", 18, 1)], "an honest answer: both lines (%s)" % (got,))
got = run(signed([], ok="reverts"))
check(not isinstance(got, str) and got[1] == [], "an honest 'reverts' answer passes (%s)" % (got,))
got = run(signed([dict(GOT, symbol="?", decimals=-1)]))
check(not isinstance(got, str), "a token that won't say its name (? and -1) passes (%s)" % (got,))

# 2. the attack: the ETH line folded into the token field
refused(signed([ETH, GOT], send=[dict(GOT, token=line(ETH) + "\n" + TOK)]), "a signed line hidden in a token field")
# 3. folded into the symbol
refused(signed([GOT, ETH], send=[dict(ETH, token=TOK, symbol="TOK,18,1,\neth,ETH")]), "a signed line hidden in a symbol")
# 4. folded into usd
refused(signed([GOT, ETH], send=[dict(GOT, usd="\n" + line(ETH))]), "a signed line hidden in usd")
refused(signed([dict(GOT, usd="1,2")]), "a comma in usd")
# 5. folded into ok
refused(signed([ETH], send=[], send_ok="ok\n" + line(ETH)), "a signed line hidden in ok")
refused(signed([GOT], ok="fine"), "an ok that is neither ok nor reverts")
# 6. a token twice
refused(signed([ETH, dict(ETH, amount="1")]), "eth twice")
refused(signed([GOT, dict(GOT, token=TOK.upper().replace("X", "x"))]), "a token twice (other case)")
# 7. not an address
refused(signed([dict(GOT, token=TOK[:-1])]), "a token of 41 characters")
refused(signed([dict(GOT, token=TOK + "0")]), "a token of 43 characters")
refused(signed([dict(GOT, token=TOK[:-1] + "g")]), "a token with a letter that isn't hex")
refused(signed([dict(GOT, token="ETH")]), "a token named ETH that isn't the coin")
# odd fields
refused(signed([dict(GOT, symbol="A" * 13)]), "a symbol of 13 characters")
refused(signed([dict(GOT, symbol="")]), "an empty symbol")
refused(signed([dict(GOT, symbol="T K")]), "a space in a symbol")
refused(signed([dict(GOT, decimals=37)]), "37 decimals")
refused(signed([dict(GOT, decimals=-2)]), "-2 decimals")
refused(signed([dict(GOT, usd="1e5")]), "a usd that isn't a plain number")
refused(dict(signed([ETH, GOT]), nonce="cd" * 16), "another question's answer")
refused(dict(signed([ETH, GOT]), changes=[ETH]), "a line left out")

# 8. a real server's answer still passes
if "--live" in sys.argv:
    safe_sim.KEYS = REAL
    tx = dict(TX, safe="0xd8da6bf26964af9d7eed9e03e53415d37aa96045", value=10 ** 15)
    for name, t in (("an ETH send", tx),
                    ("a WETH wrap", dict(tx, to="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", data=bytes.fromhex("d0e30db0")))):
        ask = {"chain": 1, "from": t["safe"], "to": t["to"], "value": str(t["value"]), "data": "0x" + t["data"].hex(), "nonce": NONCE}
        req = urllib.request.Request(os.environ.get("SIM_URL", "https://sim.wedgie.dev"), json.dumps(ask).encode(),
                                     {"content-type": "application/json", "user-agent": "wedgie-test"})
        sim = json.load(urllib.request.urlopen(req, timeout=60))
        try:
            got = safe_sim.check(t, sim, NONCE)
        except (ValueError, KeyError) as e:
            got = "%s: %s" % (e, sim)
        check(not isinstance(got, str) and len(got[1]) == len(sim["changes"]) > 0, "live, %s: %s" % (name, got,))

print("ALL PASS" if not bad else "%d FAILED" % bad)
sys.exit(1 if bad else 0)
