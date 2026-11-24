"""Build an emulator-only LittleFS image that forwards CTAP CBOR over CDC."""

import argparse
from hashlib import sha256
from pathlib import Path

from build_transport_probe import build_filesystem


BRIDGE_BOOT = """import binascii
from os import urandom
import select
import sys
from time import sleep_ms, ticks_diff, ticks_ms
import usbdev
from ctaphid import Transport
from fido_usb import FidoHid

def cbor(payload):
    if len(payload) > 1024:
        return b"\\x03"
    print("FIDO_C", binascii.hexlify(payload).decode())
    poll = select.poll()
    poll.register(sys.stdin, select.POLLIN)
    start = ticks_ms()
    response = []
    while ticks_diff(ticks_ms(), start) < 10000 and len(response) < 2053:
        if not poll.poll(0):
            sleep_ms(1)
            continue
        char = sys.stdin.read(1)
        if char == "\\n":
            text = "".join(response)
            if text.startswith("RES "):
                try:
                    output = binascii.unhexlify(text[4:].rstrip("\\r"))
                    if 0 < len(output) <= 1024:
                        return output
                except ValueError:
                    pass
            break
        if char:
            response.append(char)
    return b"\\x7f"

hid = FidoHid(lambda: Transport(lambda: urandom(4), ticks_ms, ticks_diff, cbor=cbor))
usbdev.get().init(hid, builtin_driver=True, product_str="Wedgie CTAP host fixture")
"""

BRIDGE_MAIN = """from time import sleep_ms

while True:
    hid.poll()
    sleep_ms(1)
"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    args = parser.parse_args()
    image, count = build_filesystem(BRIDGE_BOOT, BRIDGE_MAIN)
    with args.image.open("xb") as file:
        file.write(image)
    print(f"Verified {count} files in emulator LittleFS image SHA-256 {sha256(image).hexdigest()}")
