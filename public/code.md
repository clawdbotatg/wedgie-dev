---
name: wedgie-code
description: Make games and apps for a wedgie (a Raspberry Pi Pico with a 240x240 screen, a joystick and A/B/X/Y, running MicroPython + wedgie firmware). Use for "make me a wedgie game", "build an app for my wedgie", "make my wedgie game faster", "put my game on my wedgie". Covers the app format (wedgie.json), how the firmware runs an app, the built-in look (ui: pages, questions, the loading bar), fast graphics with measured numbers, saves, the two emulators (wedgie.dev/code and the virtual wedgie at wedgie.dev/virtual), installing on a real wedgie, and publishing.
---

# Make a wedgie app

You are writing a game or app for a **wedgie**: a Raspberry Pi Pico (RP2040 or RP2350) under a
240x240 color screen, with a 5-way joystick on the left and four buttons A B X Y down the right. It
runs MicroPython plus the wedgie firmware (current: 0.3.64), which boots straight into one app. You
write that app.

What you hand back is a **folder** (later a GitHub repo) with a `wedgie.json` at its top and the app's
Python files. The person plays it in the emulator at https://wedgie.dev/code while you work, and on
their own wedgie (or the virtual one) when it's ready. Everything here is MIT.

Other things about the wedgie (building one, the USB protocol, the secure chip): https://wedgie.dev/skill.md
The Trust M secure chip from an app: https://wedgie.dev/trustm.md
The virtual wedgie (real firmware in a browser tab): https://wedgie.dev/virtual.md

## The loop

