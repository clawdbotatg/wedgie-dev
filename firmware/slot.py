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

import ui
from ui import WHITE, INK, MUTED, GREEN_D, RED

d = None
keys = None
app = None          # the active app's apps.json entry (None: nothing on it yet)
mod = None          # its module, once imported
state = "empty"     # empty | running | entry (an entry to call) | ended | error
_poll = None
_rx = 0             # ticks_ms when the line being handled arrived
_serve_t = None     # the background Timer that answers USB while an entry app owns the CPU


def _band(title, lines, hint=""):
    ui.page(d, title, lines, hint, show=False)
    d.text(W.short(), 240 - 8 * 6 - 6, 42, MUTED)
    d.show()


def empty():
    """The wedgie's own home: where to get software (wedgie.dev, big, over the logo), then "No software"."""
    import loader
    y = loader.logo(d)
    d.center_text("wedgie.dev", 30, INK, 3)
    d.center_text("No software", y + 18 if y else 110, MUTED, 2)
    d.text(W.short(), ui.right() - 8 * 6, 6, MUTED)
    d.show()


def _ended(why=None):
    name = app.get("name", app["mod"])
    if why:
        _band(name, [(why[:56], RED)], "{g} try again")
    else:
        _band(name, [("ended", MUTED)], "{g} start again")


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
_kbd = False        # a Ctrl-C landed inside an app tick (or one was let in: hatch.ctrl_c): the main loop raises it
_started = 0        # ticks_ms when init ran
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
    if "power" in sys.modules:
        sys.modules["power"].stop()
    if mod and hasattr(mod, "stop"):
        try:
            mod.stop()
        except Exception as e:
            sys.print_exception(e)


def handle(line):
    """One host request: a JSON line (bytes or str) or the dict from one (the Wallet passes that, so no
    copy of the line stays alive under a job). Whatever goes wrong in it (out of memory too) is answered
    as an error to that request and logged; it never stops the app."""
    global _rx
    _rx = time.ticks_ms()               # a question's time is counted from here (wedgie.asked_ms)
    W.asked_ms = None
    if isinstance(line, dict):
        m = line
    else:
        try:
            m = json.loads(line)
        except Exception:               # bad JSON, or out of memory / too deep decoding it
            gc.collect()
            return
    line = None
    if not isinstance(m, dict):
        return
    try:
        _handle(m)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception as e:
        failed(m.get("id"), e)


failed = W.failed


def _handle(m):
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
    elif t in ("get", "rm") and not _saves_only(m.get("path")):
        W.send({"id": mid, "type": "error", "error": "locked: only /saves/ without a yes on its screen (open)"})
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
    elif t == "open":                   # full: the escape hatch (any computer, any code: let_in)
        ok = let_in(str(m.get("for") or "")[:60], bool(m.get("full")))
        W.send({"id": mid, "type": "open" if ok else "refused", "asked_ms": W.asked_ms})
        if not ok:
            _restart()
    elif t == "job":                    # a checked install (job.py): signed files only, no REPL
        try:
            if _asking(lambda: _job(mid, m)):
                return                  # a yes: it restarts into install mode (_to_job)
        except Exception as e:
            failed(mid, e)
        _restart()                      # a no: start again
    elif t == "sums" and not m.get("names"):    # only which files are there: no job.py needed
        W.send({"id": mid, "type": "sums", "sums": _there(m.get("exists")), "apps": W.apps()})
    elif t == "sums":                   # wedgie.sums: no job.py to compile on the app's heap
        W.send({"id": mid, "type": "sums", "sums": W.sums(m.get("names"), m.get("exists")), "apps": W.apps()})
    elif t == "reboot":
        W.send({"id": mid, "type": "rebooting"})
        import machine
        time.sleep_ms(50)
        machine.reset()
    else:
        W.send({"id": mid, "type": "error", "error": "unknown type"})


def _saves_only(p):
    """get / rm with no yes on the screen: saves only. Anything else could read a key or delete main.py,
    the file that locks it (the next boot would be an open REPL). Once open (let_in), anything."""
    if not W.SEALED or W.is_open():
        return True
    p = str(p or "")
    return p.startswith("/saves/") and ".." not in p.split("/")


ASK_MS = 60000      # no answer to "let this computer in?" in a minute is a no


