# The virtual wedgie

wedgie.dev/emu runs a wedgie in the browser: the real MicroPython build and firmware on a virtual RP2040
(rp2040js), a software Trust M, the screen and all 9 buttons. wedgie.dev in other tabs of the same
browser sees it plugged in, tagged **virtual**. Code: `src/chip/` (sim.ts the chip, trustm.ts the secure
chip, worker.ts runs both, port.ts its USB for other tabs), page `src/pages/emu.ts`.

Test every change on it before you ship: installs, app screens, buttons, signing.

## Run your own

```
node tools/emu.mjs            # against wedgie.dev
node tools/emu.mjs --local    # against this tree (builds it first)
```

Headless, no one's browser needed. API on `localhost:4190` (quote URLs with `?` in fish):

```
curl -s localhost:4190/status
curl -s localhost:4190/screen > s.png               # exact pixels; Read the png to look
curl -s "localhost:4190/history?n=10"               # last screens, for one that flashed by
curl -s localhost:4190/press -d '{"k":"A"}'          # A B X Y up down left right press
curl -s localhost:4190/hold -d '{"k":"up","down":true}'
curl -s localhost:4190/open -d '{"url":"/connect"}'  # -> {"tab":1}
curl -s "localhost:4190/text?tab=1"
curl -s localhost:4190/click -d '{"tab":1,"js":"document.querySelector(\"#d-shelf [data-mod=buttons] button.cart\")"}'
curl -s localhost:4190/eval -d '{"tab":1,"js":"location.href"}'
curl -s "localhost:4190/shot?tab=1" > page.png
curl -s localhost:4190/wipe -d '{}'                  # flash back to new; ID and chip keys stay
```

The same calls exist in the page: `window.wedgie.press(k, ms)`, `.hold(k, down)`, `.screen()`,
`.history(n)`. In Austin's own browser (when he hands you his browser bridge), `eval` those on his /emu tab.

## Install an app

1. Open `/connect/<ID>` (the ID is on /status), click the app's cartridge (`#d-shelf [data-mod=<mod>] button.cart`).
2. The wedgie asks "Install X". Its yes is grey while it checks the signature: wait for green, then press A.
3. `/connect/<ID>` says "It runs X".

## Know

- It runs at 20-70% of a real wedgie's speed (JS imitating the chip). Its questions time out after 60 s
  of the chip's time: answer soon.
- Every press lasts at least 120 ms of the chip's time, so quick presses never get lost.
- The chip check never passes: the virtual Trust M's certificate isn't Infineon's, on purpose.
- Its flash and chip live in that browser (IndexedDB; tools/emu.mjs: `node_modules/.cache/emu-profile`).
  Wipe erases the flash only (apps, saves); its ID and chip keys stay, like reflashing a real one.
  Clearing the browser's site data loses them, and any Safe they own.
- No RSA or AES on the virtual Trust M.
- A new one starts from `public/emu/wedgie-fs.img.gz` (firmware + Welcome), remade by `tools/sign.mjs`
  (`node tools/emuimage.mjs`). Older is fine: wedgie.dev updates it like any wedgie.
- `npm run dev` serves the old emu.html test page at /emu; use `--local` (a build) instead.
