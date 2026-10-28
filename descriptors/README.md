# Our descriptors

ERC-7730 descriptors we write ourselves, added on top of the
[EF registry](https://github.com/ethereum/clear-signing-erc7730-registry) by `wire/release.py`. One of ours
replaces the registry's for the same function. They go in root a (no "not audited").

Goal: every Safe Signer screen comes from a descriptor (the registry's or ours); no hand-written readers.

**Upstream:** this folder is a staging area. Once a descriptor is solid (real txs, reviewed, looks right on a
wedgie), PR it to the registry so every wallet gets it. Always. Ones the spec can't take yet (ThisSafe's
`0x5afe..5afe` binding, ERC-8362 files) go up when it can, or as a proposal.

- `uniswap/calldata-UniversalRouter-v2.{0,1}.json`: the Universal Router, written to the ERC-8362 draft
  (Custom Encoding Layout, [ERCs PR #1925](https://github.com/ethereum/ERCs/pull/1925)) as it is: `commands` a
  `customEncoding` sequence, `inputs[]` a `switch` on `commands[$index]` masked `0x3f`, V4 actions a switch in a
  switch. v2.0 and v2.1 differ only in V4 swaps (`minHopPriceX36`, `maxHopPriceX36`). Made from Safe Signer's old
  `safe_ur.py` address list. V4 amounts use our two additions (`wire/README.md`): one-pool swaps name their tokens
  by `zeroForOne`, and v4's 0 (`OPEN_DELTA`) reads "all {token} the swap gives" (TAKE), "... the swap costs"
  (SETTLE), "... from before" (swap in), "... owed" (swap out). No optional pool/direction or "From" fields: the
  bundle Instant Wallet sends is at most 6600 B, and a two-token swap must fit with both tokens.

- `uniswap/calldata-SwapRouter02.json`: the router before it. The registry's swaps (our words), plus `multicall`
  with each call in it, unwrap/sweep (and their fee versions), refund, wrap, on 5 chains.

- `lifi/calldata-LIFIDiamond-swaps.json`: the registry's LI.FI same-chain swaps (6) plus `swapTokensGeneric`, with
  `senderAddress: "@.from"` on the receiver (ours, `wire/README.md`): red when it isn't this Safe. Bridges stay the
  registry's. Made by `tools/make_lifi.py` from the registry file.

The 0x..01 and 0x..02 recipients are Uniswap's "the caller" (this Safe) and "the router" (a step in the middle,
hidden). Fields a small screen can skip are `"visible": "optional"`.

A new or changed descriptor ships with a new data release (new roots), so a new Safe Signer version.
