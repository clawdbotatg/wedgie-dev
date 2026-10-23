---
name: wedgie
description: Everything about a wedgie (Raspberry Pi Pico + Waveshare Pico-LCD-1.3 240x240 screen, joystick, A/B/X/Y, a secure chip on I2C, running MicroPython + wedgie firmware) - talking to it directly over USB (find its port, hello, its screen, buttons, files, the lock and the green-button press, full control), wedgie.py, building one from parts, first boot, finding what's wrong and fixing it, firmware and apps. Use for "my wedgie is plugged in", "what's on my wedgie's screen", "update my wedgie", "build a wedgie", "my wedgie is broken / won't ...", "I just got a wedgie", "is my wedgie safe", "Safe Signer / my Safe key", "make an app for my wedgie" (then code.md), "use the secure chip" (then trustm.md).
---

> You're reading SKILL.md from a WEDGIE drive: a wedgie is plugged into this computer right now.
> Its serial port is the one to talk to ("Talk to it directly" below). This file is skill.md, then code.md,
> then trustm.md: links to those three point to parts further down. Newest copies: https://wedgie.dev/skill.md

# Wedgie

A wedgie is a pocket computer made from three off-the-shelf parts: a Raspberry Pi Pico (RP2040 or
RP2350), a Waveshare Pico-LCD-1.3 hat (240x240 screen, 5-way joystick, A/B/X/Y), and a secure chip
(ATECC608 or Infineon OPTIGA Trust M) wedged between the boards on I2C. It runs MicroPython plus the
wedgie firmware: a boot logo, the one app it boots straight into, saves that outlast apps, and a USB
protocol. Everything is MIT: https://wedgie.dev

**The current firmware is 0.3.60.** If a wedgie's `hello` says older, update it first
(`wedgie.py update`, below): everything here assumes current firmware.

**Three guides cover everything** (this one first):
- **skill.md** (this): talking to a wedgie, wedgie.py, the lock, building, first boot, repair, firmware.
- **code.md**: making apps and games (the app format and template, fast graphics with measured numbers,
  the screen and button API, the `ui` kit, saves, the emulator). https://wedgie.dev/code.md
- **trustm.md**: the Trust M secure chip from an app (keys, signatures, ECDH, RSA, counters, storage).
  https://wedgie.dev/trustm.md

A plugged-in wedgie carries all three in one file, **SKILL.md**, on its WEDGIE drive.

## Just got one? Start here

1. Plug it in. The WEDGIE drive appears. Double-click **Open wedgie** (Mac) or **Open wedgie (Windows)**,
   or go to https://wedgie.dev/connect in Chrome or Edge (Safari and Firefox can't talk to USB).
2. Tap **Connect** and pick the wedgie. If the page says the firmware is old, update it.
3. Pick an app from the shelf. The wedgie asks "Install ...?" on its screen: press the green button.
4. For a Safe signer: install **Safe Signer**, then go to https://wedgie.dev/safe ("Safe Signer" below).

A new wedgie says "no software" until an app is picked. That's normal.

## Is it safe?

- **Plugging it in gives a computer nothing.** It's locked: no computer can reach its code, its files
  (except reading `/saves/`) or its secure chip without a press of the green button on the wedgie itself.
  0.3.54+: it can't see the screen or press a button either.
- **It signs nothing without that press.** No USB message, website or app on your computer can press it.
- **Firmware and shelf apps are signed by wedgie.dev.** The wedgie checks the signature before it installs.
- **Keys are made inside the secure chip and never leave it.** Not to the computer, not to wedgie.dev.
- **Limits, honestly:** an app runs with full power on the wedgie, so install only shelf apps or repos you
  trust (a repo added by hand is not signed). **A lost wedgie is a lost key:** someone holding it can reflash
  it and sign with its key. If you lose it, remove it as an owner.
  A lost or broken chip takes its keys with it: keep a Safe's other owners or recovery in place.
- **Safe Signer's key is locked for good** once made: nothing can replace it (below). Locked means it can't
  be replaced, not that only Safe Signer can use it: any code running on the wedgie can sign with it.
- Everything is open source (MIT): https://github.com/clawdbotatg/wedgie-dev

## Safe Signer

Makes the wedgie an owner of a Safe{Wallet} (Base, Ethereum, Optimism, Arbitrum, and their testnets).
App: `clawdbotatg/wedgie-safe`, on the shelf. Page: https://wedgie.dev/safe.

- **The key is made by you, on the wedgie, once.** The first time Safe Signer opens it shows **No key**
  and "make a key". Press green, then yes: the secure chip makes a new random key inside itself, then
  **locks it for good** (a Trust M or an ATECC608). Nobody has ever seen the key, including
  wedgie.dev, and nothing can ever replace or erase it: no app, no computer, no one. There's no "new key".
- **Check it's yours.** If Safe Signer shows an address the very first time you open it, someone made a
  key before you got it. Don't use it: it can't be replaced, so the chip has to be swapped.
- **Swap the chip** on the screen: the chip is locked with a key that isn't Safe Signer's. It never signs.
- The key lives only in the chip, so a broken chip loses it: keep a second owner on your Safe.
- Other apps use the chip's other key slots (trustm.md); they can't replace this one, but code on the
  wedgie can use it, so install only apps you trust.
- **Signing:** the page sends the transaction, the wedgie works out the hash itself, shows what it does,
  and signs only on green. Red says no. A long one goes over more pages. A transaction that pays a gas
  refund (gasPrice > 0) is refused: send it with gasPrice 0.
- **Execute on wedgie.dev/safe.** Safe{Wallet} can't execute a transaction a wedgie signed: it fails with
  GS021 (Safe's bug, https://github.com/safe-global/safe-wallet-monorepo/issues/8808). Signing there is fine.
- On chain the key is a passkey-style owner (P-256, Safe's WebAuthn signer). The wedgie shows its owner
  address; wedgie.dev/safe works it out too and refuses if the two differ.

## Talk to it directly

Everything wedgie.py and the website do is JSON lines over the wedgie's USB serial port. No driver.

1. **Find its port.** macOS: `/dev/cu.usbmodem*`. Linux: `/dev/ttyACM*` (or `/dev/serial/by-id/*wedgie*`).
   Windows: a `COM` port (USB vendor 0x2e8a, product name "wedgie"). Several boards: ask each for hello
   and match its `uid`. Just plugged in? Wait 2 s: the port drops once while the WEDGIE drive appears.
2. **Only one program can hold the port.** "Busy" or "Resource busy": find who has it with
   `lsof /dev/cu.usbmodem*` (macOS/Linux). Usually it's a wedgie.dev tab in Chrome (ask your person to
   close it) or mpremote.
3. **Python with pyserial.** `pip install pyserial`; if pip fails (some Homebrew Pythons can't), use
   uv, which works anywhere: `uv run --with pyserial python3 yourscript.py`.
4. **Ask it what it is** (115200 baud, one JSON object per line, answers carry your `id`):

```python
import serial, json, time                    # pip install pyserial   (or: uv run --with pyserial python3 this.py)
s = serial.Serial("/dev/cu.usbmodem1101", 115200, timeout=0.2)
s.write(b'{"id": 1, "type": "hello"}\n')
end = time.time() + 3
while time.time() < end:
    for line in s.read(65536).decode(errors="replace").splitlines():
        if line.startswith("{") and '"id": 1' in line:
            print(json.loads(line))          # firmware version, running app, chip, sealed/open, free RAM...
```

5. Lines that don't start with `{` are logs (an app's `print()`). **No answer at all:** it's showing
   "wedgie broke" (read the screen to your person; the green button there asks for full control), its app reads USB
   itself (`"usb": true`, rare), it isn't running wedgie firmware (`wedgie.py update`), or it's stuck:
   unplug it and plug it back in.

**What needs nobody:** `hello`, `shot` (its screen), `press` (a button, as if pressed: it drives an
app but can never answer a question on the wedgie), `chip` (prove the secure chip works), `ls`, and
`get` / `rm` inside `/saves/`, and `get` of its log (`/log.txt`, older half `/log1.txt`, 0.3.52+: power-ons,
app starts, crashes with tracebacks, installs). **Everything else needs your person to press the green button on the
wedgie's own screen** (installs, updates, other files, the REPL, the chip's keys). Tell them what will appear and
that they should press the green button, before you ask.
**The case's buttons have no letters on them:** to your person, A is "the green button", Y "the red
button", B and X "the grey buttons". The letters are only names in `press` and `lcd.Keys()`.

## Your tools: wedgie.py

One file: `curl -O https://wedgie.dev/wedgie.py`, then `python3 wedgie.py <command>` (or
`uv run --with pyserial python3 wedgie.py <command>`). "A" = your person presses the green button on the wedgie.

    python3 wedgie.py list                 every wedgie on USB: port, ID, firmware
    python3 wedgie.py hello                what it is and runs (JSON)
    python3 wedgie.py shot out.png         the real screen as a 240x240 PNG. READ IT to see what's there.
    python3 wedgie.py press A [ms]         press a button: A B X Y up down left right press
    python3 wedgie.py apps                 the apps on wedgie.dev, and which one it runs
    python3 wedgie.py use buttons          make that the app it runs (old one off, saves stay)          A
    python3 wedgie.py install .            make the app in this folder (wedgie.json) the app it runs   A
    python3 wedgie.py install app.py --name "My app"   one file as the app                             A
    python3 wedgie.py run app.py           run a file once (streams output; Ctrl-C stops)               A
    python3 wedgie.py uninstall            take its app off ("no software")                             A
    python3 wedgie.py update               install or update the firmware (its app and saves stay)      A
    python3 wedgie.py ls                   every file, saves included                                   A
    python3 wedgie.py saves [backup f.json | restore f.json]                                           A
    python3 wedgie.py debug                a report: firmware, files, free space and RAM, error.log     A
    python3 wedgie.py unlock               full control until it restarts (mpremote, the REPL, the chip) A, red screen

