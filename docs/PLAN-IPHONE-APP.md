# Plan: an iPhone app that talks to a wedgie over USB-C

Austin, 2026-10-03: plug a wedgie into an iPhone and talk to it with no Files taps. This is the plan
for the machine that has Xcode. Read it all before starting.

## Why an app

An iPhone can't open a wedgie's USB serial port: Safari has no Web Serial or WebUSB, and an app
can't open a serial device without Apple's paid MFi program. But an iPhone **does** mount USB drives,
and a wedgie already shows up as one (the WEDGIE drive). So the phone and the wedgie talk through
**files on that drive**.

A web page can do this too (wedgie.dev/drive.html), but iOS makes you pick the folder every time:
Send → Save to Files → WEDGIE → Save; Read → Browse → WEDGIE → pick the file. An app picks the
WEDGIE drive **once**, keeps permission, and then reads and writes it with no taps.

## What's proven (2026-10-03, a real RP2040 wedgie and an iPhone)

- Branch `drive-inbox`: the WEDGIE drive takes writes (`firmware/wedgiedrive.py`). Written sectors live
  in RAM (12 sectors, 6 KB at most), are gone at unplug, and flash is never written.
- A `.txt` saved on the drive is read as request lines, exactly like USB serial
  (`firmware/inbox.py` → `wedgie.lines()`). One JSON request per line (the protocol in
  `public/skill.md`). Anything that moves money still needs the A press on the wedgie.
- Test: wedgie.dev/drive.html sent `{"type":"open"}` as `wedgie.txt`, the wedgie asked
  "Let this computer in?", and the page read the file back off the drive.
- `uv run --with pyfatfs --with 'setuptools<81' python3 tools/test_drive.py` covers the drive and the inbox.
- Not done: the wedgie can't answer back on the drive yet (answers go to USB serial, which the
  phone can't read). Not released: no VERSION bump, not signed, not on main.

## How it works

```
iPhone app                         WEDGIE drive (FAT12, 1 MB)              wedgie
----------                         --------------------------              ------
writes REQ-<n>.TXT  ───────────►   the host's writes, kept in RAM   ──►   inbox.py reads each line
                                                                           → slot/Wallet handle it
reads  ANSWER.TXT   ◄───────────   a file in drive.bin, the wedgie  ◄──   its answers (TO BUILD)
                                   rewrites its sectors in RAM
```

### Firmware still to build (this repo, not the Xcode machine)

1. **Answers back on the drive.** `drive.bin` (tools/drive.py, needs macOS) gets a fixed
   `ANSWER.TXT`, say 4 KB, its clusters already allocated. The wedgie writes its answers (the same
   JSON lines it prints on USB) into those sectors in RAM, padded with newlines, plus a counter line
   so the app can tell a new answer from an old one. The FAT and the folder never change, so the
   phone's copy of them stays right; only the file's data changes.
2. **Merge `drive-inbox` and release it** (VERSION bump, chipprobe, a real board, signing).
3. **The Mac eject warning:** a writable drive probably makes macOS say "Disk Not Ejected Properly"
   at unplug. Check it, and decide (only writable when the host isn't a Mac? a setting?).

### The app (the Xcode machine)

- **Where:** `ios/WedgieDrive/` in this repo (MIT, public). SwiftUI, iOS 17+.
- **Pick the drive once:** `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])`. The
  person picks the WEDGIE drive's top folder. Save a **security-scoped bookmark** of that URL
  (`url.bookmarkData()`) in UserDefaults.
- **Every use:** resolve the bookmark, `startAccessingSecurityScopedResource()`, use
  `NSFileCoordinator` to read and write, then `stopAccessing…`.
- **Send:** write `REQ-<n>.TXT` (a new name every time, so the wedgie never skips it as already
  read). One JSON line per request.
- **Read:** read `ANSWER.TXT` until its counter moves, or time out (say 60 s: the wedgie may be
  waiting for an A press).
- **Plugged in?** iOS has no plug-in notification for drives. Try to resolve the bookmark when the
  app comes to the front and every second while it's open. "Plug in your wedgie" until it resolves.
- **First screens:** pick the drive → the wedgie's hello (`{"type":"hello"}`: name, firmware, app)
  → Ask to connect (`{"type":"open"}`) → a log of every request and answer.

## Unknowns: test these first, in this order

1. **Does the bookmark survive unplug and replug?** If it doesn't, the person picks the drive once
   per plug-in (still better than the browser). This decides how good the app can be.
2. **Does the phone see the wedgie's new `ANSWER.TXT`, or an old cached copy?** iOS may cache
   what it read from the drive. Test with a rough version (the wedgie rewrites the file every few
   seconds) before building answers properly. If it caches, try reading with
   `.withoutChanges` coordination, re-resolving the bookmark, or a new file name per answer.
3. **How fast does the phone write?** The wedgie waits 0.7 s after the last write before reading
   (`inbox.SETTLE`).
4. **Junk files:** iOS may write hidden files (`._x`, `.Trashes`). They use up the 12-sector RAM
   budget. Count them.

## Milestones

1. App: pick the drive, write `REQ-1.TXT` with `{"type":"open"}`, and the wedgie asks. Then unplug,
   replug, and send again with no picker (unknown 1).
2. Firmware: a rough `ANSWER.TXT` the wedgie rewrites; the app shows it (unknown 2).
3. Firmware: real answers, merged and released.
4. App: hello, connect, and a Wallet request (sign a message) start to finish, with the A press.
5. TestFlight, then the App Store.

## Rules carried over

- Never skip the A press. A file on the drive is just another way in, with the same rules as USB.
- RAM: every firmware change is measured with `node tools/chipprobe.mjs` and run on a real RP2040
  before anyone calls it tested (CLAUDE.md landmine 13).
- The browser page (wedgie.dev/drive.html) stays as the no-install way.
