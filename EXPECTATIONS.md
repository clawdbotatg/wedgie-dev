# Expectations

The three things a wedgie must always do. We keep failing them, so when anything is
broken, start here. If a change breaks one of these, it doesn't ship. In this order:

## 1. The wedgie is secure

- A computer can't get into a wedgie. Plugging it in gives the computer nothing.
- A wedgie never signs anything without a person saying yes, by pressing a button on
  the wedgie itself.
- No host, no USB message, no bug, no "just for testing" path skips that press.

Where it lives: CLAUDE.md landmine 9 (the lock, `slot.let_in`, `firmware/hatch.py`).

## 2. The wedgie always works

- The screen "wedgie broke: memory allocation failed" never shows up. Ever.
- We never install firmware or an app that can cause it.
- The emulator passing proves nothing about memory. A real RP2040 has far less RAM.
  Firmware is tested on the virtual chip and a real board before it ships.

Where it lives: CLAUDE.md landmines 12-14, `tools/test_memory.py`, `tools/chipprobe.mjs`,
`tools/boardprobe.py`, `docs/PLAN-MEMORY.md`.

## 3. Everything has one style

- Everything looks the same: the wedgie, the website, every app.
- Reuse what exists: the wedgie logo, the loader bar, the palette, the screens in
  `firmware/ui.py`. Never recreate them.
- Nothing does its own thing. Busy always means the boot logo + a title + the loader bar.
  Never "working...", never a second bar.

Where it lives: `docs/STYLE.md`, CLAUDE.md landmines 10-11, `tools/test_style.py`,
`tools/busyprobe.mjs`.
