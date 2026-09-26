---
name: wedgie
description: Write, install and debug apps on a wedgie (Raspberry Pi Pico + Waveshare Pico-LCD-1.3 240x240 screen, joystick, A/B/X/Y, secure chip on I2C, running MicroPython + wedgie firmware) over USB. Use for "make an app/game for my wedgie", "put this on my wedgie", "what's on my wedgie's screen", "update my wedgie", "why won't my wedgie ...".
---

# Wedgie

A wedgie is a pocket computer made from three off-the-shelf parts: a Raspberry Pi Pico (RP2040 or
RP2350), a Waveshare Pico-LCD-1.3 hat (240x240 screen, 5-way joystick, A/B/X/Y), and a secure chip
(ATECC608 or Infineon Trust M) wedged between the boards on I2C. It runs MicroPython plus wedgie
firmware: a boot logo, a launcher menu of apps, and a USB protocol. Everything is MIT: https://wedgie.dev

## Your tools

Get the host tool (one file; needs `pip install pyserial`):

    curl -O https://wedgie.dev/wedgie.py

    python3 wedgie.py list                 every wedgie on USB: port, ID, firmware
    python3 wedgie.py update               install/update wedgie firmware (only changed files)
    python3 wedgie.py hello                what it is and runs (JSON)
    python3 wedgie.py shot out.png         the real screen as a 240x240 PNG. READ IT to see what you drew.
    python3 wedgie.py press A              press a button (A B X Y up down left right press) [ms]
    python3 wedgie.py launch myapp         open an app;  home  goes back to the launcher
    python3 wedgie.py run app.py           run a file once (streams output; Ctrl-C stops)
    python3 wedgie.py install app.py --name "My app"    save it and add it to the launcher
    python3 wedgie.py uninstall myapp
    python3 wedgie.py apps | ls

`--port /dev/cu.usbmodemXXXX` or `--id A1B2C3` picks one when several are plugged in. Only one program
can hold the port: if wedgie.py says busy, the wedgie.dev tab (its device panel) or mpremote has it.
`mpremote` works too (`mpremote cp app.py :app.py`, `mpremote repl`); Ctrl-C stops the launcher.

## The loop

1. Write `myapp.py` (template below).
2. `python3 wedgie.py install myapp.py --name "My app"` then `python3 wedgie.py launch myapp`.
3. `python3 wedgie.py shot s.png` and read the PNG. `python3 wedgie.py press A` (and others) to drive it,
   shot again. Text is the 8x8 font: check it is readable and inside the 240x240 edges.
4. If it crashed: `python3 wedgie.py run myapp.py` shows the traceback. A launcher error screen also
   shows the message on the device.
5. Iterate. The person can also see and click their wedgie at https://wedgie.dev (Chrome/Edge).

## An app

One module that starts itself when imported, draws with `lcd`, reads `Keys`, ticks on a `Timer`
(so USB stays responsive), quits on X, and offers `stop()`. The launcher imports it; X returns home.

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
        if k == "X":
            return stop()
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

A game can use a `while` loop with `time.sleep_ms()` instead, if it polls X and returns. Register
it with an entry so the launcher calls it: in apps.json `{"mod": "game", "name": "Game", "entry": "run"}`
(`wedgie.py install` registers timer-style apps; add `entry` by hand for loop-style ones).

## The hardware, from Python

- `lcd.LCD()` is a `framebuf.FrameBuffer` (240x240 RGB565): `fill(c)`, `pixel(x,y,c)`, `hline/vline`,
  `line`, `rect(x,y,w,h,c[,fill])`, `fill_rect`, `ellipse(cx,cy,rx,ry,c[,fill])`, `poly`, `text(s,x,y,c)`
  (8x8 font), `blit(fb,x,y[,key])`, `scroll`; plus `big_text(s,x,y,c,scale)`, `center_text(s,y,c,scale)`,
  `backlight(pct)`, `show()`. Always make colors with `color(r, g, b)` (the panel wants byte-swapped
  RGB565); ready-made `BLACK WHITE RED GREEN BLUE YELLOW GREY DARK`.
