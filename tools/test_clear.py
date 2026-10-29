#!/usr/bin/env python3
"""Clear signing end to end on CPython, against the public ERC-7730 registry's own test transactions (testsv2: a
real raw tx and what a wallet must show). wire/release.py builds the data (two Merkle roots), the bundle for each
tx is picked the way wedgie.dev/safe picks it (src/safe/clear.ts: the descriptor for (chain, to, selector), the
descriptors of any contract named in the calldata whose selector appears in it, the tokens named in it), and Safe
Signer's own reader (wedgie-safe safe_7730.py) turns it into text. Each field must equal what the registry expects,
except where a wedgie shows less on purpose (an address, not the name the test pretends a wallet knows).
    uv run -q -p 3.13 --with clearsig --with eth-account --with pycryptodome --with cryptography \\
        python3 tools/test_clear.py [registry checkout] [wedgie-safe checkout]
(defaults: a shallow clone in $TMPDIR, and ../wedgie-safe, else community/clawdbotatg/wedgie-safe)"""
import glob, json, os, subprocess, sys, tempfile, time, types, collections

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, "..")
sys.path.insert(0, os.path.join(root, "wire"))
import wire, release

reg = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "erc7730-registry")
if not os.path.isdir(reg):
    subprocess.run(["git", "clone", "-q", "--depth", "1", "https://github.com/ethereum/clear-signing-erc7730-registry.git", reg], check=True)
app = sys.argv[2] if len(sys.argv) > 2 else next(p for p in (os.path.join(root, "..", "wedgie-safe"),
                                                             os.path.join(root, "community", "clawdbotatg", "wedgie-safe")) if os.path.isdir(p))
bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


# ---- the tests and their tokens ----------------------------------------------------------------------
tests = []
extra = []
for tf in sorted(glob.glob(reg + "/registry/**/testsv2/calldata-*.tests.json", recursive=True)
                 + glob.glob(reg + "/ercs/**/testsv2/calldata-*.tests.json", recursive=True)):
    T = json.load(open(tf))
    dp = T.get("dataProvider") or {}
    for t in T["tests"]:
        tests.append((os.path.relpath(tf, reg), t, dp))
    # the tokens a test pretends a wallet knows: signed into this test's data like real ones (any chain: the
    # test tx says which)
    for a, v in (dp.get("tokens") or {}).items():
        for c in release.CHAINS:
            extra.append((c, a, v["symbol"], v["decimals"], v.get("name")))

# ---- the data, as wire/release.py makes it -------------------------------------------------------------
roots, out, skipped = release.build(reg, int(time.time()), extra)
D, TK = {}, {}
for kind, c, a, s, b, name in out:
    if kind == "d":
        D[(c, a, s)] = b
    else:
        TK.setdefault(c, {})[a] = b
check(len(skipped) <= 3, "at most 3 registry files skipped (%s)" % ", ".join(sorted(skipped)))
check(len(roots["a"]) == 32 and len(roots["b"]) == 32, "two roots")

# ---- the app's reader, with stand-ins for the screen modules -----------------------------------------
sys.path.insert(0, app)
sys.modules["safe_roots"] = types.SimpleNamespace(TAG="test", ROOTS=roots)
sys.modules["ui"] = types.SimpleNamespace(INK="INK", MUTED="MUTED", GREEN_D="GREEN", RED="RED")
NAT = {56: "BNB", 100: "XDAI", 137: "POL", 146: "S", 999: "HYPE", 5042: "USDC", 9745: "XPL", 42220: "CELO", 43114: "AVAX"}
import ast                                  # the app's own amount(), out of safe.py (which needs a screen to load)
_m = ast.Module([f for f in ast.parse(open(os.path.join(app, "safe.py")).read()).body
                 if isinstance(f, ast.FunctionDef) and f.name == "amount"], [])
_ns = {}
exec(compile(_m, "safe.py", "exec"), _ns)
sys.modules["safe"] = types.SimpleNamespace(BIG="big", ADDR="addr", CHAINS={1: "Ethereum"}, amount=_ns["amount"],
                                            coin=lambda tx: NAT.get(tx["chainId"], "ETH"))
import safe_7730 as R


