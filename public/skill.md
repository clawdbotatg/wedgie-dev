---
name: wedgie
description: Write, install and debug apps on a wedgie (Raspberry Pi Pico + Waveshare Pico-LCD-1.3 240x240 screen, joystick, A/B/X/Y, secure chip on I2C, running MicroPython + wedgie firmware) over USB. Use for "make an app/game for my wedgie", "put this on my wedgie", "what's on my wedgie's screen", "update my wedgie", "why won't my wedgie ...".
---

# Wedgie

A wedgie is a pocket computer made from three off-the-shelf parts: a Raspberry Pi Pico (RP2040 or
RP2350), a Waveshare Pico-LCD-1.3 hat (240x240 screen, 5-way joystick, A/B/X/Y), and a secure chip
(ATECC608 or Infineon Trust M) wedged between the boards on I2C. It runs MicroPython plus wedgie
firmware: a boot logo, one app it boots straight into, saves that outlast apps, and a USB protocol.
Everything is MIT: https://wedgie.dev

## Why "wedgie" (read this, it explains the build)

A Pico with a screen hat plugged on top, and a secure chip on the I²C bus **wedged** in: its four
cable wires are wedged into the hat's header in the same holes as the Pico's pins, and the chip's
little board is wedged into the gap between the Pico and the hat. No solder anywhere. "Give yourself
a wedgie" = build one; "give someone a wedgie" = send one. The logo's waistband (green, grey, red) is
the button column (A green, B/X grey, Y red). Full lore: https://wedgie.dev/lore.md

## The hardware: parts, pinout, putting it together

You may be asked to help someone build a wedgie from loose parts, or put one back together. Be
exact; a wire in the wrong hole is the most common failure.

### Parts
- **A Pico**: Raspberry Pi Pico 2 W (RP2350, WiFi), Pico W (RP2040, WiFi), or a USB-C RP2040 Pico clone
  (often pink, no WiFi). Same 40-pin layout on all of them. It needs its two 20-pin male headers
  (buy "pre-soldered headers").
- **Waveshare Pico-LCD-1.3**: 1.3" 240x240 IPS (ST7789, SPI), a 5-way joystick, four buttons A B X Y,
  and a 2x20 female header the Pico plugs into.
- **Secure chip breakout**: Adafruit ATECC608 (product 4314) or Adafruit OPTIGA Trust M (4351). Both
  have two STEMMA QT ports (same bus, wired in parallel).
- **A 4-pin STEMMA QT / Qwiic cable with bare ends** (JST-SH plug on one end, loose wires on the other).
- A data USB cable (not charge-only), and optionally the printed case (below).

### How the sandwich goes
The Pico plugs into the hat's female header: Pico components facing AWAY from the screen board (its RP2040 and BOOTSEL button stay visible from the back), the Pico's USB
at the same end as the joystick. Held as a wedgie (landscape, screen facing you): USB on the left,
joystick left of the screen, A B X Y in a column on the right, A at the top. Push straight, no force
at an angle; the pins must all go in, none outside the socket.

### The I²C plug (STEMMA QT / Qwiic)
Four contacts, from one end: **GND, V+ (3.3 V), SDA (data), SCL (clock)**. Adafruit cables color them
black, red, blue, yellow. Other bags use other colors (one common bag: white, yellow, black, red).
**Trust the order, never the colors**: find the GND end of the plug and count.

### Where the four wires go
Look at the Pico side of the sandwich, USB end at the top. Count holes down from the USB end in the
hat's header socket, beside the Pico's pins (the bare wire goes into the same hole as the Pico pin;
the spring contact holds both):

| Wire (plug order) | Signal | Side  | Hole from USB end | Pico pin |
|-------------------|--------|-------|-------------------|----------|
| 1st | GND        | right | 3rd | 38 (GND)   |
| 2nd | V+ 3.3 V   | right | 5th | 36 (3V3 OUT) |
| 3rd | SDA        | left  | 6th | 6 (GP4)    |
| 4th | SCL        | left  | 7th | 7 (GP5)    |

Right side top-down is VBUS, VSYS, GND, 3V3_EN, 3V3. **Never put anything in the 4th hole on the right
(3V3_EN): grounding it switches the 3.3 V supply off.** Never use VBUS/VSYS (5 V) for the chip.
Then tug each wire lightly, and wedge the chip board flat into the gap between the boards (~8.5 mm
tall), wires flat so nothing presses on the back of the screen.

