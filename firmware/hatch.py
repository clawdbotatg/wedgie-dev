# The escape hatch: a computer gets the whole wedgie (the REPL, every file, the secure chip) only after
# its person sees this red question and presses A. Asked by {"type": "open", "full": true} (wedgie.py
# unlock) and by a Ctrl-C while sealed (main.py turns Ctrl-C off, so it arrives as a plain byte: slot.serve,
# usbwallet.pump). A yes stops the app and drops to the REPL (slot.let_in), under a screen that says the
# computer has full access, until a restart or an unplug. Only a real press answers (ui.ask). Loaded only
# when asked: the running app pays no heap for it.
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
        shown(slot.d)
    return ok


def shown(d):
    """While the computer has it: the underwear, and what that means. Nothing draws over it (the app is
    stopped: slot.let_in), so it stays up until a restart or an unplug."""
    import loader
    y = loader.logo(d) or 60
    d.center_text("COMPUTER HAS", y + 12, ui.RED, 2)
    d.center_text("FULL ACCESS", y + 34, ui.RED, 2)
    d.center_text("didn't want that?", y + 62, ui.INK)
    d.center_text("unplug it now", y + 76, ui.INK)
    d.show()


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
