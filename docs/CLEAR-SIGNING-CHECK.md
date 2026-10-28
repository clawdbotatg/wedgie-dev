# Clear signing: what shipped, what a human must see

Goal (Austin, 10-27): every Safe Signer screen comes from an ERC-7730 descriptor (the EF registry's or ours in
`descriptors/`), one reader, no hand-written dapp code. Shipped first, tested after: every item below passed on
the virtual wedgie (`tools/safechip.mjs`), and **none has been seen on a real wedgie yet**. Screens of each:
wedgie.dev/clear.

## Shipped (Safe Signer on the shelf)

| App | What | Screens |
|---|---|---|
| safe-26 | Token pictures (ETH, USDC, USDT, WBTC, cbBTC, DAI), only for known addresses | any swap or send |
| safe-28 | Short amounts (6 decimals, or 4 digits past the zeros); CoinGecko top 1,000 tokens; Uniswap V2 | /clear#uniswap-v2 |
| safe-30, 31 | Universal Router from our ERC-8362 descriptor; `safe_ur.py` deleted. Optional fields hidden, tag bytes grey | /clear#uniswap-universal-router |
| safe-32 | SwapRouter02 from our descriptor (multicall, 5 chains); `_uniswap` deleted | /clear#uniswap-v3 |
| safe-33 | Owners, threshold, modules, recovery helpers, passkey signer from descriptors; local names (THIS wedgie, 14-day recovery) | /clear#safe-settings |
| safe-35 | ERC-20 approve and send from the registry's generic descriptor; red warnings for every dapp | (below) |

Red warnings (safe-35), the same rule for any dapp: on an approval or a module/guard/fallback change, an address
the wedgie has no name for and an unlimited amount; anywhere, a recipient the descriptor expects to be this Safe
that isn't ("not this Safe!").

## A human must see these on a real wedgie

Through wedgie.dev/safe (a real Safe, a dapp over WalletConnect: skill `virtual-wedgie` has the rig). Say no at
the end unless you mean it. Tick each when it looks right.

- [ ] **Uniswap app swap, ETH to USDC** (Universal Router, V4): 2-3 pages, "Send", "Pay at most", "Get at least" with
      the USDC picture, no red.
- [ ] **Uniswap swap, USDC to ETH** (needs an approval or Permit2 first): the approval page, then the swap.
- [ ] **A swap on Base**, and one on another chain (Arbitrum or Optimism).
- [ ] **Approve USDC to Uniswap**: "Uniswap" by name, black. **Approve unlimited to a random address**: red address,
      red "Unlimited USDC".
- [ ] **Send USDC** to an address: amount big with picture, address with blockie.
- [ ] **Add this wedgie as an owner** / remove an owner / change how many must sign (wedgie.dev/safe settings).
- [ ] **Turn on recovery** (14-day): named, not an address. A recovery helper add / cancel.
- [ ] **A batch** (Instant Wallet: a swap + the relay fee): reads, and no out-of-memory (a real wedgie crashed on
      this 10-27; see "Open" below).
- [ ] **Something with no descriptor**: the big red "can't read this" page, A still signs.

## Open

- **Batches** (MultiSend): still the hand-written reader. Next: our ERC-8362 MultiSend descriptor
  (`descriptors/safe/calldata-MultiSend.json`, written, not shipped). Someone's uncommitted fix for the 10-27 batch
  crash (`clear_buf`, `safe_7730.reads`) sits in the wedgie-safe worktree; no live session owns it.
- **Daily limit** (Zodiac Roles, Instant Wallet) and LI.FI: still hand-written.
- **Upstream:** PR the solid descriptors to the EF registry (descriptors/README.md). Open: SwapRouter02 multicall + 4 chains, ethereum/clear-signing-erc7730-registry#3161. Next: Candide recovery, passkey factory.
- One-pool V4 swaps name their tokens (a switch on `zeroForOne`); v4's 0 is hidden, the intent says it ("Take out
  what the swap gives"). Standard only: data b9845390, Safe Signer safe-43 (not yet signed).
