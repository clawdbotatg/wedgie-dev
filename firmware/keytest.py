# Buttons: checks every button, then turns it into a game.
# Part 1, the check: push each one in order (N S E W, IN, A B X Y, then the diagonals SE SW NE NW).
# The one to push is green; any key you hold goes dark, so a dead button is plain to see.
# Part 2, the game: random buttons against the clock, faster each hit. Three misses and it's over.
# The best score is the save "best".
import time
import random
from lcd import LCD, Keys
import ui
import save

lcd = LCD()
keys = Keys()
FRAME = 33                          # ms per frame: 30 fps

# Joystick (left) and A B X Y (right), as on the case. name -> (x, y, w, h, label)
CX, CY = 70, 152
BOX = {
    "up": (CX - 16, CY - 52, 32, 32, "N"),
    "down": (CX - 16, CY + 20, 32, 32, "S"),
    "left": (CX - 52, CY - 16, 32, 32, "W"),
    "right": (CX + 20, CY - 16, 32, 32, "E"),
    "press": (CX - 16, CY - 16, 32, 32, "IN"),
    "ne": (CX + 26, CY - 46, 20, 20, "NE"),
    "nw": (CX - 46, CY - 46, 20, 20, "NW"),
    "se": (CX + 26, CY + 26, 20, 20, "SE"),
    "sw": (CX - 46, CY + 26, 20, 20, "SW"),
}
for i, k in enumerate(("A", "B", "X", "Y")):
    BOX[k] = (172, 100 + i * 28, 56, 22, k)

DIAG = {"ne": ("up", "right"), "nw": ("up", "left"), "se": ("down", "right"), "sw": ("down", "left")}
SAY = {"up": "up", "down": "down", "left": "left", "right": "right", "press": "press it in",
       "A": "button A", "B": "button B", "X": "button X", "Y": "button Y",
       "ne": "up and right", "nw": "up and left", "se": "down and right", "sw": "down and left"}
ORDER = ("up", "down", "right", "left", "press", "A", "B", "X", "Y", "se", "sw", "ne", "nw")
REAL = ("up", "down", "left", "right", "press", "A", "B", "X", "Y")

held = {k: False for k in REAL}
done = {k: False for k in ORDER}
s = {"mode": "check", "i": 0, "target": "up", "head": "", "line": "", "wait": False,
     "wrong": None, "wrong_t": 0, "t0": 0, "limit": 3000, "score": 0, "lives": 3, "best": 0,
     "score_s": "", "n_s": ""}


def aim(k):
    s["target"] = k
    s["head"] = "Push " + BOX[k][4]
    s["line"] = SAY[k]
    s["wait"] = True                # the next one counts once every key is let go
    s["t0"] = time.ticks_ms()


