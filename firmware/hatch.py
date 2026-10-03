# The escape hatch: a computer gets the whole wedgie (the REPL, every file, the secure chip) only after
# its person sees this red question and presses A. Asked by {"type": "open", "full": true} (wedgie.py
# unlock) and by a Ctrl-C while sealed (main.py turns Ctrl-C off, so it arrives as a plain byte: slot.serve,
# usbwallet.pump). A yes is any other yes (slot.let_in): Ctrl-C works until main.py runs again. Only a real
# press answers (ui.ask). Loaded only when asked: the running app pays no heap for it.
import time
import wedgie as W
import ui

AFTER = 3000        # ms after the slot starts: a Ctrl-C before that is a host's leftover, not a person's


def ask():
    """The red question. True after A."""
    import slot
    W.asked_ms = None
    ok = ui.ask(slot.d, "FULL CONTROL?",
                ["This computer could run any code and make the chip sign anything: send your money.",
                 "Didn't ask for this? Press Y."],
                yes="full control", no="no", ms=slot.ASK_MS, scary=True)
    W.asked_ms = time.ticks_diff(ui.drawn, slot._rx)
    if ok:
        slot._band("full control", [("this computer has it", ui.RED), ("Ctrl-C stops the app", ui.INK),
                                    ("unplug to lock it again", ui.MUTED)])
    return ok


def ctrl_c():
    """A Ctrl-C came in while sealed. True after a yes: the caller stops the app as Ctrl-C would. A no
    restarts it, locked."""
    import slot
    if not W.SEALED or W.is_open() or time.ticks_diff(time.ticks_ms(), slot._started) < AFTER:
        return False
    print("wedgie: locked. Press A on its red screen to give this computer full control.")
    if slot.let_in("", True):
        return True
    slot._restart()
    return False