1. Make the folder: `wedgie.json` + your files (start from the template below, or copy
   https://github.com/clawdbotatg/wedgie-starter, a small complete game).
2. Tell the person: open https://wedgie.dev/code in Chrome, press **Open a folder**, pick this folder.
   Their app runs in an emulated wedgie right there, and **runs again by itself every time you save a
   file**. Keys: `W A S D` joystick, `Space` press the joystick in, `J K L ;` are A B X Y, `R` runs it
   again. Their `print()`s and tracebacks show under **Output**. Saves show under **Saves**.
3. Keep writing; they keep playing. Ask what they see. A traceback in Output is yours to fix.
4. Check it on a real RP2040's memory: the **virtual wedgie** (below) or a real wedgie.
5. On their real wedgie (plugged in with USB):

       curl -O https://wedgie.dev/wedgie.py        # needs pyserial: pip install pyserial, or run it as
                                                    # uv run --with pyserial python3 wedgie.py ...
       python3 wedgie.py install .                  # this folder's app becomes the app it runs
       python3 wedgie.py unlock                     # once: shot and press need a green-button yes
       python3 wedgie.py shot s.png                 # the real screen as a PNG: READ IT
       python3 wedgie.py press A                    # press a button (A B X Y up down left right press)
       python3 wedgie.py run mygame.py              # run a file once and see its output/traceback
       python3 wedgie.py debug                      # firmware, files, free flash and RAM, error.log

   `install` and `run` ask on the wedgie's screen: the person presses the green button. Only one program
   can hold the wedgie's USB port: if wedgie.py says busy, close the wedgie's page on wedgie.dev (and
   mpremote). Several plugged in: `--id A1B2C3`. The emulator is not the real speed; **check frame times
   on the real wedgie** (below). Everything wedgie.py does: https://wedgie.dev/usb.md
6. Put the folder on GitHub (public). Anyone can then add it on their wedgie's page at
   wedgie.dev/connect (Software, **Apps from a GitHub repo**, `owner/repo`). Such an app isn't signed by
   wedgie.dev, so it installs with full access: it can do anything on that wedgie, including replacing
   the keys in its Trust M's spare key slots. Say so in your README.
7. To be on wedgie.dev for everyone (signed, one tap to install): ask wedgie.dev to add the repo
   (email the repo to wedgie@buidlguidl.com). We read one commit, sign it, and it's on the shelf;
   a later commit goes up only when we read that one too. An app's version is its commit: there's no
   version number to bump.

## Two emulators

| | wedgie.dev/code | wedgie.dev/virtual |
|---|---|---|
| What | MicroPython (WebAssembly) running the firmware's Python | the real firmware on a virtual RP2040, with a software Trust M |
| For | writing: open a folder, it reruns on every save | checking: real RAM, real questions, real installs |
| Your app | Open a folder, or a GitHub repo | install it like on a real one: wedgie.dev/connect, **Apps from a GitHub repo** |
| RAM | no limit (a memory bug won't show) | a real RP2040's (~130-150 KB for your app) |
| Speed | not a real wedgie's | 20-70% of a real wedgie's |
| Saves | kept per app in the browser; edit one to start anywhere | its own flash, kept in the browser |
| Secure chip | none (`rand_source()` says so) | a software Trust M (no RSA or AES; the chip check fails on purpose) |

The virtual wedgie: open https://wedgie.dev/virtual (or **Pop out a virtual wedgie** on the front
page, or on /code). wedgie.dev in other tabs of the same browser sees it plugged in, tagged
**virtual**. Same keys as above. Only one per browser: a second tab says one is already open. For an
agent, in that tab's JS: `await wedgie.press("A")`, `wedgie.screen()` (a PNG data URL),
`wedgie.history(10)`. Headless from the wedgie-dev repo: `node tools/emu.mjs` (a curl API). More:
https://wedgie.dev/virtual.md

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
      "fw": "0.3.36",
      "label": "#22c452",
      "icon": ["............", "............", "..kkkkkk....", "..kggggk....", "..kgkkgk....", "..kgk.kgkkk.",
               "..kgk.kgggk.", "..kgk.kkkgk.", "..kgk...kgk.", "..kkk...krk.", "........kkk.", "............"]
    }
  ]
}
```

- `mod`: the Python module name, 2-20 of `a-z 0-9 _`, starting with a letter. Must not be a firmware
  module (`lcd`, `ui`, `save`, `slot`, `wedgie`, `loader`, `optiga`, ...) or an app already on
  wedgie.dev. It's also the app's save folder.
- `files`: paths in the folder. On the wedgie **every file lands in the flash's root under its own
  name**, so every file name is `<mod>.py` or starts with `<mod>_` (`snake_levels.json`), lowercase
  `a-z 0-9 _`, ending `.py .mpy .bin .json .txt`. `<mod>.py` (or `.mpy`) is required: it's what gets
  imported. Up to 30 files, 256 KB per app.
- `entry`: a function the firmware calls after importing (a game loop). Leave it out for a Timer app
  (it starts itself at import).
- `fw`: the oldest firmware it runs on. Using the whole `ui` kit below (`ui.say`, `{g}` squares,
  `lcd.tint`): `"0.3.36"`. Older floors: `"0.2.3"` `show(y0, y1)`/`show_rect`, `"0.2.4"` `wedgie.rand`,
  `"0.2.5"` `Keys(physical=True)`, `"0.3.5"` `ui`, `"0.3.17"` `optiga`, `"0.3.23"` `lcd.art`,
  `"0.3.28"` `ui.right`, `"0.3.61"` `net`.
- `name` up to 14 characters (it's printed on the cartridge), Title Case. `about` one line, up to 140
  characters. `label` the cartridge color (`#rrggbb`). `icon` 12 rows of 12 characters: `.` clear,
  `k` black, `w` white, `g` green, `r` red, `y` yellow, `b` blue, `s` grey.
- `chip`: `"ATECC608"` or `"OPTIGA Trust M"` if it needs that secure chip. `usb`: true only if the app
  speaks its own protocol on USB (a wallet); almost never. Then the firmware stops answering USB for you.
- `net`: the sites it gets from the internet (below), like `["api.coinbase.com", "chain"]`. A site name
  covers its subdomains; `"chain"` is read-only chain calls and the ETH price. Needs `"fw": "0.3.61"`.
- One repo can hold up to 20 apps; each is its own entry.

