# A registry test file's transactions (real ones, from mainnet) as safechip cases: [{name, chainId, to, value, data,
# safe}], the sender as the Safe (so "this Safe" reads as it would for its owner). Then see them on a wedgie:
#   python3 tools/clear_txs.py <registry>/registry/uniswap/testsv2/calldata-UniswapV2Router02.tests.json > /tmp/v2.json
#   node tools/safechip.mjs --app ../wedgie-safe --txs /tmp/v2.json --shots <dir>     # every page of every one
import json, sys


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
    """(chain, to, value, data) of a signed or unsigned raw transaction (legacy, 2930, 1559, 7702)."""
    b = bytes.fromhex(raw[2:])
    num = lambda x: int.from_bytes(x, "big")
    if b[0] in (1, 2, 4):
        f = rlp(b[1:])[0]
        i = {1: 4, 2: 5, 4: 5}[b[0]]
        return num(f[0]), f[i], num(f[i + 1]), f[i + 2]
    f = rlp(b)[0]
    chain = num(f[6]) if len(f) > 6 else 1
    if len(f) == 9 and num(f[6]) > 36 and (num(f[7]) or num(f[8])):     # signed: v = chain * 2 + 35/36. Unsigned
        chain = (num(f[6]) - 35) // 2                                    # (EIP-155: v = chain, r = s = 0): as is
    return chain, f[3], num(f[4]), f[5]


out = []
for path in sys.argv[1:]:
    for t in json.load(open(path))["tests"]:
        if "rawTx" not in t:
            continue
        chain, to, value, data = decode(t["rawTx"])
        out.append({"name": t["description"], "chainId": chain, "to": "0x" + to.hex(), "value": str(value),
                    "data": "0x" + data.hex(), "safe": t.get("from", "0x" + "5a" * 20).lower()})
json.dump(out, sys.stdout, indent=1)
