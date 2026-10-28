#!/usr/bin/env python3
# The clear-signing data wedgie.dev serves, made from the public ERC-7730 registry (and token lists), for the Safe
# Signer app (clawdbotatg/wedgie-safe safe_7730.py). Runs on the computer, never on a wedgie.
#
# Every descriptor (transaction-info) and token (token-information) is a wire-format structure signed with
# algorithm 4: no signature, a Merkle proof to a root built into the app (spec v 29.09.26-1, as PQ1). The app
# itself is signed when wedgie.dev publishes it, so nothing here needs a key. Two roots:
#   a: descriptors an auditor we trust attested (ERC-8176, EAS offchain, checked here), ours (descriptors/), tokens
#   b: every other descriptor: the wedgie shows "not audited"
# Leaf = SHA-256(0x00 || message), node = SHA-256(0x01 || the smaller hash || the bigger), an odd one out goes up
# as is; message = the structure with its envelope cut to [4, leaf index, issued-at] (wire.signed_message).
# Descriptors are compiled from clearsig's merge of a file's includes: the same JSON an auditor hashes.
#
#   uv run -q -p 3.13 --with clearsig --with eth-account --with pycryptodome python3 wire/release.py \
#       <registry checkout> <public/clear> <wedgie-safe/safe_roots.py>
# Writes <public/clear>/<tag>/{index.json, <chain>/<address>.json (selector -> structure), <chain>/tokens.json}
# and safe_roots.py (TAG, ROOTS). tag: the first 8 hex of SHA-256(root a || root b).
import hashlib, json, os, subprocess, sys, time, urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wire, from7730

AUDITORS = {"0x3846c3a30e62075fa916216b35ef04b8f53931f6": "Cyfrin"}     # registry auditors/ we accept
EAS_SCHEMA = "0xe023eef113c1670774801c34b377fdf612dd8a4d2fa92fe382e15bd91fafb5c2"   # ERC-8176's EAS schema id, public (gitleaks:allow)
CHAINS = {1, 10, 56, 100, 137, 146, 999, 4663, 5042, 8453, 9745, 42161, 42220, 43114, 84532, 11155111}   # wedgie-safe's
CLEAR_MAX = 10000   # bytes of bundle the app made with this release takes (safe-30+; older apps: 6000, src/safe/clear.ts)
# The registry's descriptors for any contract of a kind (no addresses): bound to ANY, which the app reads a call
# with when no descriptor is under its own address. Only ERC-20 for now: ERC-721's approve has the same selector.
GENERIC = {"ercs/calldata-erc20-tokens.json"}
ANY = "0x7730773077307730773077307730773077307730"
OURS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "descriptors")   # ours, on top of the registry
TOKEN_LIST = "https://tokens.uniswap.org"
# then CoinGecko's top 1,000 coins by market cap, on the chains it lists (decimals from its per-chain token lists).
# A ticker already taken on that chain by another address is left out: no second "USDC".
GECKO = "https://api.coingecko.com/api/v3"
GECKO_TOP = 1000
GECKO_CHAINS = {"ethereum": 1, "optimistic-ethereum": 10, "binance-smart-chain": 56, "xdai": 100, "polygon-pos": 137,
                "sonic": 146, "base": 8453, "arbitrum-one": 42161, "celo": 42220, "avalanche": 43114}