# ---- a raw tx ------------------------------------------------------------------------------------------
def rlp(b, i=0):
    p = b[i]
    if p < 0x80:
        return b[i:i + 1], i + 1
    if p < 0xb8:
        return b[i + 1:i + 1 + p - 0x80], i + 1 + p - 0x80
    if p < 0xc0:
        n = int.from_bytes(b[i + 1:i + p - 0xb6], "big")
        return b[i + p - 0xb6:i + p - 0xb6 + n], i + p - 0xb6 + n
    if p < 0xf8:
        n, j = p - 0xc0, i + 1
    else:
        n, j = int.from_bytes(b[i + 1:i + p - 0xf6], "big"), i + p - 0xf6
    out, end = [], j + n
    while j < end:
        x, j = rlp(b, j)
        out.append(x)
    return out, end


def decode(raw):
    b = bytes.fromhex(raw[2:])
    num = lambda x: int.from_bytes(x, "big")
    if b[0] in (1, 2, 4):
        f = rlp(b[1:])[0]
        i = {1: 4, 2: 5, 4: 5}[b[0]]
        return num(f[0]), f[i], num(f[i + 1]), f[i + 2]
    f = rlp(b)[0]
    chain = num(f[6]) if len(f) > 6 else 1
    if len(f) == 9 and num(f[6]) > 36:
        chain = (num(f[6]) - 35) // 2
    return chain, f[3], num(f[4]), f[5]


# ---- the bundle, the way the page picks it -------------------------------------------------------------
def bundle(chain, to, data):
    ds = [D[(chain, to, data[:4])]] if (chain, to, data[:4]) in D else []
    words = {data[k + 12:k + 32] for k in range(4, len(data) - 31) if not any(data[k:k + 12])} | {to}
    for (c, a, s), b in D.items():          # contracts the calldata names, whose selector it carries
        if c == chain and a in words and (c, a, s) != (chain, to, data[:4]) and s in data[4:]:
            ds.append(b)
    named = data + b"".join(ds)             # tokens the calldata or a descriptor (a constant) names
    ts = [b for a, b in TK.get(chain, {}).items() if a in words or a in named]
    return bytes(wire.dumps({8: [wire.loads(x) for x in ts], 13: [wire.loads(x) for x in ds]}))


def same(got, want, dp, kind=None):
    names = {}
    for k in ("addressNames", "ensNames"):
        names.update({v.lower(): a.lower() for a, v in (dp.get(k) or {}).items()})
    if isinstance(want, dict):
        if not (isinstance(got, tuple) and got[0] == "call" and got[3] is not None):
            return False
        _, intent, owner, sub, _ = got
        wf = want.get("fields", [])
        return intent == want.get("intent") and len(sub) == len(wf) and all(
            l == f["label"] and same(t, f["value"], dp, k) for (l, t, k), f in zip(sub, wf))
    if isinstance(got, tuple):
        return False
    w = names.get(want.lower(), want)
    if want == "Sender" and kind == "safe":     # a sender address: the wedgie says "this Safe"
        return True
    return got.lower() == w.lower()


def ok_diff(label, got, want):
    """A difference a wedgie means: it has no NFT collection names (it shows "#id of 0x.."), it knows a token
    the test runner didn't ("1471.08 USDC" for "1471080000"), it marks a token it doesn't know ("(unknown token)"),
    or a call inside has no descriptor and shows its callee."""
    if isinstance(got, tuple):
        return got[3] is None or isinstance(want, dict)
    if isinstance(want, dict):
        return False
    if " of 0x" in got and got.startswith("#") and want.endswith(got.split(" of ")[0]):
        return True
    if got == want + " (unknown token)" or got.split(" of 0x")[0] == want:
        return True
    g, w = got.split(" ", 1), want.split(" ", 1)          # an amount cut short: "0.0009026 WETH" for 0.000902656..
    if len(g) == 2 and len(w) == 2 and g[1] == w[1] and "." in w[0] and w[0].startswith(g[0]) and \
            w[0].split(".")[0] == g[0].split(".")[0]:
        return True
    return want.isdigit() and got.split(" ")[0].replace(".", "").lstrip("0") == want.rstrip("0").lstrip("0")


