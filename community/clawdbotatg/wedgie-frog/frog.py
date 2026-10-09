# Frog: your pet frog. Hatch him, name him, feed him, play with him, and he grows.
#
#   joystick left/right   pick FEED / PLAY / NAME (and a food when feeding)
#   A                     do it        Y   back
#   joystick up/down      he looks where you push (when not picking)
#
# He gets hungry and bored while the wedgie is on. Fed and happy, he grows: baby, froglet, frog,
# big frog. Everything about him is one save, "frog" (wedgie.dev/code: edit "xp" to skip ahead).
#
# Drawn with framebuf's C calls (ellipses, lines): no sprite RAM, and he can be any size.
# Only the pond (y 34..203) is redrawn every frame; the top bar and the menu only when they change.
import time, random, math
from array import array
from lcd import LCD, Keys, color
import save
import ui

lcd = LCD()
keys = Keys()
FRAME = 50                              # ms per frame: 20 fps is plenty for a pet
TOP, BOT = 34, 204                      # the pond lives between the top bar and the menu

# The screen has 16 colors (lcd.PALETTE, firmware 0.3.24+): every color here is one of them.
WHITE = color(254, 254, 254)
SKY = color(236, 237, 238)
SKY_HI = WHITE
HILL = color(195, 196, 197)
WATER = color(40, 100, 230)
RIPPLE = color(216, 217, 218)
PAD = color(22, 140, 52)
PAD_D = color(26, 27, 26)
PAD_SH = color(26, 27, 26)
REED = color(22, 140, 52)
CATTAIL = color(90, 91, 90)
FROG = color(34, 196, 82)
FROG_D = color(22, 140, 52)
BELLY = color(255, 220, 0)
EYE_W = WHITE
PUPIL = color(0, 0, 0)
MOUTH = color(26, 27, 26)
CHEEK = color(227, 49, 44)
TONGUE = color(227, 49, 44)
HEART = color(227, 49, 44)
JOY = color(255, 220, 0)
BAR_BG = color(216, 217, 218)
FLY = color(0, 0, 0)
WING = WHITE
WORM = color(227, 49, 44)
CRICKET = color(90, 91, 90)
BERRY = color(227, 49, 44)
LEAF = color(34, 196, 82)
SPARK = color(255, 220, 0)

# name, food it gives, joy it gives
FOODS = (("fly", 12, 3), ("worm", 20, 4), ("cricket", 30, 3), ("berry", 6, 15))
# name, body half-width, eye size (% of the body): the younger, the bigger the eyes
STAGES = (("baby", 22, 52), ("froglet", 29, 46), ("frog", 36, 40), ("big frog", 44, 36))
GROW = (0, 40, 120, 300)                # xp to reach each stage
MENU = ("FEED", "PLAY", "NAME")
CX, BY = 120, 184                       # where he sits on the lily pad

HEART_TRI = array("h", [-6, 1, 6, 1, 0, 8])
NOTCH = array("h", [0, 0, 62, -11, 74, -3])
BUB_TRI = array("h", [0, 0, 8, 0, -2, 7])
RIPS = ((10, 128, 30), (150, 136, 24), (60, 150, 40), (190, 160, 28), (20, 172, 22), (90, 198, 34),
        (180, 196, 30), (8, 192, 20))

frog = {"name": "", "food": 70, "joy": 70, "xp": 0, "fav": 0}
dirty = False                           # changed since the last save
sel = 0                                 # menu item, or food while feeding
feeding = False
act, act_t = None, 0                    # "eat" "play" "full" "grow" "hatch" and when it started
eat_i = 0                               # which food is being eaten
ate = False                             # this bite has counted
bubble, bubble_t = "", 0                # what he says and until when
look_x, look_y, look_t = 0, 0, 0
blink_t = 0
size = 22                               # drawn half-width: walks toward the stage's size when he grows
parts = [[0, 0, 0, 0] for _ in range(8)]  # hearts/sparkles: alive-until, x, y, kind (reused)
now = 0


def stage():
    s = 0
    for i, g in enumerate(GROW):
        if frog["xp"] >= g:
            s = i
    return s


def mood():
    f, j = frog["food"], frog["joy"]
    if f < 25 or j < 25:
        return 0
    return 2 if f >= 60 and j >= 60 else 1


def keep():
    global dirty
    try:
        save.store("frog", frog)
        dirty = False
    except OSError:
        pass                            # flash full: play on without saving


