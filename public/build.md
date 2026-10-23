---
name: wedgie-build
description: Build, fix or rebuild a wedgie by hand - the parts and where to buy them, what's in a kit, all 21 assembly steps (no soldering), where the four chip wires go, the full Pico pinout, the printed case, putting firmware on (BOOTSEL, wedgie.dev/reset), first boot, and finding what's wrong in order. Use for "build a wedgie", "I got the kit", "which wire goes where", "print the case", "my wedgie won't turn on / no chip found / black screen", "take my wedgie apart".
---

# Build a wedgie

Part of the wedgie skills. Index: https://wedgie.dev/skill.md

Be exact when someone builds or rebuilds one: **a wire in the wrong hole is the most common failure.**

| Guide | URL |
|---|---|
| Step by step with photos | https://wedgie.dev/assemble |
| Every step animated in 3D | https://wedgie.dev/assemble/3d |
| Printable assembly manual (PDF) | https://wedgie.dev/assemble.pdf |
| Owner's manual, in every box (PDF) | https://wedgie.dev/manual.pdf |
| Pick your own parts and colors (a link per build) | https://wedgie.dev/build |
| Put firmware on (BOOTSEL, wipe, latest) | https://wedgie.dev/reset |
| Wipe, reinstall and test everything | https://wedgie.dev/test |
| Case source (STLs, every iteration) | https://github.com/clawdbotatg/clawd-pico-case |

## Parts

No soldering. Order them anywhere: to a store it's just a dev board, a screen and a chip.

| # | Part | What | Buy |
|---|---|---|---|
| 1 | A Pico | RP2040 Pico-shaped board **with headers soldered**. The case is made for the **pink USB-C NULLLAB Pico** (RP2040, 2 MB). Any Pico-shaped board runs the code but may not fit the case. A Pico 2 W (RP2350) works, but we don't recommend WiFi in a wallet | Amazon 2-pack https://www.amazon.com/dp/B0GL1D8RWX · single https://www.amazon.com/dp/B0GQRMVT4P · more: https://wedgie.dev/build |
| 2 | Screen hat | **Waveshare Pico-LCD-1.3**: 1.3" 240x240 IPS (ST7789, SPI), 5-way joystick, buttons A B X Y, a 2x20 female header the Pico plugs into | Amazon https://www.amazon.com/dp/B092VVCBQP · Waveshare https://www.waveshare.com/pico-lcd-1.3.htm · The Pi Hut, Welectron, RobotShop, Abra, Botland |
| 3 | Secure chip | **Adafruit Infineon OPTIGA Trust M breakout (4351)**, I2C address 0x30. Or an Adafruit ATECC608 (4314, 0x60). Both have two STEMMA QT ports on the same bus | Adafruit https://www.adafruit.com/product/4351 · Mouser · DigiKey · Jameco · The Pi Hut · Core Electronics · RS · eBay |
| 4 | Cable | A 4-pin **STEMMA QT / Qwiic** cable (JST-SH plug). You cut one plug off | comes with the kit; any STEMMA QT cable |
| 5 | Case | Printed: white lid, black base, joystick cap, 4 button caps (2 grey, 1 green, 1 red) | print it (below) or it comes with the kit |
| 6 | USB **data** cable | USB-C or micro USB, whichever your Pico has. Charge-only cables are common and won't work | your own |

Telling Picos apart: the chip on the board says RP2040 or RP2350; a W has a silver WiFi can; `hello`'s
`board` says which. The USB port is USB-C or micro USB depending on the model (official Picos are micro USB,
most clones USB-C). **USB-C and micro USB Picos both fit the same case.**

**Tools you need:** a wire stripper (cuts near the hinge, strips near the tip), electrical tape, a stiff wire
or pin, tweezers. A paperclip for BOOTSEL.