## How the firmware runs your app

- At power-up the boot logo and bar show while your files load, then `import <mod>`. With an `entry`,
  the firmware calls it and it owns the CPU. Without one, your module starts itself at import (a
  `machine.Timer`) and returns.
- While it runs, the firmware answers USB in the background (a timer every 60 ms) so a computer can
  read the screen and press keys without stopping your app. Sleep a little every frame
  (`time.sleep_ms`) so it gets its turn.
- If `entry` returns, the screen shows your app's name and "ended"; green starts it again. If it raises,
  the screen shows the error in red; green tries again. The traceback goes to USB and to the log
  (`wedgie.py debug`). Never call `sys.exit()` or raise `KeyboardInterrupt`: both count as a crash.
- Your app gets every button. There is no menu and no way out: to run something else, the person picks
  it at wedgie.dev/connect. Holding both grey buttons (B and X) while plugging in starts without the app.
- `print()` goes to USB (Output on /code, the terminal for `wedgie.py run`). Don't read stdin: USB is
  the firmware's unless `"usb": true`.
- On a battery (no USB), the firmware draws the charge in the top-right corner and sleeps after 20 s
  with no press. The press that wakes it never reaches your app.
- A thin red border on every screen means a computer had full control since the files were last as
  signed. That's the firmware's, not a bug in your app.

## The template