def say(s, ms=2200):
    global bubble, bubble_t
    bubble, bubble_t = s, time.ticks_add(now, ms)


def burst(n, kind, x, y):
    for p in parts:
        if n and time.ticks_diff(p[0], now) <= 0:
            p[0] = time.ticks_add(now, 900 + random.randint(0, 500))
            p[1], p[2], p[3] = x + random.randint(-30, 30), y + random.randint(-10, 10), kind
            n -= 1


def add(k, v):
    frog[k] = max(0, min(100, frog[k] + v))


# ---- eating: the food comes in, the tongue snaps it ----

FLY_MS = 2120           # the fly buzzes this long; 2120 lands it at the bottom of its loop
TONGUE_MS = 260         # out in 100 ms, back in the rest


def snap_at():
    return FLY_MS if eat_i == 0 else 700


def food_at(e):
    """Where the food is, e ms into a bite."""
    if eat_i == 0:      # the fly: loops around his head, flying in from the right at first
        x = CX + 45 + int(38 * math.sin(e / 260))
        y = BY - size * 2 - 10 + int(22 * math.sin(e / 150)) + ((e >> 5) & 1) * 2
        if e < 500:
            x, y = 250 + (x - 250) * e // 500, 60 + (y - 60) * e // 500
        return x, y
    tx, ty = CX + size + 34, BY - size * 2
    return 250 - (250 - tx) * e // 700, ty - 30 + 30 * e // 700


# ---- drawing ----

def heart(x, y, c=HEART):
    lcd.ellipse(x - 3, y, 3, 3, c, True)
    lcd.ellipse(x + 3, y, 3, 3, c, True)
    lcd.poly(x, y, HEART_TRI, c, True)


def food_art(i, x, y, t):
    if i == 0:                          # fly: wings beat
        w = 3 if t & 64 else 2
        lcd.ellipse(x - 3, y - 3, 3, w, WING, True)
        lcd.ellipse(x + 3, y - 3, 3, w, WING, True)
        lcd.ellipse(x, y, 4, 3, FLY, True)
        lcd.pixel(x + 2, y - 1, EYE_W)
    elif i == 1:                        # worm: wiggles
        for k in range(5):
            lcd.ellipse(x - 8 + k * 4, y + (2 if (k + (t >> 7)) & 1 else -1), 3, 3, WORM, True)
        lcd.pixel(x + 8, y - 1, PUPIL)
    elif i == 2:                        # cricket
        lcd.line(x - 6, y + 4, x - 9, y + 7, CRICKET)
        lcd.line(x + 2, y + 3, x + 5, y + 7, CRICKET)
        lcd.ellipse(x, y, 7, 4, CRICKET, True)
        lcd.ellipse(x + 6, y - 1, 3, 3, CRICKET, True)
        lcd.line(x + 8, y - 3, x + 13, y - 9, CRICKET)
        lcd.pixel(x + 7, y - 2, PUPIL)
    else:                               # berry
        lcd.ellipse(x, y + 1, 6, 6, BERRY, True)
        lcd.ellipse(x + 2, y - 6, 4, 2, LEAF, True)
        lcd.pixel(x - 2, y - 1, EYE_W)
        lcd.pixel(x - 3, y, EYE_W)


def pond(t):
    lcd.fill_rect(0, TOP, 240, 24, SKY_HI)
    lcd.fill_rect(0, TOP + 24, 240, 60, SKY)
    lcd.ellipse(60, 120, 90, 22, HILL, True)
    lcd.ellipse(200, 122, 80, 16, HILL, True)
    lcd.fill_rect(0, 118, 240, BOT - 118, WATER)
    ph = (t >> 6) % 240
    for x, y, w in RIPS:
        x = (x + ph) % 240
        lcd.hline(x, y, min(w, 240 - x), RIPPLE)
    for x, h in ((10, 30), (17, 40), (24, 26), (214, 36), (222, 28), (229, 44)):
        lcd.vline(x, 124 - h, h + 10, REED)
        lcd.ellipse(x, 128 - h, 2, 6, CATTAIL, True)
    lcd.ellipse(CX, BY + 2, 78, 15, PAD_D, True)
    lcd.ellipse(CX, BY, 76, 13, PAD, True)
    lcd.poly(CX, BY, NOTCH, WATER, True)