Adding more: any I2C board (sensors, a haptic motor, a QR reader, EEPROM) plugs into the chip breakout's second
STEMMA QT port and shares the bus. No new wires. /build lists dozens with their addresses.

## The 4 wires (the one thing to get right)

The STEMMA QT plug's four contacts, from one end: **GND, V+ (3.3 V), SDA (data), SCL (clock)**.

| Wire | Kit cable color | Signal | Socket row | Socket from the USB end | Pico pin |
|---|---|---|---|---|---|
| 1st | white | GND | right | 3rd | 38 (GND) |
| 2nd | yellow | V+ 3.3 V | right | 5th | 36 (3V3 OUT) |
| 3rd | black | SDA | left | 6th | 6 (GP4) |
| 4th | red | SCL | left | 7th | 7 (GP5) |

- "Right" and "left": the screen board **face down, sockets up, USB end at the top** (the same as looking at the
  Pico's back with its USB end up). Right is the row whose top socket is VBUS (pin 40); left starts at GP0 (pin 1).
- **The kit's cable is always white, yellow, black, red**, top to bottom, with the Trust M chip side up and the
  plug in its left socket. **Another cable can use other colors** (Adafruit's: black, red, blue, yellow): then
  go by plug order, never color. Find the GND end and count.
- **Never put anything in the 4th socket on the right (3V3_EN):** grounding it switches the 3.3 V supply off.
  Never use VBUS or VSYS (5 V) for the chip.
- The bare wire goes into the same socket as the Pico's pin; the socket's spring contact holds both.

## Assembly, step by step

Same steps and numbers as https://wedgie.dev/assemble. Take your time on the wires (steps 3-9); the rest clicks.

1. **Cable and tools.** The STEMMA QT cable, a wire stripper, electrical tape, a stiff wire or pin, tweezers.
2. **Cut and strip.** Keep one plug. Cut the wires about **2 in (5 cm)** from it. Strip about **5 mm** (as deep as
   a socket) so the bare wire goes all the way down.
3. **Lay out the screen board.** Face down, sockets up, USB mark at the top. Count sockets from the USB end.
   Never the 4th on the right.
4. **White and yellow in.** Twist each tip's strands tight. Right row: **white into the 3rd, yellow into the
   5th**. This is the hard part: every strand in, nothing sticking out.
5. **Tape over the wires.** A small piece of electrical tape over those sockets holds the wires in.
6. **Poke the holes open.** Push the stiff wire through the tape into each covered socket, so the Pico's pins can
   go in.
7. **Black and red, same way.** Left row: **black into the 6th, red into the 7th**. Tape. Poke.
8. **Header ready.** 4 wires in, taped, holes open.
9. **Plug in the chip.** Cable into the Trust M, either socket (it fits one way). Tilt the Trust M on its side
   and wedge it between the two rows of sockets, over the wires. Snug.
10. **Snap off extra board** (some Picos only): a little extra board on the end away from USB. Snap it off with
    pliers or it won't fit the case.
11. **Stack the boards.** Push the Pico into the sockets, **its USB at the same end as the screen board's USB
    mark**, its chips and BOOTSEL button facing out. Straight, all the way, flush. The Trust M ends up wedged
    between. Nothing may stick out, or it won't fit the case.
12. **Peel the screen protector** (the blue tab).
13. **Case parts:** white lid, black base, joystick cap, 2 grey buttons, 1 green, 1 red.
14. **Joystick cap.** Square hole on the joystick, press hard until it snaps. It should stay on upside down and
    click all 4 ways and in. The small gap under its rim is on purpose.
15. **Buttons into the lid.** Lid face down at the edge of the mat. Drop them in with tweezers: **green, grey,
    grey, red**. Green sits over A, red over Y.
16. **Boards into the base.** Screen up, **USB end first** into the base's hole, then lower the rest. Don't force
    it straight down. The board lies flat on the rails.
17. **Check the USB fit.** The port must sit right in the middle of the hole. If not: push the Pico fully into
    the sockets, seat the screen board flush on the supports, try again.
18. **Close the case.** Base over, screen down, into the lid (buttons in). Press hard until it snaps. Tight on
    purpose.
19. **Check the feel.** Every button and every joystick direction clicks. Nothing tilted or stuck.
20. **Install the firmware.** Unplugged: hold **BOOTSEL** through the small hole in the base with a paperclip,
    plug in a USB data cable, let go. Open https://wedgie.dev/reset in Chrome, click **Find it**, follow the page.
    The screen stays dark until the firmware is on. Don't unplug while it runs.
21. **Install the software.** Leave it plugged in. Open https://wedgie.dev/connect in Chrome and follow the page.

Firmware done, but the screen is dark or shows an error: a wire is in the wrong socket, a wire came out, or the
Trust M touches a Pico pin. Open the case and check.

### How the sandwich sits
Held as a wedgie (landscape, screen facing you): USB on the left, joystick left of the screen, A B X Y in a
column on the right, A at the top. The Pico's components face away from the screen. The gap between the boards
is about 8.5 mm.

## Full Pico pinout (looking at the Pico's back, USB at top)

Left, pins 1-20 top-down: GP0, GP1, GND, GP2, GP3, GP4, GP5, GND, GP6, GP7, GP8, GP9, GND, GP10, GP11, GP12,
GP13, GND, GP14, GP15.
Right, pins 40-21 top-down: VBUS, VSYS, GND, 3V3_EN, 3V3, ADC_VREF, GP28, AGND, GP27, GP26, RUN, GP22, GND,
GP21, GP20, GP19, GP18, GND, GP17, GP16.

| Used by | Pins |
|---|---|
| Screen (SPI) | GP8 DC, GP9 CS, GP10 SCK, GP11 MOSI, GP12 RST, GP13 backlight |
| Joystick | GP2 up, GP18 down, GP16 left, GP20 right, GP3 press |
| Buttons | GP15 A (green), GP17 B (grey), GP19 X (grey), GP21 Y (red) |
| Secure chip (I2C0) | GP4 SDA, GP5 SCL, pin 36 3V3, pin 38 GND |
| Battery sense (optional) | VSYS read on GP29 |
| **Free** | GP0, GP1, GP6, GP7, GP14, GP22, GP26, GP27, GP28 (GP26-28 can read analog) |

## The case

A snap-together printed shell, no screws, MIT: https://github.com/clawdbotatg/clawd-pico-case (STLs in
`stl/current/`: lid, base, joystick cap, 4 button caps).

- **Print:** PETG, 0.16 mm layers, 4 walls, no supports. Lid face down, base floor down, caps flange down. Caps
  can be PETG or PLA.
- **Colors:** white lid, black base, grey joystick; buttons 2 grey, 1 green (A), 1 red (Y). The buttons carry no
  letters: to people, A is "the green button", Y "the red button", B and X "the grey buttons".
- **Atomic wedgie:** a variant with its own base and a RESET plunger, and a LiPo on VSYS.
- A hole in the base reaches BOOTSEL. A pry notch on one side opens it.

## Taking it apart and putting it back

Open at the pry notch, lift the lid (caps may fall out), lift the board stack out. Pull the Pico and the screen
board straight apart, rocking gently end to end, never twisting; the chip slides out of the gap. Pull the four
wires straight out of the sockets. Reassemble in reverse, then check it on its page at wedgie.dev/connect.

## First boot

1. **The easy way: https://wedgie.dev/reset** (or /test) in Chrome or Edge. Hold BOOTSEL while plugging in; the
   page wipes the Pico, puts MicroPython on (the W build if it has WiFi), the latest firmware, and Welcome.
2. **By hand:** hold BOOTSEL while plugging in; a drive (RPI-RP2 or RP2350) appears; drag the `.uf2` from
   https://micropython.org/download/ (RPI_PICO for RP2040 boards and clones, RPI_PICO_W for a Pico W,
   RPI_PICO2_W for a Pico 2 W). Then `python3 wedgie.py update` (a bare board isn't locked yet, so it doesn't
   ask). Then `python3 wedgie.py use welcome` or pick an app at https://wedgie.dev/connect.
