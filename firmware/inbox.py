# Files dropped on the WEDGIE drive (wedgiedrive.py), read as request lines: a phone (or any computer)
# that can save a file but has no serial port talks to a wedgie this way. A host-written file in the
# drive's top folder is fed, byte by byte, through the one USB line reader (wedgie.lines(): no new
# buffer), so each of its lines is handled exactly like one from USB serial, with the same rules: any
# job still needs a real A press on the wedgie. Answers go out on USB serial as usual (no file back yet).
#
# Imported only once the host has written something (wedgie._dropped). A file is read once per power-up
# (and again if it's saved again: a new time or size); a file starting with a 0 byte (a Mac's ._ file) is
# skipped. Writes are taken only after the host has been quiet for SETTLE ms, so a file is read whole.
import struct
from time import ticks_ms, ticks_diff

SETTLE = 700
MAX = 16384             # bytes: a bigger file is skipped
seen = set()            # small: one tuple per file dropped this power-up
todo = []               # (cluster, size) of files waiting to be read
cur = None              # [cluster, offset in it, bytes left] of the file being read
_geo = None
_buf = None


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
