#!/usr/bin/env python3
# Host-side test of firmware/wedgiedrive.py's mass-storage protocol: a fake usbdev plays the USB host,
# sends the SCSI commands an OS sends at plug-in, and checks every reply (and every sector) against
# the FAT image tools/drive.py builds. Then the writable part: a real FAT library (pyfatfs) saves files
# onto a copy of the volume, the changed sectors go in as WRITE(10)s, and the wedgie must read their
# lines back through wedgie.lines() (inbox.py).
#     uv run --with pyfatfs --with "setuptools<81" python3 tools/test_drive.py
import struct, sys, types, subprocess, tempfile, time
from pathlib import Path
root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "firmware"))

sent = []                                    # (ep, bytes) the device sent to the host
pending = {}                                 # ep -> (buf, cb)
class Interface:
    def __init__(self): self._open = False
    def on_open(self): self._open = True
    def on_reset(self): self._open = False
    def submit_xfer(self, ep, data, cb=None):
        if ep in pending: raise RuntimeError("xfer_pending")
        pending[ep] = (data, cb)
fake = types.ModuleType("usbdev"); fake.Interface = Interface; fake.get = lambda: None
sys.modules["usbdev"] = fake
mp = types.ModuleType("micropython"); mp.const = lambda x: x; sys.modules["micropython"] = mp
time.ticks_ms = lambda: int(time.monotonic() * 1000)
time.ticks_diff = lambda a, b: a - b
sys.modules["machine"] = types.ModuleType("machine")
import wedgiedrive as W

def expand(path):
    """drive.bin -> the whole volume (what Image serves)."""
    b = Path(path).read_bytes()
    _, total, n = struct.unpack_from("<4sII", b)
    lbas = struct.unpack_from("<%dI" % n, b, 12)
    out = bytearray(total * 512)
    for i, lba in enumerate(lbas):
        out[lba * 512:(lba + 1) * 512] = b[12 + 4 * n + i * 512:12 + 4 * n + (i + 1) * 512]
    return bytes(out)

img = Path(tempfile.mkstemp(suffix=".img")[1])
built = subprocess.run([sys.executable, str(root / "tools/drive.py"), "--img", str(img)], capture_output=True)
if built.returncode:                         # drive.py needs macOS + pngquant: check drive.bin against itself
    print("(drive.py can't build here: reading drive.bin as it is)")
    img.write_bytes(expand(root / "firmware/drive.bin"))
IMG = img.read_bytes()
if Path("/sbin/fsck_msdos").exists():       # macOS checks (and "repairs", in the drive's few KB of RAM) at plug-in
    fsck = subprocess.run(["/sbin/fsck_msdos", "-n", str(img)], capture_output=True, text=True)
    print(("ok   " if fsck.returncode == 0 else "FAIL ") + "fsck_msdos finds nothing to repair" + ("" if fsck.returncode == 0 else ":\n" + fsck.stdout))
    if fsck.returncode:
        sys.exit(1)

d = W.Drive(W.Image(str(root / "firmware/drive.bin")))
d.desc_cfg(types.SimpleNamespace(interface=lambda *a: None, endpoint=lambda *a: None), 1, 2, [])
OUT, IN = d.ep_out, d.ep_in
d.on_open()

def pump_in():
    """Take everything the device sends until it asks for the next command."""
    got = []
    while IN in pending:
        buf, cb = pending.pop(IN)
        got.append(bytes(buf))
        if cb: cb(IN, 0, len(buf))
    return got

tag = 0
def command(cdb, want, data_in=True, out=b""):
    global tag
    tag += 1
    buf, cb = pending.pop(OUT)
    cbw = struct.pack("<IIIBBB", 0x43425355, tag, want, 0x80 if data_in else 0, 0, len(cdb)) + cdb.ljust(16, b"\0")
    buf[:] = cbw
    cb(OUT, 0, 31)
    for i in range(0, len(out), 512):        # the data a write sends, a sector per transfer
        buf, cb = pending.pop(OUT)
        buf[:] = out[i:i + 512]
        cb(OUT, 0, 512)
    got = pump_in()
    csw = got[-1]
    sig, t, residue, status = struct.unpack("<IIIB", csw)
    assert sig == 0x53425355 and t == tag, csw
    assert OUT in pending, "device must wait for the next command"
    return b"".join(got[:-1]), status

