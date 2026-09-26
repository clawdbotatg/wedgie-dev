# Button test for a bare Pico + Waveshare Pico-LCD-1.3. No chip, no WiFi.
# Draws the joystick (left) and the A/B/X/Y column (right). A key turns green while
# held and its press count goes up. Events also print on the serial REPL.
# Runs from a 30 ms Timer so the REPL stays free. Stop with keytest.stop().
from machine import Timer
from lcd import LCD, Keys, KEYS, BLACK, WHITE, GREEN, GREY, DARK, YELLOW

lcd = LCD()
keys = Keys()
count = {k: 0 for k in KEYS}
last = {k: 1 for k in KEYS}
timer = None

# name -> (x, y, w, h)
S = 34
JX, JY = 20, 96
BOX = {
    "up": (JX + S + 4, JY - S - 4, S, S),
    "down": (JX + S + 4, JY + S + 4, S, S),
    "left": (JX, JY, S, S),
    "right": (JX + 2 * (S + 4), JY, S, S),
    "press": (JX + S + 4, JY, S, S),
}
for i, k in enumerate(("A", "B", "X", "Y")):
    BOX[k] = (170, 14 + i * 56, 52, 46)

LABEL = {"up": "UP", "down": "DN", "left": "LT", "right": "RT", "press": "IN"}


def draw():
    lcd.fill(BLACK)
    lcd.text("KEY TEST", 4, 4, YELLOW)
    lcd.text("GP" , 4, 228, GREY)
    for k, (x, y, w, h) in BOX.items():
        down = keys.pins[k].value() == 0
        lcd.fill_rect(x, y, w, h, GREEN if down else DARK)
        lcd.rect(x, y, w, h, WHITE if down else GREY)
        name = LABEL.get(k, k)
        lcd.text(name, x + (w - 8 * len(name)) // 2, y + h // 2 - 10, BLACK if down else WHITE)
        n = str(count[k])
        lcd.text(n, x + (w - 8 * len(n)) // 2, y + h // 2 + 2, BLACK if down else GREY)
    seen = sum(1 for k in KEYS if count[k])
    lcd.text("%d/%d keys seen" % (seen, len(KEYS)), 4, 216, WHITE if seen < len(KEYS) else GREEN)
    lcd.show()


def tick(_):
    changed = False
    for k, p in keys.pins.items():
        v = p.value()
        if v != last[k]:
            changed = True
            if v == 0:
                count[k] += 1
                print("down", k, "GP%d" % KEYS[k])
            else:
                print("up  ", k)
            last[k] = v
    if changed:
        draw()


def start():
    global timer
    draw()
    timer = Timer(period=30, mode=Timer.PERIODIC, callback=tick)
    print("keytest running; press keys. keytest.stop() to stop.")


def stop():
    if timer:
        timer.deinit()


start()
