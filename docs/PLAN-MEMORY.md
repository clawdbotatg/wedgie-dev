# Plan: installs and updates that are fast and never run out of memory

Written 2026-10-02 after a day of "memory allocation failed" on Austin's wedgie. For review (Codex).
Goal, in Austin's words: every time you ask to install software or firmware, the question comes right
up, you press the button, and it works. Fast. No memory errors, ever.

Everything marked **measured** was seen on Austin's real board (RP2040, MicroPython 1.29.0) or on the
virtual RP2040 (rp2040js running the same MicroPython build). Everything else is a plan or an estimate.

---

## 1. The numbers

| | bytes | source |
|---|---|---|
| Heap on an RP2040, MicroPython 1.29, nothing loaded | 233,728 | measured, virtual chip |
| Free when main.py starts (screen buffer 115,200 + boot.py's drive + splash already taken) | 89,488 | measured, virtual chip |
| Core modules compiled from source: wedgie 6.4K, loader 5.7K, slot 7.4K, ui 1.6K, save 1.7K | ~23,000 | measured, virtual chip |
| job.py 3.8K + p256.py 5.8K (loaded for a job) | ~9,600 | measured, virtual chip |
| Free, no app, 0.3.12 | 71,200 | measured, real board |
| Free, Battery running | ~69,500 | measured, real board |
| Free during a Battery install in place (old way) | 49,952 | measured, real board |
| Free during a Wallet install in install mode (new way) | 59,500-60,700 | measured, real board |
| usbwallet.py: source / compiled .mpy | 22,945 / 11,298 | measured (mpy-cross 1.29, mpy v6.3) |

"Free" is total free bytes. What kills an install is the **largest free piece**: MicroPython never
moves a block, so 60 KB free in small pieces can still fail to find 1.3 KB in one piece.

## 2. What went wrong (every failure seen today)

| # | Failure | Where | Cause |
|---|---|---|---|
| F1 | Battery install, 0.3.11: `allocating 1336 bytes` | job.py, reading a `put` line | A USB line built one char at a time (`buf += ch`): every char copied the whole line. A 1.4 KB line = a thousand growing copies, heap chopped up. Same bug 0.3.9 fixed in slot.py only. |
| F2 | Wallet install over Battery, 0.3.12 (in place): `allocating 2604 bytes` | job.py, parsing the 2.6 KB signed list | The job ran on whatever heap the app left behind. Even with F1 fixed, the app's leftovers left no 2.6 KB piece. |
| F3 | Wallet won't start after install: `allocating 584` / `472 bytes` | slot.open_app, importing usbwallet.py | Compiling 23 KB of Python on the wedgie needs a big temporary parse tree. Doesn't fit. Same files compiled to .mpy on a computer: starts fine (**measured**). |
| F4 | Wedgie unreachable after F3 | slot.py | An app that "owns USB" (the Wallet) failed to start, so nothing answered USB. Only "hold X while plugging in" got it back. |
| F5 | "wedgie broke", A did nothing visible | main.py stuck() | Any uncaught error in a host request killed the app. A let the computer in, but the screen never changed. |
| F6 | hello said 4,032 bytes free | wedgie.hello | It counted garbage as used (no `gc.collect()`). Really ~60-70 KB. |
| F7 | No test ever caught any of this | the emulator | The browser emulator is MicroPython for WebAssembly: its heap starts at **128 MB and grows on demand** (**measured**: `heapsize` is ignored). It cannot run out of memory. 0.3.11's "calibrate the emulator's heap" never worked. |

Lessons:
1. A memory bug is a **class**, not a line. Fix every copy of the pattern in one release, and add a
   check that fails the build on the pattern.
2. Memory on a wedgie depends on **history** (which app ran, what it did). Anything that depends on
   history can't be tested once and trusted. Make the memory **the same every time**.
3. Only a real RP2040 heap tells the truth. The emulator says nothing about memory.

## 3. The design

Five rules. Each one closes one class of failure.

### Rule 1: USB lines go into one buffer made at boot (fixes F1) — DONE in 0.3.12

`wedgie.lines()`: one 6 KB bytearray made in main.py while the heap is whole. Every reader (slot, job,
the Wallet) uses it. A finished line is copied once, at its own size. `tools/test_memory.py` fails the
build on any other `sys.stdin.read` and on any `str`/`bytes` grown with `+=` that doesn't carry a
`# small: <why>` note.

- Pro: no growing copies. One fixed 6 KB cost.
- Con: 6 KB taken for good. Lines over 6 KB are dropped (the longest real line is the job, ~3.2 KB; the
  signed list ~2.7 KB). **The Wallet's limit went from 16 KB to 6 KB**: a big EIP-712 sign request
  from another host could now be refused. Check what hosts send the Wallet.

### Rule 2: every job runs in install mode, on a clean heap (fixes F2) — DONE in 0.3.12, tested on the real board

The question is asked from code already loaded (as in 0.3.10: up in **~90 ms, measured**). On a yes,
the wedgie saves the job to `_job.json` and soft-resets. main.py finds the file, deletes it, and runs
`job.resume()` before anything else loads: no app, no slot, no loader. Then the host sends the signed
list and the files as before. Commit, abort, error or timeout: it restarts into the app.

- Pro: **the memory during an install is the same every time**, whatever app ran. Test it once per
  firmware version and it holds for every app. Measured: 59-61 KB free through a whole Wallet install.
- Pro: the protocol didn't change. Hosts already wait for `go` after the question; the restart happens
  inside that wait. Old hosts (0.3.0-0.3.9 send the list in the job) work the same way.
- Con: ~0.5-1 s of restart after the yes (boot logo shows at once, so it doesn't look stuck).
- Con: an entry app (Demo, Speed lab) runs the question inside its USB timer, where a soft reset is
  swallowed. The reset fires at its next `show()` instead, with a hard reset 1.5 s later as a backstop.
  The hard reset drops the USB port mid-job: **untested; the host would fail that install.**
- Con: the emulator wipes its flash on restart, so it can't do install mode; there the job runs in
  place. The emulator and the board now take different paths. (Fine for memory, since the emulator
  can't test memory anyway, but the install-mode path itself is only tested on chip and board.)
- A crash in install mode can't loop: the job file is deleted before the job starts.

### Rule 3: ship compiled code (.mpy), never compile on the wedgie (fixes F3) — TO DO

Compile every firmware and app `.py` to `.mpy` with mpy-cross at site build (`tools/fw.mjs`), pinned
to the MicroPython the site flashes (1.29.0, mpy v6.3). The wedgie only loads bytecode: no parse tree,
no compile peak, about half the bytes to send and store. Measured: the Wallet fails from source and
runs from .mpy on the same board.

Work it needs:
1. fw.mjs: run mpy-cross (pinned) on every `.py` except `boot.py` and `main.py`, which MicroPython only
   runs as `.py`; keep those two tiny. Manifest, signed list (`tools/release.mjs`) and carts list the
   `.mpy` names.
2. hello reports `sys.implementation._mpy`. If it doesn't match, the site offers a MicroPython update
   (picoboot.ts already flashes UF2s) or falls back to `.py`.
3. Every install deletes **both** forms of a file it replaces (MicroPython imports a `.py` before an
   `.mpy` of the same name, so a stale `.py` silently wins). Add the old `.py` names to `RETIRED` in
   install.ts and wedgie.py.
4. loader.py reads an app's imports from its `.py` to fill the boot bar. For `.mpy`, list each app's
   dependencies in the manifest/apps.json at build time.
5. Apps from GitHub repos are pinned by sha and fetched at build: compile them at build too.
6. Apps written live at /code stay `.py` (they're small). Give them a size budget and a warning.

- Pro: removes the biggest memory spike there is (compiling). Halves transfer time and flash use.
- Con: a toolchain pin. A MicroPython update means rebuilding every file. A board on a different
  MicroPython needs `.py` or a MicroPython update.
- Con: tracebacks show fewer details (no source lines on the device).

### Rule 4: a host request can never kill the wedgie (fixes F4, F5) — DONE in 0.3.12, partly tested

- `slot.handle` catches everything a request throws, answers `{"type":"error"}` and logs `error.log`.
  The app keeps running.
- A job that fails answers the error and restarts cleanly. **Seen on the real board** (F2): no
  "wedgie broke", it restarted into the app.
- An app that owns USB but failed to start no longer owns it: the slot answers, so a host can always
  get back in (fix written, **not yet seen on the board**: the board showed it stuck before this fix).
- "wedgie broke" + A now draws "computer let in" (written, not yet seen).

### Rule 5: measure memory where it's real, before every release (fixes F7)

| Test | What it proves | State |
|---|---|---|
| `tools/test_memory.py` | No growing strings, no second USB reader. Seconds, every build. | done, passes |
| `tools/chipprobe.mjs` | The real MicroPython build on a virtual RP2040 (rp2040js). Boots the firmware, drives a real install the way the site does, presses A on its pins. Reports free heap. | boots and answers USB (**measured**); the full install run hit "release: null" for both old and new firmware: **open**, see section 5 |
| `tools/boardprobe.py` | The same install on a real board, with wedgie.dev's real signed files. | done, used today |
| `tools/emuprobe.mjs` | Everything except memory. | unchanged, passes |
| `tools/memprobe.mjs` | Was meant to test memory in the emulator. **Can't** (F7). | deleted 2026-10-02, with the emulator `heap` option |

Release gate for any firmware change:
1. test_memory.py passes.
2. chipprobe: every app starts; every app installs over every other in install mode; a firmware update
   from the previous release; the least free heap stays above a set margin (proposal: 16 KB). Add a
   "largest free piece" check: in a test image, find the biggest `bytearray(n)` that succeeds.
3. boardprobe on a real board: install every app, update firmware. A person presses A each time.
4. Only then sign (on the Mac) and push.

## 4. Speed

| Step | Now | Plan |
|---|---|---|
| Request to question on screen | ~90 ms (**measured**, `asked_ms`) | keep: nothing loads before the question (0.3.10 rule) |
| Yes to install mode running | ~0.5-1 s restart (estimate; boot logo at once) | measure with asked/go timestamps; trim boot.py work on a job restart |
| Checking the signature (pure-Python P-256) | "a few seconds" (code comment; not measured today) | measure on the board. Options: verify on the ATECC608 when there is one (hardware P-256 verify, ms); cache a verified list by hash until the next release |
| File transfer | 1 KB chunks, one round trip each | .mpy halves the bytes. In install mode the heap is clean and the line buffer fixed, so 2-3 KB chunks are safe up to the 6 KB line limit: fewer round trips. Measure before changing |
| Only changed files | yes (sums after the yes) | keep |

## 5. Open items and risks (please check these)

1. **Wedgies already on 0.3.11 or older still have F1.** Updating them to the new firmware runs the
   OLD job.py, in place, with `buf += ch`, so the update itself can fail. Options:
   a. For firmware < 0.3.12 the site sends small chunks (256 B: lines ~400 chars, far less churn).
   b. Do the update through the REPL ("let this computer in") after a soft reset. A raw-REPL soft reset
      doesn't run main.py, so the heap is clean. Con: the question says "full access" that one time.
   Recommend a + b-as-fallback; test both on the virtual chip and a board running 0.3.11.
2. **chipprobe's full install timed out at the signed-list step** ("release: null") for both 0.3.11 and
   0.3.12, after ~17 min of wall time. Unknown whether that's slowness (the chip runs ~4x slower than
   real time, and P-256 is slow) or a crash the probe didn't print. Must be understood before chipprobe
   is a release gate. Its output on failure should dump the chip's serial log.
3. The hard-reset backstop for entry apps (rule 2) drops the port mid-job. Test a Demo -> X install on
   chip and board; consider a host retry.
4. The "let this computer in" path (full-access installs, GitHub apps, /format, wedgie.py) still runs
   on the app's fragmented heap. It could get the same clean restart as jobs.
5. The Wallet's line limit is now 6 KB (rule 1).
6. Austin's board now has hand-copied 0.3.12 files and a hand-compiled Wallet (.mpy). It should get a
   proper signed update once the release is out.
7. Signing: the release key exists only on Austin's Mac (`~/.wedgie/release-key.pem`). `tools/sign.mjs`
   used to make a new key silently when it was missing, which would have locked every wedgie out of
   checked installs. It now refuses when wedgie.py already has a key.
8. Frozen modules (core bytecode built into a custom UF2, run from flash, 0 bytes of heap) would free
   another ~25-30 KB. Con: core updates then need a UF2 flash (BOOTSEL / picoboot), a firmware build
   toolchain (arm gcc) and a slower update loop. Not now; keep as the next step if margins stay thin.

## 6. Order of work

1. Settle open item 2 (make chipprobe trustworthy).
2. Ship 0.3.12 (rules 1, 2, 4) with the old-firmware path (open item 1). Gate: section 3, rule 5.
3. Rule 3 (.mpy for everything), as 0.4.0. Gate: same.
4. Speed: measure each row in section 4, then fix the slowest.

## 7. What changed today (uncommitted, in this tree)

- firmware: `wedgie.py` (Lines, lines(), install mode save/take, failed(), ram after collect, p256
  freed after use, VERSION 0.3.12), `slot.py` (one reader, handle catches all, install mode, USB
  ownership fix), `job.py` (one reader, resume(), progress moved here, list freed after check, errors
  answered), `main.py` (line buffer at boot, install mode, "computer let in" screen), `usbwallet.py`
  (one reader, 6 KB, errors answered), `keccak.py`/`trustm.py` (`# small:` notes only).
- tools: `test_memory.py`, `chipprobe.mjs` + `rp2040/` (virtual chip), `boardprobe.py`, `sign.mjs`
  guard, every probe finds Chromium on Linux too. (memprobe.mjs and an emulator `heap` option were added and deleted the same day: the emulator can't test memory.)
- docs: CLAUDE.md landmine 13, `public/code.md` (no `+=` strings in loops), `public/skill.md` (error
  answers, 6 KB lines).
- Not done: signing (needs the Mac), release, rule 3, open items.
