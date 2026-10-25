# Infineon OPTIGA Trust M (Adafruit 4351 breakout) on the wallet's I2C bus, GP4 SDA / GP5 SCL.
# Physical layer only, straight from the datasheet (SLS32AIA, rev 3.70, chapter A):
#   - 7-bit address 0x30
#   - the chip NACKs its address while asleep or busy; retry every 1 ms, give up after 200 tries
#     (Infineon's ifx_i2c_physical_layer.c: PL_POLLING_MAX_CNT 200, PL_POLLING_INVERVAL_US 1000)
#   - GUARD_TIME 50 us between one transaction's STOP and the next START; we wait 100 us
#   - soft reset: write register 0x88 with two zero bytes, then tSTARTUP 15..20 ms
# Registers: 0x80 DATA, 0x82 I2C_STATE (4 bytes: flags, rfu, length hi, length lo).
# I2C_STATE byte 0: 0x80 BUSY, 0x40 RESP_RDY, 0x08 SOFT_RESET supported.
from machine import Pin, I2C
import time

ADDR = 0x30
GUARD_US = 100
TRIES = 200
# busy[0] > 0 while a command is under way (here or in optiga.py, which shares this I2C layer): the
# host's chip check (wedgie.chip) waits instead of resetting the chip under an app that's using it.
busy = [0]

i2c = None


def bus(sda=4, scl=5, freq=400000):
    global i2c
    i2c = I2C(0 if sda % 4 == 0 else 1, sda=Pin(sda), scl=Pin(scl), freq=freq)
    return i2c


def _write(data):
    for _ in range(TRIES):
        try:
            i2c.writeto(ADDR, data)
            time.sleep_us(GUARD_US)
            return
        except OSError:
            time.sleep_ms(1)
    raise OSError("trustm: write not acked")


def _read(n):
    for _ in range(TRIES):
        try:
            r = i2c.readfrom(ADDR, n)
            time.sleep_us(GUARD_US)
            return r
        except OSError:
            time.sleep_ms(1)
    raise OSError("trustm: read not acked")


def reg(addr, n):
    _write(bytes([addr]))
    return _read(n)


def state():
    return reg(0x82, 4)


# The data link's frame numbers (frnr, acknr). One I2C link to one chip, so every Session (and optiga.Chip)
# shares them: a Session kept its own, and once another Session reset the chip its next frame had the
# wrong number, the chip ignored it, and it waited out wait_response's 10 s (Welcome froze 8-10 s while a
# host checked the chip, 2026-10-18). gen: soft resets so far; a session from before the last one opens
# the application again before its next command.
link = [0, 3]
gen = [0]


def soft_reset():
    _write(b"\x88\x00\x00")
    time.sleep_ms(25)
    link[0], link[1] = 0, 3
    gen[0] += 1


def wait_response(timeout_ms=10000):
    """Poll I2C_STATE until RESP_RDY; return the response length. 10 s: a factory-key sign took over 1 s
    on a real board (2026-10-11, the chip check failed with state 88800000, busy)."""
    t = time.ticks_ms()
    while True:
        s = state()
        if s[0] & 0x40:
            return (s[2] << 8) | s[3]
        if time.ticks_diff(time.ticks_ms(), t) > timeout_ms:
            raise OSError("trustm: no response, state %s" % s.hex())
        time.sleep_ms(5)


def read_data():
    n = wait_response()
    return reg(0x80, n)


def read_frame():
    """Next data frame. The chip may first hand back its zero-length ack of our last write
    (FCTR 0x8x, LEN 0, FCS); skip those."""
    while True:
        f = read_data()
        if len(f) > 5 or f[1:3] != b"\x00\x00":
            return f


# Datasheet A.2: the exact frames (data-link sequence numbers and FCS included), valid as the
# first two exchanges after a reset.
OPEN_APP = bytes.fromhex("8003001500700000" "10D2760000044765" "6E41757468417070" "6C041A")
OPEN_APP_ACK = bytes.fromhex("8080000" "00CEC")
GET_UID = bytes.fromhex("8004000B00010000" "06E0C200000064F0" "9F")
GET_UID_ACK = bytes.fromhex("8081000" "05630")


def coprocessor_uid():
    """Reset, OpenApplication, GetDataObject(0xE0C2). Returns the 27-byte UID field."""
    soft_reset()
    s = state()
    if s != b"\x08\x80\x00\x00":
        raise OSError("trustm: unexpected state after reset %s" % s.hex())
    _write(OPEN_APP)
    resp = read_frame()          # 00 00 05 00 00 00 00 00 14 87: OpenApplication response
    _write(OPEN_APP_ACK)
    _write(GET_UID)
    resp = read_frame()          # 05 00 20 00 | 00 00 00 1B | CD + 27 bytes | fcs
    _write(GET_UID_ACK)
    if len(resp) != 37 or resp[4:8] != b"\x00\x00\x00\x1b":
        raise OSError("trustm: bad UID response %s" % resp.hex())
    return resp[8:35]


