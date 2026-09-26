# Emulator `rp2`: no PIO. bootsel_button() is the only thing sketches tend to touch.
def bootsel_button():
    return 0


def country(c=None):
    return "US"


class PIO:
    def __init__(self, *a, **k):
        raise NotImplementedError("PIO is not emulated")


def asm_pio(**kw):
    def deco(f):
        return f
    return deco


class StateMachine:
    def __init__(self, *a, **k):
        raise NotImplementedError("PIO is not emulated")
