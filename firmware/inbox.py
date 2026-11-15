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
# A file read whole gives its written sectors back at once (_free, 0.3.41): the RAM holds 12, and waiting for
# the host's delete (an iPhone holds deletes in its cache) left a big transaction's third piece no room.
import struct, sys
from time import ticks_ms, ticks_diff

SETTLE = 700
MAX = 16384             # bytes: a bigger file is skipped
seen = set()            # small: one tuple per dropped file still in the top folder (64 entries at most)
todo = []               # (cluster, size) of files waiting to be read, QUEUE at most
QUEUE = 16
cur = None              # [cluster, offset in it, bytes left, first cluster] of the file being read
_geo = None
_buf = None
fed = False             # a request came in through a file: answers go to ANSWER.TXT too
_ans = None             # bytearray: ANSWER.TXT as the host reads it (made at the first answer)
_end = 0                # where the answer lines stop in it
_count = 0
_HEAD = 80              # its first line: b"#00000007" (how many answers so far, so a host sees a new one), then
                        # the drive's state (stat): what reached the wedgie, for a phone; then " t" + the wedgie's
                        # clock in ms, stamped at every read of the sector (0.3.45, wedgiedrive.sector): two reads
                        # with the same t didn't both reach the wedgie (a host's cached copy); then "\n"
_T = _HEAD - 13         # where " t%010d" goes
_stat_at = 0
scans = 0


def _geometry(dr):
    """(fat0, root0, root sectors, data0, sectors per cluster), from the image's own boot sector: never one the
    computer wrote (0.3.82: a root folder of 65535 entries kept every scan busy for good)."""
    global _geo
    if _geo is None:
        b = dr.img.read(0, _buf)
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
    """Queue every new host-written file in the top folder. seen keeps only files still in the folder, and todo
    holds QUEUE at most (0.3.82: a computer rewriting the folder with new times grew both until the RAM ran out);
    a file that found no room is taken at a later scan."""
    global seen
    fat0, root0, nroot, data0, spc = _geometry(dr)
    here, done = set(), False
    for s in range(root0, root0 + nroot):
        b = dr.sector(s, _buf)
        for o in range(0, 512, 32):
            if b[o] == 0:
                done = True
                break
            attr = b[o + 11]
            if b[o] == 0xE5 or attr == 0x0F or attr & 0x18:   # deleted, long name, label or folder
                continue
            clus, size = struct.unpack_from("<HI", b, o + 26)
            if clus < 2 or not 0 < size <= MAX or data0 + (clus - 2) * spc not in dr.over:
                continue                                    # empty, too big, or the image's own
            key = (bytes(b[o:o + 11]), clus, size, bytes(b[o + 22:o + 26]))
            if key in seen:
                here.add(key)
            elif len(todo) < QUEUE:
                here.add(key)
                todo.append((clus, size))
            else:
                dr.wrote = dr.wrote or ticks_ms()   # no room now: scan again once these are read
        if done:
            break
    seen = here


def _free(dr, clus):
    """The file starting at clus has been read whole: forget the sectors the host wrote for it."""
    data0, spc = _geometry(dr)[3], _geometry(dr)[4]
    for _ in range(MAX // 512 + 2):                 # a looped FAT can't hold us
        if clus < 2 or clus >= 0xFF8:
            return
        for s in range(data0 + (clus - 2) * spc, data0 + (clus - 1) * spc):
            dr.over.pop(s, None)
            dr.when.pop(s, None)
        clus = _next(dr, clus)


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
        dr.ans_t = _T
    b = s.encode()
    if len(b) + 1 > len(_ans) - _HEAD:
        b = b'{"type":"error","error":"answer too long for ANSWER.TXT"}'
    if _end < _HEAD or _end + len(b) + 1 > len(_ans):
        _fill(_HEAD)
        _end = _HEAD
    _ans[_end:_end + len(b)] = b
    _end += len(b) + 1
    _count += 1
    _ans[0:9] = ("#%08d" % _count).encode()
    stat(dr, True)


def stat(dr, now=False):
    """The rest of ANSWER.TXT's first line, at most every 500 ms: w writes taken, a ms since the last, l its lba,
    p 1 = written since the last scan (waiting for SETTLE ms of quiet), o RAM sectors held, f 1 = RAM full,
    s scans, z writes by area (boot.FATs.root folder.data), e root folder entries used/deleted/of. A phone
    reads it uncached: did its request reach the wedgie, and why no answer."""
    global _stat_at
    t = ticks_ms()
    if _ans is None or _buf is None or not (now or ticks_diff(t, _stat_at) >= 500):
        return
    _stat_at = t
    a = min(ticks_diff(t, dr.lastw), 99999) if dr.lastw else -1
    fat0, root0, nroot, data0, spc = _geometry(dr)
    used = gone = 0
    for sct in range(root0, root0 + nroot):
        b = dr.sector(sct, _buf)
        for o in range(0, 512, 32):
            if b[o] == 0xE5:
                gone += 1
            elif b[o]:
                used += 1
    z = dr.nwz
    line = (" w%d a%d l%d p%d o%d f%d s%d z%d.%d.%d.%d e%d/%d/%d" % (dr.nw, a, dr.lastlba, 1 if dr.wrote else 0,
            len(dr.over), 1 if dr.full else 0, scans, z[0], z[1], z[2], z[3], used, gone, nroot * 16)).encode()[:_T - 9]
    _ans[9:_T] = line + b" " * (_T - 9 - len(line))


def _pump(dr, R):
    global cur, _buf
    if _buf is None:
        _buf = bytearray(512)
    global scans
    stat(dr)
    if dr.wrote and ticks_diff(ticks_ms(), dr.wrote) >= SETTLE:
        dr.wrote = 0
        scans += 1
        _scan(dr)
    while True:
        if cur is None:
            if not todo:
                return None
            clus, size = todo.pop(0)
            cur = [clus, 0, size, clus]
            if dr.sector(_geometry(dr)[3] + (clus - 2) * _geometry(dr)[4], _buf)[0] == 0:
                cur = None                                  # binary (a Mac's ._ file): skip it
                _free(dr, clus)
                continue
        clus, off, left, first = cur
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
            _free(dr, first)
            if r is None:
                r = R.feed(10)                              # a last line with no newline
            if r is not None:
                return r
            continue
        if off >= spc * 512:
            clus, off = _next(dr, clus), 0
            if clus >= 0xFF8 or clus < 2:
                cur = None
                _free(dr, first)
                r2 = R.feed(10)
                return r if r is not None else r2
        cur = [clus, off, left, first]
        if r is not None:
            return r