- `lcd.Keys()`: `pressed()` -> list of key names since the last call; `held(k)`. Names:
  `A B X Y up down left right press`. Layout seen from the screen: joystick left, A B X Y down the right
  edge (A top, green cap; Y bottom, red cap). Convention: A = yes, Y = no/back, X = quit.
  `wedgie.py press` reaches every Keys() the way a finger would (apps reading Pins directly won't see it).
- Pins, if you need them: screen SPI1 DC=8 CS=9 SCK=10 MOSI=11 RST=12 BL=13; buttons (active low,
  pull-up) A=15 B=17 X=19 Y=21 up=2 down=18 left=16 right=20 press=3. Free GPIOs: 0 1 6 7 14 22 26 27 28.
- Secure chip on I2C0 SDA=GP4 SCL=GP5: ATECC608 at 0x60 (`signer.py`/`atecc.py`), Trust M at 0x30
  (`trustm.py`). The chip's breakout has a spare STEMMA QT port: other I2C boards daisy-chain on the
  same bus with no new wires. NEVER lock an ATECC608 or generate a key on it unless the person asks
  explicitly; both are permanent and can brick the chip for its current use.
- `import wedgie`: `wedgie.uid()`, `wedgie.short()`, `wedgie.board()`, `wedgie.VERSION`.
- Speed and memory: ~300 KB RAM free with the 115 KB screen buffer (less on RP2040: import `lcd`
  before big modules). Drawing primitives run in C; per-pixel Python loops are slow (~300k simple
  iterations/s) — use `@micropython.viper` for pixel work, precompute, `gc.collect()` between scenes.
  Full-frame show ~38 ms (25 fps); `machine.freq(150_000_000, 150_000_000)` before LCD() gets ~65 fps.
- MicroPython, not CPython: small stdlib (`math random struct json time array binascii hashlib`),
  `time.ticks_ms()/ticks_diff()/sleep_ms()`, no real clock, no typing. WiFi only on W boards.

## What's already on it

apps.json lists the launcher's apps: `hello` (bouncing box, the template), `keytest` (buttons),
`demo` (balls/cube/plasma speed test), `mock` (nine wallet screens), `wire_demo` (clear-signs a
signed transaction request), `battery` (Waveshare Pico-UPS-B hat), `usbwallet` (the USB hardware
wallet; needs the ATECC608). Their source is at https://wedgie.dev/fw/manifest.json -> /fw/<file> and
in https://github.com/clawdbotatg/wedgie-dev/tree/main/firmware. Read `hello.py` and `lcd.py` first.

## The USB protocol (what wedgie.py speaks)

The launcher owns the USB serial port (vendor 0x2e8a, 115200) and answers one JSON line per request,
without interrupting anything:

    {"id":1,"type":"hello"}              -> {"id":1,"type":"hello","fw":"wedgie-0.1.0","uid":...,"board":...,"apps":[...],"running":...}
    {"id":2,"type":"shot"}               -> {"id":2,"type":"shot","i":0,"n":38,"fmt":"rgb565be","data":"<base64>"} x n
    {"id":3,"type":"press","key":"A"}    -> {"id":3,"type":"ok"}
    {"id":4,"type":"launch","app":"hello"}  /  {"id":5,"type":"home"}  /  {"id":6,"type":"reboot"}

Lines that don't start with `{` are logs (an app's print()). Ctrl-C (0x03) stops the launcher and
drops to the MicroPython REPL; raw REPL (Ctrl-A) is how files get written. A soft reset (Ctrl-D in
the normal REPL) boots the launcher again. The Wallet app speaks its own protocol while it runs.

## Blank board

No MicroPython yet: hold BOOTSEL while plugging in, drag the `.uf2` for that board from
https://micropython.org/download/ (RPI_PICO, RPI_PICO_W, RPI_PICO2_W) onto the drive that appears,
then `python3 wedgie.py update`.
