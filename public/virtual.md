---
name: wedgie-virtual
description: The virtual wedgie at wedgie.dev/virtual - the real wedgie firmware running on a virtual RP2040 with a software Trust M in a browser tab, plugged into wedgie.dev's other tabs. No hardware needed. How to open it, press its buttons and read its screen (keyboard, window.wedgie for agents), install apps, sign Safe transactions, and what it can't do. Use for "try a wedgie without one", "test my app on a wedgie", "virtual wedgie", "emulator", "drive a wedgie from a script without hardware".
---

# The virtual wedgie

Part of the wedgie skills. Index: https://wedgie.dev/skill.md

**https://wedgie.dev/virtual** runs a whole wedgie in a browser tab: the real MicroPython build and the real
firmware on a virtual RP2040 (rp2040js), a software OPTIGA Trust M, the screen and all 9 buttons, in the 3D case.
wedgie.dev in **other tabs of the same browser** sees it plugged in, tagged **virtual**: /connect installs apps on
it, /safe signs with it, /secret chats with it. On the front page: **Pop out a virtual wedgie**.

| Fact | Value |
|---|---|
| ID | `EEE` + 3 digits (E for emulator), made once and kept |
| Starts with | the latest firmware + Welcome |
| Speed | 20-70% of a real wedgie |
| Storage | that browser's IndexedDB (flash and chip keys) |
| Page buttons | Screenshot (3x PNG), Replug, Wipe (flash only: ID and chip keys stay, like reflashing a real one) |
| Just the screen | https://wedgie.dev/virtual?no3d |

## Press buttons

| Wedgie | Keyboard |
|---|---|
| joystick up/down/left/right | W A S D or the arrow keys |
| joystick press | Space or Enter |
| A (green, yes) | J |
| B (grey) | K |
| X (grey) | L |
| Y (red, no) | ; |

Or click the 3D buttons. Every press lasts at least 250 ms, so a quick click is never lost.

## For an agent (in the /virtual tab's JS)

```js
await wedgie.press("A")          // A B X Y up down left right press; optional ms
wedgie.hold("up", true)          // hold down; wedgie.hold("up", false) lets go
wedgie.screen()                  // the screen now, as a data:image/png URL (240x240)
wedgie.history(10)               // the last 10 different screens: [{t, png}], oldest first
wedgie.id                        // its board ID (EEE123)
wedgie.speed                     // how fast it runs vs a real one
```

From the repo (`github.com/clawdbotatg/wedgie-dev`): `node tools/emu.mjs` runs one headless with a curl API on
`localhost:4190` (status, screen, history, press, hold, open a wedgie.dev tab, click, eval, text, shot, wipe).
Details: `docs/EMU.md` in the repo.

## Install an app on it

1. Open https://wedgie.dev/connect in another tab of the same browser; pick the virtual wedgie.
2. Click the app on the shelf. The virtual wedgie asks **Install**, the app's name big under it. Its yes is grey while it checks the
   signature: wait for green, then press A.
3. Its page says it runs that app.

## Know

- It's the real firmware, so the lock, the questions and the signature checks are all real.
- Its questions time out after 60 s of its own clock: answer soon.
- The chip check never passes: the virtual Trust M's certificate isn't Infineon's, on purpose.
- No RSA or AES on the virtual Trust M.
- Clearing the browser's site data loses it: its ID, its keys, and any Safe they own. **Never put real money on a
  virtual wedgie.**
- It has a real RP2040's RAM (the /code emulator doesn't), but test on a real board before shipping anyway.
- App developers: the emulator for your own app's code is https://wedgie.dev/code (code.md).