fails = 0
def check(name, ok):
    global fails
    print(("ok   " if ok else "FAIL ") + name)
    fails += not ok

data, st = command(b"\x12\x00\x00\x00\x24\x00", 36); check("INQUIRY: removable, 'wedgie.dev'", st == 0 and data[1] == 0x80 and b"wedgie.dev" in data)
data, st = command(b"\x00" * 6, 0, False);         check("TEST UNIT READY", st == 0)
data, st = command(b"\x25" + b"\0" * 9, 8);         check("READ CAPACITY: 2048 x 512", st == 0 and struct.unpack(">II", data) == (2047, 512))
data, st = command(b"\x1a\x00\x3f\x00\xc0\x00", 192); check("MODE SENSE(6): write-protected until phone mode", st == 0 and data[2] & 0x80)
for lba, n in ((0, 1), (1, 8), (19, 4), (27, 40), (2040, 8)):
    data, st = command(b"\x28\x00" + struct.pack(">I", lba) + b"\x00" + struct.pack(">H", n) + b"\x00", n * 512)
    check(f"READ(10) sectors {lba}..{lba + n - 1} match the image", st == 0 and data == IMG[lba * 512:(lba + n) * 512])
data, st = command(b"\x28\x00" + struct.pack(">I", 5000) + b"\x00\x00\x01\x00", 512); check("READ past the end fails", st == 1)
data, st = command(b"\x4a" + b"\0" * 9, 8);         check("unknown command fails cleanly", st == 1 and len(data) == 8)
check("GET_MAX_LUN = 0", d.on_interface_control_xfer(0, bytes([0xA1, 0xFE, 0, 0, 0, 0, 1, 0])) == b"\x00")

# ---- writes, and files dropped on the drive ------------------------------------------------------
def write(lba, data):
    n = len(data) // 512
    return command(b"\x2a\x00" + struct.pack(">I", lba) + b"\x00" + struct.pack(">H", n) + b"\x00", n * 512, False, data)[1]

def sense():
    data, _ = command(b"\x03\x00\x00\x00\x12\x00", 18)
    return data[2] & 15, data[12]

# ---- read-only until phone mode (0.3.37): a write fails and changes nothing; phone() takes the medium
# out for a moment (NOT READY), then it's back (UNIT ATTENTION once) and writable --------------------
check("read-only: a write fails", write(40, b"x" * 512) == 1)
check("read-only: write protected (7/27)", sense() == (7, 0x27))
data, st = command(b"\x28\x00" + struct.pack(">I", 40) + b"\x00\x00\x01\x00", 512)
check("read-only: the sector is unchanged", st == 0 and data == IMG[40 * 512:41 * 512] and not d.over)
now = [10 ** 6]
real_ticks = W.ticks_ms
W.ticks_ms = lambda: now[0]
d.phone()
data, st = command(b"\x00" * 6, 0, False);        check("phone(): not ready at first", st == 1 and sense() == (2, 0x3A))
data, st = command(b"\x28\x00" + struct.pack(">I", 0) + b"\x00\x00\x08\x00", 8 * 512)
check("phone(): a read meanwhile fails (zeros, no big buffer)", st == 1 and data == bytes(8 * 512))
data, st = command(b"\x12\x00\x00\x00\x24\x00", 36); check("phone(): INQUIRY still answers", st == 0)
now[0] += 2000
data, st = command(b"\x00" * 6, 0, False);        check("phone(): back, medium changed (6/28) once", st == 1 and sense() == (6, 0x28))
data, st = command(b"\x00" * 6, 0, False);        check("phone(): then ready", st == 0)
data, st = command(b"\x1a\x00\x3f\x00\xc0\x00", 192); check("phone(): MODE SENSE writable", st == 0 and not data[2] & 0x80)
W.ticks_ms = real_ticks

