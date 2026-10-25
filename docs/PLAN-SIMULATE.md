# Signed simulation: a clean swap screen the computer can't fake

Status 2026-10-25: the simulator is its own repo, [clear-sim](https://github.com/clawdbotatg/clear-sim), live at
https://sim.wedgie.dev (Vercel project `clear-sim`, BuidlGuidl team). The screen is a prototype (not in Safe Signer yet).
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

1. The page sends the tx to `POST https://sim.wedgie.dev {chain, from, to, value, data, nonce, sig: "p256"}`.
2. clear-sim runs it with `debug_traceCall` (Alchemy; sends nothing), asks each token its symbol and decimals, and
   prices it (Alchemy, then DexScreener).
3. It adds up the sender's ETH, ERC-20 and WETH changes and signs them with its own P-256 key (`GET` shows the public
   half). The signed text: clear-sim's SPEC.md.
4. The page passes the signed answer to the wedgie with the tx.
5. The wedgie checks the signature (Trust M, 0.2 s; pure Python 2.4 s), then checks the answer against the tx:
   ETH out must equal the tx's value; tokens in must be at least the descriptor's minimum. If either fails: red.

Why P-256: it's the only scheme a wedgie checks fast. The asker names the scheme (`sig`) so others can come later.

Limits: 60 a minute and 2,000 a day per IP, 20,000 a day in all, counted in memory per Vercel instance. A Telegram
note when the cap is hit, once `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set on the clear-sim project (not yet).

## Who can lie

- **The computer:** can't change the answer (the signature fails). It can block it (no clean screen), or resend an
  old one for the same tx until the wedgie picks its own nonce.
- **sim.wedgie.dev, or anyone who hacks it or steals its key, or Alchemy:** can lie about token names and prices. Not
  about ETH going out or the minimum coming in: the wedgie checks those against the tx itself.
- **Not TLS.** The wedgie's MicroPython (the plain Pico build) has no TLS, and TLS would only prove "Alchemy said so".

## Plan: many simulators

1. **Open-source repo.** Done: clear-sim. Anyone runs it with their own Alchemy key or node. One answer format, so
   answers can be compared byte for byte. sim.wedgie.dev is simulator #1. A wedgie-picked `block` is in it already.
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

- The simulator: github.com/clawdbotatg/clear-sim (`api/sim.ts`, `SPEC.md`).
- `tools/safechip.mjs`: a case's `sim` goes with its tx; `keys` press the d-pad (`"wait"` = a second with none).
- The screen prototype: `docs/proto-sim/` (`safe_sim.py`, `safe.py.patch` for `_browse`). Not in the Safe Signer
  app yet. To see it: copy the app, add both, then `node tools/safechip.mjs --app <copy> --txs <cases> --shots <dir>`. Cases: `tools/clear_txs.py` output, each with `sim` (the
  sim.wedgie.dev answer, from = its safe) and `keys` (e.g. `["wait","down","wait","wait","down"]`).
