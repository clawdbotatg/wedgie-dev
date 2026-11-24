"""Offline FIDO HID framing with an optional bench CTAP2 callback."""

REPORT_BYTES = 64
INITIAL_BYTES = REPORT_BYTES - 7
CONTINUATION_BYTES = REPORT_BYTES - 5
MAX_PAYLOAD = INITIAL_BYTES + 128 * CONTINUATION_BYTES
BROADCAST = b"\xff" * 4
INVALID = bytes(4)
PING = 0x01
INIT = 0x06
CBOR = 0x10
ERROR = 0x3F
INVALID_COMMAND = 0x01
INVALID_LENGTH = 0x03
INVALID_SEQUENCE = 0x04
MESSAGE_TIMEOUT = 0x05
CHANNEL_BUSY = 0x06
INVALID_CHANNEL = 0x0B

# FIDO usage page 0xF1D0, U2F authenticator usage 1, 64-byte IN and OUT reports.
REPORT_DESCRIPTOR = bytes.fromhex(
    "06 d0 f1 09 01 a1 01 09 20 15 00 26 ff 00 75 08 95 40 81 02"
    " 09 21 15 00 26 ff 00 75 08 95 40 91 02 c0"
)


def reports(channel, command, payload):
    """Pack one CTAPHID command or reply into fixed-size reports."""
    if len(channel) != 4 or not 0 <= command <= 0x7F or len(payload) > MAX_PAYLOAD:
        raise ValueError("Invalid CTAPHID message")
    header = channel + bytes((0x80 | command,)) + len(payload).to_bytes(2, "big")
    first = header + bytes(payload[:INITIAL_BYTES])
    yield first + bytes(REPORT_BYTES - len(first))
    for offset in range(INITIAL_BYTES, len(payload), CONTINUATION_BYTES):
        sequence = (offset - INITIAL_BYTES) // CONTINUATION_BYTES
        continuation = channel + bytes((sequence,)) + bytes(payload[offset:offset + CONTINUATION_BYTES])
        yield continuation + bytes(REPORT_BYTES - len(continuation))


class Transport:
    """Handle one bounded in-flight message without a USB dependency."""

    def __init__(self, allocate, now_ms, elapsed_ms, timeout_ms=1000, *, cbor=None):
        self.allocate = allocate
        self.now_ms = now_ms
        self.elapsed_ms = elapsed_ms
        self.timeout_ms = timeout_ms
        self.cbor = cbor
        self.channels = set()
        self.pending = None

    def error(self, channel, code):
        return tuple(reports(channel, ERROR, bytes((code,))))

    def expire(self):
        if self.pending is not None and self.elapsed_ms(self.now_ms(), self.pending[-1]) >= self.timeout_ms:
            channel = self.pending[0]
            self.pending = None
            return self.error(channel, MESSAGE_TIMEOUT)
        return ()

    def receive(self, report):
        if len(report) != REPORT_BYTES:
            raise ValueError("Expected a 64-byte CTAPHID report")
        expired = self.expire()
        return expired + self._receive(report)

    def _receive(self, report):
        channel, marker = report[:4], report[4]
        if channel not in self.channels and (channel != BROADCAST or marker != 0x80 | INIT):
            return self.error(channel, INVALID_CHANNEL)
        if self.pending is not None and channel != self.pending[0]:
            return self.error(channel, CHANNEL_BUSY)
        if marker == 0x80 | INIT:
            if int.from_bytes(report[5:7], "big") != 8:
                return self.error(channel, INVALID_LENGTH)
            self.pending = None
            allocated = channel
            if channel == BROADCAST:
                if len(self.channels) == 8:
                    return self.error(channel, CHANNEL_BUSY)
                allocated = self.allocate()
                if (len(allocated) != 4 or allocated in (BROADCAST, INVALID)
                        or allocated in self.channels):
                    return self.error(channel, CHANNEL_BUSY)
                self.channels.add(allocated)
            # Interface protocol v2, prototype v0.1.0. CAPABILITY_NMSG is always set.
            capabilities = 0x08 if self.cbor is None else 0x0C
            payload = report[7:15] + allocated + b"\x02\0\x01\0" + bytes((capabilities,))
            return tuple(reports(channel, INIT, payload))
        if marker & 0x80:
            if self.pending is not None:
                return self.error(channel, CHANNEL_BUSY)
            command = marker & 0x7F
            if command != PING and (command != CBOR or self.cbor is None):
                return self.error(channel, INVALID_COMMAND)
            size = int.from_bytes(report[5:7], "big")
            if size > MAX_PAYLOAD:
                return self.error(channel, INVALID_LENGTH)
            if size <= INITIAL_BYTES:
                return self._reply(channel, command, report[7:7 + size])
            self.pending = (channel, command, size, bytearray(report[7:]), 0, self.now_ms())
            return ()
        if self.pending is None:
            return ()
        _, command, size, data, sequence, started = self.pending
        if marker != sequence:
            self.pending = None
            return self.error(channel, INVALID_SEQUENCE)
        data.extend(report[5:5 + min(size - len(data), CONTINUATION_BYTES)])
        if len(data) == size:
            self.pending = None
            return self._reply(channel, command, data)
        self.pending = (channel, command, size, data, sequence + 1, started)
        return ()

    def _reply(self, channel, command, data):
        if command == CBOR:
            data = self.cbor(bytes(data))
        return tuple(reports(channel, command, data))
