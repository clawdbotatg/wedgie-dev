# The WEDGIE drive: when a wedgie is plugged in it also shows up as a tiny read-only USB drive with
# the underwear as its icon and an "Open wedgie.dev" page on it. The drive sits beside MicroPython's
# own USB serial port (builtin_driver=True), so wedgie.dev, wedgie.py and mpremote keep working.
#
# USB mass storage, Bulk-Only Transport, a handful of SCSI commands, on top of usbdev.py (the
# micropython-lib runtime USB device core). The disk image is drive.bin (tools/drive.py): a FAT12
# volume stored sparse, read sector by sector from flash. Nothing is ever written: the drive reports
# write-protected and refuses WRITE.
#
# boot.py starts it, only at power-up (not on a soft reset). Hold Y while plugging in to skip it for
# that boot. Adding the drive re-enumerates USB: the serial port drops and comes back about a second
# after power-up. Read boot.py's note before changing when or how this starts.
import struct
from micropython import const
import usbdev

_CLASS_MSC, _SUBCLASS_SCSI, _PROTO_BOT = const(8), const(6), const(0x50)
_EP_IN = const(0x80)
_REQ_GET_MAX_LUN, _REQ_BOT_RESET = const(0xFE), const(0xFF)
_CBW_SIG, _CSW_SIG = const(0x43425355), const(0x53425355)
_SECTOR = const(512)


class Image:
    """drive.bin: b"WDRV", u32 total sectors, u32 n, n x u32 lba, then n x 512 bytes. Missing = zeros."""
    def __init__(self, path="drive.bin"):
        self.f = open(path, "rb")
        magic, self.sectors, n = struct.unpack("<4sII", self.f.read(12))
        if magic != b"WDRV":
            raise ValueError("drive.bin")
        lbas = struct.unpack("<%dI" % n, self.f.read(4 * n))
        base = 12 + 4 * n
        self.at = {lba: base + i * _SECTOR for i, lba in enumerate(lbas)}
        self.zero = bytearray(_SECTOR)

    def read(self, lba, buf):
        off = self.at.get(lba)
        if off is None:
            buf[:] = self.zero
        else:
            self.f.seek(off)
            self.f.readinto(buf)


class Drive(usbdev.Interface):
    def __init__(self, image):
        super().__init__()
        self.img = image
        self.cbw = bytearray(31)
        self.csw = bytearray(13)
        self.sec = bytearray(_SECTOR)
        self.sense = (0, 0, 0)
        self.ep_out = self.ep_in = None

    # ---- descriptors / control ------------------------------------------------------------------
    def desc_cfg(self, desc, itf_num, ep_num, strs):
        desc.interface(itf_num, 2, _CLASS_MSC, _SUBCLASS_SCSI, _PROTO_BOT)
        self.ep_out = ep_num
        self.ep_in = ep_num | _EP_IN
        desc.endpoint(self.ep_out, "bulk", 64, 0)
        desc.endpoint(self.ep_in, "bulk", 64, 0)

    def num_eps(self):
        return 1

    def on_interface_control_xfer(self, stage, request):
        req = request[1]
        if req == _REQ_GET_MAX_LUN:
            return b"\x00"
        if req == _REQ_BOT_RESET:
            return True
        return False

    def on_open(self):
        super().on_open()
        self._want_cbw()

    def on_reset(self):
        super().on_reset()

    # ---- Bulk-Only Transport --------------------------------------------------------------------
    def _want_cbw(self):
        try:
            self.submit_xfer(self.ep_out, self.cbw, self._got_cbw)
        except Exception as e:
            print("drive:", e)

    def _got_cbw(self, ep, result, n):
        c = self.cbw
        if n != 31 or struct.unpack_from("<I", c, 0)[0] != _CBW_SIG:
            self._want_cbw()
            return
        self.tag = struct.unpack_from("<I", c, 4)[0]
        self.want = struct.unpack_from("<I", c, 8)[0]
        self.cmd = bytes(c[15:31])
        self._scsi()

    def _status(self, ok, residue=0):
        struct.pack_into("<IIIB", self.csw, 0, _CSW_SIG, self.tag, residue, 0 if ok else 1)
        self.submit_xfer(self.ep_in, self.csw, lambda *a: self._want_cbw())

    def _reply(self, data, ok=True):
        """Send data (trimmed or zero-padded to what the host asked for), then the status."""
        n = self.want
        buf = bytearray(n)
        buf[: min(n, len(data))] = data[:n]
        if n:
            self.submit_xfer(self.ep_in, buf, lambda *a: self._status(ok))
        else:
            self._status(ok)

    def _fail(self, key, asc, ascq=0):
        self.sense = (key, asc, ascq)
        if self.want and self.cbw[12] & 0x80:           # host expects data in: pad, then fail
            self._reply(b"", ok=False)
        else:
            self._status(False, self.want)

    # ---- SCSI -----------------------------------------------------------------------------------
    def _scsi(self):
        op = self.cmd[0]
        last = self.img.sectors - 1
        if op in (0x00, 0x1E, 0x1B, 0x2F, 0x35):      # test unit ready, prevent removal, start/stop, verify, sync
            self.sense = (0, 0, 0)
            self._status(True)
        elif op == 0x12:                                # INQUIRY
            d = bytearray(36)
            d[1] = 0x80                                 # removable
            d[2], d[3], d[4] = 4, 2, 31
            d[8:16] = b"wedgie  "
            d[16:32] = b"wedgie.dev      "
            d[32:36] = b"0.1 "
            self._reply(d)
        elif op == 0x03:                                # REQUEST SENSE
            d = bytearray(18)
            d[0], d[2], d[7], d[12], d[13] = 0x70, self.sense[0], 10, self.sense[1], self.sense[2]
            self.sense = (0, 0, 0)
            self._reply(d)
        elif op == 0x1A:                                # MODE SENSE(6): write-protected
            self._reply(b"\x03\x00\x80\x00")
        elif op == 0x5A:                                # MODE SENSE(10)
            self._reply(b"\x00\x06\x00\x80\x00\x00\x00\x00")
        elif op == 0x25:                                # READ CAPACITY(10)
            self._reply(struct.pack(">II", last, _SECTOR))
        elif op == 0x23:                                # READ FORMAT CAPACITIES
            self._reply(b"\x00\x00\x00\x08" + struct.pack(">I", self.img.sectors) + b"\x02\x00\x02\x00")
        elif op == 0x28:                                # READ(10)
            lba = struct.unpack_from(">I", self.cmd, 2)[0]
            count = struct.unpack_from(">H", self.cmd, 7)[0]
            if lba + count > self.img.sectors:
                self._fail(5, 0x21)                     # LBA out of range
            else:
                self._read(lba, count)
        elif op == 0x2A:                                # WRITE(10): no
            self._fail(7, 0x27)                         # data protect / write protected
        else:
            self._fail(5, 0x20)                         # illegal request / invalid opcode

    def _read(self, lba, count):
        if count == 0:
            self._status(True)
            return
        self.img.read(lba, self.sec)
        self.submit_xfer(self.ep_in, self.sec, lambda *a: self._read(lba + 1, count - 1))


def start():
    drive = Drive(Image())
    usbdev.get().init(drive, builtin_driver=True, product_str="wedgie", manufacturer_str="wedgie.dev")
    return drive
