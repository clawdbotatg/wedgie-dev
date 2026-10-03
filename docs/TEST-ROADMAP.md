# Test roadmap

How firmware gets tested before it reaches a wedgie. The goal (EXPECTATIONS.md): never "wedgie broke",
never a release that can cause it.

## Stage 1: no real board in the loop (now)

- Fake wedgies in a browser (fakeserial, updateprobe, formatprobe, busyprobe, btprobe): the site's flows.
- The emulator (emuprobe, codeprobe): firmware logic. Its memory is huge, so it can't find memory bugs.
- The virtual RP2040 (chipprobe): the real MicroPython build with the real heap. Finds most memory bugs,
  but missed 0.3.13's boot crash (a real plug-in: macOS reads the WEDGIE drive at the same moment).
- test_job, test_memory, test_style, mpy --check: seconds, no board.
- A real board only when Austin runs it (docs/BOARD-TEST.md), because every job needs an A press.

The gap: 0.3.12 and 0.3.13 shipped without a real-board run, and 0.3.13 crashed on Austin's wedgie.

## Stage 2: a real board on every release, by hand

- Before signing a firmware release: update a spare wedgie from a local preview, install a few apps,
  unplug and plug in 3 times. About 5 minutes, someone presses A.
- tools/optigaprobe.py for anything touching the Trust M (one raw-REPL session, never restarts it).

## Stage 3: hardware in the loop, automatic

A test wedgie that stays plugged in, and a release can't ship until it passes on it. No one presses anything.

What it needs:
- **Something that presses A and Y.** Open: how. Ideas:
  - a second Pico wired to the button lines (GP15 = A, GP21 = Y; a press = the line pulled to ground);
  - a relay or optocoupler across each button;
  - a servo or solenoid pressing the real button (no wires on the wedgie at all).
  Only on a dedicated test wedgie that never holds money. The firmware doesn't change: the lock still
  needs a physical press, the rig just makes one.
- **Unplug and plug in** from the computer: a USB hub with per-port power (uhubctl), so the fresh-boot
  case (the WEDGIE drive, the port drop) is tested every time.
- **A script** that runs on every firmware release: power-cycle, update from the release candidate,
  install every app (boardprobe), power-cycle again, optigaprobe, and fail the release on any
  "memory allocation failed".
- One rig per chip (ATECC608, Trust M V1, later a V3), and both RP2040 and RP2350.
