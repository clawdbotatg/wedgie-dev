# The WEDGIE drive: when a wedgie is plugged in it also shows up as a tiny USB drive with
# the underwear as its icon and an "Open wedgie.dev" page on it. The drive sits beside MicroPython's
# own USB serial port (builtin_driver=True), so wedgie.dev, wedgie.py and mpremote keep working.
#
# USB mass storage, Bulk-Only Transport, a handful of SCSI commands, on top of usbdev.py (the
# micropython-lib runtime USB device core). The disk image is drive.bin (tools/drive.py): a FAT12
# volume stored sparse, read sector by sector from flash. It takes writes (0.4 test build): a
# written sector lives in RAM (`over`, at most _CAP of them, made only when one is written) and is gone
# at unplug; flash is never written. A .txt dropped on it is read as request lines, the same as USB
# serial (inbox.py, through wedgie.lines()): a phone with no serial port can talk to a wedgie this way.
#
# boot.py starts it, only at power-up (not on a soft reset). Hold Y while plugging in to skip it for
# that boot. Adding the drive re-enumerates USB: the serial port drops and comes back about a second
# after power-up. Read boot.py's note before changing when or how this starts.
import struct
from micropython import const
from time import ticks_ms, ticks_diff
import usbdev

_CLASS_MSC, _SUBCLASS_SCSI, _PROTO_BOT = const(8), const(6), const(0x50)
_EP_IN = const(0x80)
_REQ_GET_MAX_LUN, _REQ_BOT_RESET = const(0xFE), const(0xFF)
_CBW_SIG, _CSW_SIG = const(0x43425355), const(0x53425355)
_SECTOR = const(512)
_CAP = const(12)                    # written sectors kept in RAM: 6 KB at most (the Wallet runs with ~19 KB free)
drive = None


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
        self.over = {}                  # lba -> bytearray(512): what the host wrote (differs from the image)
        self.when = {}                  # lba -> ticks_ms it was last written (for _reclaim)
        self.base = None                # a sector of the image, to compare a write with (made at the first)
        self.wrote = 0                  # ticks_ms of the last write; 0: nothing new for inbox.py
        self.full = False
        self.ans = None                 # (first lba, end lba, [512-byte memoryviews]): ANSWER.TXT, set by inbox.py

    def sector(self, lba, buf):
        """Sector lba as the host sees it: ANSWER.TXT from RAM, what it wrote, else the image (read into buf)."""
        a = self.ans
        if a is not None and a[0] <= lba < a[1]:
            return a[2][lba - a[0]]
        b = self.over.get(lba)
        if b is not None:
            return b
        self.img.read(lba, buf)
        return buf

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
        elif op == 0x1A:                                # MODE SENSE(6): writable
            self._reply(b"\x03\x00\x00\x00")
        elif op == 0x5A:                                # MODE SENSE(10)
            self._reply(b"\x00\x06\x00\x00\x00\x00\x00\x00")
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
        elif op == 0x2A:                                # WRITE(10)
            lba = struct.unpack_from(">I", self.cmd, 2)[0]
            count = struct.unpack_from(">H", self.cmd, 7)[0]
            if lba + count > self.img.sectors or self.cbw[12] & 0x80:
                self._fail(5, 0x21)
            else:
                self.full = False
                self._write(lba, count)
        else:
            self._fail(5, 0x20)                         # illegal request / invalid opcode

    def _read(self, lba, count):
        if count == 0:
            self._status(True)
            return
        self.submit_xfer(self.ep_in, self.sector(lba, self.sec), lambda *a: self._read(lba + 1, count - 1))

    def _write(self, lba, count):
        """Take count sectors from the host, one at a time. One the same as the image is dropped from
        RAM; past _CAP new ones the rest are still taken (the host sends them anyway) and the write fails."""
        if count == 0:
            if self.full:
                self.sense = (3, 0x0C, 0)               # medium error / write error
            self._status(not self.full)
            return
        self.submit_xfer(self.ep_out, self.sec, lambda *a: self._wrote(lba, count))

    def _reclaim(self):
        """RAM is full: forget written data sectors of clusters the FAT now says are free (a deleted
        file's, like a request already read), if written over 2 s ago (a new file's data can come
        before its FAT entry). True if one was freed."""
        b = self.sector(0, self.base)
        spc, res, nfats, nroot, _, _, fsz = struct.unpack_from("<BHBHHBH", b, 13)
        data0 = res + nfats * fsz + nroot * 32 // _SECTOR
        now = ticks_ms()
        freed = False
        for lba in list(self.over):
            if lba < data0 or ticks_diff(now, self.when.get(lba, 0)) < 2000:
                continue
            clus = (lba - data0) // spc + 2
            off = clus * 3 // 2
            lo = self.sector(res + off // _SECTOR, self.base)[off % _SECTOR]
            hi = self.sector(res + (off + 1) // _SECTOR, self.base)[(off + 1) % _SECTOR]
            v = lo | hi << 8
            if (v >> 4 if clus & 1 else v & 0xFFF) == 0:
                del self.over[lba]
                self.when.pop(lba, None)
                freed = True
        return freed

    def _wrote(self, lba, count):
        a = self.ans
        if a is not None and a[0] <= lba < a[1]:        # ANSWER.TXT is the wedgie's: a host write is dropped
            self._write(lba + 1, count - 1)
            return
        if self.base is None:
            self.base = bytearray(_SECTOR)
        self.img.read(lba, self.base)
        if self.sec == self.base:
            self.over.pop(lba, None)
            self.when.pop(lba, None)
        elif lba in self.over:
            self.over[lba][:] = self.sec
        elif len(self.over) < _CAP or self._reclaim():
            self.over[lba] = bytearray(self.sec)
        else:
            self.full = True
        self.wrote = ticks_ms() or 1
        if lba in self.over:
            self.when[lba] = self.wrote
        self._write(lba + 1, count - 1)


def start():
    global drive
    drive = Drive(Image())
    usbdev.get().init(drive, builtin_driver=True, product_str="wedgie", manufacturer_str="wedgie.dev")
    return drive
