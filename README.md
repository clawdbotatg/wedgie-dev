# wedgie.dev

Give yourself a wedgie: a pocket computer from three off-the-shelf parts (a Pico, a Waveshare
Pico-LCD-1.3 hat, and a secure chip wedged in between). This repo is the website: order one, build
one, plug it in and put software on it, hand it to your agent.

- `index.html` — the loader. The underwear and the plastic bar paint from the first byte of HTML
  (the same boot screen as the device, picowallet `tools/bar` + `firmware/loader.py`); the bar fills
  by real bytes of every asset, turns green, and hands off to the site.
- `firmware/` — the wedgie firmware: the core (boot logo, WEDGIE drive, the slot that runs its one app,
  saves, drivers). Published to `/fw/` by `tools/fw.mjs`, with the apps: each in its own repo
  (`clawdbotatg/wedgie-*`), listed in `community.json` at a reviewed commit and signed with the firmware.
- `src/serial/` — WebSerial: every plugged-in wedgie, identified by its board ID (`wedgies.ts`),
  over MicroPython's raw REPL (`repl.ts`, from picowallet `factory/`); `install.ts` puts the core and
  its one app on, `files.ts` reads and writes its files and saves. `src/pages/connect.ts` is the list at /connect, `src/pages/wedgie.ts` one wedgie,
  `src/pages/format.ts` the wipe-and-test bench (/test, was /format), `src/pages/update.ts` the update bench (/update),
  `src/pages/build.ts` the build-your-own page (/build: app, chip, colors; every choice is in the URL, so a link is a wedgie).

**Heads-up for anyone who talks to a wedgie over USB:** about a second after it's plugged in, the
wedgie adds its WEDGIE drive, and its serial port disappears and comes back as a new port. Find it by
its ID, not its port, and don't soft-reset it just to restart its app. Details: `firmware/boot.py`.
- `public/device/probe.py` — board-side test code (screen, buttons, chip, `ident`), pasted into the
  raw REPL; nothing is written to flash.
- `public/skill.md` — the agent skill index at wedgie.dev/skill.md; it links the other guides in `public/*.md` (usb, build, safe, shop, virtual, security, code, trustm).
- `/code` (`src/pages/code.ts`) — make apps: the prompt for your AI, and the emulator (open a local folder or a
  GitHub repo, play it, it re-runs when a file changes, saves kept and editable). `public/code.md` is the
  app-building skill at wedgie.dev/code.md (app format, fast graphics with measured numbers).
- Apps from other repos: a repo with `wedgie.json` (rules: `src/apps/appjson.mjs`, one copy for build and
  site). Anyone adds one on their wedgie's page (`src/apps/repos.ts`, this browser only, marked not
  reviewed). `community.json` lists repos on everyone's shelf, each pinned to a reviewed commit;
  `node tools/community.mjs add owner/repo` copies that commit into `community/` (review the diff),
  `node tools/sign.mjs` signs them with the firmware, and `tools/fw.mjs` publishes them first on the
  site. Every app is its own repo (ours: `clawdbotatg/wedgie-*`); the steps are in `docs/APPS.md`.
  Starter: github.com/clawdbotatg/wedgie-starter.
- An app's internet (firmware 0.3.61+): `firmware/net.py` (`net.get`, `net.post`, `net.chain`, `net.price`), only for what
  the app's wedgie.json lists in `"net"`. A site (0.3.67+) is the wedgie's own TLS 1.3 (`firmware/tls.py`,
  `tls/README.md`): its wedgie.dev page (`src/serial/net.ts` answerTcp) carries the encrypted bytes through
  relay.wedgie.dev (`relay/`), `wedgie.py net` straight to the site. Ethereum reads and the price: the same TLS to
  mainnet.rpc.buidlguidl.com (`"chain"` allows it). Other chains go through `api/rpc.ts` (Alchemy key stays server-side). Tests: `node tools/test_net.mjs`, `node tools/netchip.mjs`, `python3 tls/test_tls.py`.
- `art/` + `tools/art.py` — source renders and the web images made from them.

```
npm install
npm run dev        # http://localhost:5173 (WebSerial works on localhost)
npm run build      # dist/, what Vercel serves
```

Deploy: Vercel, framework "Other", build `npm run build`, output `dist` (see `vercel.json`).

## Run it yourself (no wedgie.dev)

A clone is the whole thing: the site, the firmware, MicroPython (`public/mp/`) and the apps on the shelf
(`community/`). No `.env` needed.

- **The site:** `npm install`, `npm run dev`, open http://localhost:5173 in Chrome or Edge. Its pages set up,
  update and fill a wedgie from your clone's `firmware/`, not from wedgie.dev.
- **The terminal:** `WEDGIE_SITE=http://localhost:5173 python3 public/wedgie.py update` (any command).
- **No hardware:** `node tools/emu.mjs`, or `/virtual` on your local site (`docs/EMU.md`).
- **Your own firmware:** change `firmware/` and it is no longer signed by us, so a wedgie won't take it as an
  update. Put it on at `/reset` on your local site: hold BOOTSEL while plugging in, Find it, Reset it. That
  wipes its apps and saves; the chip and its keys aren't touched.
- **Your own releases:** put your two public keys in `RELEASE_KEYS` in `firmware/wedgie.py`, put that firmware
  on once at `/reset`, and from then on your wedgie takes updates you sign. `tools/sign.mjs` signs with a Mac's
  Secure Enclave (`tools/sekey.swift`) or a YubiKey (`tools/yksign.py`).

What still needs the internet or keys of your own: the shop (`/order`), the Safe pages, and an app's internet
through the page (it goes through relay.wedgie.dev; `wedgie.py net` goes straight to the site).

MIT — everything, including the art in `art/`.
