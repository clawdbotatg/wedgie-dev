# The cartridge slot: a wedgie runs one app, the active one (apps.json, put there by wedgie.dev).
# It boots straight into it and the app gets every button; there is no menu to go back to. To run
# something else, pick it at wedgie.dev/connect: the site copies it on and restarts the wedgie.
#
# While the app runs, the slot answers one JSON line per request on USB (the protocol in
# wedgie.dev/skill.md), so a host can identify the wedgie, mirror its screen and press its keys
# without stopping anything. An app that talks on USB itself ("usb": true in apps.json, the Wallet)
# gets stdin to itself (and asks for {"type": "open"} itself: let_in). The wedgie is sealed (main.py):
# Ctrl-C does nothing until the person lets a computer in (let_in); after that it stops the app and
# drops to the REPL, so mpremote and wedgie.dev's raw-REPL tools keep working.
#
# Hold X while plugging in to start without the app (the home screen; USB always works there).
#
# App forms: a Timer app starts itself at import (hello); an app with an `entry` is called and owns
# the CPU (demo.run). If an entry returns, the screen says so and A starts it again.
#
# READ THIS before touching how apps run: a soft Timer callback runs in MicroPython's scheduler, and
# one that takes about as long as its period (hello draws a full frame, ~38 ms, every 40 ms) is
# queued again before it ends, so the main loop never gets a turn: USB goes unanswered and the site
# hangs on "finding it". A Ctrl-C then lands inside the callback, where it's swallowed. So on the
# board every app's Timer is wrapped (_Timer): a tick that comes right on the heels of the last one
# (under GAP ms after it ended) before the USB code (serve) has had a turn is skipped, so serve runs
# in that gap. Only an app that overruns its period loses ticks; one that keeps up, or one busy while
# a long USB request runs (a screen shot), keeps them all. A Ctrl-C inside a tick stops the app and reaches the main loop. The emulator's Timers are JavaScript's and don't starve anything.
import sys, select, json, time, gc, struct
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
    """The wedgie's own home: the boot logo, and where to pick what it runs."""
    try:
        with open("logo.bin", "rb") as f:
            x, y, w, h = struct.unpack(">4H", f.read(8))
            bg = f.read(2)
            d.fill(bg[0] | bg[1] << 8)          # the framebuffer keeps pixels as the panel's bytes
            b = memoryview(L._BUF)
            for r in range(h):
                o = ((y + r) * 240 + x) * 2
                f.readinto(b[o:o + w * 2])
        top = y + h + 16
    except (OSError, ValueError):
        d.fill(WHITE)
        top = 110
    d.center_text("no software", top, INK, 2)
    d.center_text("pick what it runs at", top + 28, MUTED)
    d.center_text("wedgie.dev/connect", top + 44, GREEN_D)
    d.text(W.short(), 240 - 8 * 6 - 6, 6, MUTED)
    d.show()


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


# ---- app Timers that can't starve USB (see the top) -----------------------------------------------
GAP = 10            # ms: a tick this soon after the last one ended, with no serve() between, is skipped
_breath = True      # serve() has run since the last app tick
_last = 0           # when the last app tick ended
_timers = []        # every app Timer, so stop() can end them all
_kbd = False        # a Ctrl-C landed inside an app tick: the main loop raises it
_paused = False     # the "let this computer in?" screen is up: no app ticks draw over it


def _guard(cb, t):
    def tick(_):
        global _breath, _kbd, _last
        if _paused:
            return
        if not _breath and time.ticks_diff(time.ticks_ms(), _last) < GAP:
            return                      # back to back, and USB hasn't had a turn: give it this one
        _breath = False
        try:
            cb(t)
        except KeyboardInterrupt:
            _kbd = True
            t.deinit()
        finally:
            _last = time.ticks_ms()
    return tick


class _Timer:
    """machine.Timer for apps: the same calls, with every soft callback run through _guard."""
    def __init__(self, id=-1, **kw):
        self._t = _RealTimer(id)
        _timers.append(self)
        if kw:
            self.init(**kw)

    def init(self, **kw):
        if kw.get("callback") and not kw.get("hard"):
            kw["callback"] = _guard(kw["callback"], self)
        self._t.init(**kw)

    def deinit(self):
        self._t.deinit()


_RealTimer = None