def ask(job="", checked=False, v=""):
    """Let the computer do `job` (what it says it wants, e.g. "Install Safe signer", "Update firmware to
    0.3.30")? ui.ask: only a real press answers, green yes, red no. Nothing comes off USB meanwhile, so the
    computer waits. Only for a checked job (job.py: only files signed by wedgie.dev go on, so the green
    check): anything that gives the computer the REPL asks the red question (hatch.ask, let_in), never
    this calm one with the computer's own title on it. Few words, big (Austin, 2026-10-09): the job,
    the version it puts on when it's an update (v: the one job.py holds the signed list to), the check."""
    if not checked:
        return False
    W.asked_ms = None
    head = (job or "Install").partition(" to ")[0]     # wedgie.dev titles an update just "Update firmware"
    if head.startswith("Update"):
        ok = ui.ask(d, head, ms=ASK_MS, big=str(v or "?")[:12])
    elif head.startswith("Install "):                  # "Install" over the app's name, big
        ok = ui.ask(d, "Install", ms=ASK_MS, big=head[8:])
    else:
        ok = ui.ask(d, head + "?", ms=ASK_MS)
    W.asked_ms = time.ticks_diff(ui.drawn, _rx)
    return ok


def _job(mid, m):
    """A checked install: ask (from code already loaded: the question is up at once), and on a yes save
    the job and restart into install mode (wedgie.save_job, main.py, job.resume): job.py then runs on a
    clean heap with no app in it, so every install has the same memory however fragmented the app left
    it. True after a yes. Older hosts (0.3.0-0.3.9) send the signed list with the job: job.py checks it
    there too."""
    title = str(m.get("job") or "Update")[:60]
    v = m.get("version")
    if not v and "release" in m:
        v = str(m["release"]).split("\n")[1][8:]
    if not ask(title, True, v):
        W.send({"id": mid, "type": "refused", "asked_ms": W.asked_ms})
        return False
    if not W.SEALED:                    # the emulator: its flash is new at every restart, so no install
        import job                      # mode there; the job runs in place (its heap is big anyway)
        job.run(mid, m, lambda *a: True, job.progress)
        return False
    W.save_job({"id": mid, "m": m, "asked_ms": W.asked_ms})
    try:                                # the yes shows at once: the install's screen (the restart keeps it:
        ui.progress(W.doing(title).replace("...", ""), "starting", bar=False)    # splash.show(keep)). No bar
    except Exception as e:              # here: its 9 KB failed on the Wallet's heap; install mode draws it
        print("slot: progress:", e)
    _to_job()
    return True


def _to_job():
    """Restart into install mode, keeping USB (a soft reset: the host stays connected and waits for the
    job's go). From the main loop that's now. An entry app (Demo) owns the main loop and this runs in
    its USB timer, where a soft reset is swallowed: the app's next screen or key read does it
    (lcd._on_show, lcd._on_keys: an app on a still screen only reads keys), and a hard reset a second
    later if it does neither (_cold: the screen flashes black)."""
    import machine
    W.restarting = True
    stop()
    if state == "entry" and not _own_usb():
        def now(*_):
            machine.soft_reset()
        L._on_show = L._on_keys = now
        _RealTimer(-1).init(period=1500, mode=_RealTimer.ONE_SHOT, callback=_cold)
        return
    machine.soft_reset()


def _cold(_=None):
    """The hard reset when an entry app never draws again (Bunker waiting on its title page). It resets
    the panel too (its reset pin floats low), so boot.py must set it up again, not keep it: kept, the
    whole install ran on a black screen (0.3.24, Austin 2026-10-04). Watchdog scratch1 says so."""
    import machine
    try:
        machine.mem32[(0x400D8000 if "RP2350" in sys.implementation._machine else 0x40058000) + 0x10] = 0xC01D
    except Exception:
        pass
    machine.reset()


def _there(names):
    """{name: 1 or None}: which of names are on it."""
    import os
    out = {}
    for n in names or ():
        try:
            os.stat(n)
            out[n] = 1
        except OSError:
            out[n] = None
    return out


def let_in(job="", full=False):
    """{"type": "open"}: may this computer have the REPL? Asks the person, unless they already said
    yes for this job (or nothing is sealed: the emulator). Yes turns Ctrl-C on (wedgie.set_open) until
    main.py starts again. False only after a no: the caller restarts it (_restart).
    Always the red question (hatch.py), whatever the computer calls its job: a yes gives it everything, so
    it never looks like a normal install (Austin, 2026-10-08: a site said "Install Safe signer?" over a
    calm screen and got full access). full ({"type": "open", "full": true}, or a Ctrl-C) also stops the app."""
    if not W.SEALED or W.is_open():
        W.set_open()
        return True
    global _paused
    ok = _asking(lambda: __import__("hatch").ask())
    if ok:
        W.set_open()
        if full:
            _drop()
        else:
            _paused = True              # the app draws nothing until the computer stops it: Frog drew its
            L._on_show = _hold          # picture back over this screen (Austin, 2026-10-09). Ticks: _guard;
                                        # an entry app's own loop: its next show() waits in _hold
            ui.progress(W.doing(job).replace("...", ""), "the computer is starting", False)   # the app is still loaded: no bar's RAM (the computer fills it)
    return ok


