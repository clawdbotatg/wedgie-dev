# Files dropped on the WEDGIE drive (wedgiedrive.py), read as request lines: a phone (or any computer)
# that can save a file but has no serial port talks to a wedgie this way. A host-written file in the
# drive's top folder is fed, byte by byte, through the one USB line reader (wedgie.lines(): no new
# buffer), so each of its lines is handled exactly like one from USB serial, with the same rules: any
# job still needs a real press of the green button on the wedgie. Answers go out on USB serial as usual, and once a request
# came in through a file, into ANSWER.TXT too (answer(): a phone can't read the serial port).
#
# Imported only once the host has written something (wedgie._dropped). A file is read once per power-up
# (and again if it's saved again: a new time or size); a file starting with a 0 byte (a Mac's ._ file) is
# skipped. Writes are taken only after the host has been quiet for SETTLE ms, so a file is read whole.
import struct, sys
from time import ticks_ms, ticks_diff

SETTLE = 700
MAX = 16384             # bytes: a bigger file is skipped
seen = set()            # small: one tuple per file dropped this power-up
todo = []               # (cluster, size) of files waiting to be read
cur = None              # [cluster, offset in it, bytes left] of the file being read
_geo = None
_buf = None
fed = False             # a request came in through a file: answers go to ANSWER.TXT too
_ans = None             # bytearray: ANSWER.TXT as the host reads it (made at the first answer)
_end = 0                # where the answer lines stop in it
_count = 0
_HEAD = 10              # its first line, b"#00000007\n": how many answers so far, so a host sees a new one


def _geometry(dr):
    """(fat0, root0, root sectors, data0, sectors per cluster), from the boot sector."""
    global _geo
    if _geo is None:
        b = dr.sector(0, _buf)
        spc, res, nfats, nroot, _, _, fsz = struct.unpack_from("<BHBHHBH", b, 13)
        root0 = res + nfats * fsz
        _geo = (res, root0, nroot * 32 // 512, root0 + nroot * 32 // 512, spc)
    return _geo


def _fat_byte(dr, off):
    return dr.sector(_geometry(dr)[0] + off // 512, _buf)[off % 512]


def _next(dr, clus):
    """FAT12: the cluster after clus (>= 0xFF8: the end)."""
    off = clus * 3 // 2
    v = _fat_byte(dr, off) | _fat_byte(dr, off + 1) << 8
    return v >> 4 if clus & 1 else v & 0xFFF


def _scan(dr):
    """Queue every new host-written file in the top folder."""
    fat0, root0, nroot, data0, spc = _geometry(dr)
    for s in range(root0, root0 + nroot):
        b = dr.sector(s, _buf)
        for o in range(0, 512, 32):
            if b[o] == 0:
                return
            attr = b[o + 11]
            if b[o] == 0xE5 or attr == 0x0F or attr & 0x18:   # deleted, long name, label or folder
                continue
            clus, size = struct.unpack_from("<HI", b, o + 26)
            if clus < 2 or not 0 < size <= MAX or data0 + (clus - 2) * spc not in dr.over:
                continue                                    # empty, too big, or the image's own
            key = (bytes(b[o:o + 11]), clus, size, bytes(b[o + 22:o + 26]))
            if key not in seen:
                seen.add(key)
                todo.append((clus, size))


def pump(dr, R):
    """Feed dropped files into the line reader R until a line is done. Returns it (bytes, or False: too
    long), or None when there is nothing (more) to read for now."""
    global fed
    r = _pump(dr, R)
    if r is not None:
        fed = True
    return r


def _answer_file(dr):
    """(first lba, sectors) of ANSWER.TXT in the image's top folder (drive.py: contiguous), or None."""
    fat0, root0, nroot, data0, spc = _geometry(dr)
    for s in range(root0, root0 + nroot):
        b = dr.img.read(s, _buf)                # (the image's zero sector itself when it has none there)
        for o in range(0, 512, 32):
            if bytes(b[o:o + 11]) == b"ANSWER  TXT":
                clus, size = struct.unpack_from("<HI", b, o + 26)
                return data0 + (clus - 2) * spc, size // 512
    return None


def _fill(i):
    while i < len(_ans):
        _ans[i] = 10
        i += 1


def answer(s):
    """One answer (the JSON line just sent on USB) into ANSWER.TXT: the count line, then the answers
    since it last filled up, oldest first, then newlines. A full file starts over with this one."""
    global _ans, _end, _count
    dr = sys.modules["wedgiedrive"].drive
    if _ans is None:
        f = _answer_file(dr)
        if f is None or not f[1]:
            return
        _ans = bytearray(f[1] * 512)
        _fill(0)
        mv = memoryview(_ans)
        dr.ans = (f[0], f[0] + f[1], [mv[i * 512:(i + 1) * 512] for i in range(f[1])])
    b = s.encode()
    if len(b) + 1 > len(_ans) - _HEAD:
        b = b'{"type":"error","error":"answer too long for ANSWER.TXT"}'
    if _end < _HEAD or _end + len(b) + 1 > len(_ans):
        _fill(_HEAD)
        _end = _HEAD
    _ans[_end:_end + len(b)] = b
    _end += len(b) + 1
    _count += 1
    _ans[0:_HEAD - 1] = ("#%08d" % _count).encode()


def _pump(dr, R):
    global cur, _buf
    if _buf is None:
        _buf = bytearray(512)
    if dr.wrote and ticks_diff(ticks_ms(), dr.wrote) >= SETTLE:
        dr.wrote = 0
        _scan(dr)
    while True:
        if cur is None:
            if not todo:
                return None
            clus, size = todo.pop(0)
            cur = [clus, 0, size]
            if dr.sector(_geometry(dr)[3] + (clus - 2) * _geometry(dr)[4], _buf)[0] == 0:
                cur = None                                  # binary (a Mac's ._ file): skip it
                continue
        clus, off, left = cur
        data0, spc = _geometry(dr)[3], _geometry(dr)[4]
        b = dr.sector(data0 + (clus - 2) * spc + off // 512, _buf)
        i = off % 512
        while i < 512 and left:
            c = b[i]
            i += 1
            left -= 1
            if c == 3:                                      # never the escape hatch from a file
                continue
            r = R.feed(c)
            if r is not None:
                break
        else:
            r = None
        off += i - off % 512
        if not left:
            cur = None
            if r is None:
                r = R.feed(10)                              # a last line with no newline
            if r is not None:
                return r
            continue
        if off >= spc * 512:
            clus, off = _next(dr, clus), 0
            if clus >= 0xFF8 or clus < 2:
                cur = None
                r2 = R.feed(10)
                return r if r is not None else r2
        cur = [clus, off, left]
        if r is not None:
            return r
