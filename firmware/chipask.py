# May the app on it use the secure chip (its keys, its signing, its storage)? The chip drivers ask as they
# open the chip (trustm.py, atecc.py -> wedgie.chip_gate -> slot.chip_ok); the answer holds until the app
# starts again. Loaded only for that. The firmware's own uses (rand, the chip check, TLS) never ask (wedgie.own).
#   Files as signed (no "modified" mark): the signed app line says (its "chipuse": tools/release.mjs reads
#       it from the app's code, so does the store: a red cartridge). An app put on before 0.3.79 has no word
#       either way: yes for the three that used the chip then.
#   A computer had full control (the red border): nothing on it is known, so the person is asked.
# Not a wall: MicroPython can't keep code off the I2C pins. It stops an app that said it doesn't use the chip.
import os
import wedgie as W

OLD = ("safe", "secret", "welcome")


def ok(app):
    if not W.SEALED:
        return True
    try:
        os.stat(W.MARK)
    except OSError:
        c = app.get("chipuse")
        yes = app.get("mod") in OLD if c is None else bool(c)
        if not yes:
            W.log("chip refused", app.get("mod"))
        return yes
    import slot, ui
    return slot._asking(lambda: ui.ask(slot.d, "Use the secure chip?", big=str(app.get("name") or app.get("mod"))[:14],
                                       ms=slot.ASK_MS))
