---
name: wedgie-code
description: Make games and apps for a wedgie (a Raspberry Pi Pico with a 240x240 screen, a joystick and A/B/X/Y, running MicroPython + wedgie firmware). Use for "make me a wedgie game", "build an app for my wedgie", "make my wedgie game faster", "put my game on my wedgie". Covers the app format (wedgie.json), fast graphics on this hardware with measured numbers, saves, the emulator at wedgie.dev/code, and installing on a real wedgie.
---

# Make a wedgie app

You are writing a game or app for a **wedgie**: a Raspberry Pi Pico (RP2040 or RP2350) under a
240x240 color screen, with a 5-way joystick on the left and four buttons A B X Y down the right. It
runs MicroPython plus the wedgie firmware, which boots straight into one app. You write that app.

What you hand back is a **folder** (later a GitHub repo) with a `wedgie.json` at its top and the app's
Python files. The person plays it in the emulator at https://wedgie.dev/code while you work, and on
their own wedgie when it's ready. Everything here is MIT.

Other things about the wedgie (building one, the USB protocol, the secure chip): https://wedgie.dev/skill.md

## The loop

1. Make the folder: `wedgie.json` + your files (start from the template below, or copy
   https://github.com/clawdbotatg/wedgie-starter, a small complete game).
2. Tell the person: open https://wedgie.dev/code in Chrome, press **Open a folder**, pick this folder.
   Their app runs in an emulated wedgie right there, and **runs again by itself every time you save a
   file**. Keys: `W A S D` joystick, `Space` press the joystick in, `J K L ;` are A B X Y, `R` runs it
   again. Their `print()`s and tracebacks show under **Output**.
3. Keep writing; they keep playing. Ask what they see. A traceback in Output is yours to fix.
4. On their real wedgie (plugged in with USB):

       curl -O https://wedgie.dev/wedgie.py        # needs: pip install pyserial
       python3 wedgie.py install .                  # this folder's app becomes the app it runs
       python3 wedgie.py shot s.png                 # the real screen as a PNG: READ IT
       python3 wedgie.py press A                    # press a button (A B X Y up down left right press)
       python3 wedgie.py run mygame.py              # run a file once and see its output/traceback

   Only one program can hold the wedgie's USB port: if wedgie.py says busy, close the wedgie's page on
   wedgie.dev. The emulator is not the real speed; **check frame times on the real wedgie** (below).
5. Put the folder on GitHub (public). Anyone can then add it on their wedgie's page at
   wedgie.dev/connect (Software, **Apps from a GitHub repo**, `owner/repo`).

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
- `fw`: the oldest firmware it runs on. Use `"0.2.3"` if you use `show_start`/`show(y0, y1)`/`show_rect`.
- `name` up to 14 characters (it's printed on the cartridge), `about` one line, `label` the cartridge
  color, `icon` 12 rows of 12 characters: `.` clear, `k` black, `w` white, `g` green, `r` red,
  `y` yellow, `b` blue, `s` grey.
- `chip`: `"ATECC608"` or `"OPTIGA Trust M"` if it needs that secure chip. `usb`: true only if the app
  speaks its own protocol on USB (a wallet); almost never.
- One repo can hold several apps; each is its own entry.

## The template

A game is an `entry` loop at a fixed frame rate. This is the shape to keep (the full game with
sprites and saves is https://github.com/clawdbotatg/wedgie-starter/blob/main/dodge/dodge.py):

```python
import time
from lcd import LCD, Keys, color
import save

lcd = LCD()                       # the screen: a 240x240 framebuf, RGB565
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

The app gets every button; there's no menu and nothing that leaves it. Convention: A = yes/fire,
Y = no/back. Keep the joystick for movement. Show the controls on the title screen.

## Fast graphics: what things cost

Measured on a real wedgie (RP2040 Pico, firmware 0.2.3, 125 MHz, the Speed lab app). An RP2350 is
faster on CPU work. At 40 fps you have 25 ms a frame, and **pushing the full screen takes 18 of them**,
so the whole game is about not paying that twice.

| What | Cost |
|---|---|
| Full screen push, `lcd.show()` | 18 ms (62.5 MHz SPI) |
| Same, with `show_start()` | 0.9 ms of CPU, the rest runs by DMA |
| `show(y0, y1)`: a 24-row band / 120 rows | 2.4 ms / 9.4 ms |
| `show_rect(x, y, 32, 32)` | 1.8 ms (about 45 us per row, plus its bytes) |
| `fill()` the whole buffer | 4.2 ms |
| 16x16 RGB565 sprite `blit` | 0.17 ms |
| 16x16 4-bit sprite `blit` through a palette | 0.33 ms |
| `text()`, 30 characters | 0.4 ms |
| `big_text(..., scale 3)`, 10 characters | 14 ms |
| Plain Python pixel loop | 6.8 us per pixel (a full screen: 0.4 s) |
| `@micropython.viper` pixel loop | 0.26 us per pixel (26x faster) |
| `gc.collect()` | 8 ms |
| RAM free for a game (RP2040, framebuffer taken) | ~80 KB |

The rules that follow from it:

1. **Push the frame by DMA.** `lcd.show_start()` returns at once and sends the frame while your code
   runs; `lcd.show_wait()` before you draw again. Do input, game logic and `gc.collect()` between
   them. Never draw while a frame is going out (it tears). `show()`, `show(y0, y1)` and `show_rect`
   wait for a running DMA push by themselves. In the emulator `show_start` is a plain `show`.
2. **Push less when little changed.** A puzzle, a menu, a card game: redraw the part that changed and
   push `lcd.show(y0, y1)` (full-width rows: nothing is copied) or `lcd.show_rect(x, y, w, h)`.
   Prefer a band over many rects: each rect row costs ~45 us on its own.
3. **Draw with the C calls.** `fill`, `fill_rect`, `rect`, `hline`, `vline`, `line`, `ellipse`,
   `poly`, `text`, `blit`, `scroll` all run in C. A Python loop over pixels is 20-40x slower than the
   same thing done by one of these.
4. **Sprites are framebufs made once, at import.** RGB565 (`framebuf.RGB565`, 2 bytes a pixel) is
   the fastest to draw. 4-bit (`framebuf.GS4_HMSB`) drawn through a palette is a quarter of the RAM
   and lets one sprite come in many colors:

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
5. **Colors: always `color(r, g, b)`** (the panel wants byte-swapped RGB565). Make them once, at the
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
11. **RAM is ~80 KB on an RP2040** after the 115 KB screen buffer. Don't allocate a second full-screen
    buffer. A 120x120 game can draw into its own small buffer and scale it up 2x with a viper loop into
    `lcd.buffer`. Split big data into files and load what the current level needs.
12. **Measure on the real one.** `wedgie.py run` a file that times a frame with `time.ticks_us()`, or
    `print()` the frame time now and then. The **Speed lab** app (pick it at wedgie.dev/connect) times
    all of the above on that wedgie.

## Saves (and starting at level 8)

```python
import save
save.store("best", 120)                   # anything json can write; bytes are kept as they are
best = save.load("best", 0)               # the default when there's none yet
save.delete("best"); save.names()
```

Each app has its own folder (`/saves/<mod>/`); installs, switching apps and firmware updates never
touch it. Save at checkpoints, never every frame (flash wears).

**Keep progress in a save, and read it at start**, e.g. `save.store("level", {"level": 8, "lives": 3})`.
In the emulator every save shows up under **Saves**; the person can edit one (`"level": 8`) and it runs
again from there, so nobody plays through levels 1-7 to test level 8. Tell them which save does what.

## The rest of the hardware

- Screen: `lcd.LCD()` is a `framebuf.FrameBuffer` (240x240, RGB565) plus `show`, `show_start`,
  `show_wait`, `show(y0, y1)`, `show_rect`, `center_text(s, y, c, scale)`, `big_text`,
  `backlight(pct)`. Ready colors: `BLACK WHITE RED GREEN BLUE YELLOW GREY DARK`.
- Keys: `keys.pressed()` (went down since the last call) and `keys.held(k)`. Names: `A B X Y up down
  left right press`. Read `pressed()` every frame, even when you don't need it, or presses pile up.
- MicroPython, not CPython: `math random struct json time array framebuf micropython gc`,
  `time.ticks_ms()`, `ticks_diff()`, `sleep_ms()`. No real clock, no files outside the flash, no pip.
- Sound: none built in. Free pins for extras: GP0 GP1 GP6 GP7 GP14 GP22 GP26 GP27 GP28.
- The secure chip (ATECC608 or Trust M) is for wallets and crypto games: see /skill.md. Never lock
  it or make keys on it unless the person asks; both are permanent.

## Before you say it's done

- It runs in the emulator from a fresh start (delete its saves) and from each save you tell them about.
- No traceback in Output after a few minutes of play, and a game over / win screen that A gets past.
- On a real wedgie if one is plugged in: `wedgie.py install .`, a `shot`, and a frame time you printed.
- `wedgie.json` matches the files, every file name starts with the mod.
- The README says what it is, the controls, and the saves.
