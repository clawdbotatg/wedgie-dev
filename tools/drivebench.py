#!/usr/bin/env python3
# The phone's path, tested from a Mac: drop a request file on the WEDGIE drive (as the iPhone app does),
# then watch the two ways an answer can come back: USB serial (the truth) and ANSWER.TXT on the drive
# (what a phone can read). No phone, no taps, except an A press if the request asks for one.
#     uv run --with pyserial python3 tools/drivebench.py ['{"type":"hello"}' ...] [--wait 10] [--cached]
# --cached reads ANSWER.TXT through macOS's file cache, like a normal app (default: F_NOCACHE, the device).
import fcntl, glob, json, os, sys, threading, time
from pathlib import Path

VOL = Path("/Volumes/WEDGIE")
args = [a for a in sys.argv[1:] if not a.startswith("--")]
wait = float(sys.argv[sys.argv.index("--wait") + 1]) if "--wait" in sys.argv else 10
if "--wait" in sys.argv:
    args.remove(sys.argv[sys.argv.index("--wait") + 1])
reqs = args or ['{"type":"hello"}']
t0 = time.time()
def say(*a):
    print("%6.2f" % (time.time() - t0), *a, flush=True)

if not VOL.exists():
    sys.exit("no /Volumes/WEDGIE: plug a wedgie into this Mac")

serial_lines = []
port = None
try:
    import serial
    ports = sorted(glob.glob("/dev/cu.usbmodem*"))
    if ports:
        port = serial.Serial(ports[0], 115200, timeout=0.1)
        def reader():
            buf = b""
            while True:
                try:
                    buf += port.read(4096)
                except Exception as e:
                    say("serial:", e); return
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if line:
                        serial_lines.append(line)
                        say("usb   <", line.decode(errors="replace")[:200])
        threading.Thread(target=reader, daemon=True).start()
    else:
        say("no serial port: watching the drive only")
except ImportError:
    say("no pyserial: watching the drive only (uv run --with pyserial ...)")

def read_answer():
    p = VOL / "ANSWER.TXT"
    if not p.exists():
        return None
    fd = os.open(p, os.O_RDONLY)
    try:
        if "--cached" not in sys.argv:
            fcntl.fcntl(fd, fcntl.F_NOCACHE, 1)
        return os.read(fd, 65536).replace(b"\0", b"").decode(errors="replace").strip()
    finally:
        os.close(fd)

before = read_answer()
say("ANSWER.TXT", "missing (firmware without answers)" if before is None else "before: " + (before.splitlines() or [""])[0])

n = int(time.time()) % 10000
name = VOL / f"REQ-{n}.TXT"
name.write_text("\n".join(reqs) + "\n")
os.sync()
say("drive >", name.name, reqs)

last = before
end = time.time() + wait
while time.time() < end:
    a = read_answer()
    if a is not None and a != last:
        last = a
        say("drive <", a.replace("\n", "\n" + " " * 15)[:2000])
    time.sleep(0.25)

name.unlink(missing_ok=True)
junk = [p.name for p in VOL.iterdir() if p.name.startswith(".") and p.name not in (".VolumeIcon.icns", "._.")]
say("done.", len(serial_lines), "usb lines;", "junk on the drive:", junk)
