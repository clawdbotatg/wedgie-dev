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
  `src/pages/format.ts` the wipe-and-test bench (/format, was /test), `src/pages/update.ts` the update bench (/update),
  `src/pages/build.ts` the build-your-own page (/build: app, chip, colors; every choice is in the URL, so a link is a wedgie).

**Heads-up for anyone who talks to a wedgie over USB:** about a second after it's plugged in, the
wedgie adds its WEDGIE drive, and its serial port disappears and comes back as a new port. Find it by
its ID, not its port, and don't soft-reset it just to restart its app. Details: `firmware/boot.py`.
- `public/device/probe.py` — board-side test code (screen, buttons, chip, `ident`), pasted into the
  raw REPL; nothing is written to flash.
- `public/skill.md` — the agent skill file served at wedgie.dev/skill.md.
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
- `art/` + `tools/art.py` — source renders and the web images made from them.

```
npm install
npm run dev        # http://localhost:5173 (WebSerial works on localhost)
npm run build      # dist/, what Vercel serves
```

Deploy: Vercel, framework "Other", build `npm run build`, output `dist` (see `vercel.json`).

MIT — everything, including the art in `art/`.
