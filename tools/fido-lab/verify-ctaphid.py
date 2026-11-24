"""Check FIDO HID transport against wire fixtures without a USB device."""
from ctaphid import BROADCAST, MAX_PAYLOAD, INIT, PING, Transport, reports


def verify():
    time = 0
    allocated = iter((b"\x12\x34\x56\x78", b"\x87\x65\x43\x21"))
    transport = Transport(lambda: next(allocated), lambda: time, lambda now, then: now - then)
    # Hand-encoded request and response prefixes guard against mirrored framing bugs.
    init = bytes.fromhex("ff ff ff ff 86 00 08 01 23 45 67 89 ab cd ef").ljust(64, b"\0")
    first, = transport.receive(init)
    assert first[:24].hex() == "ffffffff8600110123456789abcdef123456780200010008"
    second, = transport.receive(init)
    one, two = first[15:19], second[15:19]
    assert one != two and first[7:15] == second[7:15]

    def receive(channel, command, data):
        output = ()
        for frame in reports(channel, command, data):
            output += transport.receive(frame)
        return output

    assert receive(BROADCAST, PING, b"x")[0][:8].hex() == "ffffffffbf00010b"
    assert receive(one, INIT, b"short")[0][7] == 3
    assert receive(one, 0x10, b"\x04")[0][7] == 1  # No CBOR authenticator is advertised.
    assert receive(one, PING, b"abc")[0][:10].hex() == "12345678810003616263"
    large = bytes(index % 251 for index in range(MAX_PAYLOAD))
    frames = tuple(reports(one, PING, large))
    assert len(frames) == 129 and frames[-1][4] == 127
    assert all(len(frame) == 64 for frame in frames)
    assert receive(one, PING, large) == frames

    assert transport.receive(frames[0]) == ()
    assert receive(two, PING, b"busy")[0][7] == 6
    assert transport.receive(frames[2])[0][7] == 4
    assert receive(two, PING, b"free")[0][7:11] == b"free"

    assert transport.receive(frames[0]) == ()
    time = 999
    assert transport.expire() == ()
    time = 1000
    assert transport.expire()[0][7] == 5
    assert transport.receive(frames[1]) == ()

    assert transport.receive(frames[0]) == ()
    assert receive(one, INIT, b"12345678")[0][15:19] == one
    assert transport.receive(frames[1]) == ()
    assert receive(one, PING, b"ok")[0][7:9] == b"ok"
    print("PASS: CTAPHID INIT, PING, fragmentation, channel isolation, resync, and timeout.")


if __name__ == "__main__":
    verify()
