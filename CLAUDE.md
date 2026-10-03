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
   e6ea8c1). The only sanctioned soft resets boot new firmware or a newly picked app, and the wedgie's own restart
   after a no to its question (`slot._restart`: the question draws over the app's screen at once and nothing keeps it; Austin, 2026-10-01). Full note: `firmware/boot.py`.
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
7. **The clock is set in lcd.py: 125/125 MHz** (peripherals on the CPU clock) so the screen's SPI runs
   at 62.5 MHz: 18 ms a frame instead of 46. MicroPython's default caps SPI at 24 MHz, and 150 MHz is
   worse (37.5). Measured on an RP2040 with the Speed lab app (`firmware/speed.py`); rerun it before
   changing clocks. `show_start()` pushes by DMA (SPI1 registers + DREQ differ RP2040/RP2350): nothing
   may draw into the buffer until `show_wait()`, and every other show waits for it first.
8. **App rules live in one place**: `src/apps/appjson.mjs` (build + site) and `folder_app` in
   public/wedgie.py; `public/code.md` documents them for agents. Keep the three in step. Every app
   file name starts with its mod (the flash has no folders for apps). `tools/codeprobe.mjs` covers /code
   and the emulator (GitHub faked from local folders).
9. **A wedgie is locked (0.2.5+).** main.py turns Ctrl-C off first and never ends by itself; a host gets
   the REPL only after `{"type":"open"}` and a real A press on the wedgie (`slot.let_in`, keys read with
   `Keys(physical=True)`). A yes is for one job: main.py locks it again when it next starts. Every REPL path on a host goes
   through `letIn` (install.ts takeOver, format.ts) or `let_in` (public/wedgie.py enter). Never add a
   way in that skips the press, and never let a USB `press` answer it.
   The escape hatch (`firmware/hatch.py`, 0.3.12+): `{"type":"open","full":true}` (`wedgie.py unlock`) or
   a plain Ctrl-C while locked shows a red FULL CONTROL? question; A = the same yes. Ctrl-C in the first
   3 s after the slot starts is ignored (a connecting host's leftover bytes).
10. **One progress screen: the boot screen.** Anything with progress on a wedgie (install, update,
   anything slow) shows the boot logo and the boot bar: `loader.screen(title, what)` returns the bar,
   `bar.to(0..1)` fills it, `loader.what(text)` changes the line under it. Never draw another bar
   (0.3.2 did; Austin, 2026-09-30). The site's picture of the wedgie screen should match it.
11. **One look: `firmware/ui.py`.** The palette (`ui.WHITE/INK/MUTED/GREEN/GREEN_D/GREY/RED`) and the
   system screens' pieces (`ui.page`, `ui.ask`, `ui.band`, `ui.wrap`, `ui.progress`) live there only.
   Every system screen uses them; apps are told to (`public/code.md` "Look and feel", the /code card,
   pictures in `public/img/look/` from emuprobe). The page's drawings of wedgie screens take colors from
   `src/ui/palette.ts`. `python3 tools/test_style.py` fails on a re-typed palette color, a second
   bar.bin reader, or palette.ts drifting from ui.py.
12. **Anything slow on a wedgie: trace click to screen first.** List every step (host requests, what
   the wedgie reads, imports/compiles, hashing, flash writes, drawing), estimate each, and fix them all in
   one release. Fixing the first cause found and shipping took five releases for the install question
   (0.3.6-0.3.10, two crashed a real board). The emulator has 448 KB of heap, an RP2040 about 190 KB with
   115 KB of it the framebuffer: a firmware change that allocates more is unproven until a real board runs
   it. Say so; never call it tested because the emulator passed. Offer Austin simple tradeoffs early
   ("a no can reboot it" made 0.3.9 easy).
13. **Never run out of RAM on a real board ("wedgie broke: memory allocation failed").** MicroPython never
   moves a block, so ~75 KB of heap gets chopped into pieces and a 1.3 KB string has nowhere to go.
   0.3.6 (slot.py) and 0.3.11 (job.py, the same bug 0.3.9 fixed only in slot.py) both died of a USB line
   grown a char at a time. The rules: USB is read only through `wedgie.lines()` (one buffer made at boot);
   a str/bytes grown with `+=` says why it stays small (`# small:`); a host request never crashes the app
   (slot.handle / the Wallet answer an error, `slot.failed`); after a yes to a job the app is unloaded
   (`slot._free`). `python3 tools/test_memory.py` enforces the first two. **A memory bug is fixed
   everywhere in one release:** grep every firmware file for the pattern and add it to test_memory.py.
   The browser emulator CAN'T test memory: its WebAssembly heap starts at 128 MB and grows. Before firmware
   ships: `node tools/chipprobe.mjs` (the real MicroPython build on a virtual RP2040, rp2040js) and
   `python3 tools/boardprobe.py <apps>` on a real board. Plan + open items: `docs/PLAN-MEMORY.md`.
14. Everything is MIT — never use the CC BY-NC case STLs from picowallet/instant-wallet.

## Run / check

```
npm run dev                 # localhost:5173 (WebSerial works on localhost)
npm run build && npx vite preview --port 4173
node tools/fakeserial.mjs http://localhost:4173 <outdir>   # /connect end to end with fake wedgies
node tools/btprobe.mjs http://localhost:4173/               # no Bluetooth prompt for visitors
node tools/formatprobe.mjs http://localhost:4173/ <outdir>  # /format, the wipe-and-test bench
node tools/updateprobe.mjs http://localhost:4173 <outdir>   # /update, plug-in-and-update bench
node tools/emuprobe.mjs <outdir>                            # the virtual wedgie
node tools/codeprobe.mjs http://localhost:4173 <outdir> ~/clawd/wedgie-starter   # /code: emulator, saves, repos
python3 tools/test_drive.py                                 # the WEDGIE drive's SCSI answers
python3 tools/test_style.py                                 # one palette, one progress bar (firmware/ui.py)
python3 tools/test_memory.py                                # USB only through wedgie.lines(), no growing strings
node tools/chipprobe.mjs                                    # installs on a virtual RP2040 (real heap; needs uv)
python3 tools/boardprobe.py battery                         # a checked install on a real board (press A)
python3 tools/fakedevice.py                                 # a pty wedgie for public/wedgie.py
```

`tools/drive.py` rebuilds `firmware/drive.bin` (macOS + `brew install pngquant`); every byte of it
is flash on every wedgie. Push to main = deploy (Vercel); verify by comparing
`curl https://wedgie.dev/` with `dist/index.html`.
