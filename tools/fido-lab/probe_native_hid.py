"""Check the INIT/PING-only bench image with python-fido2."""

import argparse
import json
import signal
from pathlib import Path
from subprocess import PIPE, Popen

from fido2.ctap import CtapError
from fido2.hid import CAPABILITY, CTAPHID, CtapHidDevice, list_descriptors, open_connection
from fido2.hid.base import CtapHidConnection, HidDescriptor


PRODUCT_NAME = "Wedgie FIDO transport probe"
PING_SIZES = (0, 57, 58, 116, 117, 1024)


class EmulatorConnection(CtapHidConnection):
    """Send complete HID reports to the RP2040 host harness."""

    def __init__(self, process):
        self.process = process

    def exchange(self, line):
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()
        response = self.process.stdout.readline()
        if not response:
            raise OSError("RP2040 HID harness exited before replying")
        return response.rstrip("\n")

    def write_packet(self, data):
        if self.exchange(data.hex()) != "written":
            raise OSError("RP2040 HID harness did not accept the report")

    def read_packet(self):
        return bytes.fromhex(self.exchange("read"))

    def close(self):
        self.process.stdin.close()


def probe(descriptor, connection):
    try:
        device = CtapHidDevice(descriptor, connection)
        if device.version != 2 or device.capabilities != CAPABILITY.NMSG:
            raise RuntimeError("Expected the INIT/PING-only firmware and no credential capability")
        for size in PING_SIZES:
            message = bytes(index % 251 for index in range(size))
            if device.ping(message) != message:
                raise RuntimeError(f"PING response differs at {size} bytes")
        try:
            device.call(CTAPHID.CBOR, b"\x04")  # Read-only GetInfo must be refused.
        except CtapError as error:
            if error.code != CtapError.ERR.INVALID_COMMAND:
                raise
        else:
            raise RuntimeError("Transport-only firmware unexpectedly accepted CBOR")
    finally:
        connection.close()


def matching_descriptor(serial):
    matches = [d for d in list_descriptors()
               if d.product_name == PRODUCT_NAME and d.serial_number == serial
               and d.report_size_in == d.report_size_out == 64]
    if len(matches) != 1:
        raise SystemExit("Expected exactly one 64-byte FIDO transport probe with that serial")
    return matches[0]


def _deadline(_signum, _frame):
    raise TimeoutError("FIDO transport check exceeded its deadline")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--emulator-uf2", type=Path)
    source.add_argument("--usb-serial", help="Serial of the disposable probe on a spare Pico")
    args = parser.parse_args()
    signal.signal(signal.SIGALRM, _deadline)
    signal.alarm(90)
    try:
        if args.emulator_uf2:
            harness = Path(__file__).with_name("test_transport_probe.mjs")
            with Popen(["node", str(harness), str(args.emulator_uf2), "--stdio"],
                       stdin=PIPE, stdout=PIPE, text=True) as process:
                try:
                    descriptor = HidDescriptor("emulator", 0, 0, 64, 64, PRODUCT_NAME, None)
                    probe(descriptor, EmulatorConnection(process))
                    if process.wait(timeout=5) != 0:
                        raise RuntimeError("RP2040 HID harness failed")
                finally:
                    if process.poll() is None:
                        process.terminate()
            backend = "rp2040-emulated-usb"
        else:
            descriptor = matching_descriptor(args.usb_serial)
            probe(descriptor, open_connection(descriptor))
            backend = "physical-usb"
        print(json.dumps({"backend": backend, "host": "python-fido2", "init": True,
                          "ping_sizes": PING_SIZES, "cbor_refused": True}))
    finally:
        signal.alarm(0)
