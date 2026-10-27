# The shop (/order)

Sells assembled wedgies and kits. US shipping included; outside the US +$20 per order (`ABROAD`, catalog.ts), buyer pays import tax. The server knows only that an order is abroad (`cart.abroad`), never the country: that's in the sealed address. Code: `src/pages/order.ts`, `src/shop/`, `api/`.
Privacy rules (sealed address, hashed email): `CLAUDE.md`, "The shop".

## Who sells

**BuidlGuidl DAO LLC** (Wyoming), 3307 S College Ave Unit 104, Fort Collins, CO 80525.
Named on `/terms`, `/privacy`, the footer, and the pay box (`src/pages/legal.ts`, `SELLER`).

- `/terms`: sold as-is, broken on arrival = replace or refund within 30 days, liability capped at the
  price, not an audited wallet, kits built at your own risk, Colorado law.
- `/privacy`: what's kept and when it's deleted. Keep it true when the shop's data changes.

## Stock

Wedgies and kits each have their own count. Set them on omen: `orders.py stock wedgie 50`, `orders.py stock kit 50`
(`orders.py stock 50`: both; `orders.py stock` shows them). /order shows "N in stock" on each line. Each box paid since then, or held by an open quote, takes one; a canceled order gives its boxes back. Never set,
or 0: the site says Sold out. Up to 3 boxes per order. Unpaid money never holds a box (dust can't lock the stock);
a card quote holds its box until its Stripe checkout can't be paid (31 min). Shipped orders
deleted after 30 days come off the count, so their boxes aren't sold twice. A late USDC payment can still land on a
sold-out shop: `orders.py list` then says OVERSOLD. `api/_shop.ts` `stockLeft`; test: `node tools/stocktest.mjs`.

## Tracking

The order page shows Ordered, Paid, Shipped, On the way, Delivered, each a pixel sprite (`src/shop/steps.ts`).
The site never asks USPS: omen does (`orders.py track`, wedgie-shipping) and posts just the step and time to
`/api/admin` (`moving_at`, `delivered_at`). No USPS key on Vercel, and no place ever reaches the site.

## Card

Stripe Checkout (`api/_shop.ts`). Stripe never gets a shipping address.

## USDC

Every order gets **its own deposit address**. Whatever lands there is that order's: any amount, any
wallet, any number of sends, late or not.

The address is the same on Base, Ethereum, Arbitrum and Optimism, and all four count (`usdcGot`): USDC
on the wrong chain is fine. ETH sent by mistake counts at Chainlink's ETH/USD on Base (ignored if that
feed is over an hour old).

- Paid once the address holds the price (read a few blocks back: `PAY_CHAINS` `confirm`).
- Short: the page says "Got X. Send Y more."
- Too much: paid.
- Paid with the page closed: the shipping computer's list (`GET /api/admin`) checks open orders and
  marks them paid.
- The page checks every 2 seconds: Base, Arbitrum, Optimism show "Paid" in about 2–4 s (1 block), Ethereum about 30 s.

The addresses are CREATE2 (`src/shop/deposits.ts`), so nothing is deployed per order.

### The contract

`contracts/src/WedgieDeposits.sol`. Factory **`0x555B4c148102e6acA47edBD26e54Eb0FBfdB5C67`**, the same on
Base, Ethereum, Arbitrum and Optimism (deterministic deployer, salt 0). Its `shop` is wedgie.eth
(`0xf5d3C7F2fACeAAc12A75d66e3BE4365A21d0d43C`).
Source verified on all four explorers ([Basescan](https://basescan.org/address/0x555B4c148102e6acA47edBD26e54Eb0FBfdB5C67#code)).
Not audited by a person; an AI audit: https://www.onedollaraudit.com/audit/1012

**When to sweep:** when an order is boxed and shipped, not before. Until then its money waits at its own
address, so a refund (rare) is wedgie.eth calling `exec` to send it back from there.

- Sweep on each chain the money is on.
- `sweep(salt, token)`: deploys the order's Deposit if needed and sends all of that token to wedgie.eth.
  `token = 0` sweeps ETH. Anyone may call it; the money can't go anywhere else. An early sweep doesn't hide
  a USDC payment (`usdcGot` counts transfers in), but swept ETH is missed: check the Safe by hand.
- `sweepMany(salts, token)`: the same for many orders.
- `exec(salt, to, value, data)`: **wedgie.eth only**. The Deposit makes any call, for anything `sweep`
  can't move (NFTs, odd tokens). Deposits accept ERC-721 and ERC-1155 safe transfers.
- An order's salt: `keccak256("wedgie-order:" + id)` (`saltOf`).

**Never change the contract codes** in `deposits.ts`: every deposit address comes from them. New codes
strand money at the old addresses.

### Tools

```
node tools/deposits.mjs where <safe>                    # factory address
DEPLOY_KEY=… node tools/deposits.mjs deploy <safe> <rpc>        # deploy on a new chain
DEPLOY_KEY=… node tools/deposits.mjs sweep <safe> <rpc> <id>…   # move orders' USDC to wedgie.eth
ORDERS_PY=<wedgie-shipping>/orders.py node tools/shopprobe.mjs  # the whole shop on a Base fork
```

`DEPLOY_KEY` is any key with a little gas. It only pays gas: it can't take the money.

### Old orders

Orders from before 2026-10-15 were paid straight to wedgie.eth with an exact amount (`usdcPaid`,
`usdcFind`). They still work. Renewing one gives it a deposit address.

## CV claims (/claim)

A CLAWD staker burns 500,000,000 CV (clawdviction, larv.ai) for one free wedgie, one per wallet, while stock lasts. No other cap (Austin, 10-26). Brief:
`clawdviction/docs/WEDGIE-CLAIM.md`. Code: `api/_cv.ts`, `claim()` in `api/order.ts`, `claim()` in `src/pages/order.ts`.
The wallet signs larv.ai's fixed message; our server checks it, reserves the wallet (`cv_claims`, kept for good:
an order's payer is wiped at ship and the order deleted after 30 days), makes the order, asks larv.ai to burn, then
marks it paid (`pay 'cv'`, `cents 0`). A failed burn deletes both rows. A claim takes a box from stock but never
raises the price. Env: `CV_SPEND_SECRET` (larv.ai's; never logged, never to a browser; none = closed), `CV_API`
(default larv.ai), `CV_CLAIM_COST`. vite never loads `CV_*` from `.env`: the probe can't burn real CV.
Test: `node tools/claimprobe.mjs` (a fake larv.ai).

## Checkout counts

Where people stop. A number per day per step or error (`src/shop/count.ts`, `api/count.ts`): no IP, cookie, id, or typed text.
An expired order asks "Didn't buy? Why:" with 4 buttons. Read: `node tools/funnel.mjs [days]`.
Counting never waits or throws, so it can't break checkout.

## Price alerts

The red Email alert in the price's box (open it with the green * or the green surge amount; shows only during a surge).
`api/alert.ts` keeps the email like a buyer's: a keyed hash and a locked copy. Once the price is back to $67,
`sendAlerts` (`api/_mail.ts`) mails each one, then once more the next time it's $67 at least 2 weeks later, and deletes it. It runs on every `GET /api/order` (shop page
views) and every omen admin GET (the 3-hour track timer), so a quiet site still sends. Test: `node tools/mailprobe.mjs`.