### Full Pico pinout (board face up, USB at top)
Left, pins 1-20 top-down: GP0, GP1, GND, GP2, GP3, GP4, GP5, GND, GP6, GP7, GP8, GP9, GND, GP10, GP11,
GP12, GP13, GND, GP14, GP15.
Right, pins 40-21 top-down: VBUS, VSYS, GND, 3V3_EN, 3V3, ADC_VREF, GP28, AGND, GP27, GP26, RUN, GP22,
GND, GP21, GP20, GP19, GP18, GND, GP17, GP16.

Used by the hat: GP2 up, GP3 joystick press, GP8 DC, GP9 CS, GP10 SCK, GP11 MOSI, GP12 RST, GP13
backlight, GP15 A, GP16 left, GP17 B, GP18 down, GP19 X, GP20 right, GP21 Y. Used by the wedge:
GP4 SDA, GP5 SCL, pin 36 3V3, pin 38 GND. **Free: GP0, GP1, GP6, GP7, GP14, GP22, GP26, GP27, GP28**
(GP26-28 can read analog). More I²C boards (sensors, a haptic motor, a QR reader) plug into the chip
breakout's second STEMMA QT port and share the same bus; no new wires.

### The case
A snap-together printed shell, no screws: https://github.com/clawdbotatg/clawd-pico-case (STLs in
`stl/current/`: lid, base, joystick cap, 4 button caps). PETG, 0.16 mm layers, 4 walls, no supports;
lid face down, base floor down, caps flange down. It was fit-tested with the USB-C RP2040 board and
the hat; check the wedged chip lies flat before closing. To assemble: seat the Pico's USB connector
into the base's port first, then lower the joined boards in (don't force them straight down); put the
four button caps and the joystick cap on; press the lid on until the hidden catches click. To open:
the pry notch on one side. There's a hole in the base to reach the reset/BOOTSEL button.

### Taking it apart and putting it back
Open the case at the pry notch, lift the lid (caps may fall out), lift the board stack out. Slide the
chip out of the gap. Pull the four wires straight out of the header. Separate Pico and hat by pulling
straight apart, rocking gently end to end, never twisting. Reassemble in reverse: Pico into hat
(orientation above), wires by plug order (table above), chip wedged flat, into the case.
After reassembly: `wedgie.py list` (it shows up?), then open it at wedgie.dev/connect: Hardware says
whether the chip works; Test the screen, Test the buttons.

### Limits
- 3.3 V logic everywhere; GPIOs are **not 5 V tolerant**. Power comes from USB (5 V on VBUS); the
  Pico's 3V3 pin can supply a few hundred mA for add-ons.
- RP2040: 264 KB RAM, 2 MB flash, 125-133 MHz. RP2350 (Pico 2 W): 520 KB RAM, 4 MB flash, 150 MHz.
  The screen buffer takes 115 KB of RAM.
- The screen is 240x240, 16-bit color; full-frame refresh ~38 ms at default clocks.
- No battery built in (a Waveshare Pico-UPS-B hat works; its sensor is on I²C1, GP6/GP7).

### When something's wrong
- **No wedgie on USB**: charge-only cable, or the board is in BOOTSEL mode (it shows up as a drive
  instead; drag MicroPython on), or another program holds the port.
