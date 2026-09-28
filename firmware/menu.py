# The wedgie launcher. Lists the apps in apps.json; joystick up/down picks, A (or joystick press)
# opens. X inside an app comes back here. While it runs it owns USB stdin and answers one JSON
# line per request (the protocol in wedgie.dev/skill.md), so a host can identify the wedgie, launch
# apps, press keys and take screenshots without stopping anything. Ctrl-C drops to the REPL, so
# mpremote and wedgie.dev's raw-REPL tools keep working.
import sys, select, json, time, gc
import lcd as L
import wedgie as W

WHITE, INK = L.color(254, 254, 254), L.color(26, 27, 26)
MUTED, LINE = L.color(120, 123, 120), L.color(226, 226, 221)
GREEN, GREEN_D = L.color(34, 196, 82), L.color(22, 140, 52)
GREY_S, RED = L.color(169, 170, 171), L.color(227, 49, 44)
ROW, TOP, VISIBLE = 36, 58, 4

d = None
keys = None
apps = []
sel = 0
first = 0
running = None      # (app dict, module) while a timer app is on screen
dirty = True
_poll = select.poll()
_poll.register(sys.stdin, select.POLLIN)
_buf = ""


def draw():
    global first
    d.fill(WHITE)
    for y, c in ((10, GREEN), (19, GREY_S), (28, RED)):
        d.fill_rect(0, y, 240, 5, c)
    d.text(W.short(), 240 - 8 * 6 - 6, 42, MUTED)
    d.text("wedgie", 6, 42, INK)
    if not apps:
        d.center_text("no cartridges", 100, MUTED, 2)
        d.center_text("pick one at", 136, MUTED)
        d.center_text("wedgie.dev/connect", 152, GREEN_D)
    first = max(0, min(first, sel, len(apps) - VISIBLE))
    if sel >= first + VISIBLE:
        first = sel - VISIBLE + 1
    for row, i in enumerate(range(first, min(len(apps), first + VISIBLE))):
        y = TOP + row * (ROW + 4)
        name = apps[i].get("name", apps[i]["mod"])[:12]
        if i == sel:
            d.fill_rect(8, y + 1, 224, ROW - 2, GREEN)
            d.fill_rect(9, y, 222, ROW, GREEN)
            d.fill_rect(9, y + ROW - 4, 222, 4, GREEN_D)
            d.big_text(name, 22, y + 10, WHITE, 2)
        else:
            d.rect(9, y, 222, ROW, LINE)
            d.big_text(name, 22, y + 10, INK, 2)
    if len(apps) > VISIBLE:
        d.text("%d/%d" % (sel + 1, len(apps)), 196, 226, MUTED)
    d.text("A open", 8, 226, MUTED)
    d.show()


def launch(i):
    """Open app i. Apps start themselves at import (or have an entry to call); a second launch calls
    start() again. An app with an entry that never returns (demo.run) runs until it returns."""
    global running, dirty
    a = apps[i]
    mod = a["mod"]
    d.fill(WHITE)
    d.center_text("opening", 112, MUTED, 2)
    d.show()
    gc.collect()
    try:
        if mod in sys.modules:
            m = sys.modules[mod]
            if not a.get("entry") and hasattr(m, "start"):
                m.start()
        else:
            m = __import__(mod)
        W.send({"type": "launched", "app": mod})
        if a.get("entry"):
            getattr(m, a["entry"])()        # blocks until the app returns
            dirty = True
        else:
            running = (a, m)
    except KeyboardInterrupt:
        raise
    except Exception as e:
        sys.print_exception(e)
        d.fill(WHITE)
        d.center_text(mod, 90, INK, 2)
        d.center_text(("%s" % e)[:28], 124, RED)
        d.center_text("X back", 200, MUTED)
        d.show()
        _wait_x()
        dirty = True


def _wait_x():
    while True:
        serve()
        if "X" in keys.pressed():
            return
        time.sleep_ms(20)


def home():
    global running, dirty
    if running:
        a, m = running
        running = None
        if hasattr(m, "stop"):
            try:
                m.stop()
            except Exception as e:
                sys.print_exception(e)
        gc.collect()
        W.send({"type": "home"})
    dirty = True


def handle(line):
    global apps, sel
    try:
        m = json.loads(line)
    except ValueError:
        return
    if not isinstance(m, dict):
        return
    mid, t = m.get("id"), m.get("type")
    if t == "hello":
        W.send(W.hello(mid, running=running[0]["mod"] if running else None))
    elif t == "chip":
        W.send(dict(W.chip(), id=mid))
    elif t == "apps":                   # apps.json changed (a cartridge went on or came off): re-read it
        apps = W.apps()
        sel = min(sel, max(0, len(apps) - 1))
        if not running:
            draw()
        W.send({"id": mid, "type": "ok", "apps": [a["mod"] for a in apps]})
    elif t == "ping":
        W.send({"id": mid, "type": "pong"})
    elif t == "press":
        try:
            L.press(m.get("key"), m.get("ms", 80))
            W.send({"id": mid, "type": "ok"})
        except ValueError as e:
            W.send({"id": mid, "type": "error", "error": str(e)})
    elif t == "shot":
        W.shot(mid)
    elif t == "home":
        home()
        W.send({"id": mid, "type": "ok"})
    elif t == "launch":
        for i, a in enumerate(apps):
            if a["mod"] == m.get("app"):
                home()
                W.send({"id": mid, "type": "ok"})
                launch(i)
                return
        W.send({"id": mid, "type": "error", "error": "no such app"})
    elif t == "reboot":
        W.send({"id": mid, "type": "rebooting"})
        import machine
        time.sleep_ms(50)
        machine.reset()
    else:
        W.send({"id": mid, "type": "error", "error": "unknown type"})


def serve():
    """Read what the host sent; handle each full line. Never blocks."""
    global _buf
    for _ in range(4096):
        if not _poll.poll(0):
            return
        ch = sys.stdin.read(1)
        if not ch:
            return
        if ch == "\n":
            line, _buf = _buf, ""
            if line.strip().startswith("{"):
                handle(line)
        elif ch != "\r":
            _buf += ch
            if len(_buf) > 4096:
                _buf = ""


def step():
    global sel, dirty
    serve()
    for k in keys.pressed():
        if running:
            if k == "X":
                time.sleep_ms(150)          # let the app's own X handler finish first
                home()
            continue
        if k == "up" and apps:
            sel = (sel - 1) % len(apps); dirty = True
        elif k == "down" and apps:
            sel = (sel + 1) % len(apps); dirty = True
        elif k in ("A", "press") and apps:
            launch(sel)
    if dirty and not running:
        dirty = False
        draw()


def init():
    global d, keys, apps, dirty
    home()              # a host stopped us mid-app (Ctrl-C) and runs main.py again: close that app
    dirty = True
    d = L.LCD()
    keys = L.Keys()
    apps = W.apps()
    W.send(W.hello(None, type="ready"))


def run():
    """The board: own stdin until Ctrl-C."""
    init()
    while True:
        step()
        time.sleep_ms(20)


def start():
    """The emulator: a Timer tick keeps the page responsive."""
    from machine import Timer
    init()
    Timer(period=30, mode=Timer.PERIODIC, callback=lambda t: step())
