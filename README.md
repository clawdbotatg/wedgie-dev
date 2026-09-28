# wedgie.dev

Give yourself a wedgie: a pocket computer from three off-the-shelf parts (a Pico, a Waveshare
Pico-LCD-1.3 hat, and a secure chip wedged in between). This repo is the website: order one, build
one, plug it in and put software on it, hand it to your agent.

- `index.html` — the loader. The underwear and the plastic bar paint from the first byte of HTML
  (the same boot screen as the device, picowallet `tools/bar` + `firmware/loader.py`); the bar fills
  by real bytes of every asset, turns green, and hands off to the site.
- `firmware/` — the wedgie firmware: the core (boot logo, WEDGIE drive, launcher, drivers) and the
  cartridges (apps) listed in `firmware/carts.json`. Published to `/fw/` by `tools/fw.mjs`.
- `src/serial/` — WebSerial: every plugged-in wedgie, identified by its board ID (`wedgies.ts`),
  over MicroPython's raw REPL (`repl.ts`, from picowallet `factory/`); `install.ts` puts the core and
  cartridges on. `src/pages/connect.ts` is the list at /connect, `src/pages/wedgie.ts` one wedgie,
  `src/pages/test.ts` the assembly-line test bench (/test), `src/pages/update.ts` the update bench (/update).

**Heads-up for anyone who talks to a wedgie over USB:** about a second after it's plugged in, the
wedgie adds its WEDGIE drive, and its serial port disappears and comes back as a new port. Find it by
its ID, not its port, and don't soft-reset it to restart the launcher. Details: `firmware/boot.py`.
- `public/device/probe.py` — board-side test code (screen, buttons, chip, `ident`), pasted into the
  raw REPL; nothing is written to flash.
- `public/skill.md` — the agent skill file served at wedgie.dev/skill.md.
- `art/` + `tools/art.py` — source renders and the web images made from them.

```
npm install
npm run dev        # http://localhost:5173 (WebSerial works on localhost)
npm run build      # dist/, what Vercel serves
```

Deploy: Vercel, framework "Other", build `npm run build`, output `dist` (see `vercel.json`).

MIT — everything, including the art in `art/`.
