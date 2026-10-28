# Our LI.FI swaps: the registry's 6 GenericSwapFacetV3 swaps + swapTokensGeneric, the receiver must be the sender.
import json, sys, copy
reg, out = sys.argv[1], sys.argv[2]
d = json.load(open(reg + "/registry/lifi/calldata-LIFIDiamond.json"))
f = {k: v for k, v in d["display"]["formats"].items() if k.startswith("swapTokens")}
assert len(f) == 6, len(f)
multi = [k for k in f if k.startswith("swapTokensMultipleV3ERC20ToERC20")][0]
g = copy.deepcopy(f[multi])
for x in g["fields"]:
    if x["path"] == "_minAmountOut":
        x["path"] = "_minAmount"
g["interpolatedIntent"] = g["interpolatedIntent"].replace("_minAmountOut", "_minAmount")
f["swapTokensGeneric(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmount, "
  "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, "
  "bool requiresDeposit)[] _swapData)"] = g
for v in f.values():
    for x in v["fields"]:
        if x["path"] == "_receiver":
            x["params"]["senderAddress"] = "@.from"
d["display"]["formats"] = f
d["$schema"] = "https://eips.ethereum.org/assets/eip-7730/erc7730-v2.schema.json"
json.dump(d, open(out, "w"), indent=2)
open(out, "a").write("\n")
