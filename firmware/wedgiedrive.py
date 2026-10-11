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
# Read-only until phone mode (0.3.37, Austin): a writable drive made every Mac say "Disk Not Ejected Properly"
# at unplug, and almost nobody talks to a wedgie from a phone. Holding the two grey buttons for 5 s (power.py)
# calls phone(): the drive looks taken out for a moment, then comes back writable (a card reader's media
# change: NOT READY, then UNIT ATTENTION), so the phone mounts it again and can write requests. Until unplug.
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
_NO_SENSE = (0, 0, 0)
_OUT_MS = const(1500)               # phone(): how long the medium looks taken out
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
        """The sector: buf filled from the image, or the zero sector itself (no copy). Use what it returns."""
        off = self.at.get(lba)
        if off is None:
            return self.zero
        self.f.seek(off)
        self.f.readinto(buf)
        return buf


class Drive(usbdev.Interface):
    def __init__(self, image):
        super().__init__()
        self.img = image
        # Nothing on the read or write path allocates (beyond a written sector kept, _CAP at most): a Mac
        # reads the whole drive (~2 MB) the moment it's plugged in, right while main.py starts the app.
        # 0.3.12-0.3.22 made a callback per sector and a slice, a bytes and tuples per command: thousands
        # of small objects through the heap at boot, and real boards ran out of memory ("wedgie broke").
        # tools/bootprobe.mjs plays the Mac's reads (tools/rp2040/chip.mjs mscHost) and failed the same
        # way. So: buffers made here, bound methods made once (each self.method access makes a new
        # object), header fields read byte by byte.
        self.cbw = bytearray(31)
        self.csw = bytearray(13)
        self.csw[0], self.csw[1], self.csw[2], self.csw[3] = 0x55, 0x53, 0x42, 0x53       # "USBS"
        self.cmd = bytearray(16)
        self.sec = bytearray(_SECTOR)
        self.sense = _NO_SENSE
        self.ep_out = self.ep_in = None
        self.want = 0
        self._lba = self._left = 0
        self._ok = True
        self._cb_cbw = self._got_cbw
        self._cb_status = self._status_sent
        self._cb_sector = self._sector_sent
        self._cb_reply = self._reply_sent
        self._cb_wrote = self._wrote
        self.over = {}                  # lba -> bytearray(512): what the host wrote (differs from the image)
        self.when = {}                  # lba -> ticks_ms it was last written (for _reclaim)
        self.base = None                # a sector of the image, to compare a write with (made at the first)
        self.wrote = 0                  # ticks_ms of the last write; 0: nothing new for inbox.py
        self.full = False
        self.ans = None                 # (first lba, end lba, [512-byte memoryviews]): ANSWER.TXT, set by inbox.py
        self.writable = False           # phone mode (phone()): the host may write
        self.out = 0                    # ticks_ms phone() took the medium out (0: in)
        self.changed = False            # back in: the next TEST UNIT READY says the medium changed

    def phone(self):
        """Phone mode: take the medium out for _OUT_MS, then back writable."""
        if not self.writable and not self.out:
            self.out = ticks_ms() or 1

    def _absent(self):
        """True while the medium is out; once its time is up, it's back writable."""
        if not self.out:
            return False
        if ticks_diff(ticks_ms(), self.out) < _OUT_MS:
            return True
        self.out, self.writable, self.changed = 0, True, True
        return False

    def sector(self, lba, buf):
        """Sector lba as the host sees it: ANSWER.TXT from RAM, what it wrote, else the image (read into buf)."""
        a = self.ans
        if a is not None and a[0] <= lba < a[1]:
            return a[2][lba - a[0]]
        b = self.over.get(lba)
        if b is not None:
            return b
        return self.img.read(lba, buf)

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
            self.submit_xfer(self.ep_out, self.cbw, self._cb_cbw)
        except Exception as e:
            print("drive:", e)

    def _got_cbw(self, ep, result, n):
        c = self.cbw
        if n != 31 or c[0] != 0x55 or c[1] != 0x53 or c[2] != 0x42 or c[3] != 0x43:     # "USBC"
            self._want_cbw()
            return
        s = self.csw
        s[4], s[5], s[6], s[7] = c[4], c[5], c[6], c[7]                     # the tag, as it came
        self.want = c[8] | c[9] << 8 | c[10] << 16 | (c[11] & 0x3F) << 24   # (small int: never > 1 GB)
        m, i = self.cmd, 0
        while i < 16:
            m[i] = c[15 + i]
            i += 1
        self._scsi()

    def _status(self, ok, residue=0):
        s = self.csw
        s[8], s[9], s[10], s[11] = residue & 255, residue >> 8 & 255, residue >> 16 & 255, residue >> 24 & 255
        s[12] = 0 if ok else 1
        self.submit_xfer(self.ep_in, s, self._cb_status)

    def _status_sent(self, ep, result, n):
        self._want_cbw()

    def _reply(self, data, ok=True):
        """Send data (trimmed or zero-padded to what the host asked for), then the status. Only for the
        rare commands (INQUIRY, sense, capacity): READ(10) and WRITE(10) never come here."""
        n = self.want
        buf = bytearray(n)
        buf[: min(n, len(data))] = data[:n]
        self._ok = ok
        if n:
            self.submit_xfer(self.ep_in, buf, self._cb_reply)
        else:
            self._status(ok)

    def _reply_sent(self, ep, result, n):
        self._status(self._ok)

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
        if op != 0x12 and op != 0x03 and self._absent():          # phone(): no medium for a moment
            if op == 0x28 and not self.want % _SECTOR:              # a read: zero sectors (no buffer that big), then fail
                self.sense, self._lba, self._left, self._ok = (2, 0x3A, 0), -1, self.want // _SECTOR, False
                self._sector_sent(0, 0, 0)
            else:
                self._fail(2, 0x3A)                                 # not ready / medium not present
        elif op == 0x00 and self.changed:                           # back, writable: tell the host once
            self.changed = False
            self._fail(6, 0x28)                                     # unit attention / medium may have changed
        elif op == 0x00 or op == 0x1E or op == 0x1B or op == 0x2F or op == 0x35:   # test unit ready, prevent removal, start/stop, verify, sync
            self.sense = _NO_SENSE
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
            self.sense = _NO_SENSE
            self._reply(d)
        elif op == 0x1A:                                # MODE SENSE(6): write-protected until phone mode
            self._reply(b"\x03\x00\x00\x00" if self.writable else b"\x03\x00\x80\x00")
        elif op == 0x5A:                                # MODE SENSE(10)
            self._reply(b"\x00\x06\x00\x00\x00\x00\x00\x00" if self.writable else b"\x00\x06\x00\x80\x00\x00\x00\x00")
        elif op == 0x25:                                # READ CAPACITY(10)
            self._reply(struct.pack(">II", last, _SECTOR))
        elif op == 0x23:                                # READ FORMAT CAPACITIES
            self._reply(b"\x00\x00\x00\x08" + struct.pack(">I", self.img.sectors) + b"\x02\x00\x02\x00")
        elif op == 0x28 or op == 0x2A:                  # READ(10) / WRITE(10): the hot path, allocates nothing
            m = self.cmd
            lba = (m[2] & 0x3F) << 24 | m[3] << 16 | m[4] << 8 | m[5]
            count = m[7] << 8 | m[8]
            if op == 0x28:
                if lba + count > self.img.sectors:
                    self._fail(5, 0x21)                 # LBA out of range
                else:
                    self._read(lba, count)
            elif lba + count > self.img.sectors or self.cbw[12] & 0x80:
                self._fail(5, 0x21)
            else:
                self.full = not self.writable           # read-only: take the data, keep none, fail it
                self._write(lba, count)
        else:
            self._fail(5, 0x20)                         # illegal request / invalid opcode

    def _read(self, lba, count):
        self._lba, self._left, self._ok = lba, count, True
        self._sector_sent(0, 0, 0)

    def _sector_sent(self, ep, result, n):
        if not self._left:
            self._status(self._ok)
            return
        buf = self.img.zero if self._lba < 0 else self.sector(self._lba, self.sec)
        if self._lba >= 0:
            self._lba += 1
        self._left -= 1
        self.submit_xfer(self.ep_in, buf, self._cb_sector)

    def _write(self, lba, count):
        """Take count sectors from the host, one at a time. One the same as the image is dropped from
        RAM; past _CAP new ones the rest are still taken (the host sends them anyway) and the write fails."""
        self._lba, self._left = lba, count
        self._next_write()

    def _next_write(self):
        if not self._left:
            if self.full:
                self.sense = (3, 0x0C, 0) if self.writable else (7, 0x27, 0)   # write error / write protected
            self._status(not self.full)
            return
        self.submit_xfer(self.ep_out, self.sec, self._cb_wrote)

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

    def _wrote(self, ep, result, n):
        lba = self._lba
        self._lba += 1
        self._left -= 1
        if not self.writable:
            self._next_write()
            return
        a = self.ans
        if a is not None and a[0] <= lba < a[1]:        # ANSWER.TXT is the wedgie's: a host write is dropped
            self._next_write()
            return
        if self.base is None:
            self.base = bytearray(_SECTOR)
        if self.sec == self.img.read(lba, self.base):
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
        self._next_write()


def start():
    global drive
    drive = Drive(Image())
    usbdev.get().init(drive, builtin_driver=True, product_str="wedgie", manufacturer_str="wedgie.dev")
    return drive
