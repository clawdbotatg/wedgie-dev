# tls.py on a REAL wedgie: asks for full control (press green once), puts tls.mpy + roots.bin on, runs each
# GET with this computer carrying the TCP bytes, then deletes the two files. A case is host/path; "!" first:
# the computer flips a bit in the handshake, "!!": in the answer. "host/path@{json}": a POST of that JSON.
#   uv run --with pyserial python3 tlsboard.py api.coinbase.com/v2/prices/ETH-USD/spot '!api.github.com/zen' ...
import sys, time, json, glob, socket, serial, os
cases = sys.argv[1:]
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "public"))
import wedgie as WG
wg = WG.Wedgie(glob.glob("/dev/cu.usbmodem*")[0])
print("press GREEN on the wedgie")
WG.take_over(wg, "TLS test")
for name in ("tls.mpy", "roots.bin"):
    wg.put(name, open(os.path.join(here, "..", "firmware", name), "rb").read())
wg.exec("import gc\nfor _n in list(globals()):\n    if not _n.startswith('__') and _n != 'gc': del globals()[_n]\ngc.collect()")
print("files on")
s = wg.s
s.timeout = 0.05
def read_until(pat, t):
    b, end = b"", time.time() + t
    while time.time() < end:
        b += s.read(4096)
        if pat in b:
            return b
    raise SystemExit("timed out waiting for %r; got %r" % (pat, b[-300:]))
for case in cases:
    tamper = len(case) - len(case.lstrip("!"))
    host, _, path = case.lstrip("!").partition("/")
    path, _, body = ("/" + path).partition("@")
    print("==", case)
    sock = socket.create_connection((host, 443))
    sock.settimeout(0.05)
    code = '''
    import gc, time, binascii, sys
    gc.collect()
    free0 = gc.mem_free()
    import tls
    gc.collect()
    low = [gc.mem_free()]
    t0 = time.ticks_ms()
    def log(m):
        gc.collect(); low[0] = min(low[0], gc.mem_free())
        print("  %%s %%d ms, free %%d" %% (m, time.ticks_diff(time.ticks_ms(), t0), gc.mem_free()))
    def send(b):
        sys.stdout.write("\\x1eS" + binascii.hexlify(b).decode() + "\\n")
    def recv():
        sys.stdout.write("\\x1eR\\n")
        return binascii.unhexlify(sys.stdin.readline().strip())
    print("start free", gc.mem_free())
    try:
        c = tls.Conn(%r, send, recv, log=log)
        b = c.get(%r, body=%r)
        log("got %%d bytes, status %%d" %% (len(b), c.status))
        print("BODY", b[:200])
    except tls.Error as e:
        print("TLS ERROR", e)
    print("lowest free", low[0])
    ''' % (host, path, body.encode() or None)
    code = "\n".join(l[4:] if l.startswith("    ") else l for l in code.split("\n"))
    wg.buf = b""
    cb = code.encode()
    for o in range(0, len(cb), 256):
        s.write(cb[o:o + 256]); time.sleep(0.01)
    s.write(b"\x04")
    inq, closed, flipped, buf, sends = b"", False, False, b"", 0
    end = time.time() + 120
    while time.time() < end:
        buf += s.read(4096)
        try:
            d = sock.recv(65536)
            if d: inq += d
            else: closed = True
        except socket.timeout:
            pass
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            k = line.find(b"\x1e")
            if k < 0:
                t = line.decode(errors="replace").replace("OK", "", 1).strip("\r\x04>")
                if t.strip(): print(t)
                continue
            if line[k + 1:k + 2] == b"S":
                sock.sendall(bytes.fromhex(line[k + 2:].strip().decode()))
                sends += 1
            else:
                while not inq and not closed:
                    try:
                        d = sock.recv(65536)
                        if d: inq += d
                        else: closed = True
                    except socket.timeout:
                        pass
                give, inq = inq[:512], inq[512:]
                if not flipped and ((tamper == 1 and len(give) > 300) or (tamper == 2 and sends >= 3 and give)):
                    give = bytearray(give); give[min(200, len(give) - 1)] ^= 1; give = bytes(give); flipped = True
                    print("  (computer flipped one bit in the %s)" % ("handshake" if tamper == 1 else "answer"))
                s.write(give.hex().encode() + b"\n")
        if b"\x04>" in buf or b"\x04\x04" in buf:
            e = buf.split(b"\x04")
            if len(e) > 1 and e[1].strip(): print("ERR", e[1].decode(errors="replace"))
            break
    sock.close()
    time.sleep(0.3); s.read(65536); wg.buf = b""
wg.exec("import os\nfor n in ('tls.mpy','roots.bin'):\n    os.remove(n)", 10)
print("files removed")
wg.leave(reset=True)
