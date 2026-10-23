---
name: wedgie-shop
description: Buying a wedgie or a wedgie kit at wedgie.dev/order - what each one is and what's in the box, the price and why it moves (surge pricing that melts back to $67), shipping (US included, worldwide +$20), paying by card or USDC (its own deposit address on Base, Ethereum, Arbitrum or Optimism), privacy (the address is sealed in the browser), tracking, signing in, price alerts, terms and returns. Use for "how do I get a wedgie", "how much is a wedgie", "order a kit", "where's my wedgie order", "pay with USDC", "give someone a wedgie".
---

# Buy a wedgie

Part of the wedgie skills. Index: https://wedgie.dev/skill.md. Or build one yourself from parts: build.md.

## What you can buy

| Item | List price | What it is |
|---|---|---|
| **wedgie** | **$67** shipped (US) | Assembled: Pico, screen hat, Trust M secure chip, printed case. Firmware and the Welcome app already on. Plug it in and go. |
| **wedgie kit** | **$57** shipped (US) | Every part and the case, with assembly instructions (also in 3D at wedgie.dev/assemble/3d). No soldering. You need a wire stripper, electrical tape, tweezers, a stiff wire or pin, and a USB data cable that fits the Pico (USB-C or micro USB). |

- Order: https://wedgie.dev/order. Up to 3 boxes per order (wedgies and kits together). Stock is shown; "Sold out"
  when it's gone.
- **Give someone a wedgie:** the same order, with their address as the shipping address.
- Built by hand by Austin and Gus Griffith. **Ships within a week**, by USPS.
- No USB cable in the box: use your own **data** cable (charge-only cables don't work).
- Want other parts or colors? https://wedgie.dev/build makes a link for any combination (Pico, chips, every
  printed part's color) to build yourself.

## What's in the box (assembled wedgie)

- The wedgie: a Pico (RP2040), a Waveshare Pico-LCD-1.3, an **OPTIGA Trust M** wedged between them, in the case
  (white lid, black base; buttons green, grey, grey, red).
- The owner's manual, folded (https://wedgie.dev/manual.pdf).
- **Checked before it ships** (wedgie.dev/prepare): every firmware file's hash is the latest signed release's;
  Welcome is its one app; its Trust M signs fresh random bytes with its factory key and that key's certificate
  chains to Infineon (a real chip); the chip's key slots are empty and unlocked (**nobody made a key on it**);
  no saves; every button pressed. A person looks at Welcome's check screen before it's boxed.
- First time: plug it in, go to https://wedgie.dev/connect in Chrome or Edge, update if asked, pick an app. If you
  install Safe Signer, its first screen **must** say **No key**: an address there means someone made a key
  before you; don't use it, email us.

## The price moves (surge pricing)

- Each box sold adds **$5** to the next one. The extra melts away evenly: a full day with no sales and it's back
  to $67 (kit $57). Open quotes count while they last. It's a VRGDA-style rule: sell faster than two people can
  build and the price climbs.
- During a surge, the price box (the green `*` or the green surge amount) has a red **Email alert**: one email the
  next time it's back to list, then the address is deleted.
- The price you see when you pay is the price you pay. A quote holds **10 minutes**; then Refresh price.

## Shipping

- **US:** included (USPS Ground Advantage).
- **Outside the US:** a flat **$20** per order; you pay any import tax or duty on arrival. Province, postal code and
  a phone number are asked. Not shipped to US-embargoed places (Cuba, Iran, North Korea, Syria, Russia, Belarus)
  or where USPS doesn't take mail.

## Paying

- **Card:** Stripe Checkout. Stripe never gets your shipping address.
- **USDC:** the order gets **its own deposit address**, the same on **Base, Ethereum, Arbitrum and Optimism**; any
  of the four counts. Send any amount, in one send or several, from any wallet, until it adds up (the page says
  "Got X. Send Y more."). Too much still counts as paid. Only native USDC (not USDC.e / USDbC). ETH sent by
  mistake counts at Chainlink's price. Paid shows in seconds on the L2s, ~30 s on Ethereum. A QR (EIP-681) opens
  a phone wallet with the amount filled in.
  - Deposit contract: factory `0x555B4c148102e6acA47edBD26e54Eb0FBfdB5C67` (same on all four, verified source);
    each order's address is CREATE2 and can only send to the shop's Safe, **wedgie.eth**
    (`0xf5d3C7F2fACeAAc12A75d66e3BE4365A21d0d43C`).

## Privacy

- **Your address is sealed in your browser** to the shipping computer's key before it leaves. Our server, Stripe
  and the blockchain never see it; it's deleted once the box is in the mail.
- **Your email** is kept only as a keyed hash plus a locked copy, used for sign-in links and the paid and shipped
  emails, and wiped after it ships.
- Details: https://wedgie.dev/privacy

## After you order

- **Your order:** `https://wedgie.dev/order/<id>`; all of yours at https://wedgie.dev/orders.
- **Sign in** on another device: https://wedgie.dev/signin, type your email, click the link it sends.
- **Steps:** Ordered, Paid, Shipped, On the way, Delivered (with times).
- Emails come from wedgie@buidlguidl.com.

## Terms, in short (https://wedgie.dev/terms)

- Seller: **BuidlGuidl DAO LLC** (Wyoming), 3307 S College Ave Unit 104, Fort Collins, CO 80525.
- Broken or dead on arrival: write within 30 days of delivery, replaced or refunded.
- Experimental hobby hardware, not for kids under 14, **not an audited hardware wallet**: don't keep more on it
  than you can afford to lose. We never see your keys and can't recover them.
- Can't ship within a week: we email you and you can cancel for a full refund. Lost package: we help.
- Contact: wedgie@buidlguidl.com · X @wedgiedev
