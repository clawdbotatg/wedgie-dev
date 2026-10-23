# wedgie-dev

The website (wedgie.dev) and the wedgie firmware. Overview: `README.md`. Read `EXPECTATIONS.md` first.
Push to main = deploy (Vercel). **Before every push that touches `src/`: `node tools/loadprobe.mjs`** (~13 s, every page on a phone).

## Docs that must stay true

- `public/skill.md` (the index) + `usb.md`, `build.md`, `safe.md`, `shop.md`, `virtual.md`, `security.md`, `code.md`,
  `trustm.md`: for outside agents (also `public/llms.txt`). Edit any time. The drive carries a frozen copy
  (`tools/drive_SKILL.md`); at a firmware release `tools/drive.py --refresh`. `tools/test_docs.py` checks them.
- App rules: `src/apps/appjson.mjs`, `folder_app` in `public/wedgie.py`, `public/code.md`. Keep in step.
- Style: `docs/STYLE.md`, enforced by `tools/test_style.py`. Apps: `docs/APPS.md`. Memory: `docs/PLAN-MEMORY.md`.
- Clear signing groundwork (ERC-7730 wire format, not used yet) and its next steps: `wire/README.md`.

## Accounts

X [@wedgiedev](https://x.com/wedgiedev) (log in with Google), Gmail wedgie@buidlguidl.com, ENS wedgie.eth.
Passwords: `.env` here and `~/.wedgie-credentials.env`. Never in git. New account: add to both.
The inbox: `python3 tools/mail.py list|read|send` (Gmail app password). Google 2-Step code: `python3 ~/.wedgie-totp.py`.

## Firmware rules

1. **Bump `VERSION`** in `firmware/wedgie.py` when the core changes.
2. **Compiled:** core files ship as `.mpy` (`tools/mpy.py`). Change the .py, rebuild, commit both.
3. **RAM is tight** (~190 KB, 16-color screen). The emulator can't catch memory bugs. Before shipping:
   `tools/chipprobe.mjs` and a real board. No `+=` growing strings; USB only through `wedgie.lines()`
   (`tools/test_memory.py`).
4. **New screen or question:** draw over the app, save nothing, a no reboots, rare code in its own file.
5. **Slow?** List every step click to screen, fix them all in one release.
6. **USB drops ~1 s after power-up** (the drive re-enumerates). Find a wedgie by ID, retry opens, never
   soft-reset just to restart the app. Details: `firmware/boot.py`.
7. **Locked:** a host gets the REPL only after a real A press (`slot.let_in`). Never add a way around it.
8. **Busy = the boot logo + bar** (`ui.progress`), one look (`firmware/ui.py`). Never "working...".
9. **Apps live in their own repos** (`clawdbotatg/wedgie-*`). Shelf: `node tools/community.mjs add|update`,
   `node tools/sign.mjs`, commit.
10. **Saves** (`/saves/<app>/`) are never touched by an install or update.
11. Nothing touches `navigator.serial` until the user tapped Connect (Mac Bluetooth prompt).
12. The page never drives a wedgie by default. Everything is MIT.

## The shop (/order)

Never holds an address it can read. The browser seals it (`src/shop/seal.ts`) to omen's key (`OMEN_KEY`,
committed; private half only on omen, `wedgie-shipping/orders.py`). `api/` (Vercel + Neon) keeps only the
sealed text and wipes it when omen ships. Stripe gets no address. Never log a request body in `api/`.
Email (`api/_mail.ts`, from wedgie@buidlguidl.com): stored only as a keyed hash (sign in by emailed link, `api/login.ts`) and
locked till it ships (paid + shipped mails). Test: `node tools/mailprobe.mjs`.
USDC: each order has its own deposit address; any amount counts. Never change the contract codes.
All of it: `docs/SHOP.md`. Private (EIN, Stripe, keys): `PRIVATE-SHOP.md`, local only, never commit.
Prices: `src/shop/catalog.ts`. Test: `ORDERS_PY=<wedgie-shipping>/orders.py node tools/shopprobe.mjs`.

## Run / check

```
npm run dev                                   # localhost:5173
npm run build && npx vite preview --port 4173
node tools/sign.mjs                           # the release gate
node tools/chipprobe.mjs                      # virtual RP2040, real heap
python3 tools/boardprobe.py buttons           # real board
node tools/safechip.mjs                       # Safe signer app on a virtual RP2040
```

Other probes: `ls tools/`.

**Virtual wedgie** (real firmware, fake Trust M, no hardware): `node tools/emu.mjs` and its curl API, or
wedgie.dev/virtual. Test installs, screens, buttons and signing on it before shipping: `docs/EMU.md`.
The full rig (Austin's browser, the Safe, a dapp over WalletConnect): skill `virtual-wedgie`.
Austin's screenshots of the virtual wedgie go in `screenshots/` (gitignored). "The screenshots from the simulator" = that folder; newest first (`ls -t`).