try:
    import fs                                # pyfatfs registers fat://
    import pyfatfs  # noqa: F401
except ImportError:
    print("SKIP the write tests: uv run --with pyfatfs --with 'setuptools<81' python3 tools/test_drive.py")
    img.unlink()
    sys.exit(1 if fails else 0)

def free_chain(old, vol, name):
    """Free name's clusters (found in the volume before the delete, old) in both FATs of vol, as a real
    host's delete does (pyfatfs never writes that back)."""
    sfn = (name.upper().rpartition(".")[0].ljust(8) + name.upper().rpartition(".")[2].ljust(3)).encode()
    for o in range(13 * 512, 17 * 512, 32):
        if old[o:o + 11] == sfn:
            c = struct.unpack_from("<H", old, o + 26)[0]
            while 2 <= c < 0xFF8:
                for fat in (512, 7 * 512):
                    k = fat + c * 3 // 2
                    v = vol[k] | vol[k + 1] << 8
                    nxt = v >> 4 if c & 1 else v & 0xFFF
                    v = v & 0x000F if c & 1 else v & 0xF000
                    vol[k], vol[k + 1] = v & 0xFF, v >> 8
                c = nxt
            return

def save(files):
    """Save files onto the volume as a host would (a real FAT library); WRITE every changed sector."""
    before = img.read_bytes()
    gone = [n for n, data in files.items() if data is None]
    with fs.open_fs("fat://" + str(img)) as v:
        for name, data in files.items():
            if data is None:
                v.remove(name)
            else:
                v.writebytes(name, data)
    after = bytearray(img.read_bytes())
    for name in gone:
        free_chain(before, after, name)
    img.write_bytes(after)
    st = 0
    for lba in range(len(after) // 512):
        if after[lba * 512:(lba + 1) * 512] != before[lba * 512:(lba + 1) * 512]:
            st |= write(lba, after[lba * 512:(lba + 1) * 512])
    return st, after

import wedgie as G
W.drive = d
R = G.Lines(6144)
def lines():
    d.wrote = d.wrote and d.wrote - 1000      # the host has been quiet long enough
    out = []
    while True:
        r = G._dropped(R)
        if r is None:
            return out
        if r:
            out.append(r)

big = b'{"type":"ping","id":"big","pad":"' + b"x" * 1400 + b'"}'      # crosses two sectors
st, after = save({"open.txt": b'{"type":"open"}\n{"type":"ping","id":1}\r\n', "big.txt": big,
                  "._open.txt": b"\x00\x05\x16\x07" + b"\0" * 60})
check("WRITE(10)s of a saved file succeed", st == 0)
check(f"what was written stays in RAM, under the cap ({len(d.over)} sectors)", 0 < len(d.over) <= W._CAP)
data, st = command(b"\x28\x00" + struct.pack(">I", 0) + b"\x00" + struct.pack(">H", 64) + b"\x00", 64 * 512)
check("READ(10) gives the host back what it wrote", st == 0 and data == after[:64 * 512])
got = lines()
check("dropped files read as request lines: " + repr([g[:30] for g in got]),
      sorted(got) == sorted([b'{"type":"open"}', b'{"type":"ping","id":1}', big]))
check("nothing is read twice", lines() == [])
st, _ = save({"open.txt": b'{"type":"ping","id":2}'})
check("a file saved again is read again (no newline at the end)", st == 0 and lines() == [b'{"type":"ping","id":2}'])
st, _ = save({"open.txt": None, "big.txt": None})
check("deleting files reads nothing", st == 0 and lines() == [])
st, _ = save({"huge.txt": b"y" * 512 * (W._CAP + 4)})
check("a write past the RAM cap fails (and is still taken whole)", st == 1 and len(d.over) <= W._CAP)
data, st = command(b"\x00" * 6, 0, False);           check("the drive still answers after that", st == 0)

# ---- answers: ANSWER.TXT, served from RAM once a request came in through a file -------------------
import inbox
def answer_txt():
    """ANSWER.TXT as a host reads it: every sector over READ(10), opened with a real FAT library."""
    data, st = command(b"\x28\x00" + struct.pack(">I", 0) + b"\x00" + struct.pack(">H", 2048) + b"\x00", 2048 * 512)
    img.write_bytes(data)
    with fs.open_fs("fat://" + str(img)) as v:
        return v.readbytes("ANSWER.TXT")
check("ANSWER.TXT is on the drive (zeros until the first answer)", answer_txt() == bytes(2048))
check("a request came in through a file", inbox.fed)
over = len(d.over)
G.send({"id": 1, "type": "pong"})
a = answer_txt()
check("an answer lands in ANSWER.TXT: count line, then it, then newlines: " + repr(a[:40]),
      a.split(b"\n")[:2] == [b"#00000001", b'{"id": 1, "type": "pong"}'] and a.strip(b"\n").count(b"\n") == 1 and len(a) == 2048)
G.send({"id": 2, "type": "ok"})
a = answer_txt()
check("answers stack up, oldest first", a.split(b"\n")[:3] == [b"#00000002", b'{"id": 1, "type": "pong"}', b'{"id": 2, "type": "ok"}'])
for i in range(40):
    G.send({"id": 100 + i, "type": "ok", "pad": "x" * 60})
a = answer_txt()
got = [l for l in a.split(b"\n") if l]
check("a full ANSWER.TXT starts over, the newest answer kept: %d lines" % len(got),
      got[0] == b"#00000042" and got[-1].startswith(b'{"id": 139,') and len(a) == 2048)
G.send({"id": 3, "type": "big", "pad": "y" * 3000})
check("an answer too long for the file says so", b"too long" in answer_txt())
check("answers take no write RAM", len(d.over) == over)
write(inbox._answer_file(d)[0], b"z" * 512)
check("a host can't write over ANSWER.TXT", b"zzz" not in answer_txt() and len(d.over) == over)

# ---- many requests in a row: a host that never reuses a freed cluster (macOS) still fits -----------
clock = [time.ticks_ms() + 10 ** 6]
W.ticks_ms = inbox.ticks_ms = time.ticks_ms = lambda: clock[0]
calls = [0]
_r = W.Drive._reclaim
def counted(self):
    calls[0] += 1
    return _r(self)
W.Drive._reclaim = counted
from pyfatfs.PyFat import PyFat
hint = [0]
_alloc = PyFat.allocate_bytes
def next_free(self, size, erase=False):       # like macOS: the next free cluster after the last one used,
    self.first_free_cluster = max(self.first_free_cluster, hint[0])     # never one just freed
    got = _alloc(self, size, erase)
    hint[0] = max(got) + 1
    return got
PyFat.allocate_bytes = next_free
img.write_bytes(IMG)                          # a fresh plug-in (pyfatfs leaks the old chain on an overwrite)
d.over.clear(); d.when.clear()
ok = True
for i in range(3 * W._CAP):
    clock[0] += 3000
    line = b'{"type":"ping","id":%d,"p":"%s"}' % (i, b"x" * (i * 97 % 900))     # 1 or 2 sectors
    files = {"r%d.txt" % i: line + b"\n"}
    if i:
        files["r%d.txt" % (i - 1)] = None
    st, _ = save(files)
    got = lines()
    ok = ok and st == 0 and got == [line]
    if not ok:
        print("  request", i, "write status", st, "read", got, "RAM sectors", sorted(d.over))
        break
check("%d requests in a row, each deleted after (RAM sectors at the end: %d, reclaims: %d)" % (3 * W._CAP, len(d.over), calls[0]), ok)
img.unlink()
sys.exit(1 if fails else 0)
