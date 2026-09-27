#!/usr/bin/env python3
# Host-side test of firmware/wedgiedrive.py's mass-storage protocol: a fake usbdev plays the USB host,
# sends the SCSI commands an OS sends at plug-in, and checks every reply (and every sector) against
# the FAT image tools/drive.py builds.   python3 tools/test_drive.py
import struct, sys, types, subprocess, tempfile
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
import wedgiedrive as W

img = Path(tempfile.mkstemp(suffix=".img")[1])
subprocess.run([sys.executable, str(root / "tools/drive.py"), "--img", str(img)], check=True, capture_output=True)
IMG = img.read_bytes()

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
def command(cdb, want, data_in=True):
    global tag
    tag += 1
    buf, cb = pending.pop(OUT)
    cbw = struct.pack("<IIIBBB", 0x43425355, tag, want, 0x80 if data_in else 0, 0, len(cdb)) + cdb.ljust(16, b"\0")
    buf[:] = cbw
    cb(OUT, 0, 31)
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
data, st = command(b"\x1a\x00\x3f\x00\xc0\x00", 192); check("MODE SENSE(6): write-protected", st == 0 and data[2] & 0x80)
for lba, n in ((0, 1), (1, 8), (19, 4), (27, 40), (2040, 8)):
    data, st = command(b"\x28\x00" + struct.pack(">I", lba) + b"\x00" + struct.pack(">H", n) + b"\x00", n * 512)
    check(f"READ(10) sectors {lba}..{lba + n - 1} match the image", st == 0 and data == IMG[lba * 512:(lba + n) * 512])
data, st = command(b"\x2a\x00" + b"\0" * 8, 512, False); check("WRITE(10) refused", st == 1)
data, st = command(b"\x03\x00\x00\x00\x12\x00", 18); check("REQUEST SENSE says write-protected", data[2] == 7 and data[12] == 0x27)
data, st = command(b"\x28\x00" + struct.pack(">I", 5000) + b"\x00\x00\x01\x00", 512); check("READ past the end fails", st == 1)
data, st = command(b"\x4a" + b"\0" * 9, 8);         check("unknown command fails cleanly", st == 1 and len(data) == 8)
check("GET_MAX_LUN = 0", d.on_interface_control_xfer(0, bytes([0xA1, 0xFE, 0, 0, 0, 0, 1, 0])) == b"\x00")
img.unlink()
sys.exit(1 if fails else 0)