OURS = {(c, a, s) for c, a, s, *_ in release.ours()}     # our descriptors (clear-descriptors): our words, not the test's
stats, why = collections.Counter(), collections.defaultdict(list)
for fn, t, dp in tests:
    chain, to, value, data = decode(t["rawTx"])
    if chain not in release.CHAINS or fn.replace("/testsv2/", "/").replace(".tests.json", ".json") in skipped:
        stats["out of scope"] += 1          # a chain Safe Signer doesn't do, or a file the wire format can't carry
        continue
    tx = {"chainId": chain, "safe": t.get("from", "0x" + "00" * 20).lower(), "to": "0x" + to.hex(), "value": value, "data": data}
    try:
        intent, owner, trust, its = R.items(tx, bundle(chain, to, data))
    except R.Bad as e:
        stats["refused"] += 1
        why["refused: " + str(e).split(":")[0][:50]].append(fn + " :: " + t["description"])
        continue
    if (chain, to, data[:4]) in OURS:
        stats["ours: reads, in our own words"] += 1
        continue
    its = [x for x in its if x[2] != "label" and x[0]]          # group labels and our own warnings: extra lines
    want = t["expected"]
    wf = want.get("fields", [])
    if intent != want.get("intent") and not isinstance(want.get("intent"), dict):
        stats["intent"] += 1
        why["intent differs"].append("%s :: %r vs %r" % (fn, intent, want.get("intent")))
        continue
    if [l for l, _, _ in its] != [f["label"] for f in wf]:
        stats["labels"] += 1
        why["labels differ"].append("%s :: %s vs %s" % (fn + " :: " + t["description"], [l for l, _, _ in its], [f["label"] for f in wf]))
        continue
    diff = [(l, g, f["value"]) for (l, g, k), f in zip(its, wf) if not same(g, f["value"], dp, k)]
    known = [d for d in diff if not ok_diff(*d)]
    if diff and not known:
        stats["match, but shows more or less on purpose"] += 1
        stats[trust] += 1
        continue
    if diff:
        stats["values"] += 1
        why["values differ"].append("%s :: %s" % (fn + " :: " + t["description"], diff[:2]))
        for l, g, wv in known:
            why["diff"].append((fn, l, g, wv))
    else:
        stats["match"] += 1
        stats[trust] += 1

# ---- a host can only leave things out ------------------------------------------------------------------
fn, t, dp = next(x for x in tests if "aave/testsv2/calldata-lpv3" in x[0] and x[1]["description"] == "Repay loan - chain 1")
chain, to, value, data = decode(t["rawTx"])
tx = {"chainId": chain, "safe": "0x" + "5a" * 20, "to": "0x" + to.hex(), "value": value, "data": data}
good = bundle(chain, to, data)
check(R.items(tx, good)[0] == "Repay loan", "Aave repay reads (the base for the tamper checks)")


def refused(b, what):
    try:
        R.items(tx, b)
        check(False, what)
    except (R.Bad, ValueError) as e:
        check(True, "%s (%s)" % (what, e))


d = D[(chain, to, data[:4])]
i = d.find(b"Repay loan")
refused(bytes(wire.dumps({8: [], 13: [wire.loads(d[:i] + b"Repay LOAN" + d[i + 10:])]})), "one changed letter in the intent: refused")
x = wire.loads(d)
x[-1][4][0] = bytes(32)
refused(bytes(wire.dumps({8: [], 13: [x]})), "a changed proof: refused")
x = wire.loads(d)
x[2] = bytes(20)
refused(bytes(wire.dumps({8: [], 13: [x]})), "the descriptor moved to another contract: refused")
other = next(b for (c, a, s), b in D.items() if c == chain and a != to)
refused(bytes(wire.dumps({8: [], 13: [wire.loads(other)]})), "another contract's descriptor: no descriptor for this call")
tk = wire.loads(next(iter(TK[chain].values())))
tk[3] = "USDC"
its = R.items(tx, bytes(wire.dumps({8: [tk], 13: [wire.loads(d)]})))[3]
check(its[0][2] == "token?", "a token renamed by the host is ignored: %r" % (its[0][1],))

if os.environ.get("DUMP"):
    json.dump(why, open(os.environ["DUMP"], "w"), indent=0, default=repr)
n = len(tests) - stats["out of scope"]
print("%d registry test transactions: %s" % (n, dict(stats)))
for k, v in sorted(((k, v) for k, v in why.items() if k != "diff"), key=lambda kv: -len(kv[1])):
    print("  %4d %s\n       e.g. %s" % (len(v), k, "\n            ".join(x[:400] for x in v[:3])))
same_ = stats["match"] + stats["match, but shows more or less on purpose"] + stats["ours: reads, in our own words"]
check(stats["match"] >= int(os.environ.get("MIN_MATCH", 1350)), "%d of %d show exactly what the registry expects" % (stats["match"], n))
check(n - same_ <= int(os.environ.get("MAX_OFF", 40)), "%d of %d differ in a way not explained" % (n - same_, n))
print("all ok" if not bad else "%d FAILED" % bad)
sys.exit(1 if bad else 0)