def box(k, now):
    x, y, w, h, label = BOX[k]
    on = held[k] if k in held else held[DIAG[k][0]] and held[DIAG[k][1]]
    if k == s["wrong"] and time.ticks_diff(now, s["wrong_t"]) < 300:
        bg, fg, edge = ui.RED, ui.WHITE, ui.RED
    elif on:
        bg, fg, edge = ui.INK, ui.WHITE, ui.INK
    elif k == s["target"] and not s["wait"]:
        bg, fg, edge = ui.GREEN, ui.WHITE, ui.GREEN_D
    elif s["mode"] == "check" and done[k]:
        bg, fg, edge = ui.WHITE, ui.GREEN_D, ui.GREEN
    else:
        bg, fg, edge = ui.WHITE, ui.MUTED, ui.GREY
    lcd.fill_rect(x, y, w, h, bg)
    lcd.rect(x, y, w, h, edge)
    lcd.rect(x + 1, y + 1, w - 2, h - 2, edge)
    lcd.text(label, x + (w - 8 * len(label)) // 2, y + (h - 8) // 2, fg)


def draw(now):
    lcd.fill(ui.WHITE)
    ui.band(lcd)
    lcd.center_text(s["head"], 46, ui.INK, 2)
    lcd.center_text(s["line"], 68, ui.MUTED)
    if s["mode"] == "check":
        lcd.fill_rect(20, 84, 200 * s["i"] // len(ORDER), 4, ui.GREEN)
        lcd.center_text(s["n_s"], 222, ui.MUTED)
    else:
        left = s["limit"] - time.ticks_diff(now, s["t0"]) if not s["wait"] else s["limit"]
        lcd.fill_rect(20, 84, max(0, 200 * left // s["limit"]), 4, ui.GREEN if left > s["limit"] // 3 else ui.RED)
        lcd.text(s["score_s"], 8, 222, ui.INK)
        for i in range(3):
            lcd.fill_rect(196 + i * 12, 222, 8, 8, ui.RED if i < s["lives"] else ui.GREY)
    for k in BOX:
        box(k, now)


def hit():
    if s["mode"] == "check":
        done[s["target"]] = True
        s["i"] += 1
        s["n_s"] = "%d of %d work" % (s["i"], len(ORDER))
        if s["i"] < len(ORDER):
            aim(ORDER[s["i"]])
        else:
            s["mode"] = "checked"
    else:
        s["score"] += 1
        s["score_s"] = "score %d" % s["score"]
        s["limit"] = max(700, s["limit"] * 93 // 100)
        aim(next_one())


def miss(k):
    s["wrong"], s["wrong_t"] = k, time.ticks_ms()
    if s["mode"] == "game":
        s["lives"] -= 1
        if s["lives"] <= 0:
            s["mode"] = "over"
        else:
            aim(next_one())


def next_one():
    k = s["target"]
    while k == s["target"]:
        k = ORDER[random.getrandbits(4) % len(ORDER)]
    return k


def step():
    for k in REAL:
        held[k] = keys.held(k)
    got = keys.pressed()
    if s["wait"]:
        if any(held[k] for k in REAL):
            return
        s["wait"] = False
        s["t0"] = time.ticks_ms()
        return
    t = s["target"]
    if t in DIAG:
        if held[DIAG[t][0]] and held[DIAG[t][1]]:
            hit()
            return
        for k in got:
            if k not in DIAG[t]:
                miss(k)
                return
    else:
        for k in got:
            if k == t:
                hit()
            else:
                miss(k)
            return
    if s["mode"] == "game" and time.ticks_diff(time.ticks_ms(), s["t0"]) > s["limit"]:
        miss(t)


def wait_for(*want):
    keys.pressed()
    while True:
        for k in keys.pressed():
            if k in want:
                return k
        time.sleep_ms(20)


def check():
    for k in ORDER:
        done[k] = False
    s["mode"], s["i"] = "check", 0
    s["n_s"] = "0 of %d work" % len(ORDER)
    aim(ORDER[0])


def game():
    s["mode"], s["score"], s["lives"], s["limit"] = "game", 0, 3, 3000
    s["score_s"] = "score 0"
    aim(next_one())


def loop():
    while s["mode"] in ("check", "game"):
        t = time.ticks_ms()
        step()
        lcd.show_wait()
        draw(t)
        lcd.show_start()
        left = FRAME - time.ticks_diff(time.ticks_ms(), t)
        time.sleep_ms(left if left > 1 else 1)
    lcd.show_wait()


def run():
    s["best"] = save.load("best", 0)
    check()
    loop()
    ui.page(lcd, "All buttons work", [("%d of %d checked" % (len(ORDER), len(ORDER)), ui.GREEN_D),
            ("Now hit the green one before time runs out.", ui.MUTED)], "A  play")
    wait_for("A")
    while True:
        game()
        loop()
        if s["score"] > s["best"]:
            s["best"] = s["score"]
            save.store("best", s["best"])
        ui.page(lcd, "Game over", [("score %d" % s["score"], ui.INK), ("best %d" % s["best"], ui.MUTED)],
                "A  again   Y  check buttons")
        if wait_for("A", "Y") == "Y":
            check()
            loop()
            ui.page(lcd, "All buttons work", [("%d of %d checked" % (len(ORDER), len(ORDER)), ui.GREEN_D)], "A  play")
            wait_for("A")
