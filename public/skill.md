---
name: wedgie
description: Everything about a wedgie (Raspberry Pi Pico + Waveshare Pico-LCD-1.3 240x240 screen, joystick, A/B/X/Y, a secure chip on I2C, running MicroPython + wedgie firmware) - talking to it directly over USB (find its port, hello, its screen, buttons, files, the lock and the A press, full control), wedgie.py, building one from parts, first boot, finding what's wrong and fixing it, firmware and apps. Use for "my wedgie is plugged in", "what's on my wedgie's screen", "update my wedgie", "build a wedgie", "my wedgie is broken / won't ...", "make an app for my wedgie" (then code.md), "use the secure chip" (then trustm.md).
---

# Wedgie

A wedgie is a pocket computer made from three off-the-shelf parts: a Raspberry Pi Pico (RP2040 or
RP2350), a Waveshare Pico-LCD-1.3 hat (240x240 screen, 5-way joystick, A/B/X/Y), and a secure chip
(ATECC608 or Infineon OPTIGA Trust M) wedged between the boards on I2C. It runs MicroPython plus the
wedgie firmware: a boot logo, the one app it boots straight into, saves that outlast apps, and a USB
protocol. Everything is MIT: https://wedgie.dev

**The current firmware is 0.3.31.** If a wedgie's `hello` says older, update it first
(`wedgie.py update`, below): everything here assumes current firmware.

**Three guides cover everything** (this one first):
- **skill.md** (this): talking to a wedgie, wedgie.py, the lock, building, first boot, repair, firmware.
- **code.md**: making apps and games (the app format and template, fast graphics with measured numbers,
  the screen and button API, the `ui` kit, saves, the emulator). https://wedgie.dev/code.md
- **trustm.md**: the Trust M secure chip from an app (keys, signatures, ECDH, RSA, counters, storage).
  https://wedgie.dev/trustm.md

A plugged-in wedgie carries all three in one file, **SKILL.md**, on its WEDGIE drive.

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
   "wedgie broke" (read the screen to your person; A there asks for full control), its app reads USB
   itself (`"usb": true`, rare), it isn't running wedgie firmware (`wedgie.py update`), or it's stuck:
   unplug it and plug it back in.

**What needs nobody:** `hello`, `shot` (its screen), `press` (a button, as if pressed: it drives an
app but can never answer a question on the wedgie), `chip` (prove the secure chip works), `ls`, and
`get` / `rm` inside `/saves/`. **Everything else needs your person to press A on the wedgie's own
screen** (installs, updates, other files, the REPL, the chip's keys). Tell them what will appear and
that they should press A, before you ask.

## Your tools: wedgie.py

One file: `curl -O https://wedgie.dev/wedgie.py`, then `python3 wedgie.py <command>` (or
`uv run --with pyserial python3 wedgie.py <command>`). "A" = your person presses A on the wedgie.

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

## The lock and the A press

A wedgie is **locked** (hello says `"sealed": true`). Ctrl-C does nothing and no computer can reach its
REPL, its files outside `/saves/`, or its secure chip on its own. The only way in is a question on the
wedgie's own screen answered by a **real press** (a `press` request can't answer it):

- **One job** (`{"type":"open","for":"Update firmware"}`; wedgie.py and the site send it for you): the
  same red **FULL CONTROL?** question as below (0.3.27+: a computer's own title never goes on a calm
  screen that gives it the REPL); A says yes, Y or a minute with no answer says no. Allow 65 s for the reply.
  After a yes, hello says `"open": true` and Ctrl-C (0x03) works as usual until its app starts again.