def draw_frog(cx, by, S, E, lx, ly, shut, md, mouth, breath):
    bh = S * 7 // 10 + breath
    yc = by - bh
    lcd.ellipse(cx - S + 3, by - 2, S // 3, S // 6 + 1, FROG_D, True)      # back legs
    lcd.ellipse(cx + S - 3, by - 2, S // 3, S // 6 + 1, FROG_D, True)
    lcd.ellipse(cx, yc, S, bh, FROG, True)
    lcd.ellipse(cx, yc + bh // 3, S * 6 // 10, bh * 6 // 10, BELLY, True)
    for sx in (-1, 1):                                                      # front feet
        lcd.ellipse(cx + sx * S * 4 // 10, by - 1, S // 6 + 2, S // 12 + 2, FROG_D, True)
    ex, ey = S * 55 // 100, yc - bh + E // 4
    for sx in (-1, 1):
        x = cx + sx * ex
        lcd.ellipse(x, ey, E + 2, E + 2, FROG, True)
        if shut:                                                            # a happy closed eye
            lcd.ellipse(x, ey + 1, E * 7 // 10, E // 3 + 1, MOUTH, False, 3)
            continue
        lcd.ellipse(x, ey, E, E, EYE_W, True)
        p = E * 6 // 10
        r = E - p - 1
        px, py = x + lx * r, ey + ly * r
        lcd.ellipse(px, py, p, p, PUPIL, True)
        s = p // 3 + 1
        lcd.ellipse(px - p // 3, py - p // 3, s, s, EYE_W, True)
        lcd.ellipse(px + p // 3, py + p // 3, s // 2, s // 2, EYE_W, True)
        if md == 0:                                                         # sad: droopy lids
            lcd.ellipse(x, ey, E + 1, E + 1, FROG, True, 3)
            lcd.hline(x - E, ey, 2 * E + 1, FROG_D)
    my = ey + E + 3 + bh // 8
    mw = S * 45 // 100
    if mouth == 1:                                                          # chewing, open
        lcd.ellipse(cx, my + 2, mw // 2, S // 7 + 1, MOUTH, True)
        lcd.ellipse(cx, my + 3 + S // 14, mw // 3, S // 14 + 1, TONGUE, True, 12)
    elif mouth == 2:                                                        # chewing, shut
        lcd.ellipse(cx, my, mw * 7 // 10, S // 10 + 1, MOUTH, False, 12)
    elif md == 0:
        lcd.ellipse(cx, my + S // 8 + 2, mw * 7 // 10, S // 10 + 1, MOUTH, False, 3)
    elif md == 2:
        lcd.ellipse(cx, my, mw, S // 6 + 1, MOUTH, True, 12)
        lcd.ellipse(cx, my + S // 8, mw // 2, S // 14 + 1, TONGUE, True, 12)
    else:
        lcd.ellipse(cx, my, mw, S // 8 + 1, MOUTH, False, 12)
    if md:
        for sx in (-1, 1):
            lcd.ellipse(cx + sx * S * 7 // 10, my + 2, S // 7 + 1, S // 12 + 1, CHEEK, True)
    return my


def egg(cx, by, cracks, wob):
    x = cx + wob
    lcd.ellipse(cx, by - 1, 22, 4, PAD_SH, True)
    lcd.ellipse(x, by - 26, 20, 26, BELLY, True)
    lcd.ellipse(x - 6, by - 36, 4, 3, FROG, True)
    lcd.ellipse(x + 8, by - 22, 5, 4, FROG, True)
    lcd.ellipse(x - 4, by - 12, 3, 3, FROG, True)
    if cracks > 0:
        lcd.line(x - 8, by - 34, x - 2, by - 28, MOUTH)
        lcd.line(x - 2, by - 28, x - 6, by - 22, MOUTH)
    if cracks > 1:
        lcd.line(x + 4, by - 40, x + 9, by - 32, MOUTH)
        lcd.line(x + 9, by - 32, x + 3, by - 27, MOUTH)
        lcd.line(x - 6, by - 22, x + 3, by - 27, MOUTH)


def speech(s, x, y):
    w = 8 * len(s) + 12
    x = max(2, min(238 - w, x))
    lcd.fill_rect(x + 2, y, w - 4, 20, ui.WHITE)
    lcd.fill_rect(x, y + 2, w, 16, ui.WHITE)
    lcd.poly(x + 10, y + 19, BUB_TRI, ui.WHITE, True)
    lcd.text(s, x + 6, y + 6, ui.INK)


hud_shown = None


def hud():
    global hud_shown
    st = stage()
    r = ui.right() if hasattr(ui, "right") else 236     # left of the battery, when one shows (firmware 0.3.28+)
    k = (frog["name"], st, frog["food"], frog["joy"], r)
    if k == hud_shown:
        return
    hud_shown = k
    lcd.fill_rect(0, 0, 240, TOP, ui.WHITE)
    lcd.text(frog["name"], 4, 4, ui.INK)
    s = STAGES[st][0]
    lcd.text(s, r - 8 * len(s), 4, ui.MUTED)
    for x, label, v, c in ((4, "food", frog["food"], ui.GREEN), (124, "joy", frog["joy"], JOY)):
        lcd.text(label, x, 20, ui.MUTED)
        bx = x + 8 * len(label) + 4
        w = 116 - (bx - x)
        lcd.fill_rect(bx, 20, w, 8, BAR_BG)
        lcd.fill_rect(bx, 20, w * v // 100, 8, ui.RED if v < 25 else c)
    lcd.hline(0, TOP - 1, 240, BAR_BG)


menu_shown = None


def menu(hint=None):
    global menu_shown
    k = (feeding, sel, hint)
    if k == menu_shown:
        return
    menu_shown = k
    lcd.fill_rect(0, BOT, 240, 240 - BOT, ui.WHITE)
    lcd.hline(0, BOT, 240, BAR_BG)
    if hint:
        lcd.center_text(hint, BOT + 14, ui.MUTED)
    elif feeding:
        for i, f in enumerate(FOODS):
            x = i * 60
            if i == sel:
                lcd.fill_rect(x + 2, BOT + 3, 56, 33, ui.GREEN)
            food_art(i, x + 30, BOT + 13, 0)
            lcd.text(f[0], x + 30 - 4 * len(f[0]), BOT + 25, ui.WHITE if i == sel else ui.INK)
    else:
        for i, m in enumerate(MENU):
            x = i * 80
            if i == sel:
                lcd.fill_rect(x + 3, BOT + 4, 74, 31, ui.GREEN)
            lcd.big_text(m, x + 40 - 8 * len(m), BOT + 12, ui.WHITE if i == sel else ui.INK)


def draw(t):
    pond(t)
    st = stage()
    E = size * STAGES[st][2] // 100
    lx, ly, mouth = look_x, look_y, 0
    hop = 0
    md = mood()
    e = time.ticks_diff(now, act_t)
    shut = time.ticks_diff(blink_t, now) > 0 and time.ticks_diff(blink_t, now) < 140
    fx = fy = None
    if act == "play":
        p = e % 600
        hop = 112 * p * (600 - p) // 360000             # three hops, 28 px high
        shut = p > 200 and p < 400
    elif act == "eat":
        T = snap_at()
        if e < T:                                       # the food comes in; his eyes follow it
            fx, fy = food_at(e)
            lx = 1 if fx > CX + size // 2 else (-1 if fx < CX - size // 2 else 0)
            ly = -1 if fy < BY - size * 2 - 12 else 0
        elif e < T + TONGUE_MS:
            lx, ly = 1, 0
        else:
            mouth = 1 if (e // 150) & 1 else 2
    elif act == "grow" or act == "hatch":
        shut = e < 1200
    sh = size - hop // 3
    lcd.ellipse(CX, BY + 1, sh, 4 + size // 10, PAD_SH, True)
    if act == "hatch" and e < 400:
        egg(CX, BY, 2, 0)
    else:
        breath = 1 if (t >> 9) & 1 else 0
        my = draw_frog(CX, BY - hop, size, E, lx, ly, shut, md, mouth, breath)
        T = snap_at()
        if act == "eat" and T <= e < T + TONGUE_MS:     # the tongue: snaps out, comes back with it
            tx, ty = food_at(T)
            d = e - T
            k = 1000 * d // 100 if d < 100 else 1000 * (TONGUE_MS - d) // (TONGUE_MS - 100)
            ex = CX + (tx - CX) * k // 1000
            ey = my + 2 + (ty - my - 2) * k // 1000
            for o in (-1, 0, 1):
                lcd.line(CX, my + 2 + o, ex, ey + o, TONGUE)
            lcd.ellipse(ex, ey, 3, 3, TONGUE, True)
            fx, fy = (tx, ty) if d < 100 else (ex, ey)
    if fx is not None:
        food_art(eat_i, fx, fy, t)
    for p in parts:
        left = time.ticks_diff(p[0], now)
        if left > 0:
            y = p[2] - (1400 - left) // 30
            if y < TOP + 8:
                continue
            if p[3]:
                lcd.hline(p[1] - 3, y, 7, SPARK)
                lcd.vline(p[1], y - 3, 7, SPARK)
            else:
                heart(p[1], y)
    if bubble and time.ticks_diff(bubble_t, now) > 0:
        speech(bubble, CX + size // 2, max(TOP + 4, BY - size * 2 - 46 - hop))


# ---- naming ----

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ<!"   # < erase, ! done (drawn as OK)


def name_screen(name):
    """A letter grid: joystick moves, A types, Y erases. Done on OK. Returns the name."""
    i = 0
    name = name or ""
    shown = None
    while True:
        for k in keys.pressed():
            if k == "left":
                i = (i - 1) % 28
            elif k == "right":
                i = (i + 1) % 28
            elif k == "up":
                i = (i - 7) % 28
            elif k == "down":
                i = (i + 7) % 28
            elif k == "Y":
                name = name[:-1]
            elif k in ("A", "press"):
                c = LETTERS[i]
                if c == "<":
                    name = name[:-1]
                elif c == "!":
                    if name:
                        return name
                elif len(name) < 10:
                    name = name + (c if not name else c.lower())   # small: at most 10 letters
        if (i, name) != shown:
            shown = (i, name)
            lcd.show_wait()
            lcd.fill(ui.WHITE)
            ui.band(lcd)
            lcd.center_text("Name your frog", 44, ui.INK, 2)
            lcd.fill_rect(30, 68, 180, 26, BAR_BG)
            lcd.center_text(name + "_" if len(name) < 10 else name, 73, ui.INK, 2)
            for j, c in enumerate(LETTERS):
                x, y = 15 + (j % 7) * 30, 104 + (j // 7) * 26
                on = j == i
                if on:
                    lcd.fill_rect(x + 1, y, 28, 24, ui.GREEN)
                c = "<" if c == "<" else ("OK" if c == "!" else c)
                lcd.big_text(c, x + 15 - 8 * len(c), y + 4, ui.WHITE if on else (ui.GREEN_D if c == "OK" else ui.INK))
            lcd.center_text("A  type   Y  erase", 222, ui.MUTED)
            lcd.show()
        time.sleep_ms(30)


# ---- the egg ----

def hatch():
    global now, act, act_t
    cracks, wob_t = 0, 0
    while True:
        now = time.ticks_ms()
        for k in keys.pressed():
            if k == "A":
                cracks += 1
                wob_t = time.ticks_add(now, 500)
        if cracks >= 3:
            break
        lcd.show_wait()
        hud_blank()
        pond(now)
        w = time.ticks_diff(wob_t, now)
        wob = (3 if (now >> 6) & 1 else -3) if w > 0 else 0
        lcd.ellipse(CX, BY + 1, 22, 5, PAD_SH, True)
        egg(CX, BY, cracks, wob)
        menu("A  hatch the egg")
        lcd.show_start()
        time.sleep_ms(40)
    act, act_t = "hatch", now
    burst(6, 1, CX, BY - 40)


def hud_blank():
    lcd.fill_rect(0, 0, 240, TOP, ui.WHITE)
    lcd.center_text("a frog egg", 13, ui.MUTED)


# ---- the game ----

def update():
    global sel, feeding, act, act_t, eat_i, ate, look_x, look_y, look_t, blink_t, size, dirty
    global menu_shown, hud_shown
    e = time.ticks_diff(now, act_t)
    busy = act is not None
    for k in keys.pressed():
        if busy:
            continue
        n = len(FOODS) if feeding else len(MENU)
        if k == "left":
            sel = (sel - 1) % n
        elif k == "right":
            sel = (sel + 1) % n
        elif k == "Y" and feeding:
            feeding, sel = False, 0
        elif k == "A":
            if feeding:
                if frog["food"] >= 95:
                    act, act_t = "full", now
                    say("I'm full!")
                else:
                    act, act_t, eat_i, ate = "eat", now, sel, False
                feeding, sel = False, 0
            elif sel == 0:
                feeding, sel = True, 0
            elif sel == 1:
                act, act_t = "play", now
                say("wheee!", 1800)
            else:
                lcd.show_wait()
                frog["name"] = name_screen(frog["name"])
                keep()
                menu_shown = hud_shown = None
    if not busy and not feeding:
        if keys.held("up"):
            look_x, look_y, look_t = 0, -1, time.ticks_add(now, 1500)
        elif keys.held("down"):
            look_x, look_y, look_t = 0, 1, time.ticks_add(now, 1500)
    if time.ticks_diff(now, look_t) > 0:                 # wander
        look_x, look_y = random.randint(-1, 1), random.randint(-1, 0)
        look_t = time.ticks_add(now, random.randint(1500, 4000))
    if time.ticks_diff(now, blink_t) > 0:
        blink_t = time.ticks_add(now, random.randint(2000, 5000))
    # actions finishing (e again: a key above may have just started one)
    e = time.ticks_diff(now, act_t)
    if act == "eat" and e >= snap_at() + TONGUE_MS and not ate:
        name, f, j = FOODS[eat_i]
        fav = eat_i == frog["fav"]
        add("food", f)
        add("joy", j + (10 if fav else 0))
        frog["xp"] += 5 if fav else 3
        ate = True
        burst(4 if fav else 2, 0, CX, BY - size * 2)
        if fav:
            say("my favorite!")
        else:
            say(("yum!", "tasty!", "gulp!", "mmm!")[random.randint(0, 3)], 1500)
        dirty = True
    if act == "eat" and e >= snap_at() + TONGUE_MS + 800:
        act = None
        keep()
    elif act == "play" and e >= 1800:
        add("joy", 12)
        add("food", -4)
        frog["xp"] += 4
        burst(3, 0, CX, BY - size * 2)
        act = None
        keep()
    elif act in ("full", "grow", "hatch") and e >= 1600:
        act = None
    # growing
    target = STAGES[stage()][1]
    if size != target and act in (None, "grow"):
        size += 1 if size < target else -1


def tick_needs(state):
    """Hunger and boredom while he's on; xp while he's well. Every second, cheap."""
    global dirty
    state[0] += 1
    s = state[0]
    if s % 15 == 0:
        add("food", -1)
        dirty = True
    if s % 20 == 0:
        add("joy", -2 if frog["food"] < 25 else -1)
    if s % 20 == 10 and frog["food"] >= 40 and frog["joy"] >= 40:
        frog["xp"] += 1
    if s % 9 == 0 and not bubble_live():
        if frog["food"] < 25:
            say("I'm hungry!")
        elif frog["joy"] < 25:
            say("play with me!")
        elif random.randint(0, 5) == 0:
            say("ribbit!", 1400)
    if s % 120 == 0 and dirty:            # flash wears: at most every 2 minutes
        keep()


def bubble_live():
    return time.ticks_diff(bubble_t, now) > 0


def run():
    global now, size, act, act_t
    now = time.ticks_ms()
    got = save.load("frog", None)
    if isinstance(got, dict) and got.get("name"):
        frog.update(got)
        size = STAGES[stage()][1]
    else:
        frog["fav"] = random.randint(0, len(FOODS) - 1)
        hatch()
        size = STAGES[0][1]
        t = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), t) < 1600:
            now = time.ticks_ms()
            keys.pressed()
            lcd.show_wait()
            hud_blank()
            draw(now)
            menu("say hi to your frog")
            lcd.show_start()
            time.sleep_ms(40)
        lcd.show_wait()
        frog["name"] = name_screen("")
        keep()
        act, act_t = None, now
    st = stage()
    sec = [0]
    last_sec = time.ticks_ms()
    while True:
        t = time.ticks_ms()
        now = t
        update()
        if stage() != st:
            st = stage()
            act, act_t = "grow", now
            say("I grew!", 2400)
            burst(8, 1, CX, BY - size * 2)
            keep()
        if time.ticks_diff(t, last_sec) >= 1000:
            last_sec = time.ticks_add(last_sec, 1000)
            tick_needs(sec)
        lcd.show_wait()
        draw(t)
        hud()
        menu()
        lcd.show_start()
        left = FRAME - time.ticks_diff(time.ticks_ms(), t)
        if left > 0:
            time.sleep_ms(left)
