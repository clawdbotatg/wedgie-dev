#!/usr/bin/env python3
"""wire/from7730.py against the public ERC-7730 registry: every calldata descriptor converted to the wire format,
then every registry test transaction (testsv2: a real raw tx and what a wallet must show) checked against it.
For each one: a descriptor is found by (chain, to, selector); its signature verifies with the test key over
wire.signed_message; read in place (wire.at / elements / load, as a wedgie would) every field's values come out
of the transaction's calldata with wire.value, with no error; and the labels a wallet must show appear in
order among the encoded fields. Turning values into text ("50 USDC") is the next step, not checked here.
    uv run -q --with pycryptodome --with cryptography python3 tools/test_from7730.py [registry checkout]
(no checkout given: a shallow clone of ethereum/clear-signing-erc7730-registry in $TMPDIR)"""
import glob, json, os, subprocess, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "wire"))
import wire, from7730
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.exceptions import InvalidSignature

reg = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "erc7730-registry")
if not os.path.isdir(reg):
    subprocess.run(["git", "clone", "-q", "--depth", "1", "https://github.com/ethereum/clear-signing-erc7730-registry.git", reg], check=True)
head = subprocess.run(["git", "-C", reg, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
bad = 0


def check(ok, what):
    global bad
    print(("ok  " if ok else "FAIL"), what)
    bad += not ok


# ---- RLP, just enough for a raw transaction ----
def rlp(b, i=0):
    p = b[i]
    if p < 0x80:
        return b[i:i + 1], i + 1
    if p < 0xb8:
        return b[i + 1:i + 1 + p - 0x80], i + 1 + p - 0x80
    if p < 0xc0:
        n = p - 0xb7
        L = int.from_bytes(b[i + 1:i + 1 + n], "big")
        return b[i + 1 + n:i + 1 + n + L], i + 1 + n + L
    if p < 0xf8:
        L, j = p - 0xc0, i + 1
    else:
        n = p - 0xf7
        L, j = int.from_bytes(b[i + 1:i + 1 + n], "big"), i + 1 + n
    out, end = [], j + L
    while j < end:
        x, j = rlp(b, j)
        out.append(x)
    return out, end


def tx_of(raw):
    """(chain id, to, value, data) of a raw transaction."""
    b = bytes.fromhex(raw[2:])
    num = lambda x: int.from_bytes(x, "big")
    if b[0] >= 0xc0:                        # legacy: chain id from v, or v itself when unsigned (r, s empty)
        f = rlp(b)[0]
        v = num(f[6])
        chain = v if not f[7] and not f[8] else (v - 35) // 2 if v >= 35 else 1
        return chain, f[3], num(f[4]), f[5]
    f = rlp(b, 1)[0]
    if b[0] == 1:
        return num(f[0]), f[4], num(f[5]), f[6]
    return num(f[0]), f[5], num(f[6]), f[7]     # 2, 3, 4: [chain, nonce, prio, max fee, gas, to, value, data, ...]


# ---- convert everything ----
descs, skipped, made = {}, {}, 0
for fn in from7730.files(os.path.join(reg, "registry")):
    try:
        for chain, a, sel, b in from7730.convert(fn):
            descs.setdefault((chain, a, sel), []).append(b)
            made += 1
    except (ValueError, KeyError) as e:
        skipped[os.path.relpath(fn, reg)] = str(e)
print("registry %s: %d descriptors, %d files skipped (%s)" % (head, made, len(skipped), "; ".join("%s: %s" % kv for kv in sorted(skipped.items()))))
check(len(skipped) <= 3, "at most 3 files skipped (long text constants, encryption)")
check(max(len(b) for bs in descs.values() for b in bs) <= 4096, "every descriptor fits the spec's 4 KB (largest %d B)" % max(len(b) for bs in descs.values() for b in bs))
pub = from7730.test_key().public_key()


def labels(b, fi):
    """Labels in display order, group members included, read in place."""
    out = []
    for j in wire.elements(b, fi):
        f = wire.load(b, j)
        out += [f[0]] + ([g[0] for g in f[1][2]] if f[1][0] == 12 else [])
    return out


def values(f, cd, tx):
    p = f[1]
    if p[0] == 12:
        return sum((values(g, cd, tx) for g in p[2]), [])
    vs = [p[1]] + [x for x in p[2:] if isinstance(x, list) and len(x) == 3 and isinstance(x[2], list) and x[2] and isinstance(x[2][0], int) and x[2][0] in (0, 1, 2)]
    return [r for v in vs for r in wire.value(v, cd, tx)]


tests = sorted(glob.glob(os.path.join(reg, "registry/**/testsv2/calldata-*.tests.json"), recursive=True))
n = found = sig_ok = vals_ok = labels_ok = 0
fails = {"no descriptor": [], "signature": [], "values": [], "labels": []}
for tf in tests:
    for t in json.load(open(tf))["tests"]:
        n += 1
        chain, to, value, data = tx_of(t["rawTx"])
        name = "%s: %s" % (os.path.relpath(tf, reg), t["description"])
        cands = descs.get((chain, to, data[:4]))
        if not cands and os.path.relpath(os.path.normpath(os.path.join(os.path.dirname(tf), json.load(open(tf))["descriptor"])), reg) in skipped:
            n -= 1                          # its descriptor is one of the skipped files
            continue
        if not cands:
            fails["no descriptor"].append(name)
            continue
        found += 1
        b = cands[-1]
        m, env = wire.signed_message(b)
        try:
            pub.verify(env[3], bytes(m), ec.ECDSA(hashes.SHA256()))
            sig_ok += 1
        except InvalidSignature:
            fails["signature"].append(name)
        cd = data[4:]
        txc = [bytes.fromhex(t.get("from", "0x" + "00" * 20)[2:]), to, value.to_bytes(32, "big"), chain.to_bytes(32, "big")]
        fi = wire.at(b, 0, 10)
        try:
            for j in wire.elements(b, fi):
                values(wire.load(b, j), cd, txc)
            vals_ok += 1
        except ValueError as e:
            fails["values"].append("%s (%s)" % (name, e))
        want = []                           # each label once: an array or a group repeats them per element
        for f in t["expected"]["fields"]:
            if f["label"] not in want:
                want.append(f["label"])
        have = labels(b, fi)
        it = iter(have)
        if all(any(w == h for h in it) for w in want):
            labels_ok += 1
        else:
            fails["labels"].append("%s: want %s, have %s" % (name, want, have))

print("%d test transactions in %d files" % (n, len(tests)))
for k, v in fails.items():
    for x in v[:int(os.environ.get("SHOW", 5))]:
        print("     %s: %s" % (k, x))
    if len(v) > int(os.environ.get("SHOW", 5)):
        print("     %s: ... %d more" % (k, len(v) - int(os.environ.get("SHOW", 5))))
check(found == n, "a descriptor for %d of %d (tests of skipped files left out)" % (found, n))
check(sig_ok == found, "the test signature verifies on all %d" % sig_ok)
check(vals_ok == found, "every field's values read from the calldata on %d of %d" % (vals_ok, found))
check(labels_ok == found, "the labels to show are there, in order, on %d of %d" % (labels_ok, found))
print("%d FAILED" % bad if bad else "all ok")
sys.exit(1 if bad else 0)
