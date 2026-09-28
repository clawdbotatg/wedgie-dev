# wedgie-dev — orientation for Claude

The website (wedgie.dev) and the wedgie firmware. `README.md` is the overview; `public/skill.md` is
what agents outside this repo read (keep it true when the firmware or the USB protocol changes).

## Landmines

1. **A wedgie's USB port drops about a second after power-up.** boot.py adds the WEDGIE USB drive
   (the underwear on the desktop), which re-enumerates USB: the serial port vanishes and comes back
   as a new port, same board ID. Every host must: wait before identifying a new port, retry an open
   that fails, find a wedgie by its ID (never by its port), and **never soft-reset to get back to the
   launcher** — run main.py (`Repl.leave({ reset: false })`, `wedgie.py leave(reset=False)`). 0.1.3+
   marks soft resets so the drive isn't re-added, but the first soft reset after an update from older
   firmware does drop the port, and a host that reconnects and resets again loops forever (it did:
   e6ea8c1). The only sanctioned soft reset is booting new firmware. Full note: `firmware/boot.py`.
   `tools/fakewedgies.mjs` (used by fakeserial.mjs and updateprobe.mjs) plays both the dropping and the surviving case — extend it, don't bypass it.
2. **Firmware = core + cartridges.** `tools/fw.mjs` publishes `firmware/` to `/fw/` with a manifest:
   `core` (every file no cart claims) and `carts` (`firmware/carts.json`: each app's files, label,
   12x12 icon; `v` = hash of its files, so there is no version to bump). The core ships no apps and
   no apps.json; the wedgie's own `apps.json` is rebuilt from what's really on its flash after every
   change (`install.ts writeApps`, `wedgie.py write_apps` — keep the two in step, and `cartV` in
   fw.mjs / install.ts / wedgie.py identical). A new app = its files + a carts.json entry. A module
   the core imports at boot must not be claimed by a cart.
3. **Bump `VERSION` in firmware/wedgie.py** when the core changes, or no wedgie is told to update.
4. **Nothing touches `navigator.serial` until this browser tapped Connect once** (`wedgies.ts
   armed`): on a Mac the first look makes macOS ask about Bluetooth. `tools/btprobe.mjs` guards it.
5. **RP2040 RAM is tight**: `import lcd` first (its 115 KB framebuffer needs a fresh heap). The chip
   drivers load only for a `chip` request and are dropped after (`wedgie.chip`).
6. Everything is MIT — never use the CC BY-NC case STLs from picowallet/instant-wallet.

## Run / check

```
npm run dev                 # localhost:5173 (WebSerial works on localhost)
npm run build && npx vite preview --port 4173
node tools/fakeserial.mjs http://localhost:4173 <outdir>   # /connect end to end with fake wedgies
node tools/btprobe.mjs http://localhost:4173/               # no Bluetooth prompt for visitors
node tools/testprobe.mjs http://localhost:4173/ <outdir>    # /test, the assembly-line bench
node tools/updateprobe.mjs http://localhost:4173 <outdir>   # /update, plug-in-and-update bench
node tools/emuprobe.mjs <outdir>                            # the virtual wedgie
python3 tools/test_drive.py                                 # the WEDGIE drive's SCSI answers
python3 tools/fakedevice.py                                 # a pty wedgie for public/wedgie.py
```

`tools/drive.py` rebuilds `firmware/drive.bin` (macOS + `brew install pngquant`); every byte of it
is flash on every wedgie. Push to main = deploy (Vercel); verify by comparing
`curl https://wedgie.dev/` with `dist/index.html`.