- **Screen black**: hat not fully seated, or no firmware (a bare MicroPython board shows nothing).
- **Chip not found**: wires by color instead of plug order; a data wire and the power wire swapped
  (the chip can power itself through a data pin's protection diode, the LED lights, and it looks like
  a short — it isn't; swap them); a wire in 3V3_EN; the chip board touching a Pico pin.
- **A button does nothing**: Test the buttons (its page on wedgie.dev/connect) lists which; a cap pressing the switch all the time
  shows as "held from the start"; a switch that never registers is a physical switch fault.

## Your tools

Get the host tool (one file; needs `pip install pyserial`):

    curl -O https://wedgie.dev/wedgie.py

    python3 wedgie.py list                 every wedgie on USB: port, ID, firmware
    python3 wedgie.py update               install/update wedgie firmware (only changed files; its app and saves stay)
    python3 wedgie.py hello                what it is and runs (JSON)
    python3 wedgie.py shot out.png         the real screen as a 240x240 PNG. READ IT to see what you drew.
    python3 wedgie.py press A              press a button (A B X Y up down left right press) [ms]
    python3 wedgie.py run app.py           run a file once (streams output; Ctrl-C stops), then back to its app
    python3 wedgie.py install .            make the app in this folder's wedgie.json the app it runs
    python3 wedgie.py install app.py --name "My app"    make one file the app it runs (it restarts into it)
    python3 wedgie.py apps                 the apps on wedgie.dev, and which one it runs
    python3 wedgie.py use usbwallet        make that the app it runs (the old one comes off; saves stay)
    python3 wedgie.py off                  take its app off
    python3 wedgie.py ls                   every file, saves included
    python3 wedgie.py saves [backup f.json | restore f.json]

`--port /dev/cu.usbmodemXXXX` or `--id A1B2C3` picks one when several are plugged in. Only one program
can hold the port: if wedgie.py says busy, the wedgie.dev tab (that wedgie's page) or mpremote has it.
`mpremote` works too (`mpremote cp app.py :app.py`, `mpremote repl`), once the wedgie has let this
computer in (below: a wedgie is locked). Then Ctrl-C stops its app.

## The loop

**Making a game or an app? Read https://wedgie.dev/code.md first**: the app format (a folder or repo
with wedgie.json), fast graphics with measured numbers, saves, and the emulator at wedgie.dev/code
where the person plays it while you write it. The short version for a one-file app:

1. Write `myapp.py` (template below).
2. `python3 wedgie.py install myapp.py --name "My app"`: it restarts into it.
3. `python3 wedgie.py shot s.png` and read the PNG. `python3 wedgie.py press A` (and others) to drive it,
   shot again. Text is the 8x8 font: check it is readable and inside the 240x240 edges.
4. If it crashed: `python3 wedgie.py run myapp.py` shows the traceback. The wedgie's own screen also
   shows the message (A tries again).
5. Iterate. The person can also see and click their wedgie at https://wedgie.dev (Chrome/Edge).

## An app

A wedgie runs one app. It boots straight into it and the app gets every button: there is no menu and
no button that leaves it (to run something else, pick it at wedgie.dev/connect or `wedgie.py use`).
An app is one module that starts itself when imported, draws with `lcd`, reads `Keys`, ticks on a
`Timer` (so USB stays responsive), and offers `stop()` (Ctrl-C and the site call it).

```python
from machine import Timer
from lcd import LCD, Keys, color, BLACK, WHITE

lcd = LCD()
keys = Keys()
GREEN, RED, INK = color(34, 196, 82), color(227, 49, 44), color(26, 27, 26)
x, dx = 20, 3
timer = None

def tick(_):
    global x, dx
    for k in keys.pressed():          # names that went down since the last call
        if k == "A":
            dx = -dx
    x += dx
    if not 0 < x < 200: dx = -dx
    lcd.fill(WHITE)
    lcd.center_text("my app", 10, INK, 2)
    lcd.fill_rect(x, 100, 40, 40, RED if keys.held("B") else GREEN)
    lcd.show()                         # nothing appears until show() (~38 ms for the full frame)

def start():
    global timer
    timer = Timer(period=33, mode=Timer.PERIODIC, callback=tick)

def stop():
    if timer:
        timer.deinit()

start()
```

A game can use a `while` loop with `time.sleep_ms()` instead: give it an entry the firmware calls, in
apps.json `{"mod": "game", "name": "Game", "entry": "run"}` (`wedgie.py install` writes timer-style
apps; add `entry` by hand for loop-style ones). The firmware still answers USB while it loops. If the
entry returns, the screen says it ended and A starts it again. An app that talks on USB itself (the
Wallet) says `"usb": true`, and the firmware leaves stdin to it.

### Saves

`import save` keeps what a game needs between plug-ins, in its own folder (`/saves/<app>/`, picked by
the firmware, so games never see each other's). Switching apps, updating the firmware and
wedgie.dev/format (which backs them up and puts them back) leave saves alone.

```python
import save
save.store("best", {"score": 120})      # anything json can write; bytes are kept as they are
best = save.load("best", {"score": 0})  # the default when there is none yet
save.delete("best");  save.names()
```

No size limit per game, but a write that would leave under 32 KB free raises OSError (so the firmware
can always boot and the site can always switch apps). Split a big save into several names: the
older Pico has ~100 KB of RAM for a game. A write goes to a temp file and is renamed into place, so a
pulled plug keeps the last good save. Save at checkpoints, not every frame (flash wears).

## The hardware, from Python

- `lcd.LCD()` is a `framebuf.FrameBuffer` (240x240 RGB565): `fill(c)`, `pixel(x,y,c)`, `hline/vline`,
  `line`, `rect(x,y,w,h,c[,fill])`, `fill_rect`, `ellipse(cx,cy,rx,ry,c[,fill])`, `poly`, `text(s,x,y,c)`
  (8x8 font), `blit(fb,x,y[,key])`, `scroll`; plus `big_text(s,x,y,c,scale)`, `center_text(s,y,c,scale)`,
  `backlight(pct)`, `show()`. Always make colors with `color(r, g, b)` (the panel wants byte-swapped
  RGB565); ready-made `BLACK WHITE RED GREEN BLUE YELLOW GREY DARK`.
- `lcd.Keys()`: `pressed()` -> list of key names since the last call; `held(k)`. Names:
  `A B X Y up down left right press`. Layout seen from the screen: joystick left, A B X Y down the right
  edge (A top, green cap; Y bottom, red cap). Convention: A = yes, Y = no/back. All nine are the app's.
  `wedgie.py press` reaches every Keys() the way a finger would (apps reading Pins directly won't see it).
- Pins, if you need them: screen SPI1 DC=8 CS=9 SCK=10 MOSI=11 RST=12 BL=13; buttons (active low,
  pull-up) A=15 B=17 X=19 Y=21 up=2 down=18 left=16 right=20 press=3. Free GPIOs: 0 1 6 7 14 22 26 27 28.
- Secure chip on I2C0 SDA=GP4 SCL=GP5: ATECC608 at 0x60 (`signer.py`/`atecc.py`), Trust M at 0x30
  (`trustm.py`). The chip's breakout has a spare STEMMA QT port: other I2C boards daisy-chain on the
  same bus with no new wires. NEVER lock an ATECC608 or generate a key on it unless the person asks
  explicitly; both are permanent and can brick the chip for its current use.
- `import wedgie`: `wedgie.uid()`, `wedgie.short()`, `wedgie.board()`, `wedgie.VERSION`;
  `wedgie.rand(n)` / `rand_below(n)` / `rand_source()` (0.2.4+): true random bytes from the secure chip
  (the Pico's own generator when there's none, or an ATECC608 isn't locked yet, and it says so).
- Speed and memory: ~300 KB RAM free with the 115 KB screen buffer (less on RP2040: import `lcd`
  before big modules). Drawing primitives run in C; per-pixel Python loops are slow (~300k simple
  iterations/s) — use `@micropython.viper` for pixel work, precompute, `gc.collect()` between scenes.
  Full-frame show 18 ms (firmware 0.2.3+ runs the chip at 125 MHz so the screen's SPI gets 62.5 MHz;
  don't change the clock, 150 MHz is slower for the screen). `lcd.show_start()`/`show_wait()` push by
  DMA while your code runs; `show(y0, y1)` and `show_rect` push part of it. Measured costs and the
  rest: https://wedgie.dev/code.md
- MicroPython, not CPython: small stdlib (`math random struct json time array binascii hashlib`),
  `time.ticks_ms()/ticks_diff()/sleep_ms()`, no real clock, no typing. WiFi only on W boards.

## Firmware and apps

The firmware is the core: boot logo, the WEDGIE USB drive, the slot that runs the app (`slot.py`),
saves (`save.py`), the screen/button drivers (`lcd.py`) and the chip drivers (`atecc.py`,
`trustm.py`). Apps come as **cartridges** from the catalog, https://wedgie.dev/fw/manifest.json:
`core` (the firmware's files), `carts` (each with `mod`, `name`, `files` it needs, `entry`?, `usb`?,
`chip`? (the secure chip it needs: `ATECC608` or `OPTIGA Trust M`), and `v`, a hash of those files).
The site fades an app whose `chip` isn't the wedgie's and warns before putting it on. A wedgie holds one: picking another takes the old one's files off
(a file both need, like p256.py, stays) and puts the new one's on. A fresh wedgie runs nothing and
says so ("no software") until one is picked.

The wedgie's `apps.json` names its app: `[{"mod", "name", "entry"?, "usb"?, "about"?, "v", "repo"?, "files"?}]`
(the `v` it went on at; a different `v` in the manifest = update ready), or your own app (`wedgie.py
install`). An app from a repo or folder lists its `files`, so whatever switches away takes them off.
Firmware 0.1.x had a menu and kept several; updating to 0.2 takes them off and it starts with no app.

Apps now: `hello` (bouncing box, the template), `keytest` (buttons), `demo` (balls/cube/plasma speed
test), `mock` (nine wallet screens), `wire_demo` (clear-signs a signed transaction request),
`battery` (Waveshare Pico-UPS-B hat), `speed` (Speed lab: times each graphics trick on that board),
`usbwallet` (the USB hardware wallet; needs an ATECC608). Source:
/fw/<file> or https://github.com/clawdbotatg/wedgie-dev/tree/main/firmware (`carts.json` is the
catalog). Read `hello.py` and `lcd.py` first. A new app = its files in firmware/ + an entry in
firmware/carts.json (name, files, label color, 12x12 pixel icon, `chip` if it needs one); push and
it's on the site. Anyone else's app lives in their own GitHub repo with a `wedgie.json`
(https://wedgie.dev/code.md); people add it on their wedgie's page, and `community.json` in this repo
lists the ones on everyone's shelf, each pinned to the commit that was read.

## The USB protocol (what wedgie.py speaks)

While its app runs, the firmware (`slot.py`) answers one JSON line per request on the USB serial port
(vendor 0x2e8a, 115200), without interrupting anything:

    {"id":1,"type":"hello"}              -> {"id":1,"type":"hello","fw":"wedgie-0.2.0","slot":1,"uid":...,"board":...,"carts":[{mod,v}],"running":...,"free":...}
    {"id":2,"type":"shot"}               -> {"id":2,"type":"shot","i":0,"n":38,"fmt":"rgb565be","data":"<base64>"} x n
    {"id":3,"type":"press","key":"A"}    -> {"id":3,"type":"ok"}
    {"id":4,"type":"chip"}               -> the chip proven working: ATECC608 hashes random bytes,
                                            Trust M signs them with its factory key; check it yourself
    {"id":5,"type":"ls","path":"/saves"} -> {"type":"ls","files":[[path, bytes], ...],"free":N}  (folders end in /)
    {"id":6,"type":"get","path":"/saves/hello/best.json"} -> {"type":"file","i":0,"n":N,"size":S,"data":"<base64>"} x n
    {"id":7,"type":"rm","path":"..."}    -> {"type":"ok","free":N}   (a folder goes with everything in it)
    {"id":8,"type":"stop"}  /  {"id":9,"type":"reboot"}
    {"id":10,"type":"open"}              -> {"type":"open"} or {"type":"refused"}  (asks the person; below)

`running` is the app on screen (null: none). Lines that don't start with `{` are logs (an app's
print()). Raw REPL (Ctrl-A) is how files get written. `exec(open("main.py").read())` starts the app
again. An app with `"usb": true` (the Wallet) has the port to itself and speaks its own protocol; it
answers `open` too.

**A wedgie is locked (0.2.5+; hello says `"sealed": true`).** Ctrl-C does nothing, so no computer
can reach its REPL (and through it, the secure chip) on its own. To get in, send `{"type":"open"}`:
the wedgie asks on its own screen, and only a real press answers (a `press` over USB can't). A lets
this computer in, Y or a minute with no answer says no. Allow 65 s for the reply. After a yes,
hello says `"open": true`, Ctrl-C (0x03) stops the app and drops to the REPL as usual, and nothing
asks again until the wedgie is unplugged. Tell your person to press A before you send it. wedgie.py
and wedgie.dev do all this for you. Older firmware has no lock: Ctrl-C works right away.

### Plugging in, and resets (read this before scripting a wedgie)

About a second after power-up the wedgie adds its WEDGIE USB drive (the underwear on the desktop),
which disconnects and reconnects USB. So a wedgie you just plugged in **shows up, vanishes and shows
up again** — as a new serial port, same board ID. Wait ~2 s after a plug-in before opening the port,
retry an open that fails, and find a wedgie by its ID (`--id`), never by remembering the port.

**Don't soft-reset a wedgie just to restart its app** (Ctrl-D, `machine.soft_reset()`,
`mpremote reset`): run main.py instead, as above. 0.1.3+ marks soft resets so boot.py doesn't add the
drive again, but the first soft reset after updating from older firmware does (the port drops), and a
tool that reconnects and resets again loops forever (it happened: the site did it). Soft-reset only to
boot new firmware or a newly picked app (a fresh heap for it), then expect the port to maybe drop. A hard reset (`machine.reset()`, the `reboot`
request, unplugging) always re-adds the drive. Holding Y while plugging in skips the drive for that
boot (for debugging; nobody needs it day to day). Holding X while plugging in starts it without its
app (its home screen), a way back in when an app keeps USB from answering.

## Blank board

No MicroPython yet: hold BOOTSEL while plugging in, drag the `.uf2` for that board from
https://micropython.org/download/ (RPI_PICO, RPI_PICO_W, RPI_PICO2_W) onto the drive that appears,
then `python3 wedgie.py update`.
