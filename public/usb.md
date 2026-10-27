---
name: wedgie-usb
description: Talk to a plugged-in wedgie over USB - find its port, hello, wedgie.py (install, update, unlock, shot, press, saves, debug), the lock and the green-button press, resets and re-plugs, every USB request with its answer, and requests as files on the WEDGIE drive (iPhone, locked-down computers). Use for "my wedgie is plugged in", "what's on my wedgie's screen", "update my wedgie", "install X on my wedgie", "script my wedgie", "talk to the wedgie from my phone".
---

# Talk to a wedgie over USB

Part of the wedgie skills. Index: https://wedgie.dev/skill.md. **The current firmware is 0.3.72**; if `hello`
says older, run `wedgie.py update` first.

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

**What needs nobody:** `hello`, `ping`, `chip` (prove the secure chip works), `ls`, `get` inside `/saves/`,
and `get` of its log (`/log.txt`, older half `/log1.txt`, 0.3.52+: power-ons, app starts, crashes with
tracebacks, installs). **Everything else needs your person to press the green button on the wedgie's own
screen**: installs, updates, other files, the REPL, the chip's keys, deleting saves (0.3.54+), and on 0.3.54+
also `shot` (its screen) and `press` (a button) — run `wedgie.py unlock` once, then they work until it
restarts. A `press` drives an app but can never answer a question on the wedgie. Tell your person what will
appear and that they should press the green button, before you ask.
**The case's buttons have no letters on them:** to your person, A is "the green button", Y "the red
button", B and X "the grey buttons". The letters are only names in `press` and `lcd.Keys()`.

## Your tools: wedgie.py

One file: `curl -O https://wedgie.dev/wedgie.py`, then `python3 wedgie.py <command>` (or
`uv run --with pyserial python3 wedgie.py <command>`). "A" = your person presses the green button on the wedgie.

    python3 wedgie.py list                 every wedgie on USB: port, ID, firmware
    python3 wedgie.py hello                what it is and runs (JSON)
    python3 wedgie.py shot out.png         the real screen as a 240x240 PNG. READ IT. (0.3.54+: unlock first)
    python3 wedgie.py press A [ms]         press a button: A B X Y up down left right press (0.3.54+: unlock first)
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
    python3 wedgie.py net [folder]         stay plugged in and be its app's internet (below; sites straight from here); Ctrl-C stops

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
  0.3.66+: the apps are in their own list (`/fw/apps.txt`); the signed list names it by its hash (`@apps`).
  Older firmware sees no apps in a 0.3.66+ list: update its firmware first, then install apps.
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

Hold **both grey buttons (B and X)** while plugging in (0.3.51+; X alone before): it starts without its app
(its home screen: wedgie.dev over the underwear), a way back in when an app crashes at start or keeps USB
from answering. Hold **Y**: no WEDGIE drive this time (debugging only).

## The USB requests

    {"id":1,"type":"hello"}              -> {"type":"hello","version":"0.3.72","fw":"wedgie-0.3.72","uid":...,"short":"023277",
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

**From the wedgie: its app's internet** (0.3.61+, the app's `import net`; wedgie.dev/code.md). The host holding
its port (its page on wedgie.dev, or `wedgie.py net`) carries it, only for what the running app's wedgie.json
lists in `"net"` (its sites, `"chain"` for chain reads: wedgie.dev's, plus a site, `mainnet.rpc.buidlguidl.com`,
0.3.70+, where the wedgie makes its own Ethereum reads).

A site (0.3.67+): the wedgie runs TLS 1.3 with the site itself, the host only carries the encrypted bytes:

    {"type":"tcp","rid":1,"host":"api.coinbase.com"}            open the site's port 443
    {"type":"tcp","rid":1,"d":"<base64>"}                       bytes, both ways (to the wedgie: 1000 a line at most)
    {"type":"tcp","rid":1,"end":true}                           closed (either way)
    {"type":"tcp","rid":1,"error":"api.x.com isn't in the app's \"net\""}   to the wedgie: won't, or can't

Once a host is answering these, it sends `{"type":"net"}` (no rid, 0.3.69+). The wedgie sends again every
line nothing has answered yet: an app that asked while no host was there (right after a restart) gets its answer.

A browser can't open TCP, so the page uses wedgie.dev's relay: a WebSocket to
`wss://relay.wedgie.dev/?host=<site>` (binary frames; pages on wedgie.dev only, port 443 only).

A chain read (on 0.3.70+ not Ethereum's), and a site on 0.3.61-0.3.66 (plain answers from wedgie.dev, which the host could change):

    {"type":"net","rid":2,"chain":8453,"method":"eth_blockNumber","params":[]}
    {"type":"net","rid":3,"url":"https://api.coinbase.com/v2/prices/ETH-USD/spot","pick":"data.amount"}
    -> {"type":"net","rid":2,"data":"0x1a2b3c"}   or   {"type":"net","rid":2,"error":"..."}

The host asks wedgie.dev: `POST https://wedgie.dev/api/rpc?chain=<id>` (JSON-RPC, read methods only,
`wedgie_prices` for the ETH price, `wedgie_symbols` for any coins by symbol), `POST https://wedgie.dev/api/net
{"url","pick","max"}` -> `{data}` for an old wedgie's site. Answers are plain ASCII JSON, under 5 KB.

hello's fields: `version` the firmware, `running` the app on screen (null: none), `chip` the secure
chip found, `sealed` locked, `open` let in right now, `ram` bytes of free RAM, `free` bytes of free
flash, `uid` / `short` its board ID (the short one is shown on its page), `slot: 1` it runs one app
(firmware 0.2+), `jobs: 3` it takes signed installs (3: it checks the signature while it asks), `bin: 4096` it takes raw file bytes (fast
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
