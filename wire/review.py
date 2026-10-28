#!/usr/bin/env python3
# The robot-checked descriptors wedgie.dev serves: clear-review's signed round (github.com/clawdbotatg/clear-review,
# docs/SIGNING.md) as wire structures the Safe Signer app checks against that round's root, which it saves once it has
# checked the round's signature with the key built into it. No new app per round: only the key is in the app.
#
# Each structure is release.py's own for that function, with the envelope [5, round, 0, b"", proof]: the proof folds
# leaf = SHA-256(0x00 || chainId (8) || address (20) || selector (4) || SHA-256(structure up to its envelope)) to the
# round's root. Only descriptors no auditor attested and not ours: those keep root a ("audited").
#
#   uv run -q -p 3.13 --with clearsig --with eth-account --with pycryptodome python3 wire/review.py \
#       <registry checkout at the round's commit> <clear-review rounds/<n>.json> <public/clear/review>
# Writes <out>/<n>/round.json (round, registry, root, signature), <out>/<n>/<chain>/<address>.json (selector ->
# structure), and <out>/latest.json ({"round": n}). The registry must be at the round's commit, or the structures
# differ from what was signed and are left out.
import hashlib, json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wire, release


def leaf(c, a, s, h):
    return hashlib.sha256(b"\x00" + c.to_bytes(8, "big") + a + s + h).digest()


def main():
    reg, rf, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    r = json.load(open(rf))
    sha = subprocess.run(["git", "-C", reg, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if sha != r["registry"]:
        sys.exit("registry is at %s, the round signed %s" % (sha[:7], r["registry"][:7]))
    signed = {(x["chainId"], x["address"].lower(), x["selector"], x["hash"]): x["proof"] for x in r["leaves"]}
    descs, _ = release.descriptors(reg)
    mine = {(c, a, s) for c, a, s, *_ in release.ours()}
    base = os.path.join(dst, str(r["round"]))
    files, n, root = {}, 0, bytes.fromhex(r["root"])
    for c, a, s, body, by, fn in descs:
        if by or (c, a, s) in mine:
            continue
        b = bytes(wire.dumps(body + [[5, r["round"], 0, b"", []]]))
        msg, env = wire.signed_message(b)
        h = hashlib.sha256(b[:len(msg) - len(bytes(wire.dumps(env[:3])))]).digest()
        proof = signed.get((c, "0x" + bytes(a).hex(), "0x" + bytes(s).hex(), "0x" + h.hex()))
        if proof is None:
            continue
        proof = [bytes.fromhex(p) for p in proof]
        x = leaf(c, bytes(a), bytes(s), h)
        for p in proof:
            x = hashlib.sha256(b"\x01" + (p + x if p < x else x + p)).digest()
        assert x == root, (c, a.hex(), s.hex())
        files.setdefault((c, "0x" + bytes(a).hex()), {})["0x" + bytes(s).hex()] = bytes(wire.dumps(body + [[5, r["round"], 0, b"", proof]])).hex()
        n += 1
    for (c, a), m in files.items():
        os.makedirs(os.path.join(base, str(c)), exist_ok=True)
        with open(os.path.join(base, str(c), a + ".json"), "w") as f:
            json.dump(m, f, separators=(",", ":"), sort_keys=True)
    with open(os.path.join(base, "round.json"), "w") as f:
        json.dump({k: r[k] for k in ("round", "registry", "root", "signature")}, f, indent=1)
    with open(os.path.join(dst, "latest.json"), "w") as f:
        json.dump({"round": r["round"]}, f)
    print("round %d: %d robot-checked functions in %d files (of %d signed)" % (r["round"], n, len(files), len(signed)))


if __name__ == "__main__":
    main()