def _wrap_timers():
    """Give apps _Timer: a stand-in machine module (the builtin one is read-only) in sys.modules."""
    global _RealTimer
    import machine
    if _RealTimer:
        return
    _RealTimer = machine.Timer
    for k in ("PERIODIC", "ONE_SHOT"):
        setattr(_Timer, k, getattr(machine.Timer, k))

    class _M:
        pass
    m = _M()
    for k in dir(machine):
        if not k.startswith("__"):
            setattr(m, k, getattr(machine, k))
    m.Timer = _Timer
    sys.modules["machine"] = m


def stop():
    """Stop the app (its Timers, and its stop() if it has one) and the background USB timer. Ctrl-C and
    the host's stop request both end up here, so nothing keeps drawing over the REPL."""
    global _serve_t
    if _serve_t:
        _serve_t.deinit()
        _serve_t = None
    for t in _timers:
        try:
            t.deinit()
        except Exception:
            pass
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
    elif t == "open":
        W.send({"id": mid, "type": "open" if let_in() else "refused"})
    elif t == "reboot":
        W.send({"id": mid, "type": "rebooting"})
        import machine
        time.sleep_ms(50)
        machine.reset()
    else:
        W.send({"id": mid, "type": "error", "error": "unknown type"})


ASK_MS = 60000      # no answer to "let this computer in?" in a minute is a no


def ask():
    """Let the computer in? Only a real press answers (Keys physical: a press sent over USB can't),
    A yes, Y no. Nothing comes off USB meanwhile, so the computer waits."""
    import os
    k = L.Keys(physical=True)
    k.pressed()                             # a key already down doesn't count
    wallet = "usbwallet.py" in os.listdir()
    d.fill(WHITE)
    for y, c in ((10, GREEN), (19, GREY_S), (28, RED)):
        d.fill_rect(0, y, 240, 5, c)
    d.center_text("LET THIS", 48, INK, 2)
    d.center_text("COMPUTER IN?", 72, INK, 2)
    y = 108
    for s in ("It can change anything on", "this wedgie" + (", and use its" if wallet else ","),
              ("wallet key, " if wallet else "") + "until you unplug it.", "", "Didn't ask for this? Y."):
        d.center_text(s, y, INK)
        y += 14
    d.fill_rect(0, 184, 240, 26, GREEN)
    d.center_text("A  let it in", 189, WHITE, 2)
    d.fill_rect(0, 214, 240, 26, RED)
    d.center_text("Y  no", 219, WHITE, 2)
    d.show()
    t0 = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), t0) < ASK_MS:
        for key in k.pressed():
            if key in ("A", "Y"):
                return key == "A"
        time.sleep_ms(20)
    return False


def let_in():
    """{"type": "open"}: may this computer have the REPL? Asks the person, unless they already said
    yes since power-up (or nothing is sealed: the emulator). Yes turns Ctrl-C on (wedgie.set_open)."""
    global _paused
    if not W.SEALED or W.is_open():
        W.set_open()
        return True
    _paused = True
    try:
        ok = ask()
    finally:
        _paused = False
    if ok:
        W.set_open()
        _band("computer in", [("unplug it to lock it", MUTED)])
    elif state == "empty":
        empty()
    elif state in ("ended", "error"):
        _ended()
    return ok


def serve(_=None):
    """Read what the host sent; handle each full line. Never blocks."""
    global _buf, _breath
    _breath = True
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
        elif ch == "\x03":              # a Ctrl-C while sealed is just a byte: start a clean line
            _buf = ""
        elif ch != "\r":
            _buf += ch
            if len(_buf) > 4096:
                _buf = ""


def _own_usb():
    return bool(app and app.get("usb"))


def step(board=True):
    global state, _serve_t, _breath
    if _kbd:
        raise KeyboardInterrupt
    _breath = True
    if not _own_usb():
        serve()
    if state == "entry":
        if board and not _own_usb():
            T = _RealTimer or __import__("machine").Timer     # not an app Timer: never skipped
            _serve_t = T(-1, period=60, mode=T.PERIODIC, callback=serve)
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
    if app and keys.pins["X"].value() == 0:    # X held while plugging in: start without the app (a way
        app = None                              # back in when an app won't let USB work)
        print("slot: X held, app skipped")
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
        _wrap_timers()
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
