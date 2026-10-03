#!/usr/bin/env python3
"""Compiled firmware (.mpy): the whole core (every firmware .py no app claims, but boot.py and main.py,
which MicroPython only runs as .py) and every file carts.json lists as X.mpy, built from firmware/X.py with the
mpy-cross of the MicroPython wedgie.dev flashes (1.29.0, mpy v6.3), and committed. A wedgie then loads
bytecode: compiling 23 KB of Python on an RP2040 needs a parse tree that doesn't fit (the Wallet:
"memory allocation failed" at start, docs/PLAN-MEMORY.md F3). Bytecode only, no -march: the same file
runs on RP2040, RP2350 and the browser emulator (MicroPython 1.26, also mpy v6.3). A file with
@micropython.viper/native can't be one (that needs -march, and the emulator has no native code).
The .py stays in git as the source; tools/release.mjs publishes the .mpy instead of it.
    uv run --with mpy-cross==1.29.0.post2 python3 tools/mpy.py           rebuild
    uv run --with mpy-cross==1.29.0.post2 python3 tools/mpy.py --check   fail if a .mpy is out of date"""
import json, os, subprocess, sys, tempfile
import mpy_cross

FW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware")
VERSION = "MicroPython v1.29.0"


BOOT = ("boot", "main")      # MicroPython runs these two only as .py: keep them tiny


def core():
    """The core: firmware .py files no app claims (as .py or .mpy). Compiling them on the wedgie at boot
    ran it out of memory on a fresh plug-in (0.3.13, a real board: import slot, 1016-1816 bytes)."""
    carts = json.load(open(os.path.join(FW, "carts.json")))
    claimed = {n.rsplit(".", 1)[0] for c in carts for n in c["files"]}
    return sorted(n[:-3] for n in os.listdir(FW) if n.endswith(".py") and n[:-3] not in claimed and n[:-3] not in BOOT)


def names():
    out = core()
    for c in json.load(open(os.path.join(FW, "carts.json"))):
        out += [n[:-4] for n in c["files"] if n.endswith(".mpy")]
    return sorted(set(out))


def native(text):
    return "@micropython.viper" in text or "@micropython.native" in text or "@micropython.asm_thumb" in text


def build(mod, out):
    src = os.path.join(FW, mod + ".py")
    # -s: the name in tracebacks, and no path from this machine baked in (the bytes must be the same on any computer)
    cmd = [mpy_cross.mpy_cross, "-s", mod + ".py", "-o", out, src]
    if native(open(src).read()):
        if mod not in core():
            sys.exit("%s.py has native code: an app's can't be a .mpy (list it as .py in carts.json)" % mod)
        # viper in the core (loader's bar fill): machine code for the RP2040's Cortex-M0+ (armv6m), which the
        # RP2350's M33 runs too (MicroPython takes an older ARM arch). The emulator runs the source (fw/src).
        cmd[1:1] = ["-march=armv6m"]
    subprocess.run(cmd, check=True)


def main():
    v = subprocess.run([mpy_cross.mpy_cross, "--version"], capture_output=True, text=True).stdout
    if not v.startswith(VERSION):
        sys.exit("mpy-cross is %r, not %s" % (v.strip(), VERSION))
    check, bad = "--check" in sys.argv, []
    with tempfile.TemporaryDirectory() as tmp:
        for mod in names():
            dst = os.path.join(FW, mod + ".mpy")
            out = os.path.join(tmp, mod + ".mpy") if check else dst
            build(mod, out)
            if check:
                try:
                    same = open(out, "rb").read() == open(dst, "rb").read()
                except OSError:
                    same = False
                if not same:
                    bad.append(mod + ".mpy")
            else:
                print("%s.mpy %d bytes (from %d)" % (mod, os.path.getsize(dst), os.path.getsize(os.path.join(FW, mod + ".py"))))
    if bad:
        sys.exit("out of date: %s. Run: uv run --with mpy-cross==1.29.0.post2 python3 tools/mpy.py" % " ".join(bad))
    if check:
        print("mpy: %d files up to date" % len(names()))


main()