def _drop():
    """After a full-control yes: stop the app as Ctrl-C would, so nothing draws over the full-access
    screen. The main loop raises it (_kbd); an entry app owns the main loop, so its next screen does."""
    global _kbd
    _kbd = True
    if state == "entry":
        L._on_show = L._on_keys = _interrupt


def _asking(fn):
    """Run a question (and a job) with the app's ticks paused."""
    global _paused
    _paused = True
    try:
        return fn()
    finally:
        _paused = False


def _restart():
    """After a no, or a job that ended before its commit: start from the top. The question goes straight
    over the app's screen and nothing keeps that screen, so the question is up at once (0.3.5 saved the
    115 KB screen to flash first: seconds before every question). A soft reset keeps USB (boot.py,
    0.1.3+) and main.py lets it through (W.restarting). An entry app owns the main loop and this then
    runs in its USB timer, where a soft reset's SystemExit is swallowed: the app's next screen or key
    read does it, and a hard reset if it does neither (its port drops and comes back; hosts find a
    wedgie by its ID)."""
    import machine
    time.sleep_ms(100)                  # the answer goes out first
    W.restarting = True
    if state == "entry" and not _own_usb():    # (the Wallet reads USB in its own loop: a soft reset works)
        def now(*_):                    # the app's next screen or key read, as _to_job
            machine.soft_reset()
        L._on_show = L._on_keys = now
        _RealTimer(-1).init(period=1500, mode=_RealTimer.ONE_SHOT, callback=lambda t: machine.reset())
        return
    machine.soft_reset()


def serve(_=None):
    """Read what the host sent; handle each full line. Never blocks. A line comes in through the one
    line reader (wedgie.lines: one buffer, made at boot); a host request that fails answers an error
    and the app keeps running (it never reaches main.py's "wedgie broke")."""
    global _breath, _kbd
    _breath = True
    R = W.lines()
    for _ in range(8):
        line = R.pump(_poll)
        if R.intr:                      # a Ctrl-C while sealed: the escape hatch's red question (hatch.py)
            R.intr = False
            if W.SEALED and not W.is_open():
                try:
                    import hatch
                    if hatch.ctrl_c():  # a yes: let_in stopped the app (_drop)
                        return
                except Exception as e:  # out of memory: nobody gets in, the app goes on
                    sys.print_exception(e)
        if line is None:
            return
        if line and line.strip().startswith(b"{"):
            try:
                m = json.loads(line)
            except Exception:           # bad JSON, or out of memory / too deep decoding it: drop it, go on
                line = None
                gc.collect()
                continue
            line = None                 # a job runs inside handle: don't keep its line alive under it
            handle(m)


def _hold():
    """lcd._on_show after a yes to a computer's job: the app's push waits here, so the boot screen stays
    clean, until the computer's Ctrl-C (a KeyboardInterrupt in the sleep). At most 3 s: a computer that
    never takes over gets its app back (and a show() from a Timer can't hang here for good)."""
    t = time.ticks_ms()
    while _paused and time.ticks_diff(time.ticks_ms(), t) < 3000:
        time.sleep_ms(20)


def _interrupt():
    """lcd._on_show after a yes to a Ctrl-C while an entry app runs: stop it as Ctrl-C would."""
    L._on_show = L._on_keys = None
    raise KeyboardInterrupt


def _own_usb():
    """The app reads USB itself (the Wallet), once it's running: one that failed to start doesn't, so
    the slot answers (or nothing would, and only holding X at power-up would get a computer back in)."""
    return bool(app and app.get("usb") and state in ("running", "entry"))


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
    global d, keys, app, state, _poll, _started, _paused
    _started = time.ticks_ms()
    _paused = False                     # main.py again on the same heap (LEAVE): a yes's hold is over
    d = L.LCD()
    keys = L.Keys()
    _poll = select.poll()
    _poll.register(sys.stdin, select.POLLIN)
    if _RealTimer:                      # a board: a battery shows its charge, sleeps when idle (power.py)
        try:
            import power
            power.start(d, _RealTimer)
        except Exception as e:
            sys.print_exception(e)
    app = W.active()
    if app and keys.pins["X"].value() == 0:    # X held while plugging in: start without the app (a way
        app = None                              # back in when an app won't let USB work)
        print("slot: X held, app skipped")
    if not (app and app.get("usb")):      # the Wallet says its own ready
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
        if L._on_show is _hold:         # the computer's Ctrl-C: its own screens push again
            L._on_show = None
        stop()
        raise


def start():
    """The virtual wedgie: a Timer tick keeps the page responsive."""
    from machine import Timer
    init()
    Timer(period=30, mode=Timer.PERIODIC, callback=lambda t: step(False))
