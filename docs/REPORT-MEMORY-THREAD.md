# Report: the "no more memory errors" thread (2026-10-02 to 10-03)

## The goal

Firmware installs, updates, app installs, reinstalls and removals never hit "memory allocation
failed", on any wedgie, from any state, including a fresh plug-in. Know it before a release ships.

**Result: not met.** 0.3.23 still crashed on Austin's board right after a plug-in.

## What got done (live on wedgie.dev)

1. **Installs restart first** (0.3.12, plan by another session; I fixed the restart actually happening).
   Every install runs on the same clean memory, whatever app ran before.
2. **All firmware ships precompiled (.mpy)** (0.3.14). The wedgie no longer compiles code at boot.
   Fixed the Wallet not starting, and the plug-in crash for a while (Austin's tests on 0.3.14 passed).
3. **Install security** (0.3.12-0.3.14, with codex): a computer can't swap in unsigned code, pick a
   system module as the app, delete main.py, or mislabel the job on the screen.
   `tools/test_job.py`: 32 hostile requests against the real install code.
4. **Installs about 10x faster** (0.3.16): files go as raw bytes, 4 KB at a time, not base64 lines.
5. **The virtual chip tells the truth about memory** (`tools/chipprobe.mjs`). It was broken: it never
   wrote flash and lost long USB lines. Now it runs real installs and real firmware updates.
6. **Signing refuses untested firmware** (`tools/gate.mjs`, run by `sign.mjs`, ~1 min, no skip).
7. **The virtual chip reads the WEDGIE drive like a Mac** (`chip.mjs` drive mode, `bootprobe.mjs`).
   It reproduced the plug-in crash on 0.3.19.
8. **The drive code allocates nothing per read or write** (0.3.23).

## What is not done

- **The plug-in crash.** Austin hit it on 0.3.23 right away. Cause not proven.
- **Nothing in this thread was tested on a real board before shipping.** Every release went out on
  virtual-chip evidence only. That's how 0.3.12, 0.3.13 and 0.3.23 reached Austin broken.
- `/code` still hides memory problems from app makers (its emulator has 128 MB).
- `wedgie.py`'s fast install path never ran.
- The first update to a new version is still slow (the old firmware runs it).

## Pros and cons of what was built

| | Pro | Con |
|---|---|---|
| Restart before install | Same memory every time | ~1 s extra; port drop after the yes needed host fixes |
| Precompiled firmware | No compile spike; half the size | A build step (`tools/mpy.py`); .py/.mpy twins to manage |
| Raw installs | 10x faster | A second transfer format to keep working |
| Release gate | Nothing unsigned skips tests | Only as good as the virtual chip, which missed the crash |
| Drive mode in the chip | Found a real crash on 0.3.19 | 0.3.22 passes by luck: not proof |

## Low confidence

1. **The cause of the plug-in crash.** I blamed the drive code's memory use. The 0.3.23 fix didn't
   stop it on the real board, so the cause is something else or more than that. Candidates: the
   drive image itself (100 KB, read at boot), what macOS really reads (my simulation guesses), the
   6 KB USB line buffer allocated late in main.py, main.py's own boot order.
2. **The virtual chip's memory matches the real board's.** Free memory numbers matched, but the real
   board crashes where the chip doesn't. Something real (USB timing, macOS's exact reads, the flash
   driver) isn't modeled.
3. **"16 KB free" as a safe minimum.** A guess. A crash needs one big enough block, not total free.
4. **Hosts and the port drop after a yes** worked on fakes; a real plug-in has been tested only by Austin.

## What I'd do next

1. **Read the crash off Austin's board** (error.log, which line, free memory at each boot step).
   No more guessing: trace it on real hardware, as CLAUDE.md landmine 12 says.
2. **Allocate the 6 KB USB buffer first thing in boot.py**, before the drive starts. The real crashes
   were at `import slot`, the simulated one at this buffer: both right after the drive comes up.
3. **Shrink the drive image** (another thread is on it).
4. **A real board in the gate**: no push until the exact signed build survives fresh plug-ins on a Mac.
