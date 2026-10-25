# Signed simulation: a clean swap screen the computer can't fake

Status 2026-10-25: `api/simulate.ts` is live on wedgie.dev. The screen is a prototype (not in Safe Signer yet).
Shots: wedgie.dev/clear/sim/1inch-v3-akita.png, wedgie.dev/clear/sim/1inch-v6-reverts.png.

## Why

A descriptor alone gave this for a 1inch swap: every decimal of ETH, a 15-digit "unknown token", labels like
"Beneficiary", and text off the side of the screen. The descriptor can't name the token: 1inch's `unoswap` only
passes pools. ERC-7730 also says nothing about rounding, short forms (1.2M) or small screens.

Rainbow shows what people want: what goes out, what comes in, each in dollars. It gets that by simulating the tx on
its own server, so you trust Rainbow's server. We want the same screen without trusting the computer.

## What the screen shows

```
Swap
1inch Network 0x1111..aa26
-0.00414 ETH      $9.68
+2.31B AKITA      $9.64
! 4 extra bytes (down)
```

- Amounts: 3 digits, rounded down, K/M/B/T, then 8.45e17. Decimals unknown: the raw number, shortened.
- Down: one page each, exact. What you send, what you get (and the tx's minimum), the contract, extra bytes,
  which block it was simulated at.
- Green signs, red says no, on any page. Up and down only move between pages.

## How it works

1. The page sends the tx to `POST wedgie.dev/api/simulate {chain, from, to, value, data, nonce, sig: "p256"}`.
2. wedgie.dev asks Alchemy: `debug_traceCall` (runs the tx on the latest block, sends nothing),
   `alchemy_getTokenMetadata` (names, decimals), the prices API (DexScreener fills gaps).
   `alchemy_simulateAssetChanges` isn't on our plan.
3. It adds up the sender's ETH and ERC-20 changes and signs them with P-256 (the same key as `/api/price`; its public
   half is in the wedgie-price app). The signed text is in the file's header.
4. The page passes the signed answer to the wedgie with the tx.
5. The wedgie checks the signature (Trust M, 0.2 s; pure Python 2.4 s), then checks the answer against the tx:
   ETH out must equal the tx's value; tokens in must be at least the descriptor's minimum. If either fails: red.

Why P-256: it's the only scheme a wedgie checks fast. The asker names the scheme (`sig`) so others can come later.

Limits: 60 a minute and 2,000 a day per IP, 20,000 a day in all. Austin gets a Telegram note (the shop's bot) when
the cap is hit or the count is down.

## Who can lie

- **The computer:** can't change the answer (the signature fails). It can block it (no clean screen), or resend an
  old one for the same tx until the wedgie picks its own nonce.
- **wedgie.dev, or anyone who hacks it or steals its key, or Alchemy:** can lie about token names and prices. Not
  about ETH going out or the minimum coming in: the wedgie checks those against the tx itself.
- **Not TLS.** The wedgie's MicroPython (the plain Pico build) has no TLS, and TLS would only prove "Alchemy said so".

## Plan: many simulators

1. **Open-source repo.** The simulator on its own, so anyone can run it with their own Alchemy key or node. One
   answer format, so answers can be compared byte for byte. wedgie.dev is simulator #1.
2. **The wedgie picks the nonce and the block.** No old answers, and every simulator runs the same block, so honest
   answers are identical.
3. **Ask several.** The wedgie has a list of simulator keys. It asks 3 and needs most to agree. Still checks each
   against the tx. One liar can't fool it.
4. **Your own.** Run one yourself (`npx` or Docker). It makes its own key; the wedgie shows its fingerprint and one
   green press adds it to the list. Run it on a different machine from the one the wedgie is plugged into: a hacked
   computer controls a simulator on itself too. Best with your own Ethereum node.
5. **Every host page needs the proxy.** wedgie.dev has it. Instant Wallet must get it too, or a wedgie plugged into
   it shows the old screen.

Later: simulators sign only a block's state root, and the computer proves single facts under it (a pool's tokens, a
Chainlink price) with Merkle proofs the wedgie checks itself.

## Files

- `api/simulate.ts`: the endpoint.
- `tools/safechip.mjs`: a case's `sim` goes with its tx; `keys` press the d-pad (`"wait"` = a second with none).
- The screen prototype: `docs/proto-sim/` (`safe_sim.py`, `safe.py.patch` for `_browse`). Not in the Safe Signer
  app yet. To see it: copy the app, add both, then `node tools/safechip.mjs --app <copy> --txs <cases> --shots <dir>`. Cases: `tools/clear_txs.py` output, each with `sim` (the
  /api/simulate answer, from = its safe) and `keys` (e.g. `["wait","down","wait","wait","down"]`).
