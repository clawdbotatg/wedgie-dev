---
name: virtual-wedgie
description: Run and drive a virtual wedgie (real firmware on a virtual RP2040 with a fake Trust M) to test anything without hardware - installs, app screens, buttons, Safe signing, clear signing of dapp transactions (Uniswap, Morpho) through WalletConnect. Use when asked to test on a wedgie, bring up the virtual wedgie, propose/sign a Safe transaction, or check how a transaction looks on the wedgie.
---

# Virtual wedgie

wedgie.dev/virtual runs a whole wedgie in a browser tab: the real MicroPython build and firmware on a virtual
RP2040, a software Trust M, the screen and 9 buttons. wedgie.dev tabs in the same browser see it plugged
in, tagged **virtual**. Its ID is `EEE` + 3 digits. Its flash, ID and chip keys live in that browser's
storage: Wipe erases only the flash. Code and details: `docs/EMU.md`, `src/chip/`.

Two ways to run one:

## A. Headless, your own (no one's browser)

```
node tools/emu.mjs            # against wedgie.dev  (--local: this tree, built first)
```

curl API on `localhost:4190`: `/status`, `/screen` (png), `/history?n=10`, `/press {"k":"A"}`,
`/hold {"k":"up","down":true}`, `/open {"url":"/connect"}` -> `{tab}`, `/click {"tab","js"}`,
`/eval {"tab","js"}`, `/text?tab=1`, `/shot?tab=1`, `/wipe`. Quote URLs with `?` in fish.
Good for installs, app screens, buttons. No wallet, so no real Safe transactions.

## B. Austin's browser (the full rig: Safe + dapp)

Austin hands you a clawd-browser bridge URL (`http://<host>:8765/k/<token>`). Keep the token on every
request and never write it to a file in git. `curl -s <bridge>/skill` explains the API: POST `/cmd`
with `{"cmd","args","target"?}`.

Two browsers are connected: **Chrome** (wedgie.dev: /virtual and /safe) and **Brave** (the dapp). Find them
with `curl -s <bridge>/status` (the `ua` field: they differ by Chrome version) and pin each `open` with
`"target": "<id or UA substring>"`. Connection ids change on reconnect; tabs come back after blips.

### Bring the rig up (windows closed is fine)

```
open {url: "https://wedgie.dev/virtual"}                                                   target: Chrome
open {url: "https://wedgie.dev/safe/base:0x04247285F468d1fe2aeCE43DD111d69D7fe945cc"}  target: Chrome
open {url: "https://app.uniswap.org/swap?chain=base&inputCurrency=0x4200000000000000000000000000000000000006&outputCurrency=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}   target: Brave
```

The Safe (Base and Ethereum, 1 of 2: the virtual wedgie + austingriffith.eth) is
`0x04247285F468d1fe2aeCE43DD111d69D7fe945cc`. On Base it holds WETH and a little USDC.
The WalletConnect session usually survives closed windows: check /safe for "Connected Uniswap" and the
dapp for the Safe's balance before pairing again.

### Pair a dapp (only if it isn't connected)

1. Dapp: Connect -> Other wallets -> WalletConnect (Uniswap's path).
2. Catch the link: `eval` `navigator.clipboard.writeText = (t) => { window.__wc = t; }`, then `click`
   the "Copy link" button. It's in shadow DOM: walk `shadowRoot`s for an element whose text is
   "Copy link". Read `window.__wc`.
3. /safe: `click {selector: "#a-connect"}`, `type {selector: "#wc-uri", text: <link>}`,
   `click {selector: "#wc-go"}`. It says "Connected."

### Propose, look, sign

1. Dapp: `type` the amount (Uniswap: `[data-testid=amount-input-in]`), click Review, wait for the
   modal's Swap button to be fully opaque, click it. The request lands on /safe under Waiting.
2. /safe: `eval` `document.querySelector("[data-sign]").click()` (a trusted `click` on "Sign with
   wedgie" has missed before). Wait for "Look at the wedgie".
3. /virtual: save `window.wedgie.screen()`, `wait_for` it to change (the tx takes a few seconds over the
   virtual USB), then read every page: `window.wedgie.screen()` -> png -> Read it. `press("A")` is
   next/sign, `press("Y")` is no. Report what each page says and what's unclear.
4. /safe then says "Signed. That's enough: press Execute." **Austin presses Execute** (his wallet pays
   gas). Never press it yourself.

## Know

- Answer a wedgie question soon: it says no after 60 s of the chip's time (it runs at 20-70% speed).
- An install's yes is grey while the signature check runs: wait for green, then A.
- After a deploy, wait until the new bundle is live before reloading a tab, or it gets the old page.
- Austin can save the screen with the Screenshot button (a folder he picked once): "look at the
  screenshots" means that folder.
- Spend only what Austin asked for. Signing is fine when he asked; executing is his.
- Seen so far (clear signing to fix): Permit2 shows as a bare address, and its `approve` is
  "can't read this"; the unlimited WETH approval page doesn't name who gets it.
