# Plan: descriptors for contracts that keep moving

Status 2026-11-13: not built. Written so we can build it later. Austin: "let's pretend 0x is never going to play
nice with clear signing. What kind of a system could we create that does it every time it needs to be done?"

## The problem

A clear-signing descriptor (ERC-7730) names the contract it describes by address. Some teams deploy a new copy of
their contract every few weeks. Each new copy has a new address, so the descriptor stops matching and the call goes
back to "can't read it".

The case that started this: **0x Settler**.

- A 0x swap is `AllowanceHolder.exec(operator, token, amount, target, data)`. AllowanceHolder never moves
  (`0x0000000000001fF3684f28c67538d4D072C22734`), and we have a descriptor for it (clear-descriptors
  `registry/0x/calldata-AllowanceHolder.json`, registry PR #3221).
- That descriptor shows what leaves: the token, the most that can be taken, who takes it.
- What comes back (the token bought, the least the signer accepts, who gets it) is in `data`, a call to the Settler
  (`target`): `execute((recipient, buyToken, minAmountOut), actions, zid)`, selector `0x1fff991f`.
- 0x redeploys Settler often. A descriptor listing today's Settler would be stale within weeks.
- So that half of the swap is red on a wedgie, and raw hex in every other wallet. About 20,000 mainnet
  transactions a week (erc7730.sourcify.dev, 11-12).

The same thing will happen with any team that redeploys instead of upgrading. The plan below isn't 0x-only.

## Why we can't just read `data` without knowing the Settler

We could describe `data` inside the AllowanceHolder descriptor and skip the address check. Don't: `target` can be
any contract. "Receive at least 0.007 WBTC" is only true if `target` is a real Settler. A fake one can ignore it.
The screen must only say it when the address is known to be 0x's.

## What makes it possible

0x keeps the list on-chain. Its Deployer (`0x00000000000004533Fe15556B1E086BB1A72cEae`, same address on every
chain) answers `ownerOf(feature)` with the current Settler:

| feature | what | Ethereum, 11-13 |
|---|---|---|
| 2 | swaps the user sends | `0xaddc26a3854feabfd20d6bf658254088d83a425a` |
| 3 | swaps a relayer sends for the user | `0x9a6350d532ed83a970d452b736be5847b2856768` |
| 4 | intents | `0xbfa23e39ebcb074696414fdd75ed2c9effbde688` |

Checked 11-13 through Alchemy: feature 2 on Ethereum is the `target` of 6 of the 7 real swaps we sampled (the
seventh went to another contract with another function: not a Settler, stays red). Base and Arbitrum answer too,
with their own addresses. What features 3 and 4 are is from 0x's docs, from memory: check before building.
So nobody has to guess, and nobody has to ask 0x.

## The solution: a robot that keeps the descriptor current

One small job, run every hour. For each contract family it watches (0x Settler first):

1. **Watch.** Ask the family's on-chain list for its current addresses, on every chain we serve
   (Alchemy, never a public RPC).
2. **Compare.** Any address not in the descriptor yet is new.
3. **Check it's the same contract in the ways that matter.** All must pass:
   - verified on Sourcify;
   - the described functions are there with the same signatures;
   - a real recent transaction to the new address, replayed through the descriptor, reads the same fields as
     before (the registry's runner and our `tools/test_clear.py`).
4. **Update.** Add the address to the descriptor's `deployments`. Add the replayed transaction as a test.
   Old addresses stay: people still have approvals and pending transactions on them.
5. **Ship.**
   - clear-descriptors: commit and push. Instant Wallet and wedgie.dev's web side pick it up within the hour.
   - The EF registry: open a PR as clawdbotatg, the same way we do by hand (clear-review `docs/FIXING.md`).
6. **Stop on surprise.** A changed signature, an unverified contract, or a test that reads differently: change
   nothing, tell us (Telegram), and say what differed.

What it needs per family, as a small config (no new code per family):

```
name, descriptor file, how to list current addresses (contract + call, or a deploy event), chains, functions that must match
```

## Two catches, and their fixes

**1. The registry needs a person to merge.** Every new Settler is unreadable in other wallets until a reviewer
merges our PR.

- Fix in the standard, already half there: a descriptor can say "any contract this factory deployed" instead of
  listing addresses (`context.contract.factory`: `deployEvent` + the factory's `deployments`). One registry
  descriptor uses it today (`railnet/calldata-Conduit.json`).
- What's missing: a wallet has to check the claim, and a hardware wallet can't look up an event. Someone has to
  hand it a proof it can check (a signed statement, or the address list as signed data).
- For 0x the natural form is "the address `Deployer.ownerOf(2)` returns", which isn't an event. That would need a
  small addition to the standard. Worth raising with the working group once the robot shows the need.

**2. A wedgie needs Austin's Touch ID for every data update.** The descriptors a wedgie trusts are two Merkle
roots built into Safe Signer, so new data means a new signed app. That's true for every descriptor, not only this.

- Fix: a signing key the wedgie trusts **for descriptors only**, so data can update without a new app. It's step
  2 and 3 of "next steps" in `wire/README.md` (signatures, trusted sources). The wire format allows secp256k1 and
  Ed25519; a wedgie checks P-256 fast. We asked Bacca to allow P-256 (10-20, no answer yet).
- Until then the robot still helps: the next Safe Signer release picks up whatever it added, and web wallets get
  it at once.

## Build order

1. The Settler descriptor by hand: `execute` on today's three addresses, per chain. Proves the fields and the
   screens. (A day.)
2. The robot for 0x Settler only: steps 1-6 above, PRs opened but checked by us before merge. (A day.)
3. The config file, so a second family is a few lines. Candidates: any contract the miss list
   (`clear-descriptors/tools/misses.py`) or wedgie.dev/clear's "no descriptor" list shows moving.
4. Raise the standard gap (catch 1) with the working group, with the robot's PR history as the evidence.
5. The descriptor signing key (catch 2). Its own plan; it unblocks much more than this.

## What it does not do

- It never changes what a descriptor says. It only adds addresses, and only when the contract reads the same.
- It never merges into the EF registry. A person there still decides.
- It doesn't help when a team changes the function itself. That's a new descriptor, written by hand.
