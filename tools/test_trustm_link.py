#!/usr/bin/env python3
"""trustm.py's frame numbers are shared by every session: a session made before another one reset the chip
keeps working. Before 0.3.53 each Session kept its own; after a host's chip check (wedgie.chip: a new
Session, so a reset) the app's next frame had the wrong number, the chip ignored it, and the app froze for
wait_response's 10 s (Welcome, 2026-10-18). A stand-in chip that checks frame numbers.
    python3 tools/test_trustm_link.py"""
import sys, types, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware"))
m = types.ModuleType("machine")
class Pin:
    IN=0; PULL_UP=1
    def __init__(s,*a,**k): pass
    def value(s,*a): return 1
class I2C:
    def __init__(s,*a,**k): pass
m.Pin=Pin; m.I2C=I2C; sys.modules["machine"]=m
import time
time.sleep_ms=lambda ms: None; time.sleep_us=lambda us: None; time.ticks_ms=lambda: 0; time.ticks_diff=lambda a,b: a-b
import trustm as T
chip = {"expect": 0, "out": None, "opened": False}
def w(d):
    if d[0] == 0x88: chip["expect"]=0; chip["opened"]=False; return
    if d[1] & 0x80:   # an ack frame from the host
        return
    fr = (d[1] >> 2) & 3
    if fr != chip["expect"]: chip["out"] = None; return   # wrong frame number: ignored
    chip["expect"] = (fr + 1) & 3
    apdu = d[5:-2]
    if apdu[0] == 0x70: chip["opened"] = True
    ok = chip["opened"]
    body = bytes([(fr << 2) | fr]) + (5).to_bytes(2,"big") + b"\x00" + (bytes([0,0,0,0]) if ok else bytes([0xff,0,0,0]))
    chip["out"] = b"\x00" + body + T._crc(body).to_bytes(2,"big")
T._write = w
def rf():
    if chip["out"] is None: raise OSError("trustm: no response (would wait 10 s)")
    f, chip["out"] = chip["out"][1:], None
    return f
T.read_frame = rf
a = T.Session()
a.command(0x0C, 0, b"\x00\x20")
b = T.Session()          # someone else (the USB chip check) resets and opens
b.command(0x0C, 0, b"\x00\x20")
b.command(0x0C, 0, b"\x00\x20")
a.command(0x0C, 0, b"\x00\x20")   # before: wrong frame number -> 10 s wait
print("ok: the old session works after another reset")
