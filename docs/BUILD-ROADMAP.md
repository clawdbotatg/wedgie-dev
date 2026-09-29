# /build roadmap

wedgie.dev/build: pick a wedgie's parts, get a link to that exact wedgie, buy it or build it.
Everything picked lives in the URL (`src/pages/build.ts`, guarded by `tools/buildprobe.mjs`).

## Phase 1: one case, one hat (now)

- **Hat:** Waveshare Pico-LCD-1.3 only.
- **Case:** the current clawd-pico-case (made for the pink USB-C RP2040 clone).
- **Board:** only Pico boards that fit that case: same 51 x 21 mm outline, same pins, USB-C in the same spot.
  The pink NULLLAB board is fit-tested; the DIGISHUO pink and the green USB-C copies should fit (not tested).
- **Chips:** up to two I2C boards no bigger than the ATECC608 breakout (25.4 x 17.8 mm, about 5 mm tall).
  Two boards can't share an I2C address. An app that needs a chip locks it in.
- **Colors:** filament you can get on Amazon in a couple of days. Case: PETG only. Buttons and joystick: PETG or PLA.
- **Firmware:** always the latest.
- **Price:** the parts it uses, plus a flat $30 for building and shipping it (the $30 covers shipping).
  Fixed for now: no stock, lead time or demand in it yet. At the cheapest build, we
  get $30 over parts. It is also meant to nudge people to build their own: we build for people with more
  money than free time. (Don't say that on the site.)
- **Checkout:** not open yet. When it opens, the order is the URL.

## Phase 2: other boards, other cases

- Pico boards that don't fit today's case, e.g. ones with a battery connector (Pimoroni Pico LiPo,
  Waveshare RP2040-Plus) and a battery inside. Each needs its own case (base, maybe lid) and its own prints.
- The picker then chooses the case from the board; the URL stays the same shape (`pico=`).
- **A parts catalog:** every part and every filament color, each with its price, its lead time (how long
  it takes to arrive if we order it) and how many we have in house. The page reads it, so a build shows
  what it costs us and when it ships: in stock = ships soon; a part we'd have to order adds its lead
  time (a 5-day part = +5 days).
- **Price that follows demand:** the base price stays parts + $30, and goes up as orders come in, then
  back down. Ideas: every order past the 5th in a window (8 or 24 hours) adds to the price, and the
  next window starts over; or a part running low or out (printed cases, chips) raises it.

Boards that don't fit today's case, and why (researched 2026-09-28):
- Waveshare RP2040-Plus / RP2350-Plus (battery socket): the port sticks out 1.1 mm less and the BOOT and
  RESET buttons miss the base hole. One is on the bench: test it.
- Official Pico / Pico W / Pico 2 / Pico 2 W: micro-USB, fit unknown.
- Pimoroni Pico Plus 2 (W), Pico LiPo: connectors about 4.5 mm tall where the case has about 3.5 mm.
- The black 16 MB "YD-RP2040" boards, WeAct: about 2 mm bigger, or a different pinout.

## Phase 3: other hats

- Other Pico hats, e.g. ones with three buttons. Each hat needs its own case and caps, and apps have to know
  which buttons exist.
- `hat=` in the URL; pick the hat first, then the board and case that fit it.

## Numbers used today

- Filament per wedgie, from the STLs (solid volume x 1.27 g/cm3): lid ~11 g, base ~15 g, joystick and four
  buttons under 1 g. About 26 g, so filament is about 50 cents a wedgie.
- Part prices live in `build.ts`. Re-check them when a price looks off; last checked 2026-09-28.