`--port /dev/cu.usbmodemXXXX` or `--id A1B2C3` picks one when several are plugged in. The person can
also do all of it by clicking at https://wedgie.dev/connect (Chrome or Edge).

## The lock and the green-button press

A wedgie is **locked** (hello says `"sealed": true`). Ctrl-C does nothing and no computer can reach its
REPL, its files outside `/saves/`, or its secure chip on its own. The only way in is a question on the
wedgie's own screen answered by a **real press** (a `press` request can't answer it):

- **One job** (`{"type":"open","for":"Update firmware"}`; wedgie.py and the site send it for you): the
  same red **FULL CONTROL?** question as below (0.3.27+: a computer's own title never goes on a calm
  screen that gives it the REPL); green (A) says yes, red (Y) or a minute with no answer says no. Allow 65 s for the reply.
  After a yes, hello says `"open": true` and Ctrl-C (0x03) works as usual until its app starts again.
- **Full control** (`{"type":"open","full":true}`, `wedgie.py unlock`, or just pressing Ctrl-C, e.g.
  mpremote's): a white-on-red **FULL CONTROL?** question. After a yes the app stops and the screen says
  **COMPUTER HAS FULL ACCESS / didn't want that? unplug it now**. It stays open until it restarts or is
  unplugged. mpremote gives up after ~10 s: if your person was slower, run it again (it's open by then).
  Ctrl-C in the first 3 s after it starts is ignored (a connecting tool's leftover bytes).
- **Signed installs** (an app from the wedgie.dev shelf, a firmware update) ask "Install Buttons?" /
  "Update firmware?" and then take only files signed by wedgie.dev; they never open the REPL.
  0.3.53+: a job does one thing, all of it on its question. "Update firmware" writes only the firmware
  (its app stays as it is); "Install Buttons" writes only Buttons and takes off only the app it
  replaces (the question says which); an uninstall takes off only its app. Anything more is refused.
  0.3.54+: a signed list older than the last one it installed is refused (`@serial`), even of the same version.
  0.3.55+: signed by one of two new keys, which can't be copied (a Mac's Secure Enclave, a YubiKey); lists
  signed by the old key are refused. A wedgie on 0.3.54 or older can't take a 0.3.55+ list: update it at
  wedgie.dev/test (it reflashes), or with `wedgie.py update` (asks FULL CONTROL).
  0.3.56+: the wedgie checks the signature while its question is up: a grey dot pulses, then turns into a
  green check (signed by wedgie.dev) or a red warning sign (not signed: a yes changes nothing). No check
  mark means it wasn't checked yet; it always is after the yes, before anything is written. 0.3.57+: yes is
  grey and does nothing until the check is done; no works at any time.
- **A no to FULL CONTROL holds until it's unplugged** (0.3.54+): every `open` after it is `refused` without
  asking, so a computer can't ask until the person gives in. A question takes no press in its first 0.6 s.
- **A no restarts the wedgie.** The question is drawn straight over the app's screen without saving it
  (saving the screen ran wedgies out of memory), so after a no it starts again from the top.
  Expect a `refused` answer, then its `ready` line.
- The lock is in the firmware, not the app: it turns Ctrl-C off before any app runs, so no app can
  leave a computer a way in. An app is code on the wedgie, though, and can do anything once installed;
  installing one is what the green-button press guards.

## Plugging in, and resets (read before scripting a wedgie)

About a second after power-up the wedgie adds its **WEDGIE** USB drive (its icon is the wedgie logo, a
pair of underwear), which disconnects and reconnects USB. So a wedgie you just plugged in **shows up,
vanishes and shows up again** as a new serial port, same board ID. Wait ~2 s after a plug-in, retry an
open that fails, and find a wedgie by its ID (`uid`), never by its port.

**Never soft-reset a wedgie to restart its app** (Ctrl-D, `machine.soft_reset()`, `mpremote reset`):
a soft reset runs main.py, which locks it again, and can drop the port; a tool that reconnects and
resets again loops forever. To leave the REPL and start the app: `exec(open("main.py").read())`.
Unplugging (or the `reboot` request) is a full restart.

Hold **X** while plugging in: it starts without its app (its home screen), a way back in when an app
crashes at start or keeps USB from answering. Hold **Y**: no WEDGIE drive this time (debugging only).

## The USB requests

    {"id":1,"type":"hello"}              -> {"type":"hello","version":"0.3.60","fw":"wedgie-0.3.60","uid":...,"short":"023277",
                                             "board":...,"chip":"OPTIGA Trust M","running":"buttons","sealed":true,"open":false,
                                             "ram":63000,"free":1118208,"slot":1,"jobs":3,"bin":4096,...}
    {"id":2,"type":"shot"}               -> {"type":"shot","i":0,"n":38,"w":240,"h":240,"fmt":"rgb565be","data":"<base64>"} x n
                                            0.3.54+: only after a yes (open); locked, an error
    {"id":3,"type":"press","key":"A","ms":80} -> {"type":"ok"}   (0.3.54+: only after a yes, as shot)
    {"id":4,"type":"chip"}               -> proof the chip works: an ATECC608 hashes random bytes, a Trust M
                                            signs them with its factory key (check it yourself).
                                            0.3.53+: {"busy":1} while its app is using the chip: ask again
    {"id":5,"type":"ls","path":"/saves"} -> {"type":"ls","files":[[path, bytes], ...],"free":N}  (folders end in /)
    {"id":6,"type":"get","path":"/saves/x/best.json"} -> {"type":"file","i":0,"n":N,"size":S,"data":"<base64>"} x n
    {"id":7,"type":"rm","path":"/saves/x"} -> {"type":"ok","free":N}   (a folder goes with everything in it;
                                            0.3.54+: asks "Delete saves" on the wedgie first, else "refused")
                                            get / rm outside /saves/: an error until the person lets you in
    {"id":12,"type":"ping"}              -> {"type":"pong"}     (is it there, nothing else)
    {"id":8,"type":"stop"}               -> {"type":"ok"}       (stops its app)
    {"id":9,"type":"reboot"}             -> {"type":"rebooting"} (a full restart: the port drops)
    {"id":10,"type":"open","for":"..."}  -> {"type":"open"} or {"type":"refused"}  (asks the person, in red)
    {"id":11,"type":"open","full":true}  -> the same, asked in red: full control
    {"type":"phone"}                     -> makes the WEDGIE drive writable (phone mode), no question
    {"id":13,"type":"remount"}           -> {"type":"remount"}, then USB off for 2 s and back, still writable
                                            (phone mode only, 0.3.45+: a host whose view of the drive is stale)

hello's fields: `version` the firmware, `running` the app on screen (null: none), `chip` the secure
chip found, `sealed` locked, `open` let in right now, `ram` bytes of free RAM, `free` bytes of free
flash, `uid` / `short` its board ID (the short one is shown on its page), `slot: 1` it runs one app
(firmware 0.2+), `jobs: 2` it takes signed installs, `bin: 4096` it takes raw file bytes (fast
installs). A request that fails on the wedgie answers `{"type":"error","error":"..."}` and its app
keeps running. A line over 6 KB is dropped.

Installs and updates are a longer conversation (a signed file list, file sums, the files, commit, a
restart into install mode); **use wedgie.py or the site for them**, don't reimplement it. wedgie.py's
source (https://wedgie.dev/wedgie.py) is the reference if you must.

## No serial port? Files on the WEDGIE drive (0.3.22+)

A host that can't open the serial port (an iPhone, a locked-down computer) can send the same requests as
files on the drive. It's a new way in for requests, not more power: anything that needs a yes still asks on
the wedgie's screen.

**Turning it writable (0.3.41+).** The drive is read-only until something asks, so a desktop never says
"not ejected properly". To ask: read the hidden `KNOCKB.TXT`, then `KNOCKA.TXT`, then `KNOCKB.TXT` again,
uncached, each read 0.3-3 s after the last (0.5 s is good). A second read of the same file within 0.3 s counts
as one. It works any time, right after plug-in too. No question on the wedgie: files can't do more than USB
serial. The wedgie drops off USB for 2 s and comes back writable, with a phone in the screen's corner, until
unplug. Keep asking every couple of seconds until the drive is writable; extra asks are ignored. (A scan reads
A then B milliseconds apart, so it never asks by accident.) Firmware 0.3.37-0.3.40 asked differently: read
`PHONE.TXT` twice 1-10 s apart, not in the first 8 s, then a yes on the wedgie ("Allow phone txns?").

**Send.** Write a new file `REQ-<n>.TXT` in the top folder: one JSON request per line with your own unique
`id`, a new name every time. The wedgie reads it 0.7 s after the last write.

**Answer.** Once a request came in as a file, every answer also goes into `ANSWER.TXT` (2048 bytes): first
line `#<count>` (0.3.42+: then the drive's state, below), then the last few answers as JSON lines, padded with newlines (strip `\0`). It starts over
when full. Read it uncached about every 0.7 s until an answer with your `id` is there (a few seconds; up to a
minute while it waits for a press). Never read it through a cache: the host keeps the old copy and won't see
new answers for minutes (seen on an iPhone after re-picking the drive: the app's uncached reads got a frozen copy
for 3-5 min, likely the picker's preview; F_NOCACHE skips the cache only for data not in it yet). 0.3.44+ hides it so file browsers don't
show or preview it.

**What reached the wedgie (0.3.42+).** The rest of `ANSWER.TXT`'s first line, refreshed every 0.5 s, read it
uncached: `w` writes taken, `a` ms since the last, `l` its sector, `p1` written since the last look (it reads
new files only after 0.7 s with no writes), `o` RAM sectors held, `f1` RAM full, `s` looks, `z` writes by area
(boot.FATs.root folder.data, 0.3.43+), `e` root folder entries used/deleted/of (the root folder holds only 64).
No answer and `w` didn't move: your write never reached it. `p1` with a small `a` that stays small: something
keeps writing, so it never looks. `f1`: full.

**Is what you read real (0.3.45+)?** The first line ends with ` t` and the wedgie's clock in ms, stamped at
every read of that sector. Read it twice: the same `t` means the second read never reached the wedgie (your
host served a cached copy). Then write a `{"type":"remount"}` request (writes still get through): the drive
drops off USB for 2 s and your host mounts it again with nothing cached; the answer is there after.

**The wedgie keeps your writes in 12 sectors of RAM (6 KB, folder and FAT writes included), never flash.**
0.3.41+ gives a request's sectors back as soon as it has read the file. Before that, only once the host's
delete reached it and 2 s had passed. So:
- one request at a time, the next only after the last one's answer;
- delete old REQ files (on 0.3.40 and older: every one, just before writing the next, and at least 2.2 s
  from one write to the next);
- keep a line under about 1.6 KB;
- a write that fails with an I/O error means full: wait a second and try again;
- a big request goes in pieces if its app takes them (the Safe signer: `safe_data`, 1400 hex a piece over
  the drive, then `safe_sign` with `data: "@"`).

**On an iPhone** (reference: ios/WedgieDrive in this repo, and Instant Wallet's app, `Drive.swift`):
- Pick the drive once with the folder picker (`UIDocumentPickerViewController(forOpeningContentTypes:
  [.folder])`) and keep a security-scoped bookmark. It survives unplug. The first time the picker opens
  wherever the person last was (Recents, iCloud): tell them Browse, WEDGIE, Open. It can't be started on the
  drive before the app has been given it once (`directoryURL` to its path is ignored).
- Check the pick: the drive has `README.txt` and `SKILL.md` at its top.
- `volumeIsReadOnly` says whether it's writable yet. iOS has no plug-in event: poll about once a
  second while the app is in front.
- Read uncached (`NSFileCoordinator` `.withoutChanges` + `Data(contentsOf:options: .uncached)`) or iOS hands
  back its old copy. Plain writes; the drive doesn't do `fsync` (`FileHandle.synchronize` fails).
- Every drive call off the main thread, with a time limit, and never at app start: a stuck drive can hang a
  call for good.
- On a Mac, ask by reading `/Volumes/WEDGIE/KNOCKB.TXT`, `KNOCKA.TXT`, `KNOCKB.TXT` with `F_NOCACHE`, 0.5 s apart.

**Rules for an agent:**
- The knock is the only way to make the drive writable. Don't look for another (no SCSI tricks, no
  firmware edits); a writable drive by default makes every Mac warn at unplug.
- A computer that knocks gets a writable drive, so its person sees "not ejected properly" unless they eject
  first. Tell them. On a computer, USB serial is the better path; the drive is for hosts without one.
- Writable never means more power: every request still goes through the same handler as serial, and anything
  that signs or installs still needs the green button on the wedgie.
- Reads must reach the wedgie: uncached, and never two reads of the same file within 0.3 s (they count as one).

**Sketch (Python on a Mac; not run against a board):**

    import fcntl, os, time, json
    V = "/Volumes/WEDGIE"
    def raw(name):                                    # uncached: the wedgie must see the read
        fd = os.open(os.path.join(V, name), os.O_RDONLY)
        try:
            fcntl.fcntl(fd, getattr(fcntl, "F_NOCACHE", 48), 1)
            return os.read(fd, 4096)
        finally:
            os.close(fd)
    def writable():
        try: return not os.statvfs(V).f_flag & os.ST_RDONLY
        except OSError: return False                  # gone for its 2 s drop
    while not writable():                             # the knock, again until it takes
        try:
            for f in ("KNOCKB.TXT", "KNOCKA.TXT", "KNOCKB.TXT"):
                raw(f); time.sleep(0.5)
        except OSError: pass
        time.sleep(2)
    rid = int(time.time())
    with open(os.path.join(V, "REQ-%d.TXT" % rid), "w") as f:
        f.write(json.dumps({"id": rid, "type": "hello"}) + "\n")
    for _ in range(30):                               # the answer: match by id
        time.sleep(0.7)
        for line in raw("ANSWER.TXT").decode(errors="ignore").replace("\0", "").splitlines():
            if line.startswith("{") and json.loads(line).get("id") == rid:
                print(line); raise SystemExit

## The hardware: parts, pinout, putting it together

Be exact when someone builds or rebuilds one: **a wire in the wrong hole is the most common failure.**
A 3D step-by-step is on https://wedgie.dev ("Put it together"); parts are below.

### Parts
- **A Pico**: Raspberry Pi Pico 2 W (RP2350, WiFi), Pico W (RP2040, WiFi), or an RP2040 Pico clone
  (often pink, no WiFi). The USB port is USB-C or micro USB depending on the model (official Picos are
  micro USB; most clones are USB-C), so check which cable fits. Same 40-pin layout on all of them. It needs its two 20-pin male headers
  (buy "pre-soldered headers"). Telling them apart: the chip on the board says RP2040 or RP2350; a W
  has a silver WiFi can next to it; `hello`'s `board` says which.
- **Waveshare Pico-LCD-1.3**: 1.3" 240x240 IPS (ST7789, SPI), a 5-way joystick, four buttons A B X Y,
  and a 2x20 female header the Pico plugs into.
- **Secure chip breakout**: Adafruit ATECC608 (product 4314) or Adafruit OPTIGA Trust M (4351). Both
  have two STEMMA QT ports (same bus, wired in parallel).
- **A 4-pin STEMMA QT / Qwiic cable with bare ends** (JST-SH plug on one end, loose wires on the other).
- A data USB cable (not charge-only), and optionally the printed case (below).

### How the sandwich goes
The Pico plugs into the hat's female header: Pico components facing AWAY from the screen board (its
chip and BOOTSEL button stay visible from the back), the Pico's USB at the same end as the joystick.
Held as a wedgie (landscape, screen facing you): USB on the left, joystick left of the screen, A B X Y
in a column on the right, A at the top. Push straight, no force at an angle; all pins in, none outside.

### The I²C plug (STEMMA QT / Qwiic)
Four contacts, from one end: **GND, V+ (3.3 V), SDA (data), SCL (clock)**. Adafruit cables color them
black, red, blue, yellow. Other bags use other colors (one common bag: white, yellow, black, red).
**Trust the order, never the colors**: find the GND end of the plug and count.

### Where the four wires go
Turn the sandwich over so you look at the Pico's back (its chip facing you), USB end pointing up.
"Right" and "left" below are as you look at it like that: **right is the side whose top hole is VBUS
(pin 40)**, left the side whose top hole is GP0 (pin 1). Count holes down from the USB end in the hat's
header socket, beside the Pico's pins; the bare wire goes into the same hole as the Pico pin and the
socket's spring contact holds both:

| Wire (plug order) | Signal | Side  | Hole from USB end | Pico pin |
|-------------------|--------|-------|-------------------|----------|
| 1st | GND        | right | 3rd | 38 (GND)   |
| 2nd | V+ 3.3 V   | right | 5th | 36 (3V3 OUT) |
| 3rd | SDA        | left  | 6th | 6 (GP4)    |
| 4th | SCL        | left  | 7th | 7 (GP5)    |

Right side top-down is VBUS, VSYS, GND, 3V3_EN, 3V3. **Never put anything in the 4th hole on the right
(3V3_EN): grounding it switches the 3.3 V supply off.** Never use VBUS/VSYS (5 V) for the chip.
Use the cable's ends as they come; push each straight in beside the pin as far as it goes. It should
hold against a light tug; one that slides out isn't making contact. Then wedge the chip board flat into
the gap between the boards (~8.5 mm tall), wires flat so nothing presses on the back of the screen.
(No photo of the four wires in place is published yet; the 3D steps on wedgie.dev show them.)

### Full Pico pinout (looking at the Pico's back, USB at top)
Left, pins 1-20 top-down: GP0, GP1, GND, GP2, GP3, GP4, GP5, GND, GP6, GP7, GP8, GP9, GND, GP10, GP11,
GP12, GP13, GND, GP14, GP15.
Right, pins 40-21 top-down: VBUS, VSYS, GND, 3V3_EN, 3V3, ADC_VREF, GP28, AGND, GP27, GP26, RUN, GP22,
GND, GP21, GP20, GP19, GP18, GND, GP17, GP16.

Used by the hat: GP2 up, GP3 joystick press, GP8 DC, GP9 CS, GP10 SCK, GP11 MOSI, GP12 RST, GP13
backlight, GP15 A, GP16 left, GP17 B, GP18 down, GP19 X, GP20 right, GP21 Y. Used by the wedge:
GP4 SDA, GP5 SCL, pin 36 3V3, pin 38 GND. **Free: GP0, GP1, GP6, GP7, GP14, GP22, GP26, GP27, GP28**
(GP26-28 can read analog). More I²C boards (sensors, a haptic motor, a QR reader) plug into the chip
breakout's second STEMMA QT port and share the bus; no new wires.

### The case
A snap-together printed shell, no screws: https://github.com/clawdbotatg/clawd-pico-case (STLs in
`stl/current/`: lid, base, joystick cap, 4 button caps). PETG, 0.16 mm layers, 4 walls, no supports;
lid face down, base floor down, caps flange down. **USB-C and micro USB Picos both fit the same case.** Check the wedged chip lies flat
before closing. To assemble: seat the Pico's USB connector into the base's port first, then lower the
joined boards in (don't force them straight down); put the four button caps and the joystick cap on;
press the lid on until the hidden catches click. To open: the pry notch on one side. There's a hole in
the base to reach BOOTSEL.

### Taking it apart and putting it back
Open the case at the pry notch, lift the lid (caps may fall out), lift the board stack out. Slide the
chip out of the gap. Pull the four wires straight out of the header. Separate Pico and hat by pulling
straight apart, rocking gently end to end, never twisting. Reassemble in reverse, then check it as in
"First boot" step 4.

### Limits
- 3.3 V logic everywhere; GPIOs are **not 5 V tolerant**. Power comes from USB (5 V on VBUS); the
  Pico's 3V3 pin can supply a few hundred mA for add-ons.
- RP2040: 264 KB RAM, 2 MB flash. RP2350 (Pico 2 W): 520 KB RAM, 4 MB flash. The screen buffer takes
  29 KB (16 colors, 0.3.24+; it was 115 KB). Free RAM for an app on an RP2040: about 120-150 KB
  (`hello`'s `ram` says); an RP2350 has several times that.
- 240x240; the panel is 16-bit color, the firmware draws in 16 colors (the boot logo in full color); a full-screen push takes ~25 ms (code.md has the measured costs).
- No battery built in. A LiPo on VSYS (the atomic wedgie) works: off USB, the firmware (0.3.28+,
  `power.py`) shows the charge in the top-right corner over every app (read from VSYS on GP29) and puts
  the wedgie to sleep after 20 s with no press (0.3.29+: dormant, every clock stopped); any button or
  plugging in USB wakes it, and that press goes to nobody.

## First boot, in order

1. **MicroPython.** The easy way: https://wedgie.dev/test in Chrome does steps 1-4 itself. By hand:
   hold BOOTSEL while plugging in; a drive (RPI-RP2 or RP2350) appears; drag the `.uf2` for that board
   from https://micropython.org/download/ (RPI_PICO for RP2040 boards and clones, RPI_PICO_W for a Pico
   W, RPI_PICO2_W for a Pico 2 W) onto it. It restarts as a serial port.
2. **The wedgie firmware:** `python3 wedgie.py update` (a bare board doesn't ask; it isn't locked yet).
   The boot logo shows, then "no software".
3. **An app:** pick one at https://wedgie.dev/connect, or `python3 wedgie.py use buttons` (A).
4. **Check it:** its page at wedgie.dev/connect shows Hardware (the chip works?), Test the screen,
   Test the buttons. Buttons (the app) also walks every button.

## When something's wrong: check in this order

1. **Is it on USB?** `python3 wedgie.py list`. Nothing: try another cable (charge-only cables are
   common) and another port. A drive called RPI-RP2 / RP2350 instead: it's in BOOTSEL (no
   MicroPython, or BOOTSEL was held): first boot step 1.
2. **Does hello answer?** No answer: read its screen. "wedgie broke: <error>": B tries again, A asks
   for full control so a computer can fix it (`wedgie.py debug` shows `error.log`). Black screen: the
   hat isn't fully seated, or there's no firmware (bare MicroPython shows nothing): `wedgie.py update`.
   An app that crashes at start: hold both gray buttons (B and X) while plugging in, then pick another app.
   What happened lately: `get` `/log1.txt` then `/log.txt` (no yes needed). Your person can send it to us
   with **Send a bug report** on its page at wedgie.dev/connect.
3. **Is the chip OK?** `{"type":"chip"}` (or Hardware on its page). Not found, in order of likelihood:
   wires by color instead of plug order; SDA/SCL swapped; a data wire and the power wire swapped (the
   chip powers itself through a data pin, its LED lights, it looks like a short: it isn't, swap them);
   a wire in 3V3_EN; the chip board touching a Pico pin. With full control you can scan the bus:
   `from machine import I2C, Pin; print([hex(a) for a in I2C(0, sda=Pin(4), scl=Pin(5)).scan()])` should
   show `0x60` (ATECC608) or `0x30` (Trust M). With a meter: 3.3 V between pin 36 (3V3) and pin 38 (GND).
4. **The screen:** Test the screen on its page. Stripes or nothing with the backlight on: reseat the hat.
5. **The buttons:** Test the buttons on its page lists which work. "Held from the start": a cap presses
   the switch all the time. Never registers: the switch itself.
6. **Still broken: https://wedgie.dev/test.** It copies the saves into the browser, wipes the whole
   Pico (BOOTSEL), puts MicroPython on (the W build if it has WiFi), then the firmware, puts the saves
   back, and tests the board, the screen, every button and the chip. Nothing starts until its Test it
   button is pressed. It uses the secure chip but never changes it: safe to run again and again.
   Just the latest firmware, no tests (old firmware, or it won't start): https://wedgie.dev/reset. It
   shows how to hold BOOTSEL, then wipes it and puts on MicroPython, the firmware and Welcome. Saves go.

**A dead or locked secure chip:** it's its own little board, so swap in a new breakout. Keys made inside
the old chip are gone with it: anything they guarded (a wallet whose key lived on that chip) can only
come back through that wallet's own recovery. A reflash or /test never erases the chip.

## Firmware and apps

The firmware is the core: the boot logo, the WEDGIE drive, the slot that runs the app, saves, the
screen and button drivers, the chip drivers, and `ui`. It's compiled (`.mpy`), signed by wedgie.dev,
and a wedgie checks the signature before it takes an update. Apps are separate, one at a time: picking
another takes the old one's files off and puts the new one's on; saves stay. A fresh wedgie runs
nothing and says "no software" until one is picked.

Apps live in their own GitHub repos, each with a `wedgie.json` (code.md). **The shelf** at
wedgie.dev/connect lists the ones wedgie.dev has read and signed (Safe Signer, Buttons, Keypad, Frog,
Grove, Bunker, Blocks, 2048, Blackjack: `clawdbotatg/wedgie-*`); they install with a signed install. **Any other repo** can be added on a
wedgie's page (Software, "Apps from a GitHub repo"): it isn't signed, so it installs with full access,
and **an app installed that way can do anything a computer with full control can, including replacing
the keys in the Trust M's spare key slots.** Only install repos you trust.

## From Python (an app's view)

The full API with templates and measured speeds is in code.md; the essentials:

- `lcd.LCD()`: a `framebuf.FrameBuffer` (240x240, 16 colors): `fill`, `pixel`, `hline`, `vline`, `line`,
  `rect`, `fill_rect`, `ellipse`, `poly`, `text(s, x, y, c)` (8x8 font), `blit`, `scroll`, plus
  `show()`, `show(y0, y1)`, `show_rect(x, y, w, h)`, `show_start()` / `show_wait()` (the same as `show()` since 0.3.24),
  `big_text(s, x, y, c, scale)`, `center_text(s, y, c, scale)`, `backlight(pct)`. Colors:
  `lcd.color(r, g, b)` (the nearest of the 16), or `BLACK WHITE RED GREEN BLUE YELLOW GREY DARK`.
- `lcd.Keys()`: `pressed()` (names that went down since the last call) and `held(name)`. Names:
  `A B X Y up down left right press`. A (green) = yes, Y (red) = no/back, B and X are grey. Never show a
  letter on screen: `{g}` `{r}` `{k}` in `ui` text draw a green / red / grey square.
- `ui`: the palette (`WHITE INK MUTED GREEN GREEN_D GREY RED`), `page`, `ask`, `progress`, `say`, `band`,
  `title`, `wrap`, `buttons` (code.md, "Look and feel").
- `save`: `store(name, value)`, `load(name, default)`, `delete(name)`, `names()`, in `/saves/<app>/`.
- `wedgie`: `uid()`, `short()`, `board()`, `VERSION`, `chip()` (proves the chip, as the USB `chip`
  request), `rand(n)`, `rand_below(n)`, `rand_source()` (true random numbers from the chip).
- The secure chip: a Trust M through `import optiga` (trustm.md: keys, signatures, ECDH, RSA, counters,
  storage). An ATECC608 through `atecc.ATECC608(sda=4, scl=5)`: `random()`, `serial()`, `pubkey(slot)`,
  `sign(digest, slot)` (P-256), but a key exists only after its config is written and locked
  (`write_config`, `lock_config`), which is **permanent**: never do it unless your person asks. Slot 0
  is Safe Signer's (it locks it for good); your app: another slot.
- **Neither chip does secp256k1** (Ethereum's curve). Both sign P-256, which smart-account wallets with
  passkey-style (P-256 / RIP-7212) verification accept; a plain Ethereum key would have to live in
  software on the Pico, without the chip's protection.
- MicroPython, not CPython: small stdlib (`math random struct json time array binascii hashlib
  framebuf gc`), `time.ticks_ms()`, `ticks_diff()`, `sleep_ms()`, no real clock, no pip. WiFi only on W
  boards.


# Make a wedgie app

You are writing a game or app for a **wedgie**: a Raspberry Pi Pico (RP2040 or RP2350) under a
240x240 color screen, with a 5-way joystick on the left and four buttons A B X Y down the right. It
runs MicroPython plus the wedgie firmware, which boots straight into one app. You write that app.

What you hand back is a **folder** (later a GitHub repo) with a `wedgie.json` at its top and the app's
Python files. The person plays it in the emulator at https://wedgie.dev/code while you work, and on
their own wedgie when it's ready. Everything here is MIT.

Other things about the wedgie (building one, the USB protocol, the secure chip): https://wedgie.dev/skill.md
The Trust M secure chip from an app: https://wedgie.dev/trustm.md

## The loop

1. Make the folder: `wedgie.json` + your files (start from the template below, or copy
   https://github.com/clawdbotatg/wedgie-starter, a small complete game).
2. Tell the person: open https://wedgie.dev/code in Chrome, press **Open a folder**, pick this folder.
   Their app runs in an emulated wedgie right there, and **runs again by itself every time you save a
   file**. Keys: `W A S D` joystick, `Space` press the joystick in, `J K L ;` are A B X Y, `R` runs it
   again. Their `print()`s and tracebacks show under **Output**.
3. Keep writing; they keep playing. Ask what they see. A traceback in Output is yours to fix.
4. On their real wedgie (plugged in with USB):

       curl -O https://wedgie.dev/wedgie.py        # needs pyserial: pip install pyserial, or run it as
                                                    # uv run --with pyserial python3 wedgie.py ...
       python3 wedgie.py install .                  # this folder's app becomes the app it runs
       python3 wedgie.py shot s.png                 # the real screen as a PNG: READ IT
       python3 wedgie.py press A                    # press a button (A B X Y up down left right press)
       python3 wedgie.py run mygame.py              # run a file once and see its output/traceback

   Only one program can hold the wedgie's USB port: if wedgie.py says busy, close the wedgie's page on
   wedgie.dev. The emulator is not the real speed; **check frame times on the real wedgie** (below).
5. Put the folder on GitHub (public). Anyone can then add it on their wedgie's page at
   wedgie.dev/connect (Software, **Apps from a GitHub repo**, `owner/repo`). Such an app isn't signed by
   wedgie.dev, so it installs with full access: it can do anything on that wedgie, including replacing
   the keys in its Trust M's spare key slots. Say so in your README.
6. To be on wedgie.dev for everyone (signed, one tap to install): ask wedgie.dev to add the repo
   (an issue on github.com/clawdbotatg/wedgie-dev). We read one commit, sign it, and it's on the shelf;
   a later commit goes up only when we read that one too.

## wedgie.json

```json
{
  "apps": [
    {
      "mod": "snake",
      "name": "Snake",
      "about": "Eat, grow, don't bite yourself.",
      "files": ["snake/snake.py", "snake/snake_levels.json"],
      "entry": "run",
      "fw": "0.2.3",
      "label": "#22c452",
      "icon": ["............", "............", "..kkkkkk....", "..kggggk....", "..kgkkgk....", "..kgk.kgkkk.",
               "..kgk.kgggk.", "..kgk.kkkgk.", "..kgk...kgk.", "..kkk...krk.", "........kkk.", "............"]
    }
  ]
}
```

- `mod`: the Python module name, 2-20 of `a-z 0-9 _`. Must not be a firmware module (`lcd`, `save`,
  `slot`, `wedgie`, ...). It's also the app's save folder.
- `files`: paths in the folder. On the wedgie **every file lands in the flash's root under its own
  name**, so every file name is `<mod>.py` or starts with `<mod>_` (`snake_levels.json`), lowercase,
  ending `.py .mpy .bin .json .txt`. `<mod>.py` is required: it's what gets imported. Up to 30 files,
  256 KB per app.
- `entry`: a function the firmware calls after importing (a game loop). Leave it out for a Timer app
  (it starts itself at import).
- `fw`: the oldest firmware it runs on. `"0.2.3"` if you use `show_start`/`show(y0, y1)`/`show_rect`,
  `"0.2.4"` if you use `wedgie.rand`.
- `name` up to 14 characters (it's printed on the cartridge), `about` one line, `label` the cartridge
  color, `icon` 12 rows of 12 characters: `.` clear, `k` black, `w` white, `g` green, `r` red,
  `y` yellow, `b` blue, `s` grey.
- `chip`: `"ATECC608"` or `"OPTIGA Trust M"` if it needs that secure chip. `usb`: true only if the app
  speaks its own protocol on USB (a wallet); almost never.
- One repo can hold several apps; each is its own entry.

## The template

**Use this shape for every app and game:** an `entry` loop at a fixed frame rate, in a folder with a
`wedgie.json` that names the entry. (A Timer app, which starts itself at import, also works, but has
nothing this lacks. Don't install a loop like this as one bare file with `wedgie.py install app.py`: with
no wedgie.json there's no `entry`, and a loop that starts at import keeps USB from answering.) This is the shape to keep (the full game with
sprites and saves is https://github.com/clawdbotatg/wedgie-starter/blob/main/dodge/dodge.py):

```python
import time
from lcd import LCD, Keys, color
import save

lcd = LCD()                       # the screen: a 240x240 framebuf, 16 colors
keys = Keys()
BG, INK = color(8, 10, 24), color(240, 240, 235)
FRAME = 25                        # ms per frame: 40 fps
x = 112

def update():
    global x
    if keys.held("left"): x = max(0, x - 4)
    if keys.held("right"): x = min(224, x + 4)

def draw():
    lcd.fill(BG)
    lcd.fill_rect(x, 200, 16, 16, INK)
    lcd.text("hello", 4, 4, INK)

def run():                        # wedgie.json: "entry": "run"
    while True:
        t = time.ticks_ms()
        for k in keys.pressed():  # names that went down since last call: A B X Y up down left right press
            pass
        update()                  # runs while the last frame is still going out
        lcd.show_wait()           # the buffer is ours again
        draw()
        lcd.show_start()          # this frame goes out by DMA while the next update runs
        left = FRAME - time.ticks_diff(time.ticks_ms(), t)
        if left > 0:
            time.sleep_ms(left)   # the firmware answers USB in here: always sleep a little
```

The app gets every button; there's no menu and nothing that leaves it. Convention: A (green) = yes/fire,
Y (red) = no/back; B and X are grey. Keep the joystick for movement. Show the controls on the title screen.

## Fast graphics: what things cost

Measured on a real wedgie (RP2040 Pico, firmware 0.2.3, 125 MHz). An RP2350 is
faster on CPU work. At 40 fps you have 25 ms a frame, and **pushing the full screen takes 18 of them**,
so the whole game is about not paying that twice.

| What | Cost |
|---|---|
| Full screen push, `lcd.show()` | ~25 ms (0.3.24+: turned from 16 colors to RGB565 row by row; not yet re-measured) |
| `show(y0, y1)`: a 24-row band / 120 rows | 2.4 ms / 9.4 ms |
| `show_rect(x, y, 32, 32)` | 1.8 ms (about 45 us per row, plus its bytes) |
| `fill()` the whole buffer | 4.2 ms |
| 16x16 4-bit sprite `blit` through a palette | 0.33 ms |
| `text()`, 30 characters | 0.4 ms |
| `big_text(..., scale 3)`, 10 characters | 14 ms |
| Plain Python pixel loop | 6.8 us per pixel (a full screen: 0.4 s) |
| `@micropython.viper` pixel loop | 0.26 us per pixel (26x faster) |
| `gc.collect()` | 8 ms |
| RAM free for a game (RP2040, framebuffer taken) | ~130-150 KB on 0.3.24+ (hello's `ram`) |

The rules that follow from it:

0. **Never grow a string or bytes with `+=` in a loop.** Each `+=` copies the whole thing, and on an
   RP2040 the copies chop the heap into pieces too small for the next one: "memory allocation failed"
   with plenty of RAM free in total. Collect parts in a list and `"".join` them once, or write into a
   `bytearray` made once at start. Make big buffers at import, while the heap is in one piece.

1. **The screen has 16 colors (0.3.24+).** The framebuffer keeps a 4-bit palette index per pixel (29 KB
   instead of 115 KB, so an RP2040 has room left). `color(r, g, b)` gives the nearest of the 16
   (`lcd.PALETTE`: the ui colors, a grey ramp, black, yellow, blue). `show_start()` is a plain `show()`
   now and `show_wait()` does nothing; both stay so older apps run. Need an exact color (0.3.36+)?
   `lcd.tint(i, r, g, b)` shows index `i` as that color until the next `fill()`; pick an `i` nothing
   else on the screen uses (`lcd.tinted()` = the ones this screen already took, a bit each).
2. **Push less when little changed.** A puzzle, a menu, a card game: redraw the part that changed and
   push `lcd.show(y0, y1)` (full-width rows: nothing is copied) or `lcd.show_rect(x, y, w, h)`.
   Prefer a band over many rects: each rect row costs ~45 us on its own.
3. **Draw with the C calls.** `fill`, `fill_rect`, `rect`, `hline`, `vline`, `line`, `ellipse`,
   `poly`, `text`, `blit`, `scroll` all run in C. A Python loop over pixels is 20-40x slower than the
   same thing done by one of these.
4. **Sprites are framebufs made once, at import: 4-bit (`framebuf.GS4_HMSB`) drawn through a palette.**
   An RGB565 sprite can't be blitted onto the 16-color screen (its colors come out wrong). The palette
   framebuf holds `color()` values, which are palette indexes:

   ```python
   import framebuf
   from lcd import color
   KEY = color(255, 0, 255)                      # palette slot 0: the transparent color
   def palette(*rgb):                            # up to 15 colors
       p = framebuf.FrameBuffer(bytearray(32), 16, 1, framebuf.RGB565)
       for i, c in enumerate((KEY,) + rgb): p.pixel(i, 0, c)
       return p
   def sprite(rows):                             # '.' clear, '1'-'9' a palette color
       w, h = len(rows[0]), len(rows)
       fb = framebuf.FrameBuffer(bytearray((w * h + 1) // 2), w, h, framebuf.GS4_HMSB)
       for y, r in enumerate(rows):
           for x, ch in enumerate(r): fb.pixel(x, y, 0 if ch == "." else int(ch))
       return fb
   lcd.blit(SHIP, x, y, KEY, SHIP_PAL)           # key = the palette COLOR that's skipped
   ```
   For big art, keep raw bytes in a `<mod>_art.bin` file and `f.readinto()` it into a preallocated
   `bytearray` once.
5. **Colors: always `color(r, g, b)`** (the nearest of the screen's 16). Make them once, at the
   top, never in the loop.
6. **Pixel work (plasma, fire, a raycaster's columns) goes in viper:**

   ```python
   import micropython
   @micropython.viper
   def shade(buf: ptr16, t: int):
       for i in range(240 * 240):
           buf[i] = (i + t) & 0xFFFF             # int math only: no floats, no calls to Python functions
   shade(lcd.buffer, frame)
   ```
   Viper is integer-only: precompute tables (sine, palettes) as `bytearray`s at import and pass them
   in as `ptr8`. In the emulator viper runs as plain Python (correct, just slow).
7. **Make nothing new inside the loop.** Every new list, tuple, string, float or `%` format is
   garbage, and a `gc.collect()` costs 8 ms when it comes. Keep game objects in lists you reuse
   (`r[0], r[1] = x, y`, not `rocks[i] = (x, y)`), build score text only when the score changes, and
   call `gc.collect()` yourself at calm moments (a level change, between `show_start` and `show_wait`).
8. **Big text is slow.** `text()` (the 8x8 font) is cheap. For a big title, draw it with `big_text`
   once into its own framebuf and `blit` that each frame.
9. **Don't change the clock.** The firmware runs the chip at 125 MHz so the screen's bus gets its top
   speed, 62.5 MHz (MicroPython's default leaves it at 24 MHz: 46 ms a frame). 150 MHz is *slower*
   for the screen (its divider lands at 37.5 MHz).
10. **Pace it.** A fixed frame time, sleeping the rest (the template). No tearing signal is wired to
    the Pico, so steady pacing is what keeps motion smooth. Move things by whole pixels per frame.
11. **RAM is ~130-150 KB on an RP2040** after the 29 KB screen buffer (0.3.24+; it was 60-70 KB). Don't
    allocate a second full-screen buffer. Split big data into files and load what the current level needs.
12. **Measure on the real one.** `wedgie.py run` a file that times a frame with `time.ticks_us()`, or
    `print()` the frame time now and then.

## Look and feel: use the built-in kit

Every wedgie has `ui` (firmware 0.3.5+): the palette and the few screens that aren't your game. Use
them, don't redraw them, so every app looks like a wedgie and nobody rebuilds a progress bar. Your
game's own art (sprites, levels, backgrounds) can use any colors you like.

```python
import lcd, ui
d = lcd.LCD()
ui.page(d, "Game over", [("score 120", ui.INK), ("best 340", ui.MUTED)], "{g} play again")
if ui.ask(d, "Delete your save?", ["It can't come back."]):   # green yes, red no; only real presses count
    save.delete("best")
bar = ui.progress("Loading level 3", "tiles")                  # the boot logo and the boot bar
if bar:
    bar.to(0.5)                                                # 0..1, forward only
import loader; loader.what("enemies")                          # the line under the bar
```

| `ui.page` | `ui.ask` | `ui.progress` |
|---|---|---|
| ![page](https://wedgie.dev/img/look/page.png) | ![ask](https://wedgie.dev/img/look/ask.png) | ![progress](https://wedgie.dev/img/look/progress.png) |

- **Few words, big.** Every screen: as few words as fit the job, drawn as big as they fit. Space left
  over means something can be bigger: center it and scale it up (scale 2 or 3, a bigger picture).
  A question is the action and the one fact that matters ("Send", "0.5 ETH"), never sentences
  explaining the buttons.
- **No button letters on screen.** The case has none: a screen never says "A" or "press Y". In
  `ui.page` lines and hints, `ui.ask` lines and `ui.say(d, text, y)`, `{g}` `{r}` `{k}` draw a green,
  red, grey square: `"{g} play again"`, `"Press {r} to quit"`.
- **Names are Title Case:** your app's name in `wedgie.json` and its title on screen ("Safe Signer").
- **Palette:** `ui.WHITE` (screen), `ui.INK` (text), `ui.MUTED` (second lines, hints), `ui.GREEN`
  (yes, the green button), `ui.GREEN_D` (green text on white), `ui.GREY`, `ui.RED` (no, errors, the red
  button). The waistband is `ui.band(d, y)`.
- **Text:** 8 px font. Scale 1 fits 28 characters across, scale 2 fits 15 (`ui.COLS_SMALL`,
  `ui.COLS_BIG`). `ui.wrap(text, n)` breaks words into lines; `ui.title(d, text, y)` draws a big one.
- **Buttons mean the same everywhere:** A (green) is yes / go / again, Y (red) is no / back. Put the
  hint at the bottom in `ui.MUTED` ("{g} play again"), as `ui.page` does.
- **Slow things show `ui.progress`**, never a bar of your own and never "loading..." or "please wait".
  Its title says what you're doing ("Loading level 3"), the line under the bar the step ("tiles"). It
  draws straight to the screen (not your framebuffer) and costs about 9 KB of RAM while it's up; your
  next `d.show()` covers it.
- **The top-right corner is the battery's** on a wedgie running on one (0.3.28+): the firmware draws the
  charge there over your frame and sleeps the wedgie after 20 s with no press (the waking press never
  reaches your app). Right-align your own top-right text to `ui.right()` (236 normally, further left
  while the battery shows; call it at each draw: it changes when USB comes and goes). For older firmware:
  `ui.right() if hasattr(ui, "right") else 236`.
- An app that uses `ui` needs `"fw": "0.3.5"` in its wedgie.json entry.

## Saves (and starting at level 8)

```python
import save
save.store("best", 120)                   # anything json can write; bytes are kept as they are
best = save.load("best", 0)               # the default when there's none yet
save.delete("best"); save.names()
```

Each app has its own folder (`/saves/<mod>/`); installs, switching apps and firmware updates never
touch it. Save at checkpoints, never every frame (flash wears).

**Any plugged-in computer can read saves** with no press (and, before 0.3.54, see the screen). Never
keep a secret in a save. Deleting one asks on the wedgie (0.3.54+). Anything that decides for the person
(sign, reveal, give away) reads real buttons only: `Keys(physical=True)` or `ui.ask`. Plain `Keys()`
also takes presses a computer sends over USB.

**Keep progress in a save, and read it at start**, e.g. `save.store("level", {"level": 8, "lives": 3})`.
In the emulator every save shows up under **Saves**; the person can edit one (`"level": 8`) and it runs
again from there, so nobody plays through levels 1-7 to test level 8. Tell them which save does what.

## Randomness from the secure chip

Every wedgie has a secure chip (ATECC608 or OPTIGA Trust M) with a true hardware random generator.
Use it for anything where fair or unguessable matters: shuffling a deck, dice, loot, a crypto game.
Firmware 0.2.4+ (`"fw": "0.2.4"`):

```python
from wedgie import rand, rand_below, rand_source
rand(32)            # 32 random bytes from the chip
rand_below(52)      # a fair whole number 0..51 (no modulo bias), 32 bytes fetched per 10 draws
rand_source()       # "OPTIGA Trust M", "ATECC608", or "os.urandom (why)"
for i in range(51, 0, -1):          # a fair shuffle: Fisher-Yates, every swap from the chip
    j = rand_below(i + 1); deck[i], deck[j] = deck[j], deck[i]
```

- Measured on a Trust M: the first call takes ~0.5 s (it finds the chip), then 12 ms per 32 bytes.
  Draw what a round needs at its start (shuffle once), not one byte per frame.
- **Show `rand_source()` on screen** where fairness matters ("shuffled by OPTIGA Trust M"). An
  ATECC608 as shipped (config not locked) answers a fixed pattern instead of randomness; `rand`
  detects that and uses the Pico's own generator, and `rand_source()` says so. So does the emulator,
  which has no chip.
- For looks (star fields, particles) plain `random` is fine and faster.
- Example: Hi-Lo, https://github.com/clawdbotatg/wedgie-starter/blob/main/hilo/hilo.py

**More from the chip** (Trust M: keys that never leave it, signatures, ECDH, RSA, counters, storage):
`import optiga`, firmware 0.3.17+. Every call, with examples and timings: https://wedgie.dev/trustm.md

## The rest of the hardware

- Screen: `lcd.LCD()` is a `framebuf.FrameBuffer` (240x240, 16 colors: GS4_HMSB) plus `show`, `show_start`,
  `show_wait`, `show(y0, y1)`, `show_rect`, `center_text(s, y, c, scale)`, `big_text`,
  `backlight(pct)`. Ready colors: `BLACK WHITE RED GREEN BLUE YELLOW GREY DARK`.
- Keys: `keys.pressed()` (went down since the last call) and `keys.held(k)`. Names: `A B X Y up down
  left right press`. Read `pressed()` every frame, even when you don't need it, or presses pile up.
- MicroPython, not CPython: `math random struct json time array framebuf micropython gc`,
  `time.ticks_ms()`, `ticks_diff()`, `sleep_ms()`. No real clock, no files outside the flash, no pip.
- Sound: none built in. Free pins for extras: GP0 GP1 GP6 GP7 GP14 GP22 GP26 GP27 GP28.
- The secure chip (ATECC608 or Trust M): random numbers above. Keys and signing: a Trust M through
  `import optiga` (trustm.md); an ATECC608 through `atecc.ATECC608` (skill.md, "From Python"). Never lock
  a chip or make keys on it unless the person asks; locking is permanent.

## Before you say it's done

- It runs in the emulator from a fresh start (delete its saves) and from each save you tell them about.
- No traceback in Output after a few minutes of play, and a game over / win screen that A gets past.
- On a real wedgie if one is plugged in: `wedgie.py install .`, a `shot`, and a frame time you printed.
- `wedgie.json` matches the files, every file name starts with the mod.
- The README says what it is, the controls, and the saves.


# The Trust M on a wedgie

Some wedgies have an **Infineon OPTIGA Trust M** (Adafruit 4351) wedged between the boards on I2C
(SDA GP4, SCL GP5, address 0x30). It's a small secure computer of its own: keys made inside it never
leave it, it signs and checks signatures, and it holds data and counters a program can't fake. Your app
talks to it with `optiga`, part of the wedgie firmware (0.3.17+):

```python
import optiga
c = optiga.Chip()                    # 46 ms: resets the chip's link and opens a session
c.random(32)                         # 32 true random bytes
pub = c.genkey(optiga.KEY2)          # a P-256 key pair inside the chip; you get the public key
r, s = c.sign(optiga.KEY2, digest)   # ECDSA over a 32-byte digest, 140 ms
```

Which chip does this wedgie have? `wedgie.chip()` says (or hello's `"chip"`): `"OPTIGA Trust M"` or
`"ATECC608"`. `optiga` is for the Trust M only. The emulator at wedgie.dev/code has no secure chip:
`optiga.Chip()` fails there, so test chip code on a real wedgie (`python3 wedgie.py run app.py`).

Other wedgie docs: making apps https://wedgie.dev/code.md, the hardware and USB https://wedgie.dev/skill.md

## What you should know first

- **Memory.** `import optiga` takes about 10 KB of RAM (measured, with its I2C layer). Import it when you
  need it, not at the top of a game that's already tight on memory; `del sys.modules["optiga"]` and
  `del sys.modules["trustm"]` give it back. Don't paste big data into code you send to a wedgie: build it
  there, or the wedgie runs out of memory compiling it.
- **One `Chip()` at a time**, and reuse it. Making a new one resets the chip's link (~45 ms) and
  forgets session secrets (`SESSION`).
- **Speed.** Every call waits for the chip. Measured on a real Trust M V1 on a wedgie (RP2040, 400 kHz I2C):

  | Call | Time |
  |---|---|
  | `Chip()` | 46 ms |
  | `random(32)` | 11 ms |
  | `sign` (P-256) | 140 ms |
  | `genkey` P-256 | 157 ms |
  | `verify` P-256 | 190 ms |
  | `ecdh` P-256 | 132 ms |
  | `sha256` of 1 KB | 221 ms |
  | `genkey` RSA-1024 | 3 s |
  | `genkey` RSA-2048 | 25 s (show `ui.progress`) |
  | `read` of the 485-byte certificate | 148 ms |

  Do chip work between frames or behind `ui.progress`, never once a frame.
- **Errors** raise `optiga.Error` with `.code` (the table at the end). `except optiga.Error as e:`.
- **Two chip versions.** V1 does everything here except AES, HMAC, HKDF, Brainpool and P-521 curves,
  and `aes_*`/`hmac`/`mac`; those are V3. A V1 answers them with error `0x0A` (AES, HMAC) or `0x03`
  (HKDF, the other curves). The Trust M tested so far (an Adafruit 4351, chip firmware build 0809) is a
  V1: plan for V1.
- **The security event counter.** Using a stored private key, or deriving from a stored secret, counts
  as a "security event". More than about one every 5 seconds for a while and the chip slows itself down
  (up to seconds a call). Normal use never gets there; a loop that signs as fast as it can does. While
  the count isn't 0, `hibernate()` refuses (error `0x0B`); it was back to 0 about 6 s after a few signatures.

## The chip's slots

Everything on the chip lives in an object with a 2-byte ID (OID). `optiga` names them:

| Name | OID | What | You can |
|---|---|---|---|
| `FACTORY_KEY` | E0F0 | P-256 key made at Infineon, usage Auth | sign with it, never change it |
| `CERT` | E0E0 | its certificate, signed by Infineon (~485 bytes) | read it |
| `KEY2` `KEY3` `KEY4` | E0F1-E0F3 | ECC key slots, empty from the factory | `genkey` into them, sign, ECDH |
| `RSA1` `RSA2` | E0FC-E0FD | RSA key slots | `genkey` RSA, sign, decrypt |
| `SESSION[0..3]` | E100-E103 | session keys/secrets, in RAM | `genkey`/`ecdh`/`derive` into them; gone at reset |
| `DATA[0..11]` | F1D0-F1DB | 140-byte data objects | `read`, `write` |
| `BIG_DATA[0..1]` | F1E0-F1E1 | 1500-byte data objects | `read`, `write` |
| `COUNTERS[0..3]` | E120-E123 | monotonic counters | `count`, `counter`, `set_counter` |
| `CERT2-4` | E0E1-E0E3 | your own certificates | `read`, `write` |
| `TRUST1` `TRUST2` `TRUST8` | E0E8 E0E9 E0EF | trust anchors (CA certs) for `verify(cert=)` | `read`, `write` |
| `BINDING` | E140 | 64-byte platform binding secret | (shielded connection; not used by wedgies) |
| `AES_KEY` | E200 | AES key (V3) | `aes_genkey`, `aes`, `mac` |
| `UID` `LCSG` `SEC` ... | E0C0-E0C6, F1C0-F1C2 | chip info and state | `read`, `info()` |

**Who uses which slot.** `KEY2` and `DATA[11]` are **Safe Signer's**: the person's key and its public key,
locked for good once made (below). Never write, re-key or lock them. Your app: `KEY3` or `KEY4`, and any
other `DATA`. Two slots for every other app: check `c.metadata(KEY3)` isn't locked before you use one, and
say in your README which you take.

Who can do what to each slot is in its **metadata** (`c.metadata(oid)`). As shipped, the key slots,
data, counters and certificates are open to everyone (rule: "while its lifecycle is below
operational"). That means **any program on the wedgie can use or replace a key in KEY2-4**: the
wedgie's lock (nothing gets the REPL without an A press) is what keeps a computer from doing it.

## Every call

### Random

```python
c.random(32)              # 8-256 bytes from the true random generator (TRNG)
c.random(32, drng=True)   # from its deterministic generator (seeded from the TRNG)
```
For fair shuffles and dice, `wedgie.rand` / `rand_below` (code.md) already use this and work on both
chips.

### Keys and signatures (ECC)

```python
pub = c.genkey(optiga.KEY2)                                  # P-256, usage SIGN, kept in KEY2
pub = c.genkey(optiga.KEY3, optiga.P384, optiga.SIGN | optiga.KEY_AGREE)
pub, priv = c.genkey(None, optiga.P256)                      # exported: the chip keeps nothing
```
- `pub` is the uncompressed point: `04 || X || Y` (65 bytes for P-256, 97 for P-384).
- **Save `pub` yourself** (a save file, a `DATA` object). The chip never hands a stored key's public key
  out again. The factory key's public key is inside `CERT`.
- `genkey` into a slot **replaces** what was there. There's no undo.
- Curves: `P256`, `P384` (V1 and V3); `P521`, `BP256`, `BP384`, `BP512` (V3).
- Usage bits, OR them: `SIGN`, `AUTH`, `KEY_AGREE` (ECDH), `ENC` (RSA). A key only does what its usage says.

```python
import hashlib
d = hashlib.sha256(b"message").digest()
r, s = c.sign(optiga.KEY2, d)              # ints; the digest goes in, never the message
c.verify(d, r, s, pub)                     # True / False, on the chip
c.verify(d, r, s, pub, optiga.P384)        # other curves: say which
c.verify(d, r, s, cert=optiga.CERT2)       # check against the key in a stored certificate
```
- ECDSA over the digest as given. For P-256 hash with SHA-256 (`hashlib.sha256` or `c.sha256`).
- On a computer, `(r, s)` with `pub` verifies with any ECDSA library (Python `cryptography`:
  `encode_dss_signature(r, s)` + `ec.ECDSA(hashes.SHA256())`).
- **Ethereum needs secp256k1, which the Trust M doesn't have.** P-256 works with passkey-style smart
  accounts (RIP-7212 / P-256 verification on chain), not plain Ethereum keys.

### Shared secrets (ECDH) and key derivation

```python
mine = c.genkey(optiga.KEY3, optiga.P256, optiga.KEY_AGREE)
secret = c.ecdh(optiga.KEY3, their_pub)          # 32 bytes: the shared X coordinate
c.ecdh(optiga.KEY3, their_pub, store=optiga.SESSION[0])   # kept inside the chip instead
key = c.derive(optiga.SESSION[0], 32, b"label" + seed, method="prf256")   # TLS 1.2 PRF (V1 + V3)
key = c.derive(optiga.SESSION[0], 32, salt, info=b"app v1", method="hkdf256")  # HKDF (V3)
```
- Both sides get the same `secret` (the other side computes it with its private key and your `mine`).
- With `store=`, the secret never leaves the chip; `derive` turns it into key material (16+ bytes).
- `derive(..., store=optiga.SESSION[1])` keeps the result inside too.
- A `DATA` object can be a derive secret only if its type is "pre-shared secret" (metadata `E8 = 21`),
  which takes a metadata write: see "Calls that can lock the chip".

### Hashing

```python
c.sha256(data)                       # any length; long data goes in 264-byte parts
c.sha256_object(optiga.CERT)         # hash an object without it leaving the chip
```
`hashlib.sha256` on the RP2040 is faster for your own data; the chip's is for what's inside it.

### RSA

```python
pub = c.genkey(optiga.RSA1, optiga.RSA2048, optiga.ENC | optiga.SIGN)   # 25 s on a V1
ct = c.rsa_encrypt(b"hi", pub)                    # PKCS#1 v1.5, up to key size - 11 bytes
c.rsa_decrypt(optiga.RSA1, ct)                    # b"hi"
sig = c.sign_rsa(optiga.RSA1, sha256_digest)      # PKCS#1 v1.5, raw bytes (256 for RSA-2048)
c.verify_rsa(sha256_digest, sig, pub)             # True / False
```
- `pub` for RSA is the DER `SEQUENCE { n, e }`. A computer loads it as a SubjectPublicKeyInfo once you
  put `30 82 01 22 30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00 03 82 01 0f 00` (RSA-2048) or
  `30 81 9f 30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00 03 81 8d 00` (RSA-1024) in front.
- `RSA1024` and `RSA2048`. `sign_rsa(..., sha=384)` / `512` for those digests.

### Storage

```python
c.write(optiga.DATA[0], b"hello", erase=True)   # erase=True: empty it first
c.write(optiga.DATA[0], b"!", offset=5)         # change bytes in place
c.read(optiga.DATA[0])                          # b"hello!"
c.read(optiga.CERT, 0, 64)                      # a slice: offset, length
```
- `DATA` objects hold 140 bytes, `BIG_DATA` 1500. Writing past the end raises error `0x08`.
- What's in the chip survives a reflash of the wedgie (a wipe at /test erases the Pico's flash, not
  the chip). It's a good place for something an app must find again after a reinstall.
- Anyone who can run code on the wedgie can read and write these as shipped. For secrets that must
  stay inside, use a key slot (nothing reads a private key) or change the object's read rule (metadata).
- Flash on the chip wears out too: ~2 million writes across the whole chip. Don't write every frame.

### Counters that only go up

```python
o = optiga.COUNTERS[0]
c.set_counter(o, 0, 1000)    # value 0, threshold 1000 (while its rules allow changing it)
c.count(o)                   # (1, 1000)
c.count(o, 5)                # (6, 1000)
c.counter(o)                 # (6, 1000)
```
At the threshold, `count` raises error `0x0E`. Each counter takes ~600,000 counts.
To make one nobody can reset, lock its change rule (metadata) after `set_counter`; that's permanent.

### Sessions and power

```python
ctx = c.hibernate()    # 8 bytes: the session saved inside the chip (security event count must be 0)
c = optiga.Chip()      # ... later, even after a power cycle
c.open(ctx)            # back where it was (SESSION keys included)
c.close()              # forget the session
```

### AES and HMAC (V3 chips)

Written from Infineon's manual; **not yet run on a real V3** (the tested chip is a V1). Same for HKDF,
Brainpool and P-521, and for `verify(cert=)` / `rsa_encrypt(cert=)`.

```python
c.aes_genkey(128)                              # an AES-128 key in AES_KEY (or 192, 256)
ct = c.aes(data16, iv=iv16)                    # AES-CBC, data a multiple of 16 bytes (no padding)
c.aes(ct, decrypt=True, iv=iv16)
c.aes(data16, mode="ecb")
c.mac(data)                                    # AES-CMAC
c.hmac(optiga.SESSION[0], data)                # HMAC-SHA256 keyed by a session secret (or sha=384/512)
key = c.aes_genkey(256, export=True)           # just random key bytes, kept nowhere
```

### Chip info and anything else

```python
c.info()     # {'uid': ..., 'lifecycle': 7, 'security_events': 0, 'sleep_ms': 20, 'current_ma': 6, 'buffer': 1557}
c.metadata(optiga.KEY2)     # {0xC0: b'\x01', 0xD0: b'\xe1\xfc\x07', 0xD3: b'\x00', 0xE0: b'\x03', 0xE1: b'\x10'}
c.command(cmd, param, data) # any raw command (Infineon's Solution Reference Manual), returns its data
c.last_error()              # the chip's last error code (reading it clears it)
```

Metadata tags: `C0` lifecycle (01 creation, 03 initialization, 07 operational, 0F terminated), `C4` max
size, `C5` used size, `D0` change rule, `D1` read rule, `D3` use rule, `E0` key algorithm, `E1` key
usage, `E8` object type. Rules: `00` always, `FF` never, `E1 FC 07` "while the object's lifecycle is
below operational", `40 <counter OID>` "each use counts that counter".

## Calls that can lock the chip forever

`set_metadata` is the only call in `optiga` that can do it, and only on purpose. **Never call it to
"try it out".** What's permanent:
- **A lifecycle (`C0`) only goes up.** Setting a slot's lifecycle to `07` (operational) closes every
  "below operational" rule on it for good: on a key slot, no more `genkey` into it, ever; on a data
  object or counter, no more changes. That's how you *make* something tamper-proof, and it can't be undone.
- A rule set to `FF` (never) on an operational object is gone for good.
- The global lifecycle (`LCSG`, E0C0) and the application's (`LCSA`, F1C0) only go up too; `0F` there
  ends the chip's application. Don't write them.
- `genkey` into a slot destroys the key that was there (not a lock, but no undo either).
- `c.command(...)` can send anything, including Infineon's protected-update and lifecycle commands.

Everything else in `optiga` (keys, signing, storage, counters below their threshold, sessions) can be
done again or undone.

## Errors

`optiga.Error.code`:

| Code | Meaning |
|---|---|
| 0x01 | no such object |
| 0x03 / 0x05 | bad parameter |
| 0x04 | bad length |
| 0x07 | access rules say no (a locked slot, a key without that usage) |
| 0x08 | past the end of the object |
| 0x0A | command not on this chip (a V3 command on a V1) |
| 0x0B | out of sequence |
| 0x0E | counter reached its threshold |
| 0x24 / 0x25 | unsupported algorithm or parameters |
| 0x2C | signature doesn't verify (`verify` returns False instead) |
| 0x2E | decryption failed |

## How it's tested

`tools/optigaprobe.py` in github.com/clawdbotatg/wedgie-dev runs every call above on a real Trust M and
checks the results on the computer (signatures, ECDH, hashes and RSA against Python's `cryptography`).
It touches only things that can be redone: KEY3, RSA1, one data object and one counter (both put back),
and sessions. It talks over one raw-REPL session (never restarts the wedgie). Last run, 2026-10-03, on a
Trust M V1: 21 of 21 checks pass. Not covered by it: the V3-only calls (above), `verify`/`rsa_encrypt` with a
stored certificate, `set_metadata` (on purpose: it can lock the chip).
