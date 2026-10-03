# Plan: no more memory errors (2026-10-03)

**The goal: NO MORE MEMORY ERRORS.** Not fewer. None, on any wedgie, in anything it does.

**North star:** firmware installs, firmware updates, software installs, reinstalls and uninstalls
never hit a memory error, on any wedgie, from any state (any app running or none, fresh plug-in
or not). Every release is tested against exactly this list before it's signed.

## What Austin wants

- Installing, updating, plugging in, starting any app: never "memory allocation failed". On any wedgie.
- Know it before a release ships. A real board must never be the first test.
- Simple: no new chores for app makers.

## What broke today (0.3.12, a real board)

Buttons on, Buttons off, unplug, plug in: "wedgie broke: allocating 1336 bytes" at `import slot`.
The install worked. The boot after a fresh plug-in didn't.

Likely cause (to prove on the board first): on a plug-in, boot.py compiles the USB drive code from
source (usbdev 35 KB + wedgiedrive 7 KB), then main.py compiles the slot (20 KB, bigger in 0.3.12).
Compiling Python on the wedgie needs a big chunk of spare memory. The second compile doesn't fit.
Same failure as the Wallet's, in the core.

Why the tests missed it: the virtual chip never boots from a fresh plug-in with no app, and may not
run the USB drive at all.

## The plan

1. **Prove the cause** on Austin's board: free memory after each step of boot.
2. **Precompile the core** (.mpy), as the Wallet already is. Every file except boot.py and main.py
   (MicroPython only runs those as .py). The wedgie then never compiles anything at boot: no spike.
   Same tool, same checks (tools/mpy.py), signed like everything else.
3. **Test every way a wedgie starts**, on the virtual chip: fresh plug-in (with the USB drive) and soft
   reset, with each app and with none; then every install and update. Each must leave 16 KB free.
4. **Make that a hard gate**: tools/sign.mjs refuses to sign unless all of it passes. No firmware
   reaches wedgie.dev untested.
5. **One real board run** (docs/BOARD-TEST.md) before the release, plug-in included.

## Risks, handled

- Updating from a .py core to a .mpy core: the old .py must come off once its .mpy is on (it would
  load first). The install code already does this for the Wallet; the core gets the same, and
  job.py's protected names move to the .mpy names.
- The site detects firmware by `wedgie.py` on the flash: it must accept `wedgie.mpy` too.
- loader.py uses fast machine code (viper): it may have to stay .py or be built for the chip.

## Later, if memory is still tight

Build the core into the MicroPython image itself (frozen). It then takes no memory at all, but a core
update means reflashing the whole image.