TOKENS = [          # the token list's gaps: test networks /safe uses, and staking/stable tokens the registry's
    (84532, "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", 6, "USD Coin"),          # descriptors name
    (11155111, "0x1c7D4B196Cb0C7B01d743fbc6116a902379C7238", "USDC", 6, "USD Coin"),       # (symbol(), decimals()
    (1, "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", "stETH", 18, "Liquid staked Ether 2.0"),    # read on chain
    (1, "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "wstETH", 18, "Wrapped liquid staked Ether 2.0"),  # 10-22)
    (1, "0xae78736Cd615f374D3085123A210448E74Fc6393", "rETH", 18, "Rocket Pool ETH"),
    (1, "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", "weETH", 18, "Wrapped eETH"),
    (1, "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", "USDe", 18, "USDe"),
    (1, "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", "sUSDe", 18, "Staked USDe"),
    (1, "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", "GHO", 18, "Gho Token"),
    (1, "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", "crvUSD", 18, "Curve.Fi USD Stablecoin"),
    (1, "0x83F20F44975D03b1b09e64809B757c47f942BEeA", "sDAI", 18, "Savings Dai"),
    (1, "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "UNI", 18, "Uniswap"),
    (8453, "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", "wstETH", 18, "Wrapped liquid staked Ether 2.0"),
    (8453, "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", "cbETH", 18, "Coinbase Wrapped Staked ETH"),
    (8453, "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", "weETH", 18, "Wrapped eETH"),
    (8453, "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", "USDS", 18, "USDS Stablecoin"),
    (8453, "0x940181a94A35A4569E4529A3CDfB74e38FD98631", "AERO", 18, "Aerodrome"),
]


def leaf(msg):
    return hashlib.sha256(b"\x00" + bytes(msg)).digest()


def node(a, b):
    return hashlib.sha256(b"\x01" + (a + b if a < b else b + a)).digest()


def tree(leaves):
    """(root, proof(i)) for a list of leaf hashes."""
    levels = [list(leaves)]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        levels.append([node(cur[i], cur[i + 1]) if i + 1 < len(cur) else cur[i] for i in range(0, len(cur), 2)])

    def proof(i):
        out = []
        for lv in levels[:-1]:
            j = i ^ 1
            if j < len(lv):
                out.append(lv[j])
            i //= 2
        return out
    return levels[-1][0], proof


def attested(path, doc_hash, reg):
    """The auditors whose ERC-8176 attestation of this exact descriptor checks out."""
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    sigs = Path(path).parent / "sigs"
    base = Path(path).stem
    out = []
    for f in sorted(sigs.glob(base + ".*.json")) if sigs.is_dir() else []:
        try:
            a = json.loads(f.read_text())
            s = a["sig"]
            m = s["message"]
            if m["schema"].lower() != EAS_SCHEMA or m["data"].lower() != "0x" + doc_hash.hex() or int(m["expirationTime"]):
                continue
            types = dict(s["types"])
            types["EIP712Domain"] = [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                                     {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}]
            dom = dict(s["domain"])
            dom["chainId"] = int(dom["chainId"])
            msg = dict(m)
            for k in ("version", "time", "expirationTime"):
                msg[k] = int(msg[k])
            sm = encode_typed_data(full_message={"types": types, "primaryType": s["primaryType"], "domain": dom, "message": msg})
            v = s["signature"]
            who = Account.recover_message(sm, vrs=(v["v"], int(v["r"], 16), int(v["s"], 16))).lower()
            if who in AUDITORS and who == a.get("signer", "").lower():
                out.append(AUDITORS[who])
        except Exception as e:
            print("  attestation %s: %s" % (f.name, e))
    return out


def descriptors(reg):
    """[(chain, address bytes, selector bytes, body, audited by [names], file)] for every calldata descriptor."""
    from clearsig._descriptor_hash import descriptor_hash
    from clearsig._includes import resolve_includes
    out, skipped = [], {}
    for fn in from7730.files(os.path.join(reg, "registry")) + from7730.files(os.path.join(reg, "ercs")):
        try:
            p = Path(fn)
            raw = json.loads(p.read_text())
            if "contract" not in (raw.get("context") or {}) and "includes" not in raw:
                continue
            doc = resolve_includes(raw, p.parent)
            rel = os.path.relpath(fn, reg)
            if rel in GENERIC:  # any token: bound to ANY, which the app falls back to (wedgie-safe safe_book)
                doc = dict(doc, context=dict(doc["context"], contract={"deployments": [
                    {"chainId": c, "address": ANY} for c in sorted(CHAINS)]}))
            if "contract" not in (doc.get("context") or {}) or "deployments" not in doc["context"]["contract"]:
                continue        # an interface others include, or a factory binding: no addresses of its own
            by = attested(fn, descriptor_hash(p), reg)
            bodies = from7730.convert(fn, doc=doc, seal=lambda body: body)
            out += [(c, a, s, b, by, os.path.relpath(fn, reg)) for c, a, s, b in bodies if c in CHAINS]
        except (ValueError, KeyError, OSError) as e:
            skipped[os.path.relpath(fn, reg)] = str(e)
    return out, skipped


def ours(root=OURS):
    """Our own descriptors (wedgie-dev descriptors/): root a, and over the registry's for the same function.
    Compiled in full here: a file that won't compile stops the release."""
    out = []
    for fn in from7730.files(root):
        doc = from7730.load(fn)
        out += [(c, a, s, b, ["wedgie"], os.path.relpath(fn, os.path.dirname(root)))
                for c, a, s, b in from7730.convert(fn, doc=doc, seal=lambda body: body) if c in CHAINS]
    return out


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "wedgie.dev release"}), timeout=60) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(20)                  # CoinGecko's free API: a few calls a minute


