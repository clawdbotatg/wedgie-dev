#!/usr/bin/env python3
"""A pretend wedgie on a pseudo-terminal, for testing public/wedgie.py without hardware.
Raw-REPL code runs in real CPython inside a temp dir (so file writes, hashes, renames are real);
JSON lines get the firmware's answers (hello, shot, press, stop) once main.py + slot.py (0.1.x: menu.py) exist.
  python3 tools/fakedevice.py        prints the pty path, then serves until killed"""
import os, sys, pty, json, io, tempfile, contextlib, base64, select

master, slave = pty.openpty()
import tty; tty.setraw(slave)
print(os.ttyname(slave), flush=True)
fs = tempfile.mkdtemp(prefix="fakewedgie-")
os.chdir(fs)
with open("boot.py", "w") as f: f.write("# stock\n")
state = {"raw": False, "code": b"", "line": b"", "launched": None, "presses": []}
g = {}

def out(b): os.write(master, b if isinstance(b, bytes) else b.encode())

def wedgie(): return (os.path.exists("slot.py") or os.path.exists("menu.py")) and os.path.exists("main.py")

def hello(mid, t="hello"):
    return json.dumps({"id": mid, "type": t, "name": "wedgie", "fw": "wedgie-0.2.0", "version": "0.2.0", "slot": 1, "uid": "e66138935f5a2c29",
                       "board": "Pico 2 W", "apps": ["hello"], "running": state["launched"]}) + "\r\n"

def run(code):
    if code == "":
        out("OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>"); return
    buf, err = io.StringIO(), ""
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, g)
    except Exception as e:
        err = "Traceback\r\n%s: %s\r\n" % (type(e).__name__, e)
    out("OK" + buf.getvalue().replace("\n", "\r\n") + "\x04" + err + "\x04>")

def js(line):
    try: m = json.loads(line)
    except ValueError: return
    if not wedgie(): out(">>> " + line + "\r\n{'x': 1}\r\n>>> "); return
    mid, t = m.get("id"), m.get("type")
    if t == "hello": out(hello(mid))
    elif t == "shot":
        px = bytes([0x07, 0xE0]) * (240 * 240)        # all green
        n = (len(px) + 3071) // 3072
        for i in range(n):
            out(json.dumps({"id": mid, "type": "shot", "i": i, "n": n, "w": 240, "h": 240, "fmt": "rgb565be", "data": base64.b64encode(px[i * 3072:(i + 1) * 3072]).decode()}) + "\r\n")
    elif t in ("press", "launch", "home", "stop"):
        state["presses" if t == "press" else "launched"] = (state["presses"] + [m.get("key")]) if t == "press" else m.get("app")
        out(json.dumps({"id": mid, "type": "ok"}) + "\r\n")

while True:
    r, _, _ = select.select([master], [], [])
    for ch in os.read(master, 4096):
        c = bytes([ch])
        if c == b"\x03": state["raw"] = False; state["line"] = b""; continue
        if c == b"\x01": state["raw"] = True; state["code"] = b""; out("raw REPL; CTRL-B to exit\r\n>"); continue
        if c == b"\x02": state["raw"] = False; continue
        if not state["raw"]:
            if c == b"\x04":
                g.clear()
                if wedgie(): out(hello(None, "ready"))
                continue
            if c == b"\n":
                l = state["line"].decode(); state["line"] = b""
                if l.startswith("{"): js(l)
                continue
            if c != b"\r": state["line"] += c
            continue
        if c != b"\x04": state["code"] += c; continue
        code = state["code"].decode(); state["code"] = b""
        run(code)