3. **Check it:** its page at wedgie.dev/connect shows Hardware (does the chip work?), Test the screen, Test the
   buttons. The Buttons app walks every button too.

## When something's wrong: check in this order

1. **Is it on USB?** `python3 wedgie.py list` or https://wedgie.dev/connect. Nothing: another cable (charge-only
   cables are common), another port, or turn the cable around (some only work one way). A drive called RPI-RP2 /
   RP2350 instead: it's in BOOTSEL (no MicroPython, or BOOTSEL was held): First boot.
2. **Does hello answer?** No: read its screen. "wedgie broke: <error>": B tries again, A asks for full control so
   a computer can fix it (`wedgie.py debug` shows `error.log`). Black screen: the Pico isn't fully seated, or
   there's no firmware (bare MicroPython shows nothing): /reset. An app that crashes at start: **hold both grey
   buttons (B and X) while plugging in**, then pick another app. What happened lately: `get` `/log1.txt` then
   `/log.txt` (no yes needed), or **Send a bug report** on its page at wedgie.dev/connect.
3. **Is the chip OK?** `{"type":"chip"}` or Hardware on its page. Not found, in order of likelihood: wires by color
   on a non-kit cable instead of plug order; SDA/SCL swapped; a data wire and the power wire swapped (the chip
   powers itself through a data pin, its LED lights: it looks like a short, it isn't, swap them); a wire in
   3V3_EN; the chip board touching a Pico pin; a wire that came out. With full control, scan the bus:
   `from machine import I2C, Pin; print([hex(a) for a in I2C(0, sda=Pin(4), scl=Pin(5)).scan()])` shows `0x30`
   (Trust M) or `0x60` (ATECC608). With a meter: 3.3 V between pin 36 and pin 38.
4. **The screen:** Test the screen on its page. Stripes or nothing with the backlight on: reseat the Pico.
5. **The buttons:** Test the buttons on its page lists which work. "Held from the start": a cap presses the switch
   all the time. Never registers: the switch itself.
6. **Still broken: https://wedgie.dev/test.** It copies the saves into the browser, wipes the Pico (BOOTSEL), puts
   MicroPython, the firmware and Welcome on, puts the saves back, and tests the board, screen, every button and the
   chip. Nothing starts until its Test it button is pressed. It uses the chip but never changes it: safe to run
   again and again. Just the latest firmware, no tests (old firmware, or it won't start): https://wedgie.dev/reset
   (saves go).
7. **Still stuck:** wedgie@buidlguidl.com.

**A dead or locked secure chip:** it's its own little board: swap in a new breakout. Keys made inside the old chip
are gone with it: anything they guarded (a Safe owner key) comes back only through that wallet's other owners or
recovery. A reflash, /reset or /test never erases the chip.

## Limits

| | RP2040 (Pico, clones) | RP2350 (Pico 2 W) |
|---|---|---|
| RAM | 264 KB (free for an app: ~120-150 KB, `hello`'s `ram`) | 520 KB |
| Flash | 2 MB | 4 MB |

- 3.3 V logic; GPIOs are **not 5 V tolerant**. Power is USB (5 V on VBUS); the 3V3 pin gives a few hundred mA.
- Screen 240x240, 16-bit panel; the firmware draws in 16 colors (a 29 KB buffer); a full-screen push is ~25 ms.
- No battery built in. A LiPo on VSYS works: off USB the firmware (0.3.28+) shows the charge top right and sleeps
  after 20 s with no press; any button or USB wakes it, and that press goes to nobody.
- No real-time clock. WiFi only on W boards (never used by wallet apps).
