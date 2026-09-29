# wedgie-dev — orientation for Claude

The website (wedgie.dev) and the wedgie firmware. `README.md` is the overview; `public/skill.md` is
what agents outside this repo read (keep it true when the firmware or the USB protocol changes).

## Landmines

1. **A wedgie's USB port drops about a second after power-up.** boot.py adds the WEDGIE USB drive
   (the underwear on the desktop), which re-enumerates USB: the serial port vanishes and comes back
   as a new port, same board ID. Every host must: wait before identifying a new port, retry an open
   that fails, find a wedgie by its ID (never by its port), and **never soft-reset just to restart
   its app** — run main.py (`Repl.leave({ reset: false })`, `wedgie.py leave(reset=False)`). 0.1.3+
   marks soft resets so the drive isn't re-added, but the first soft reset after an update from older
   firmware does drop the port, and a host that reconnects and resets again loops forever (it did:
   e6ea8c1). The only sanctioned soft resets boot new firmware or a newly picked app. Full note: `firmware/boot.py`.
   `tools/fakewedgies.mjs` (used by fakeserial.mjs and updateprobe.mjs) plays both the dropping and the surviving case — extend it, don't bypass it.
2. **Firmware = core + one app (0.2+).** A wedgie boots straight into the one app in its `apps.json`
   (`firmware/slot.py`); no menu, and no button leaves the app. `tools/fw.mjs` publishes `firmware/` to
   `/fw/` with a manifest: `core` (every file no cart claims) and `carts` (`firmware/carts.json`: each
   app's files, label, 12x12 icon, `entry`/`usb`; `v` = hash of its files, so there is no version to
   bump). Picking an app takes the old one's files off and soft-resets into the new one; a core update
   keeps it, but one from 0.1.x (the menu, several apps) starts with none. `apps.json` is rebuilt from what's
   really on the flash after every change (`install.ts writeApps`/`useApp`, `wedgie.py write_apps`/`use`
   — keep the two in step, and `cartV` in fw.mjs / install.ts / wedgie.py identical). A new app = its
   files + a carts.json entry. A module the core imports at boot must not be claimed by a cart.
   Removed core files go in `RETIRED` (install.ts, wedgie.py) so an update deletes them.
   **App Timers are wrapped on the board** (`slot.py _Timer`): an app whose tick takes as long as its
   period (hello) otherwise starves the USB code and the site hangs on "finding it". The emulator
   can't show this (its Timers are JavaScript's); only a real board can.
   **The page never watches or drives a wedgie by default** (it moves money: its app decides on its
   own). The live screen mirror and pressing its buttons from the page are opt-in, in Developer.
3. **Bump `VERSION` in firmware/wedgie.py** when the core changes, or no wedgie is told to update.
4. **Saves (`/saves/<app>/`, `firmware/save.py`) are never touched** by an install, a switch or an
   update, and `/format` copies them into the browser before its wipe and puts them back after
   (`src/serial/files.ts`). Nothing on /format starts until its Format button is pressed.
5. **Nothing touches `navigator.serial` until this browser tapped Connect once** (`wedgies.ts
   armed`): on a Mac the first look makes macOS ask about Bluetooth. `tools/btprobe.mjs` guards it.
6. **RP2040 RAM is tight**: `import lcd` first (its 115 KB framebuffer needs a fresh heap). The chip
   drivers load only for a `chip` request and are dropped after (`wedgie.chip`).
7. Everything is MIT — never use the CC BY-NC case STLs from picowallet/instant-wallet.

## Run / check

```
npm run dev                 # localhost:5173 (WebSerial works on localhost)
npm run build && npx vite preview --port 4173
node tools/fakeserial.mjs http://localhost:4173 <outdir>   # /connect end to end with fake wedgies
node tools/btprobe.mjs http://localhost:4173/               # no Bluetooth prompt for visitors
node tools/formatprobe.mjs http://localhost:4173/ <outdir>  # /format, the wipe-and-test bench
node tools/updateprobe.mjs http://localhost:4173 <outdir>   # /update, plug-in-and-update bench
node tools/emuprobe.mjs <outdir>                            # the virtual wedgie
python3 tools/test_drive.py                                 # the WEDGIE drive's SCSI answers
python3 tools/fakedevice.py                                 # a pty wedgie for public/wedgie.py
```

`tools/drive.py` rebuilds `firmware/drive.bin` (macOS + `brew install pngquant`); every byte of it
is flash on every wedgie. Push to main = deploy (Vercel); verify by comparing
`curl https://wedgie.dev/` with `dist/index.html`.