# --- IFX I2C data-link + APDU layer (datasheet frames decoded; FCS is CRC-16 poly 0x8408, init 0, big-endian)
def _crc(data):
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0x8408 if c & 1 else c >> 1
    return c


class Session:
    """One OpenApplication session after a soft reset. Frame numbers run 0..3 (shared: link)."""

    def __init__(self):
        busy[0] += 1
        try:
            soft_reset()
            self._open()
        finally:
            busy[0] -= 1

    def _open(self):
        self.gen = gen[0]
        self.command(0x70, 0x00, bytes.fromhex("D2760000044765" "6E41757468417070" "6C"))

    def _send(self, apdu):
        body = bytes([(link[0] << 2) | link[1]]) + len(apdu + b"\x00").to_bytes(2, "big") + b"\x00" + apdu
        _write(b"\x80" + body + _crc(body).to_bytes(2, "big"))
        link[0] = (link[0] + 1) & 3

    def _recv(self):
        f = read_frame()
        if _crc(f[:-2]) != int.from_bytes(f[-2:], "big"):
            raise OSError("trustm: bad fcs %s" % f.hex())
        link[1] = (f[0] >> 2) & 3
        ack = bytes([0x80 | link[1], 0, 0])
        _write(b"\x80" + ack + _crc(ack).to_bytes(2, "big"))
        return f[4:-2]                      # drop FCTR, LEN, PCTR and FCS

    def command(self, cmd, param, data):
        if self.gen != gen[0]:              # the chip was reset under this session: open it again
            self._open()
        busy[0] += 1
        try:
            self._send(bytes([cmd, param]) + len(data).to_bytes(2, "big") + data)
            r = self._recv()
        finally:
            busy[0] -= 1
        if r[0] != 0:
            raise OSError("trustm: cmd %02x failed, status %02x, %s" % (cmd, r[0], r[4:].hex()))
        return r[4:4 + int.from_bytes(r[2:4], "big")]

    def get(self, oid, offset=None, length=None):
        d = oid.to_bytes(2, "big")
        if length is not None:
            d += offset.to_bytes(2, "big") + length.to_bytes(2, "big")   # small: 4 bytes, once
        return self.command(0x01, 0x00, d)

    def metadata(self, oid):
        return self.command(0x01, 0x01, oid.to_bytes(2, "big"))

    def sign(self, oid, digest):
        """CalcSign 0x31, ECDSA over a 32-byte digest with the key at oid. Returns (r, s)."""
        d = b"\x01" + len(digest).to_bytes(2, "big") + digest + b"\x03\x00\x02" + oid.to_bytes(2, "big")
        r = self.command(0x31, 0x11, d)
        if r[0] == 0x30:                    # some builds wrap r,s in a SEQUENCE
            r = r[2:]
        out = []
        while r:
            n = r[1]
            out.append(int.from_bytes(r[2:2 + n], "big"))
            r = r[2 + n:]
        return out[0], out[1]

    def random(self, n):
        return self.command(0x0C, 0x00, n.to_bytes(2, "big"))

    def verify(self, digest, r, s, x, y):
        """VerifySign 0x32: True if (r, s) is a P-256 ECDSA signature of digest by the key (x, y), checked on the chip
        (~0.2 s on an RP2040; pure-Python p256.verify: 2.4 s). False if the chip says it isn't (0x2C); any other
        trouble raises."""
        def i(v):
            b = v.to_bytes(32, "big").lstrip(b"\x00") or b"\x00"
            return b"\x02" + bytes([len(b) + (b[0] >> 7)]) + b"\x00" * (b[0] >> 7) + b
        t = lambda tag, v: bytes([tag]) + len(v).to_bytes(2, "big") + v
        k = b"\x03\x42\x00\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")     # the key: a DER BIT STRING
        try:
            self.command(0x32, 0x11, t(1, digest) + t(2, i(r) + i(s)) + t(5, b"\x03") + t(6, k))
            return True
        except OSError:
            if self.get(0xF1C2, 0, 1) == b"\x2c":       # the chip's last error (reading clears it): bad signature
                return False
            raise

    def get_all(self, oid, step=200):
        out = b""
        while True:
            part = self.get(oid, len(out), step)
            out += part   # small: a ~1 KB certificate in 200-byte parts: a few copies, only on a chip check
            if len(part) < step:
                return out


if __name__ == "__main__":
    bus()
    print("state", state().hex())
    uid = coprocessor_uid()
    print("coprocessor UID", uid.hex())
    print("fw build", uid[25:27].hex())