def gecko():
    """[(chain, address, ticker, decimals, name)] of CoinGecko's top GECKO_TOP coins, biggest first."""
    top = []
    for page in range(1, GECKO_TOP // 250 + 1):
        top += get("%s/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=%d" % (GECKO, page))
    where = {x["id"]: x.get("platforms") or {} for x in get(GECKO + "/coins/list?include_platform=true")}
    lists = {c: {t["address"].lower(): t for t in get("https://tokens.coingecko.com/%s/all.json" % p)["tokens"]}
             for p, c in GECKO_CHAINS.items()}
    out = []
    for coin in top:
        for p, a in where.get(coin["id"], {}).items():
            t = lists.get(GECKO_CHAINS.get(p), {}).get((a or "").lower())
            if t:
                out.append((GECKO_CHAINS[p], t["address"], t["symbol"], t["decimals"], t.get("name")))
    return out


def tokens(extra=()):
    """[(chain, address bytes, ticker, decimals, name)] from the Uniswap token list, TOKENS, then CoinGecko's top."""
    lst = get(TOKEN_LIST)["tokens"]
    seen, out = set(), []
    first = [(x["chainId"], x["address"], x["symbol"], x["decimals"], x.get("name")) for x in lst] + TOKENS + list(extra)
    taken = {(t[0], t[2].lower()): t[1].lower() for t in reversed(first)}
    for t in first + [(None,) + g for g in gecko()]:
        late = t[0] is None
        t = t[1:] if late else t
        k = (t[0], t[1].lower())
        if late and taken.setdefault((t[0], t[2].lower()), k[1]) != k[1]:
            continue                        # a ticker another address already has on this chain
        if t[0] in CHAINS and k not in seen and len(t[2]) <= 16:
            seen.add(k)
            out.append((t[0], bytes.fromhex(t[1][2:]), t[2], int(t[3]), t[4]))
    return out


def build(reg, issued, extra_tokens=()):
    """{ "a"/"b": root }, [(kind, chain, address, key, structure bytes, root name)], skipped files."""
    descs, skipped = descriptors(reg)
    mine = ours()
    taken = {(c, a, s) for c, a, s, *_ in mine}
    descs = [d for d in descs if d[:3] not in taken] + mine
    toks = tokens(extra_tokens)
    sets = {"a": [], "b": []}
    for c, a, s, body, by, fn in descs:
        sets["a" if by else "b"].append(("d", c, a, s, body))
    for c, a, tk, d, nm in toks:
        sets["a"].append(("t", c, a, None, [1, c, a, tk, d, nm]))
    roots, out = {}, []
    for name, items in sets.items():
        msgs = []
        for i, (kind, c, a, s, body) in enumerate(items):
            msgs.append(bytes(wire.dumps(body + [[4, i, issued]])))
        root, proof = tree([leaf(m) for m in msgs])
        roots[name] = root
        for i, (kind, c, a, s, body) in enumerate(items):
            out.append((kind, c, a, s, bytes(wire.dumps(body + [[4, i, issued, b"", proof(i)]])), name))
    return roots, out, skipped


def main():
    reg, dst, roots_py = sys.argv[1], sys.argv[2], sys.argv[3]
    sha = subprocess.run(["git", "-C", reg, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    issued = int(time.time())
    roots, out, skipped = build(reg, issued)
    tag = hashlib.sha256(roots["a"] + roots["b"]).hexdigest()[:8]
    base = os.path.join(dst, tag)
    files = {}
    for kind, c, a, s, b, name in out:
        k = (c, "tokens" if kind == "t" else "0x" + a.hex())
        files.setdefault(k, {})["0x" + (a.hex() if kind == "t" else s.hex())] = b.hex()
    for (c, n), m in files.items():
        os.makedirs(os.path.join(base, str(c)), exist_ok=True)
        with open(os.path.join(base, str(c), n + ".json"), "w") as f:
            json.dump(m, f, separators=(",", ":"), sort_keys=True)
    n = {k: sum(1 for x in out if x[5] == k and x[0] == "d") for k in roots}
    nt = sum(1 for x in out if x[0] == "t")
    with open(os.path.join(base, "index.json"), "w") as f:
        json.dump({"tag": tag, "registry": sha, "issued": issued, "roots": {k: v.hex() for k, v in roots.items()},
                   "audited": n["a"], "notAudited": n["b"], "tokens": nt, "auditors": sorted(set(AUDITORS.values())),
                   "clearMax": CLEAR_MAX}, f, indent=1)
    with open(roots_py, "w") as f:
        f.write("# Safe Signer: the roots of the clear-signing data it trusts. Made by wedgie-dev wire/release.py, don't edit.\n"
                "# Registry %s, issued %d. a: audited (%s) descriptors and tokens; b: the rest, \"not audited\".\n"
                "TAG = \"%s\"\nROOTS = {\"a\": %r, \"b\": %r}\n" % (sha[:7], issued, ", ".join(sorted(set(AUDITORS.values()))), tag, roots["a"], roots["b"]))
    print("tag %s: %d audited + %d not audited descriptors, %d tokens, %d files, %d registry files skipped" % (
        tag, n["a"], n["b"], nt, len(files), len(skipped)))
    for fn, why in sorted(skipped.items()):
        print("  skip %s: %s" % (fn, why))


if __name__ == "__main__":
    main()
