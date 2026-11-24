"""Disposable OpenPGP rehearsal cartridge for an isolated virtual RP2040."""

import binascii
import json
import lcd
import optiga
import select
import sys
import time
import ui
import wedgie as W


def run():
    display = lcd.LCD()
    keys = lcd.Keys(physical=True)
    poll = select.poll()
    poll.register(sys.stdin, select.POLLIN)
    lines = W.lines()
    chip = None
    issued = False
    signed = 0
    expires = None

    def approve(mid, action, details):
        title = "OpenPGP test key" if action == "key" else "OpenPGP test sign"
        W.send({"type": "pgp_prompt", "id": mid, "action": action})
        return ui.ask(display, title, details, yes="Approve", no="Reject", keys=keys)

    ui.page(display, "OpenPGP bench", [("Disposable test key", ui.INK)])
    W.send(W.hello(None, type="ready", running="pgp_bench", app="pgp-bench-1"))
    try:
        while True:
            if chip is not None and time.ticks_diff(time.ticks_ms(), expires) >= 0:
                chip.close()
                chip = None
            line = lines.pump(poll)
            lines.intr = False
            if not line:
                time.sleep_ms(10)
                continue
            mid = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("Invalid fixture request")
                mid = request.get("id")
                action = request.get("type")
                if action == "hello":
                    W.send(W.hello(mid, running="pgp_bench", app="pgp-bench-1"))
                    continue
                if not W.SEALED or W.is_open():
                    raise ValueError("Bench must be sealed")
                if action == "pgp_key" and not issued:
                    issued = True
                    if not approve(mid, "key", ("Volatile test key only",)):
                        W.send({"id": mid, "type": "refused"})
                        continue
                    chip = optiga.Chip()
                    public = chip.genkey(optiga.SESSION[0])
                    expires = time.ticks_add(time.ticks_ms(), 180000)
                    W.send({"id": mid, "type": "pgp_key", "public": binascii.hexlify(public).decode()})
                elif action == "pgp_sign" and chip is not None and signed < 3:
                    text = request.get("digest")
                    if not isinstance(text, str) or len(text) != 64:
                        raise ValueError("Expected a SHA-256 digest")
                    digest = binascii.unhexlify(text)
                    phase = "Detached test message" if signed == 2 else "Test key certificate"
                    details = (phase, text[:16], text[16:32], text[32:48], text[48:])
                    if not approve(mid, "sign", details):
                        W.send({"id": mid, "type": "refused"})
                        continue
                    r, s = chip.sign(optiga.SESSION[0], digest)
                    signed += 1
                    if signed == 3:
                        chip.close()
                        chip = None
                    W.send({"id": mid, "type": "pgp_sig", "signature": "%064x%064x" % (r, s)})
                else:
                    raise ValueError("Unavailable fixture operation")
            except (ValueError, RuntimeError, OSError, TypeError) as error:
                W.send({"id": mid, "type": "error", "error": str(error)})
    finally:
        if chip is not None:
            chip.close()
