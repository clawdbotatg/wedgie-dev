# The cartridge slot: a wedgie runs one app, the active one (apps.json, put there by wedgie.dev).
# It boots straight into it and the app gets every button; there is no menu to go back to. To run
# something else, pick it at wedgie.dev/connect: the site copies it on and restarts the wedgie.
#
# While the app runs, the slot answers one JSON line per request on USB (the protocol in
# wedgie.dev/skill.md), so a host can identify the wedgie, mirror its screen and press its keys
# without stopping anything. An app that talks on USB itself ("usb": true in apps.json, the Wallet)
# gets stdin to itself. Ctrl-C stops the app and drops to the REPL, so mpremote and wedgie.dev's
# raw-REPL tools keep working.
#
# App forms: a Timer app starts itself at import (hello); an app with an `entry` is called and owns
# the CPU (demo.run). If an entry returns, the screen says so and A starts it again.
import sys, select, json, time, gc
import lcd as L
import wedgie as W
import save

WHITE, INK = L.color(254, 254, 254), L.color(26, 27, 26)
MUTED = L.color(120, 123, 120)
GREEN, GREEN_D = L.color(34, 196, 82), L.color(22, 140, 52)
GREY_S, RED = L.color(169, 170, 171), L.color(227, 49, 44)

d = None
keys = None
app = None          # the active app's apps.json entry (None: nothing on it yet)
mod = None          # its module, once imported
state = "empty"     # empty | running | entry (an entry to call) | ended | error
_poll = None
_buf = ""
_serve_t = None     # the background Timer that answers USB while an entry app owns the CPU


def _band(title, lines):
    d.fill(WHITE)
    for y, c in ((10, GREEN), (19, GREY_S), (28, RED)):
        d.fill_rect(0, y, 240, 5, c)
    d.text("wedgie", 6, 42, INK)
    d.text(W.short(), 240 - 8 * 6 - 6, 42, MUTED)
    d.center_text(title, 96, INK, 2)
    y = 132
    for s, c in lines:
        d.center_text(s[:28], y, c)
        y += 16
    d.show()


def empty():
    _band("no software", [("pick what it runs at", MUTED), ("wedgie.dev/connect", GREEN_D)])


def _ended(why=None):
    name = app.get("name", app["mod"])
    if why:
        _band(name, [(why[:28], RED), ("", MUTED), ("A tries again", MUTED)])
    else:
        _band(name, [("ended", MUTED), ("", MUTED), ("A starts it again", MUTED)])


def open_app():
    """Import the active app (a Timer app is then running) or get its entry ready to call."""
    global mod, state
    save.game = app["mod"]
    gc.collect()
    try:
        if app["mod"] in sys.modules:
            mod = sys.modules[app["mod"]]
            if not app.get("entry") and hasattr(mod, "start"):
                mod.start()
        else:
            mod = __import__(app["mod"])
        state = "entry" if app.get("entry") else "running"
        if not _own_usb():
            W.send({"type": "launched", "app": app["mod"]})
    except KeyboardInterrupt:
        raise
    except Exception as e:
        sys.print_exception(e)
        state = "error"
        _ended("%s" % e)


def stop():
    """Stop the app (its Timer, if it has one) and the background USB timer. Ctrl-C and the host's
    stop request both end up here, so nothing keeps drawing over the REPL."""
    global _serve_t
    if _serve_t:
        _serve_t.deinit()
        _serve_t = None
    if mod and hasattr(mod, "stop"):
        try:
            mod.stop()
        except Exception as e:
            sys.print_exception(e)


def handle(line):
    try:
        m = json.loads(line)
    except ValueError:
        return
    if not isinstance(m, dict):
        return
    mid, t = m.get("id"), m.get("type")
    if t == "hello":
        W.send(W.hello(mid, running=app["mod"] if app and state in ("running", "entry") else None))
    elif t == "chip":
        W.send(dict(W.chip(), id=mid))
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
    elif t == "ls":                     # every file under path: [[path, bytes], ...]; dirs end in /
        W.send({"id": mid, "type": "ls", "files": W.ls(m.get("path") or "/"), "free": W.free()})
    elif t == "get":
        try:
            W.get(m.get("path"), mid)
        except OSError as e:
            W.send({"id": mid, "type": "error", "error": "can't read it: %s" % e})
    elif t == "rm":
        try:
            W.rm(m.get("path"))
            W.send({"id": mid, "type": "ok", "free": W.free()})
        except OSError as e:
            W.send({"id": mid, "type": "error", "error": "can't delete it: %s" % e})
    elif t in ("stop", "home"):         # home: what hosts for 0.1.x send before taking the REPL
        stop()
        W.send({"id": mid, "type": "ok"})
    elif t == "reboot":
        W.send({"id": mid, "type": "rebooting"})
        import machine
        time.sleep_ms(50)
        machine.reset()
    else:
        W.send({"id": mid, "type": "error", "error": "unknown type"})


def serve(_=None):
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


def _own_usb():
    return bool(app and app.get("usb"))


def step(board=True):
    global state, _serve_t
    if not _own_usb():
        serve()
    if state == "entry":
        if board and not _own_usb():
            from machine import Timer
            _serve_t = Timer(period=60, mode=Timer.PERIODIC, callback=serve)
        try:
            getattr(mod, app["entry"])()     # owns the CPU until it returns
            state = "ended"
            _ended()
        except KeyboardInterrupt:
            raise
        except Exception as e:
            sys.print_exception(e)
            state = "error"
            _ended("%s" % e)
        if _serve_t:
            _serve_t.deinit()
            _serve_t = None
    elif state in ("ended", "error"):
        if "A" in keys.pressed():
            open_app()
    else:
        keys.pressed()                  # its own copy of every host press: don't let it pile up


def init():
    global d, keys, app, state, _poll
    d = L.LCD()
    keys = L.Keys()
    _poll = select.poll()
    _poll.register(sys.stdin, select.POLLIN)
    app = W.active()
    if not _own_usb():
        W.send(W.hello(None, type="ready", running=app and app["mod"]))
    if app:
        open_app()
    else:
        state = "empty"
        empty()


def run():
    """The board: run the active app, answer USB, until Ctrl-C."""
    try:
        init()
        while True:
            step()
            time.sleep_ms(20)
    except KeyboardInterrupt:
        stop()
        raise


def start():
    """The virtual wedgie: a Timer tick keeps the page responsive."""
    from machine import Timer
    init()
    Timer(period=30, mode=Timer.PERIODIC, callback=lambda t: step(False))
