# hello: the smallest complete sketch for the Pico wallet. A box bounces, every key press shows up.
# Emulator: tools/emu run hello       Pico: ./tools/pico cp emu/sketches/hello.py :hello.py exec 'import hello'
# Pattern: draw into the framebuffer, lcd.show() pushes it (about 38 ms), a Timer ticks so the REPL
# stays free. Every button is the app's: A bounces the box back.
import time
from machine import Timer
from lcd import LCD, Keys, color, BLACK, WHITE, GREEN, RED, YELLOW, GREY, DARK

lcd = LCD()
keys = Keys()
timer = None
x, y, dx, dy = 100, 100, 3, 2
last = "-"
t0 = time.ticks_ms()


def draw():
    lcd.fill(BLACK)
    lcd.fill_rect(0, 0, 240, 20, DARK)
    lcd.text("hello pico", 4, 6, YELLOW)
    lcd.text("%ds" % (time.ticks_diff(time.ticks_ms(), t0) // 1000), 200, 6, GREY)
    lcd.fill_rect(x, y, 40, 40, GREEN)
    lcd.rect(x, y, 40, 40, WHITE)
    lcd.center_text("key: " + last, 200, WHITE, 2)
    lcd.center_text("A bounces", 228, GREY)
    lcd.show()


def tick(_):
    global x, y, dx, dy, last
    for k in keys.pressed():           # A B X Y up down left right press
        last = k
        if k == "A":
            dx, dy = -dx, -dy
    x += dx
    y += dy
    if x < 0 or x > 200:
        dx = -dx
    if y < 24 or y > 156:
        dy = -dy
    draw()


def start():
    global timer
    draw()
    timer = Timer(period=40, mode=Timer.PERIODIC, callback=tick)
    print("hello running")


def stop():
    if timer:
        timer.deinit()
    lcd.fill(BLACK)
    lcd.center_text("stopped", 112, RED, 2)
    lcd.show()


start()
