"""USB interface adapter for a dedicated bench build using Wedgie's usbdev."""

from usbdev import Interface
from ctaphid import REPORT_BYTES, REPORT_DESCRIPTOR


_HID = bytes((9, 0x21, 0x11, 0x01, 0, 1, 0x22, len(REPORT_DESCRIPTOR), 0))
_SETUP = 1


class FidoHid(Interface):
    """Pump one FIDO HID interface with a supplied, disposable CTAPHID transport."""

    def __init__(self, make_transport):
        super().__init__()
        self._make_transport = make_transport
        self._out_report = bytearray(REPORT_BYTES)
        self._clear()

    def _clear(self):
        self._transport = None
        self._out_pending = False
        self._out_ready = False
        self._in_report = None
        self._replies = ()
        self._reply_at = 0
        self._fault = False

    def num_eps(self):
        return 1  # USB reuses the same endpoint number in each direction.

    def desc_cfg(self, desc, itf_num, ep_num, strs):
        self.itf_num = itf_num
        self.ep_out = ep_num
        self.ep_in = ep_num | 0x80
        desc.interface(itf_num, 2, 0x03, 0, 0)
        desc.extend(_HID)
        desc.endpoint(self.ep_out, "interrupt", REPORT_BYTES, 5)
        desc.endpoint(self.ep_in, "interrupt", REPORT_BYTES, 5)

    def on_interface_control_xfer(self, stage, request):
        # Standard interface GET_DESCRIPTOR, descriptor index zero.
        if (len(request) != 8 or request[0] != 0x81 or request[1] != 0x06
                or request[2] != 0 or request[4] != self.itf_num or request[5] != 0):
            return False
        if request[3] == 0x21:
            descriptor = _HID
        elif request[3] == 0x22:
            descriptor = REPORT_DESCRIPTOR
        else:
            return False
        if stage == _SETUP:
            length = request[6] | request[7] << 8
            return descriptor[:length] if length else True
        return True

    def on_open(self):
        super().on_open()
        self._clear()
        self._transport = self._make_transport()

    def on_reset(self):
        super().on_reset()
        self._clear()

    def _received(self, _endpoint, result, length):
        self._out_pending = False
        self._out_ready = result == 0 and length == REPORT_BYTES

    def _sent(self, _endpoint, result, length):
        self._in_report = None
        self._fault = result != 0 or length != REPORT_BYTES

    def poll(self):
        """Call from the bench loop; USB callbacks only record completions."""
        transport = self._transport
        if transport is None or self._fault or self._in_report is not None:
            return

        if self._reply_at == len(self._replies):
            if self._out_ready:
                self._out_ready = False
                replies = transport.receive(bytes(self._out_report))
            else:
                replies = transport.expire()
            if transport is not self._transport:
                return
            self._replies = replies
            self._reply_at = 0

        try:
            if self._reply_at < len(self._replies):
                reply = self._replies[self._reply_at]
                self._reply_at += 1
                self._in_report = reply
                self.submit_xfer(self.ep_in, reply, self._sent)
            elif not self._out_pending:
                self._out_pending = True
                self.submit_xfer(self.ep_out, self._out_report, self._received)
        except (RuntimeError, OSError):
            # usbdev may retain an endpoint callback after a DCD queue failure.
            # A bus reset clears it. Do not retry stale replies.
            if transport is self._transport:
                self._fault = True
