---
name: wedgie
description: Build software for a wedgie (Raspberry Pi Pico + Waveshare Pico-LCD-1.3 240x240 screen, joystick, A/B/X/Y, and an ATECC608 or Trust M secure chip on I2C) and put it on the device over USB. Use for "make an app/game for my wedgie", "put this on my wedgie", "why won't my wedgie ...".
---

# Wedgie

A wedgie is a pocket computer made from three off-the-shelf parts: a Raspberry Pi Pico (RP2040 or
RP2350; Pico, Pico W, Pico 2 W, or a USB-C RP2040 clone), a Waveshare Pico-LCD-1.3 hat, and a secure
chip wedged between the two boards with its I2C wires pushed into the header. It runs MicroPython
(1.26 or newer). Everything about it is MIT: https://wedgie.dev

## The hardware, as seen from MicroPython

- Screen: 240x240 ST7789, RGB565, SPI1. Pins: DC=8, CS=9, SCK=10, MOSI=11, RST=12, backlight=13
  (PWM). Draw into a `framebuf.FrameBuffer(buf, 240, 240, framebuf.RGB565)` (115,200-byte
  `bytearray`) and send the buffer with one SPI write after setting the window (0x2A/0x2B/0x2C).
  The panel wants byte-swapped RGB565: `c = ((r&0xF8)<<8)|((g&0xFC)<<3)|(b>>3); c = ((c&0xFF)<<8)|(c>>8)`.
  A full frame costs ~38 ms at 24 MHz SPI; drawing primitives run in C and are fast, per-pixel
  Python loops are not.
- Buttons, active low, use `Pin.PULL_UP`: A=15, B=17, X=19, Y=21, joystick up=2, down=18, left=16,
  right=20, press=3. Layout seen from the screen: joystick left of the screen; A, B, X, Y down the
  right edge, A on top (green cap), Y at the bottom (red cap). Convention: A = yes/confirm,
  Y = no/back, X = quit.
- Secure chip on I2C0: SDA=GP4, SCL=GP5, 100 kHz. ATECC608 at 0x60 (P-256 key generated inside,
  never leaves), or OPTIGA Trust M at 0x30 (factory P-256 key + Infineon certificate).
  Never send lock or key-generation commands to an ATECC608 unless the person explicitly asks;
  they are permanent.
- WiFi only on W boards (`network.WLAN`).

A complete, self-contained driver for the screen, the buttons and both chips (the one wedgie.dev
uses to test a device) is at https://wedgie.dev/device/probe.py. It defines `_LCD()` (with
`fill`, `rect(x, y, w, h, color, label)`, `blit`), `col(r, g, b)`, `ident(big, small)`, `KEYS`,
`chip()`, `screen(name)`, `keys(timeout)`. Start new apps from it or copy what you need.

## Writing an app

- MicroPython, not CPython: small stdlib (`math`, `random`, `struct`, `json`, `time`, `array`),
  no typing, `time.ticks_ms()`/`time.ticks_diff()`/`time.sleep_ms()`, no real clock.
- A few hundred KB of heap. Allocate the frame buffer once, use `bytearray`s, `gc.collect()`
  between scenes, avoid building lists every frame.
- Game loop: `while` with `time.sleep_ms()`, and always poll a quit key (X) so the USB console can
  get the board back. Or a `machine.Timer` callback kept under ~30 ms, which leaves the REPL free.
- `@micropython.viper` speeds up per-pixel work.
- At power-up MicroPython runs `boot.py`, then `main.py`. An app that should start on its own
  goes in `main.py`.

## Putting it on the wedgie

The wedgie is a USB serial port (vendor 0x2e8a) running the MicroPython REPL at 115200 baud.

- In a browser: https://wedgie.dev (Chrome or Edge) finds every plugged-in wedgie, shows its ID,
  runs code on it, saves `main.py`, and tests the screen, buttons and chip.
- From a terminal: `pip install mpremote`, then
  - `mpremote run app.py` runs a file without saving it,
  - `mpremote cp app.py :main.py` + `mpremote reset` installs it,
  - `mpremote ls`, `mpremote repl`, `mpremote connect list` (find the port when several are plugged in:
    `mpremote connect /dev/cu.usbmodemXXXX ...`).
  Only one program can hold the port: close the wedgie.dev tab (or its panel) before using
  mpremote, and the other way round.
- Blank board: hold BOOTSEL while plugging in, drag the MicroPython `.uf2` for that board
  (https://micropython.org/download/ — RPI_PICO, RPI_PICO_W, RPI_PICO2_W) onto the drive.

## Protocol for wedgie firmware

Firmware that wants to be identified without being interrupted answers one JSON line per request on
the same serial port: host sends `{"id":1,"type":"hello"}\n`, device answers
`{"id":1,"type":"hello","name":"...","fw":"...","uid":"<machine.unique_id hex>", ...}`. Lines that
don't start with `{` are logs.