**Use this shape for every app and game:** an `entry` loop at a fixed frame rate, in a folder with a
`wedgie.json` that names the entry. (A Timer app, which starts itself at import, also works, but has
nothing this lacks. Don't install a loop like this as one bare file with `wedgie.py install app.py`: with
no wedgie.json there's no `entry`, and a loop that starts at import keeps USB from answering.) The full
game with sprites and saves: https://github.com/clawdbotatg/wedgie-starter/blob/main/dodge/dodge.py

```python
import time
from lcd import LCD, Keys, color
import save, ui

lcd = LCD()                       # the screen: a 240x240 framebuf, 16 colors
keys = Keys()
BG = color(8, 10, 24)             # game art: any color(); text and hints: ui's palette
FRAME = 25                        # ms per frame: 40 fps
x = 112

def update():
    global x
    if keys.held("left"): x = max(0, x - 4)
    if keys.held("right"): x = min(224, x + 4)

def draw():
    lcd.fill(BG)
    lcd.fill_rect(x, 200, 16, 16, ui.GREEN)
    lcd.text("hello", 4, 4, ui.WHITE)

def run():                        # wedgie.json: "entry": "run"
    while True:
        t = time.ticks_ms()
        for k in keys.pressed():  # names that went down since last call: A B X Y up down left right press
            pass
        update()
        draw()
        lcd.show()                # push the frame (or only what changed: show(y0, y1), show_rect)
        left = FRAME - time.ticks_diff(time.ticks_ms(), t)
        time.sleep_ms(max(1, left))   # the firmware answers USB in here: always sleep a little
```

Convention: A (green) = yes/fire, Y (red) = no/back; B and X are grey. Keep the joystick for movement.
Show the controls on the title screen, as colored squares (`{g}`), never letters.

## Look and feel: always use the built-in kit

Every wedgie has `ui`: the palette and the pieces every wedgie screen is made of. **Use them for
everything that isn't your game's own art.** A loading bar, a yes/no question, a title screen, a game
over page, an error: each already exists, and every app and the firmware itself use the same one.
Never draw your own loading bar, spinner, question, or "loading..." text. Your game's own art
(sprites, levels, backgrounds) can use any colors you like.

```python
import lcd, ui, save
d = lcd.LCD()
ui.page(d, "Game over", [("score 120", ui.INK), ("best 340", ui.MUTED)], "{g} play again")
if ui.ask(d, "Delete save?", ["It can't come back."]):   # green yes, red no; only real presses count
    save.delete("best")
bar = ui.progress("Loading level 3", "tiles")           # the boot logo and the boot bar
if bar:
    bar.to(0.5)                                         # 0..1, forward only
import loader; loader.what("enemies")                   # the line under the bar
```

| `ui.page` | `ui.ask` | `ui.progress` |
|---|---|---|
| ![page](https://wedgie.dev/img/look/page.png) | ![ask](https://wedgie.dev/img/look/ask.png) | ![progress](https://wedgie.dev/img/look/progress.png) |

| Need | Use |
|---|---|
| Something slow (loading, saving, thinking, a network-free wait) | `bar = ui.progress(title, step)`; `bar.to(0..1)`; `loader.what(step)`. Title says what it's doing ("Loading level 3"), the line under the bar the step ("tiles"). No way to measure: `ui.progress(title, step, bar=False)` |
| A title screen, game over, a message, an error | `ui.page(d, head, [(text, color), ...], hint)` |
| A yes/no question | `ui.ask(d, question, lines, yes="yes", no="no", ms=60000, big=None)`: True for yes; no answer in `ms` is a no. `big`: one word or number drawn huge ("0.5 ETH") |
| Centered text, with button squares | `ui.say(d, text, y, color, scale)`: `{g}` `{r}` `{k}` draw a green, red, grey square |
| A big title | `ui.title(d, text, y)`: wraps to 2 lines at scale 2, returns the y under it |
| Words into lines | `ui.wrap(text, n)`; `ui.COLS_SMALL` (28 across at scale 1), `ui.COLS_BIG` (15 at scale 2) |
| The waistband (green, grey, red stripes) | `ui.band(d, y)` |
| Done / not right, small | `ui.check(d, x, y)` (a green check, 16x13), `ui.warn(d, x, y)` (a red warning sign) |
| Your top-right text | right-align it to `ui.right()` (it moves left while the battery shows) |

- **Few words, big.** Every screen: as few words as fit the job, drawn as big as they fit. Space left
  over means something can be bigger: center it and scale it up (scale 2 or 3, a bigger picture).
  A question is the action and the one fact that matters ("Send", "0.5 ETH"), never sentences
  explaining the buttons.
- **No button letters on screen.** The case has none: a screen never says "A" or "press Y". Use
  `{g}` `{r}` `{k}` in `ui.page` lines and hints, `ui.ask` lines and `ui.say`: `"{g} play again"`.
- **Names are Title Case:** your app's name in `wedgie.json` and its title on screen ("Safe Signer").
- **Palette:** `ui.WHITE` (screen), `ui.INK` (text), `ui.MUTED` (second lines, hints), `ui.GREEN`
  (yes, the green button), `ui.GREEN_D` (green text on white), `ui.GREY`, `ui.RED` (no, errors, the red
  button). Never re-type them (`color(34, 196, 82)`): use the names.
- **Buttons mean the same everywhere:** A (green) is yes / go / again, Y (red) is no / back. The hint
  goes at the bottom in `ui.MUTED` ("{g} play again"), as `ui.page` does.
- **`ui.progress` draws straight to the screen** (not your framebuffer) and costs about 9 KB of RAM
  while it's up; your next `d.show()` covers it.
- **`ui.ask` reads only real presses** and ignores presses in its first 0.6 s (one meant for the screen
  before). Anything that decides for the person (sign, reveal, give away, delete) asks through it.
- An app that uses `ui` needs `"fw": "0.3.5"` at least; `ui.say` and `{g}` squares everywhere need
  `"0.3.36"`; `ui.right()` `"0.3.28"` (for older: `ui.right() if hasattr(ui, "right") else 236`).

## Fast graphics: what things cost

Measured on a real wedgie (RP2040 Pico, 125 MHz; the partial pushes and `fill` on firmware 0.2.3, before the 16-color screen). An RP2350 is faster on CPU work. At 40 fps you have
25 ms a frame, and **pushing the full screen takes about 25 of them**, so the whole game is about
not pushing the full screen every frame.

| What | Cost |
|---|---|
| Full screen push, `lcd.show()` | ~25 ms (each row turned from 16 colors to the panel's RGB565 on the way out) |
| `show(y0, y1)`: a 24-row band / 120 rows | 2.4 ms / 9.4 ms |
| `show_rect(x, y, 32, 32)` | 1.8 ms (about 45 us per row, plus its bytes) |
| `fill()` the whole buffer | 4.2 ms (less now: the buffer is a quarter the size) |
| 16x16 4-bit sprite `blit` through a palette | 0.33 ms |
| `text()`, 30 characters | 0.4 ms |
| `big_text(..., scale 3)`, 10 characters | 14 ms |
| Plain Python pixel loop | 6.8 us per pixel (a full screen: 0.4 s) |
| `@micropython.viper` pixel loop | 0.26 us per pixel (26x faster) |
| `gc.collect()` | 8 ms |
| RAM free for an app (RP2040, framebuffer taken) | ~130-150 KB |

The rules that follow from it:

0. **Never grow a string or bytes with `+=` in a loop.** Each `+=` copies the whole thing, and on an
   RP2040 the copies chop the heap into pieces too small for the next one: "memory allocation failed"
   with plenty of RAM free in total. Collect parts in a list and `"".join` them once, or write into a
   `bytearray` made once at start. Make big buffers at import, while the heap is in one piece.
1. **The screen has 16 colors.** The framebuffer keeps a 4-bit palette index per pixel (29 KB
   instead of 115 KB, so an RP2040 has room left). `color(r, g, b)` gives the nearest of the 16
   (`lcd.PALETTE`: the ui colors, a grey ramp, black, yellow `(255, 220, 0)`, blue `(40, 100, 230)`).
   Need an exact color? `lcd.tint(i, r, g, b)` (0.3.36+) shows index `i` as that color until the next
   `fill()`; pick an `i` nothing else on the screen uses (`lcd.tinted()` = the ones this screen already
   took, a bit each). A full-color picture: `lcd.art(x, y, w, h, path, offset)` (0.3.23+) shows RGB565
   rows stored in a file (big-endian, the panel's bytes) over that box, read from flash as it's pushed
   (one row of RAM); gone at the next `fill()`.
2. **Push less when little changed.** A puzzle, a menu, a card game: redraw the part that changed and
   push `lcd.show(y0, y1)` (full-width rows: the fast path) or `lcd.show_rect(x, y, w, h)`.
   Prefer a band over many rects: each rect row costs ~45 us on its own. (`show_start()` and
   `show_wait()` are a plain `show()` and nothing now; they stay so older apps run.)
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
5. **Colors: always `color(r, g, b)`** (the nearest of the screen's 16), or `ui`'s names. Make them
   once, at the top, never in the loop.
6. **Pixel work (plasma, fire, a raycaster's columns) goes in viper.** `lcd.buffer` is the 4-bit
   framebuffer: two pixels a byte, the left one in the high 4 bits, 120 bytes a row.

   ```python
   import micropython
   @micropython.viper
   def shade(buf: ptr8, t: int):
       for i in range(120 * 240):
           c = (i + t) & 15
           buf[i] = c | (c << 4)                 # int math only: no floats, no calls to Python functions
   shade(lcd.buffer, frame)
   ```
   Viper is integer-only: precompute tables (sine, palettes) as `bytearray`s at import and pass them
   in as `ptr8`. In the /code emulator viper runs as plain Python (correct, just slow).
7. **Make nothing new inside the loop.** Every new list, tuple, string, float or `%` format is
   garbage, and a `gc.collect()` costs 8 ms when it comes. Keep game objects in lists you reuse
   (`r[0], r[1] = x, y`, not `rocks[i] = (x, y)`), build score text only when the score changes, and
   call `gc.collect()` yourself at calm moments (a level change).
8. **Big text is slow.** `text()` (the 8x8 font) is cheap. For a big title, draw it with `big_text`
   once into its own framebuf and `blit` that each frame.
9. **Don't change the clock.** The firmware runs the chip at 125 MHz so the screen's bus gets its top
   speed, 62.5 MHz. 150 MHz is *slower* for the screen (its divider lands at 37.5 MHz).
10. **Pace it.** A fixed frame time, sleeping the rest (the template). No tearing signal is wired to
    the Pico, so steady pacing is what keeps motion smooth. Move things by whole pixels per frame.
11. **RAM is ~130-150 KB on an RP2040** after the 29 KB screen buffer. Don't allocate a second
    full-screen buffer. Split big data into files and load what the current level needs.
    `gc.mem_free()` says what's left; check it on the virtual wedgie or a real one, never on /code.
12. **Measure on the real one.** `wedgie.py run` a file that times a frame with `time.ticks_us()`, or
    `print()` the frame time now and then.

## Saves (and starting at level 8)

```python
import save
save.store("best", 120)                   # anything json can write; bytes are kept as they are
best = save.load("best", 0)               # the default when there's none yet
save.delete("best"); save.names()
```

- Each app has its own folder (`/saves/<mod>/`); installs, switching apps and firmware updates never
  touch it. A name is up to 32 letters, digits, `- _ .`.
- A write goes to a temp file and is renamed into place, so pulling the plug mid-save keeps the last
  good one. Save at checkpoints, never every frame (flash wears).
- Saves share the free flash. A write that would leave under 32 KB free raises `OSError` ("flash
  full"): catch it and say so with `ui.page`. Keep a big save in several names (RAM is small).
- `wedgie.py saves backup f.json` / `restore f.json` copy them out and back.

**Any plugged-in computer can read saves** with no press. Never keep a secret in a save. Deleting one
from a computer asks on the wedgie. Anything that decides for the person (sign, reveal, give away)
reads real buttons only: `Keys(physical=True)` or `ui.ask`. Plain `Keys()` also takes presses a
computer sends over USB.

**Keep progress in a save, and read it at start**, e.g. `save.store("level", {"level": 8, "lives": 3})`.
In the /code emulator every save shows up under **Saves**; the person can edit one (`"level": 8`) and
it runs again from there, so nobody plays through levels 1-7 to test level 8. Tell them which save
does what.

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
  detects that and uses the Pico's own generator, and `rand_source()` says so. So does the /code
  emulator, which has no chip.
- For looks (star fields, particles) plain `random` is fine and faster.
- Example: Hi-Lo, https://github.com/clawdbotatg/wedgie-starter/blob/main/hilo/hilo.py

**More from the chip** (Trust M: keys that never leave it, signatures, ECDH, RSA, counters, storage):
`import optiga`, firmware 0.3.17+. Every call, with examples and timings: https://wedgie.dev/trustm.md

## The internet (0.3.61+)

A wedgie has no network, but the computer it's plugged into does. List the sites in wedgie.json
(`"net": ["api.coinbase.com", "chain"]`) and `import net`:

```python
import net
p = net.price()                                      # ETH in dollars (a float)
ps = net.chain(1, "wedgie_symbols", ["BTC", "SOL"])  # {"BTC": 80449.85, "SOL": 101.46}: any coin by symbol (25 max)
t = net.chain(8453, "wedgie_prices", ["0x4ed4...efed"])["tokens"]   # tokens on that chain by address: {address: usd}
n = int(net.chain(8453, "eth_blockNumber"), 16)      # a chain read: eth_call, eth_getBalance, eth_blockNumber, ...
amt = net.get("https://api.coinbase.com/v2/prices/ETH-USD/spot", pick="data.amount")   # "3412.10"
rows = net.get("https://example.com/list.json", pick="0:5.{title,amount}")             # [{title, amount}] x 5
```

- Who fetches: **the wedgie's page on wedgie.dev, open in a tab** (wedgie.dev/connect, pick it; Chrome or
  Edge), or `python3 wedgie.py net` in a terminal. Nothing open: `net.Error("no internet: ...")` after 15 s.
  Say so on your screen and in your README.
- `net.chain(chain, method, params)` is any read-only JSON-RPC call on that chain; wedgie.dev makes it. No URL.
- Only what `"net"` lists, through wedgie.dev. `"chain"` uses wedgie.dev's Alchemy key (it never reaches the
  app or the page); read methods only, no sending transactions. Chains: 1 Ethereum, 8453 Base, 10 Optimism,
  42161 Arbitrum, 137 Polygon, and more. Sites: https only, GET only, rate-limited.
- **The answer must fit in 5 KB** (RAM). Use `pick` to take only what you need from a JSON answer. A path
  is steps split by `.`: a field name, `3` an item (`-1` the last), `2:5` items 2-4, `*` every item,
  `{a,b}` just those fields; each list step applies the rest of the path to every item. On text, `0:500`
  is its first 500 characters (`"items.3.description.0:500"`). Or a dict of
  paths: `pick={"price": "data.amount", "base": "data.base"}`. A text page comes back as a string.
- Each call waits for its answer (usually under a second): draw your loading screen first
  (`ui.progress("Getting the price", "wedgie.dev", bar=False)`). Not waiting: `rid = net.ask({"url": ...})`,
  then `net.answer(rid)` each frame (None till it's in).
- Errors raise `net.Error` with a short reason: catch it and show it.
- Full examples: https://github.com/clawdbotatg/wedgie-ethprice, https://github.com/clawdbotatg/wedgie-ticker

## The rest of the hardware

- Screen: `lcd.LCD()` is a `framebuf.FrameBuffer` (240x240, 16 colors: GS4_HMSB) plus `show()`,
  `show(y0, y1)`, `show_rect(x, y, w, h)`, `center_text(s, y, c, scale)`, `big_text(s, x, y, c, scale)`,
  `backlight(pct)`, `buffer`, `width`, `height`. Module level: `color`, `tint`, `tinted`, `art`,
  `PALETTE`. Ready colors `BLACK WHITE RED GREEN BLUE YELLOW GREY DARK` are for game art only.
- Keys: `keys.pressed()` (went down since the last call) and `keys.held(k)`. Names: `A B X Y up down
  left right press`. Read `pressed()` every frame, even when you don't need it, or presses pile up.
  `Keys(physical=True)` ignores presses sent over USB. Pins: A GP15, B GP17, X GP19, Y GP21, up GP2,
  down GP18, left GP16, right GP20, press GP3 (low = down).
- Some wedgies have a 128x64 OLED instead (two keys: A and Y only). `ui` lays out its own screens for
  it; your app checks `d.width` (128) to draw a small layout, or it gets cut off.
- MicroPython, not CPython: `math random struct json time array framebuf micropython gc hashlib`,
  `time.ticks_ms()`, `ticks_diff()`, `sleep_ms()`. No real clock, no network of its own (`net` above), no
  files outside the flash, no pip.
- Who it is: `import wedgie; wedgie.VERSION` (firmware), `wedgie.uid()` (board ID).
- Sound: none built in. Free pins for extras: GP0 GP1 GP6 GP7 GP14 GP22 GP26 GP27 GP28.
- The secure chip (ATECC608 or Trust M): random numbers above. Keys and signing: a Trust M through
  `import optiga` (trustm.md); an ATECC608 through `atecc.ATECC608` (`firmware/atecc.py` in github.com/clawdbotatg/wedgie-dev). Never lock
  a chip or make keys on it unless the person asks; locking is permanent.

## Before you say it's done

- It runs in the /code emulator from a fresh start (delete its saves) and from each save you tell
  them about.
- No traceback in Output after a few minutes of play, and a game over / win screen that A gets past.
- It runs on the virtual wedgie or a real one (real RAM): no "memory allocation failed".
- On a real wedgie if one is plugged in: `wedgie.py install .`, a `shot`, and a frame time you printed.
- Loading, questions, pages and errors use `ui` (`ui.progress`, `ui.ask`, `ui.page`): no bar or
  question of your own, no button letters on screen.
- `wedgie.json` matches the files, every file name starts with the mod, `fw` covers what you used.
- The README says what it is, the controls, and the saves.