- **Full control** (`{"type":"open","full":true}`, `wedgie.py unlock`, or just pressing Ctrl-C, e.g.
  mpremote's): a white-on-red **FULL CONTROL?** question. After A the app stops and the screen says
  **COMPUTER HAS FULL ACCESS / didn't want that? unplug it now**. It stays open until it restarts or is
  unplugged. mpremote gives up after ~10 s: if your person was slower, run it again (it's open by then).
  Ctrl-C in the first 3 s after it starts is ignored (a connecting tool's leftover bytes).
- **Signed installs** (an app from the wedgie.dev shelf, a firmware update) ask "Install Buttons?" /
  "Update firmware?" and then take only files signed by wedgie.dev; they never open the REPL.
- **A no restarts the wedgie.** The question is drawn straight over the app's screen without saving it
  (saving the screen ran wedgies out of memory), so after a no it starts again from the top.
  Expect a `refused` answer, then its `ready` line.
- The lock is in the firmware, not the app: it turns Ctrl-C off before any app runs, so no app can
  leave a computer a way in. An app is code on the wedgie, though, and can do anything once installed;
  installing one is what the A press guards.

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

    {"id":1,"type":"hello"}              -> {"type":"hello","version":"0.3.31","fw":"wedgie-0.3.31","uid":...,"short":"023277",
                                             "board":...,"chip":"OPTIGA Trust M","running":"buttons","sealed":true,"open":false,
                                             "ram":63000,"free":1118208,"slot":1,"jobs":2,"bin":4096,...}
    {"id":2,"type":"shot"}               -> {"type":"shot","i":0,"n":38,"w":240,"h":240,"fmt":"rgb565be","data":"<base64>"} x n
    {"id":3,"type":"press","key":"A","ms":80} -> {"type":"ok"}
    {"id":4,"type":"chip"}               -> proof the chip works: an ATECC608 hashes random bytes, a Trust M
                                            signs them with its factory key (check it yourself)
    {"id":5,"type":"ls","path":"/saves"} -> {"type":"ls","files":[[path, bytes], ...],"free":N}  (folders end in /)
    {"id":6,"type":"get","path":"/saves/x/best.json"} -> {"type":"file","i":0,"n":N,"size":S,"data":"<base64>"} x n
    {"id":7,"type":"rm","path":"/saves/x"} -> {"type":"ok","free":N}   (a folder goes with everything in it)
                                            get / rm outside /saves/: an error until the person lets you in
    {"id":12,"type":"ping"}              -> {"type":"pong"}     (is it there, nothing else)
    {"id":8,"type":"stop"}               -> {"type":"ok"}       (stops its app)
    {"id":9,"type":"reboot"}             -> {"type":"rebooting"} (a full restart: the port drops)
    {"id":10,"type":"open","for":"..."}  -> {"type":"open"} or {"type":"refused"}  (asks the person, in red)
    {"id":11,"type":"open","full":true}  -> the same, asked in red: full control

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

A host that can't open the serial port (an iPhone, a locked-down computer) can talk through the drive.
Write a new file `REQ-<n>.TXT` in its top folder: one JSON request per line, the same requests as above,
a new name every time. The wedgie reads it 0.7 s after the last write; anything that needs a yes still
asks on its screen. Once a request came in as a file, every answer is also written to `ANSWER.TXT`
(2048 bytes): the first line is `#<count>`, then the answers as JSON lines, padded with newlines. Read it
uncached until the count moves (a few seconds; up to a minute when it waits for an A press), and delete
old REQ files. Writes live in the wedgie's RAM (a few KB) and are gone at unplug; flash is never written.
The iPhone app (ios/WedgieDrive in the repo) works this way.

## The hardware: parts, pinout, putting it together

Be exact when someone builds or rebuilds one: **a wire in the wrong hole is the most common failure.**
A 3D step-by-step is on https://wedgie.dev ("Put it together"); parts and where to buy them on
https://wedgie.dev/build.

### Parts
- **A Pico**: Raspberry Pi Pico 2 W (RP2350, WiFi), Pico W (RP2040, WiFi), or a USB-C RP2040 Pico clone
  (often pink, no WiFi). Same 40-pin layout on all of them. It needs its two 20-pin male headers
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
lid face down, base floor down, caps flange down. **Fit-tested only with the USB-C RP2040 clone and the
hat**; an official Pico, Pico W or Pico 2 W (micro-USB) may not fit. Check the wedged chip lies flat
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
  29 KB (16 colors, 0.3.24+; it was 115 KB). Free RAM for an app on an RP2040: about 130-150 KB
  (`hello`'s `ram` says); an RP2350 has several times that.
- 240x240; the panel is 16-bit color, the firmware draws in 16 colors (the boot logo in full color); a full-screen push takes ~25 ms (code.md has the measured costs).
- No battery built in. A LiPo on VSYS (the atomic wedgie) works: off USB, the firmware (0.3.28+,
  `power.py`) shows the charge in the top-right corner over every app (read from VSYS on GP29) and puts
  the wedgie to sleep after 20 s with no press (0.3.29+: dormant, every clock stopped); any button or
  plugging in USB wakes it, and that press goes to nobody.

## First boot, in order

1. **MicroPython.** The easy way: https://wedgie.dev/format in Chrome does steps 1-4 itself. By hand:
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
   An app that crashes at start: hold X while plugging in, then pick another app.
3. **Is the chip OK?** `{"type":"chip"}` (or Hardware on its page). Not found, in order of likelihood:
   wires by color instead of plug order; SDA/SCL swapped; a data wire and the power wire swapped (the
   chip powers itself through a data pin, its LED lights, it looks like a short: it isn't, swap them);
   a wire in 3V3_EN; the chip board touching a Pico pin. With full control you can scan the bus:
   `from machine import I2C, Pin; print([hex(a) for a in I2C(0, sda=Pin(4), scl=Pin(5)).scan()])` should
   show `0x60` (ATECC608) or `0x30` (Trust M). With a meter: 3.3 V between pin 36 (3V3) and pin 38 (GND).
4. **The screen:** Test the screen on its page. Stripes or nothing with the backlight on: reseat the hat.
5. **The buttons:** Test the buttons on its page lists which work. "Held from the start": a cap presses
   the switch all the time. Never registers: the switch itself.
6. **Still broken: https://wedgie.dev/format.** It copies the saves into the browser, wipes the whole
   Pico (BOOTSEL), puts MicroPython on (the W build if it has WiFi), then the firmware, puts the saves
   back, and tests the board, the screen, every button and the chip. Nothing starts until its Format
   button is pressed. It never touches the secure chip.

**A dead or locked secure chip:** it's its own little board, so swap in a new breakout. Keys made inside
the old chip are gone with it: anything they guarded (a wallet whose key lived on that chip) can only
come back through that wallet's own recovery. A reflash or /format never erases the chip.

## Firmware and apps

The firmware is the core: the boot logo, the WEDGIE drive, the slot that runs the app, saves, the
screen and button drivers, the chip drivers, and `ui`. It's compiled (`.mpy`), signed by wedgie.dev,
and a wedgie checks the signature before it takes an update. Apps are separate, one at a time: picking
another takes the old one's files off and puts the new one's on; saves stay. A fresh wedgie runs
nothing and says "no software" until one is picked.

Apps live in their own GitHub repos, each with a `wedgie.json` (code.md). **The shelf** at
wedgie.dev/connect lists the ones wedgie.dev has read and signed (today: Buttons,
`clawdbotatg/wedgie-buttons`); they install with a signed install. **Any other repo** can be added on a
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
  `A B X Y up down left right press`. A = yes, Y = no/back.
- `ui`: the palette (`WHITE INK MUTED GREEN GREEN_D GREY RED`), `page`, `ask`, `progress`, `band`,
  `title`, `wrap`, `buttons` (code.md, "Look and feel").
- `save`: `store(name, value)`, `load(name, default)`, `delete(name)`, `names()`, in `/saves/<app>/`.
- `wedgie`: `uid()`, `short()`, `board()`, `VERSION`, `chip()` (proves the chip, as the USB `chip`
  request), `rand(n)`, `rand_below(n)`, `rand_source()` (true random numbers from the chip).
- The secure chip: a Trust M through `import optiga` (trustm.md: keys, signatures, ECDH, RSA, counters,
  storage). An ATECC608 through `atecc.ATECC608(sda=4, scl=5)`: `random()`, `serial()`, `pubkey(slot)`,
  `sign(digest, slot)` (P-256), but a key exists only after its config is written and locked
  (`write_config`, `lock_config`), which is **permanent**: never do it unless your person asks.
- **Neither chip does secp256k1** (Ethereum's curve). Both sign P-256, which smart-account wallets with
  passkey-style (P-256 / RIP-7212) verification accept; a plain Ethereum key would have to live in
  software on the Pico, without the chip's protection.
- MicroPython, not CPython: small stdlib (`math random struct json time array binascii hashlib
  framebuf gc`), `time.ticks_ms()`, `ticks_diff()`, `sleep_ms()`, no real clock, no pip. WiFi only on W
  boards.
