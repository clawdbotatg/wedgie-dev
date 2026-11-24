"""Exercise the real Wedgie usbdev stack over an in-process USB controller."""

from os import environ
from time import monotonic_ns
from types import ModuleType, SimpleNamespace
import struct
import sys
import unittest

from fido2.ctap2 import Ctap2
from fido2.hid import CTAPHID, CtapHidDevice, HidDescriptor
from fido2.hid.base import parse_report_descriptor

from bench_ctap2 import BenchAuthenticator
from ctaphid import PING, Transport, reports


class FakeUsbController:
    # Representative USB CDC ACM configuration, with control and data interfaces
    # followed by dynamically assigned interfaces in the real usbdev wrapper.
    BUILTIN_DEFAULT = SimpleNamespace(itf_max=2, ep_max=3, str_max=4,
        desc_dev=bytes.fromhex("120100020000004000000000000101020301"),
        desc_cfg=bytes.fromhex(
            "09024b000201008032 080b000202020100 090400000102020100"
            "0524001001 0524010001 04240202 0524060001 07058103080010"
            "09040100020a000000 07050202400000 07058202400000"))
    BUILTIN_NONE = SimpleNamespace(itf_max=0, ep_max=1, str_max=4,
        desc_dev=BUILTIN_DEFAULT.desc_dev, desc_cfg=b"")

    def __init__(self):
        self.active_state = False
        self.pending = {}
        self.reject_queue = False

    def active(self, *args):
        if args:
            self.active_state = args[0]
        return self.active_state

    def config(self, _, config, _strings, opened, reset, control, transferred):
        self.configuration = bytes(config)
        self.opened = opened
        self.reset = reset
        self.control = control
        self.transferred = transferred

    def submit_xfer(self, endpoint, data):
        if self.reject_queue:
            return False
        if endpoint in self.pending:
            raise AssertionError("Duplicate transfer")
        self.pending[endpoint] = data
        return True

    def complete(self, endpoint, incoming=None, result=0):
        data = self.pending.pop(endpoint)
        if incoming is not None:
            data[:len(incoming)] = incoming
        length = len(data if incoming is None else incoming)
        self.transferred(endpoint, result, length)
        return bytes(data)

    def bus_reset(self):
        self.pending.clear()
        self.reset()


fake_machine = ModuleType("machine")
fake_machine.USBDevice = FakeUsbController
sys.modules["machine"] = fake_machine
fake_micropython = ModuleType("micropython")
fake_micropython.const = lambda value: value
sys.modules["micropython"] = fake_micropython
sys.path.insert(0, environ["WEDGIE_FIRMWARE"])

import usbdev
from fido_usb import FidoHid


class StorageDescriptor(usbdev.Interface):
    """Descriptor stand-in for the Wedgie mass-storage interface."""

    def num_eps(self):
        return 1

    def desc_cfg(self, desc, itf_num, ep_num, strs):
        desc.interface(itf_num, 2, 8, 6, 80)
        desc.endpoint(ep_num, "bulk", 64, 0)
        desc.endpoint(ep_num | 0x80, "bulk", 64, 0)


class UsbConnection:
    def __init__(self, interface, controller):
        self.interface = interface
        self.controller = controller

    def write_packet(self, data):
        self.interface.poll()
        self.controller.complete(self.interface.ep_out, data)
        self.interface.poll()

    def read_packet(self):
        self.interface.poll()
        return self.controller.complete(self.interface.ep_in)

    def close(self):
        self.controller.bus_reset()


class FidoUsbTest(unittest.TestCase):
    def setUp(self):
        usbdev._dev = None
        self.now = 0
        self.requests = []

        def make_transport():
            authenticator = BenchAuthenticator(lambda *_: False)

            def handle(request):
                self.requests.append(request)
                return authenticator.handle(request)

            return Transport(lambda: b"\x12\x34\x56\x78", lambda: self.now,
                             lambda now, start: now - start, cbor=handle)

        self.interface = FidoHid(make_transport)
        self.stack = usbdev.get()
        self.stack.init(StorageDescriptor(), self.interface, builtin_driver=True)
        self.controller = self.stack._usbd
        self.connection = UsbConnection(self.interface, self.controller)
        self.addCleanup(self.connection.close)
        self.open_interfaces()

    def open_interfaces(self):
        appended = self.controller.configuration[len(self.controller.BUILTIN_DEFAULT.desc_cfg):]
        self.controller.opened(memoryview(appended[:23]))  # Bulk interface and two endpoints.
        self.controller.opened(memoryview(appended[23:]))

    def host(self):
        descriptor = HidDescriptor("fixture", 0, 0, 64, 64, "Wedgie USB fixture", None)
        return CtapHidDevice(descriptor, self.connection)

    def test_composite_and_report_descriptors(self):
        configuration = self.controller.configuration
        self.assertEqual(struct.unpack_from("<H", configuration, 2)[0], len(configuration))
        self.assertEqual(configuration[4], 4)
        original = self.controller.BUILTIN_DEFAULT.desc_cfg
        self.assertEqual(configuration[9:len(original)], original[9:])
        self.assertEqual(configuration[-32:].hex(), "0904030002030000000921110100012222000705040340000507058403400005")
        self.assertEqual(sorted(self.stack._eps), [3, 4, 0x83, 0x84])
        report_request = bytes.fromhex("81 06 00 22 03 00 ff 00")
        report = self.controller.control(1, report_request)
        self.assertEqual(parse_report_descriptor(report), (64, 64))
        self.assertEqual(self.controller.control(1, report_request[:6] + b"\x05\x00"), report[:5])
        self.assertIs(self.controller.control(3, report_request), True)
        self.assertIs(self.controller.control(1, bytes.fromhex("21 09 00 02 03 00 40 00")), False)

    def test_getinfo_and_fragmentation(self):
        client = self.host()
        ctap = Ctap2(client)
        self.assertEqual(ctap.info.versions, ["FIDO_2_0"])
        self.assertEqual(self.requests, [b"\x04"])
        payload = bytes(range(256))
        self.assertEqual(client.call(CTAPHID.PING, payload), payload)

    def test_short_report_and_expiry(self):
        client = self.host()
        self.connection.write_packet(b"short")
        self.assertEqual(client.call(CTAPHID.PING, b"usable"), b"usable")
        channel = b"\x12\x34\x56\x78"
        first = next(reports(channel, PING, b"x" * 120))
        self.connection.write_packet(first)
        self.now = 1000
        response = self.connection.read_packet()
        self.assertEqual(response[:8], channel + b"\xbf\x00\x01\x05")

    def test_reset_discards_old_channels_and_rearms(self):
        self.host()
        channel = b"\x12\x34\x56\x78"
        first, continuation = reports(channel, PING, b"x" * 100)
        self.connection.write_packet(first)
        self.controller.bus_reset()
        self.interface.poll()
        self.assertFalse(self.controller.pending)
        self.open_interfaces()
        self.connection.write_packet(continuation)
        self.assertEqual(self.connection.read_packet()[:8], channel + b"\xbf\x00\x01\x0b")
        client = self.host()
        self.assertEqual(client.call(CTAPHID.PING, b"fresh"), b"fresh")

    def test_queue_failure_waits_for_reset(self):
        self.controller.reject_queue = True
        self.interface.poll()
        self.controller.reject_queue = False
        self.interface.poll()
        self.assertFalse(self.controller.pending)
        self.controller.bus_reset()
        self.open_interfaces()
        self.assertEqual(Ctap2(self.host()).info.versions, ["FIDO_2_0"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
