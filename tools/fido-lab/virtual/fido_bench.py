"""Disposable per-RP credential keys for the virtual RP2040 bench."""

import binascii
from hashlib import sha256
import json
import lcd
import optiga
import select
import sys
import time
import ui
import wedgie as W


SLOTS = {"alpha.invalid": optiga.SESSION[0], "beta.invalid": optiga.SESSION[1]}


def run():
    display = lcd.LCD()
    keys = lcd.Keys(physical=True)
    poll = select.poll()
    poll.register(sys.stdin, select.POLLIN)
    lines = W.lines()
    chip, public = None, {}

    def approve(mid, title, rp):
        W.send({"id": mid, "type": "fido_prompt"})
        return ui.ask(display, title, (rp, "Disposable credential"), keys=keys)

    ui.page(display, "FIDO Trust M test", [("Volatile credentials", ui.INK)])
    W.send(W.hello(None, type="ready", running="fido_bench"))
    try:
        while True:
            line = lines.pump(poll)
            lines.intr = False
            if not line:
                time.sleep_ms(10)
                continue
            mid = None
            try:
                request = json.loads(line)
                mid, action = request["id"], request["type"]
                if not W.SEALED or W.is_open():
                    raise ValueError("Bench must be sealed")
                if action == "fido_close":
                    if chip is not None:
                        chip.close()
                        chip = None
                    public.clear()
                    W.send({"id": mid, "type": "fido_closed"})
                    continue
                rp = request["rp"]
                if rp not in SLOTS:
                    raise ValueError("Unavailable test RP")
                if action == "fido_key":
                    if not approve(mid, "Test credential key", rp):
                        W.send({"id": mid, "type": "refused"})
                        continue
                    if chip is None:
                        chip = optiga.Chip()
                    if rp not in public:
                        public[rp] = binascii.hexlify(chip.genkey(SLOTS[rp])).decode()
                    W.send({"id": mid, "type": "fido_public", "public": public[rp]})
                elif action == "fido_sign" and rp in public:
                    text = request["message"]
                    if not isinstance(text, str) or len(text) > 640:
                        raise ValueError("Invalid fixture message")
                    message = binascii.unhexlify(text)
                    if len(message) < 69 or message[:32] != sha256(rp.encode()).digest():
                        raise ValueError("Authenticator data does not match RP")
                    flags = message[32]
                    if not ((flags == 1 and len(message) == 69) or (flags == 65 and len(message) > 106)):
                        raise ValueError("Unexpected authenticator data shape")
                    title = "Test registration" if flags == 65 else "Test sign-in"
                    if not approve(mid, title, rp):
                        W.send({"id": mid, "type": "refused"})
                        continue
                    r, s = chip.sign(SLOTS[rp], sha256(message).digest())
                    W.send({"id": mid, "type": "fido_sig", "signature": "%064x%064x" % (r, s)})
                else:
                    raise ValueError("Unavailable test operation")
            except (KeyError, ValueError, RuntimeError, OSError, TypeError) as error:
                W.send({"id": mid, "type": "error", "error": str(error)})
    finally:
        if chip is not None:
            chip.close()
