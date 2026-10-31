# Expectations

The three things a wedgie must always do. We keep failing them, so when anything is
broken, start here. If a change breaks one of these, it doesn't ship. In this order:

## 1. The wedgie is secure

Two rules over everything: hardware, firmware, apps, the website.

- **The wedgie trusts nothing plugged into it.** Not the computer, a phone, wedgie.dev, or
  an app's host. Everything they send is a request. The wedgie checks it and decides.
- **The person knows exactly what they say yes to.** The wedgie's own screen says everything
  that will happen, in plain words, worked out by the wedgie, never taken from the
  computer's label. Nothing happens beyond it. If it can't be said clearly, it doesn't happen.

How installs follow it (0.3.53): `docs/HONEST-QUESTIONS.md`.

Known gaps (2026-10-18), to close:
- Apps choose whether a press sent over USB counts; the firmware's own questions take only real ones.
- Physical access: BOOTSEL flashes any firmware, and the Trust M signs for any firmware.
- Apps run with full access to the chip; only review keeps a bad one off the shelf.

- A computer can't get into a wedgie. Plugging it in gives the computer nothing.
- A wedgie never signs anything without a person saying yes, by pressing a button on
  the wedgie itself.
- No host, no USB message, no bug, no "just for testing" path skips that press.

Where it lives: CLAUDE.md firmware rule 7 (the lock, `slot.let_in`, `firmware/hatch.py`).

## 2. The wedgie always works

- The screen "wedgie broke: memory allocation failed" never shows up. Ever.
- We never install firmware or an app that can cause it.
- The emulator passing proves nothing about memory. A real RP2040 has far less RAM.
  Firmware is tested on the virtual chip and a real board before it ships.

Where it lives: CLAUDE.md firmware rule 3, `tools/test_memory.py`, `tools/chipprobe.mjs`,
`tools/boardprobe.py`, `docs/PLAN-MEMORY.md`.

## 3. Everything has one style

- Everything looks the same: the wedgie, the website, every app.
- Reuse what exists: the wedgie logo, the loader bar, the palette, the screens in
  `firmware/ui.py`. Never recreate them.
- Buttons: green = the one obvious action, dark gray = the runner-up, red = destroys something
  (remove, delete, disconnect), white = the rest (Reject, Back, Close, Done, Cancel). Same as Instant Wallet. `docs/STYLE.md` section 4.
- Nothing does its own thing. Busy always means the boot logo + a title + the loader bar.
  Never "working...", never a second bar.

Where it lives: `docs/STYLE.md`, CLAUDE.md firmware rule 8, `tools/test_style.py`,
`tools/busyprobe.mjs`.
