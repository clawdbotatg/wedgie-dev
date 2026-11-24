# wedgie firmware: boot straight into the one app it has (slot.py). The slot owns the screen and USB.
# Sealed (0.2.5+): Ctrl-C goes off on the first line (MicroPython turns it on for every file it starts),
# and this file never ends by itself, so a computer can't stop the app and land in the REPL, where it
# could run anything and make the secure chip sign anything. A computer gets the REPL only after the
# person presses A on the wedgie ({"type": "open"}, slot.let_in); then Ctrl-C works as it always did
# (mpremote, wedgie.dev's raw-REPL tools) until this file runs again, which locks it. The lock is in wedgie.py.
# A Ctrl-C while locked still arrives, as a plain byte: the slot asks the escape hatch's red "FULL CONTROL?"
# question about it (hatch.py), and a real A stops the app as Ctrl-C would. Never let anything else in.
import micropython
micropython.kbd_intr(-1)
import sys, time


_RECOVERY_LIMIT = 128


def _recovery_reply(line, reason):
    # The recovery endpoint has a fixed schema and imports no codec from a
    # possibly mixed filesystem. Both ordinary JSON field orders are accepted.
    fields = {}
    mid = ""
    error = '{"type":"error","error":"read-only paired recovery"'
    if len(line) <= _RECOVERY_LIMIT:
        line = line.strip()
        if line.startswith(b"{") and line.endswith(b"}"):
            for item in line[1:-1].split(b","):
                field, sep, value = item.partition(b":")
                field = field.strip()
                if not sep or field not in (b'"id"', b'"type"') or field in fields:
                    return error + "}"
                fields[field] = value.strip()
            if b'"id"' in fields:
                identifier = fields[b'"id"']
                if (not 1 <= len(identifier) <= 8 or not all(48 <= c <= 57 for c in identifier)
                        or len(identifier) > 1 and identifier.startswith(b"0")):
                    return error + "}"
                mid = ',"id": ' + identifier.decode()
            if fields.get(b'"type"') in (b'"hello"', b'"paired_recovery_status"'):
                if reason not in ("paired_replay_incomplete", "legacy_job_pending"):
                    reason = "integrity_check_failed"
                return ('{"type":"paired_recovery_status","sealed":true,"open":false,"writes":false,'
                        '"reason":"' + reason + '"' + mid + '}')
    return error + mid + "}"


def _recovery_loop(reason):
    rest = False
    while True:
        line = sys.stdin.buffer.readline(_RECOVERY_LIMIT + 1)
        if not line:
            time.sleep_ms(20)
        elif not line.endswith(b"\n"):
            rest = True
        else:
            print(_recovery_reply(b"" if rest else line, reason))
            rest = False


if globals().get("_paired_recovery"):
    # Never fall through to the regular app, installer, full-control prompt,
    # or REPL, even if this diagnostic stream fails.
    while True:
        try:
            _recovery_loop(_paired_recovery)
        except BaseException:
            time.sleep_ms(100)


def stuck(e):
    """The slot broke. A asks the escape hatch's red FULL CONTROL question (a real press: ui.ask reads the
    pins), and its A lets the computer in to fix it; B, or a no, tries again. True: let it in."""
    try:
        with open("error.log", "w") as f:
            sys.print_exception(e, f)
    except Exception:
        pass
    try:
        sys.modules["wedgie"].log("broke", e=e)
    except Exception:
        pass
    sys.print_exception(e)
    drew = False        # not drawn: the screen may still show the app's page (Safe's "sign"), so green means nothing
    try:
        import lcd, ui
        d = lcd.LCD()
        ui.page(d, "wedgie broke", [("%s" % e, ui.RED), ("", ui.MUTED), ("{g} full control", ui.INK), ("{k} try again", ui.INK)])
        drew = True
    except Exception:
        pass
    from machine import Pin
    try:                # green and red: another screen (oled.py) has them on other pins
        import lcd
        ka, kb = lcd.KEYS["A"], lcd.KEYS.get("B", lcd.KEYS["Y"])
    except Exception:
        ka, kb = 15, 17
    a, b = Pin(ka, Pin.IN, Pin.PULL_UP), Pin(kb, Pin.IN, Pin.PULL_UP)
    while a.value() == 0 or b.value() == 0:
        time.sleep_ms(20)
    while True:
        if a.value() == 0 and drew:
            try:            # the escape hatch's red question (hatch.py). If it can't draw, no: BOOTSEL is the way back
                if not ui.ask(d, "FULL CONTROL?", ["This computer could run any code and make the chip sign anything: send your money.",
                                                   "Didn't ask? Press {r}"], yes="hold 3 seconds", no="no", scary=True, hold=3000):
                    return False
            except Exception:
                return False
            try:
                import wedgie
                wedgie.set_open()
            except Exception:
                micropython.kbd_intr(3)
            try:            # what a yes means stays on the screen: the REPL itself draws nothing
                import hatch
                hatch.shown(d)
            except Exception:
                try:
                    ui.page(d, "COMPUTER HAS FULL ACCESS", [("it can fix this now", ui.INK), ("didn't want that? unplug it now", ui.RED)])
                except Exception:
                    pass
            return True
        if b.value() == 0:
            return False
        time.sleep_ms(20)


try:
    import lcd          # first: grabs the framebuffer while the heap is fresh (RP2040 boards need this)
    import wedgie
    wedgie.SEALED = True
    wedgie._open = False                # a yes was for one job; this is a fresh start
    wedgie.flag(wedgie.WAS_OPEN, False) # locked again: boot.py needn't hard reset (wedgie.set_open)
    _j = wedgie.take_job()
    if _j:                              # install mode: a yes to a job, then this restart (slot._job).
        wedgie.lines()                  # Nothing else loads: the same clean heap for every install
        import job
        job.resume(_j)                  # ends in a restart, whatever happens
    del _j
    if globals().get("_drive_again"):   # boot.py: an install's last restart. Add the WEDGIE drive back (wedgiedrive.py)
        try:
            import wedgiedrive
            wedgiedrive.start()
        except Exception as e:
            print("drive:", e)
    import loader
    _a = wedgie.active()
    wedgie.lines()                      # the USB line buffer (6 KB), while the heap is whole
    loader.load(_a["mod"] if _a else "slot")    # its files load one by one under the boot logo's bar
except SystemExit as e:                 # install mode's restart (job.resume: machine.soft_reset is a SystemExit).
    if getattr(sys.modules.get("wedgie"), "restarting", False):   # Caught here, the reset never happened and
        raise                                                      # the old core kept running into the slot
    sys.print_exception(e)
except BaseException as e:
    sys.print_exception(e)
while True:
    try:
        import slot
        slot.run()
        e = RuntimeError("the slot ended")
    except KeyboardInterrupt:       # only once the person let the computer in: any other (an app raising it)
        if "wedgie" in sys.modules and sys.modules["wedgie"].is_open():   # is a crash, never the REPL (audit 10-18)
            break
        e = RuntimeError("an app stopped itself")
        sys.modules.pop("slot", None)
    except SystemExit:              # machine.soft_reset() is a SystemExit: let the one a job asked for through
        if getattr(sys.modules.get("wedgie"), "restarting", False):   # (0.3.0 caught it: "wedgie broke"
            raise                                                      # after every checked install)
        e = RuntimeError("an app called sys.exit")
        sys.modules.pop("slot", None)
    except BaseException as x:
        e = x
        sys.modules.pop("slot", None)
    if "wedgie" in sys.modules and sys.modules["wedgie"].is_open():
        sys.print_exception(e)
        break
    if stuck(e):
        break
