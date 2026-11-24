"""A one-login SSH cartridge for a disposable test board."""

from binascii import b2a_base64, hexlify, unhexlify
from hashlib import sha256

ALGORITHM = b"ecdsa-sha2-nistp256"
CURVE = b"nistp256"
USERNAME = b"wedgie-test"
ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


def packet(value):
    return len(value).to_bytes(4, "big") + value


def public_blob(point):
    return packet(ALGORITHM) + packet(CURVE) + packet(point)


def login_blob(session, public):
    return (packet(session) + b"\x32" + packet(USERNAME) + packet(b"ssh-connection")
            + packet(b"publickey") + b"\x01" + packet(ALGORITHM) + packet(public_blob(public)))


def exact_hex(value, size):
    if not isinstance(value, str) or len(value) != size * 2:
        raise ValueError("Incorrect request length")
    try:
        return unhexlify(value)
    except (TypeError, ValueError):
        raise ValueError("Incorrect request encoding")


class Bench:
    def __init__(self, new_chip, volatile_slot, ask):
        self.new_chip = new_chip
        self.slot = volatile_slot
        self.ask = ask
        self.chip = None
        self.public = None
        self.host = None
        self.finished = False

    def close(self):
        chip, self.chip = self.chip, None
        self.public = None
        self.host = None
        self.finished = True
        if chip is not None:
            chip.close()

    def _approve(self, title, action, host):
        fingerprint = b2a_base64(sha256(public_blob(host)).digest()).decode().strip().rstrip("=")
        return self.ask(title, ("Disposable wedgie-test", "Host key SHA256", fingerprint[:22], fingerprint[22:]), action)

    def pair(self, request):
        if self.finished or self.chip is not None:
            raise ValueError("This boot has already paired a host")
        host = exact_hex(request.get("host"), 65)
        if host[0] != 4:
            raise ValueError("Expected an uncompressed P-256 host key")
        if not self._approve("Pair SSH host?", "pair", host):
            self.close()
            return {"type": "refused"}
        self.chip = self.new_chip()
        try:
            self.public = self.chip.genkey(self.slot)
            if len(self.public) != 65 or self.public[0] != 4:
                raise RuntimeError("Invalid device-generated public key")
            self.host = host
        except Exception:
            self.close()
            raise
        return {"type": "ssh_pair", "public": hexlify(self.public).decode()}

    def sign(self, request):
        if self.finished or self.chip is None:
            raise ValueError("No active SSH pairing")
        session = exact_hex(request.get("session"), 32)
        expected = login_blob(session, self.public)
        payload = exact_hex(request.get("payload"), len(expected))
        if payload != expected:
            raise ValueError("SSH login does not match the paired identity")
        signature = exact_hex(request.get("host_signature"), 64)
        r, s = int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
        if not (0 < r < ORDER and 0 < s < ORDER
                and self.chip.verify(sha256(session).digest(), r, s, pub=self.host)):
            raise ValueError("SSH host session proof rejected")
        self.finished = True
        try:
            if not self._approve("SSH test login", "sign", self.host):
                return {"type": "refused"}
            r, s = self.chip.sign(self.slot, sha256(expected).digest())
            if not 0 < r < ORDER or not 0 < s < ORDER:
                raise RuntimeError("Invalid device signature")
            return {"type": "ssh_sig", "signature": "%064x%064x" % (r, min(s, ORDER - s))}
        finally:
            self.close()


def run():
    import json
    import lcd
    import optiga
    import select
    import slot
    import sys
    import time
    import ui
    import wedgie as W

    display = lcd.LCD()
    keys = lcd.Keys(physical=True)
    if display.width != 240 or display.height != 240:
        raise RuntimeError("SSH Bench requires a 240x240 display")
    poll = select.poll()
    poll.register(sys.stdin, select.POLLIN)
    lines = W.lines()
    mid = None
    expires = None

    def approve(title, details, action):
        W.send({"type": "ssh_prompt", "id": mid, "action": action})
        return ui.ask(display, title, details, yes=action, no="reject", keys=keys)

    def show():
        state = "Restart for another test" if bench.finished else (
            "Awaiting SSH login" if bench.public else "Awaiting test host")
        ui.page(display, "SSH Bench", [(state, ui.INK), ("Disposable key only", ui.INK)])

    bench = Bench(optiga.Chip, optiga.SESSION[0], approve)
    show()
    W.send(W.hello(None, type="ready", running="ssh_bench", app="ssh-bench-1"))
    try:
        while True:
            if expires is not None and time.ticks_diff(time.ticks_ms(), expires) >= 0:
                bench.close()
                expires = None
                show()
            line = lines.pump(poll)
            if lines.intr:
                # This cartridge never offers its standard full-control prompt.
                lines.intr = False
            if line is False:
                W.send({"type": "error", "error": "Line too long"})
            elif line and line.strip():
                try:
                    request = json.loads(line)
                except ValueError:
                    request = None
                if not isinstance(request, dict):
                    W.send({"type": "error", "error": "Invalid request"})
                    continue
                mid = request.get("id")
                kind = request.get("type")
                try:
                    if kind == "hello":
                        W.send(W.hello(mid, running="ssh_bench", app="ssh-bench-1"))
                    elif kind in ("ssh_pair", "ssh_sign"):
                        if not W.SEALED or W.is_open():
                            raise ValueError("SSH Bench requires a sealed device")
                        result = bench.pair(request) if kind == "ssh_pair" else bench.sign(request)
                        if result["type"] == "ssh_pair":
                            expires = time.ticks_add(time.ticks_ms(), 120000)
                        elif bench.finished:
                            expires = None
                        W.send(dict(result, id=mid))
                        show()
                    elif kind == "open":
                        # A normal signed upgrade is still available through the normal job endpoint.
                        # Never offer generic developer access during the SSH session.
                        W.send({"id": mid, "type": "error", "error": "SSH Bench stays sealed"})
                    else:
                        slot.handle(request)
                except (ValueError, RuntimeError, OSError) as error:
                    W.send({"id": mid, "type": "error", "error": str(error)})
            time.sleep_ms(20)
    finally:
        if not bench.finished:
            bench.close()
